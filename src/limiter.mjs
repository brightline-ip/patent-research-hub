// Cross-process limiter for keyed providers. State lives in the Hub's data folder (<dataDir>/limiter), so every Hub
// process that uses the same data folder and the same key shares it: the MCP server, the CLI, and short-lived
// `gateway` children started by other tools.
//
// What it enforces, per provider and key (the key itself is never written; only a salted hash prefix names the files):
//   1. One call at a time ("burst 1"): a lock file held for the whole call. A caller that finds it taken WAITS for its turn.
//   2. A minimum spacing between call starts (config.directMinIntervalMs[provider]), also across processes.
//   3. A request cap per rolling hour (config.maxRequestsPerHour[provider]; 0 = unlimited). Only when it is truly used up
//      does the call fail, with the distinct error code `local_limit` and the wait time stated.
//   4. After an HTTP 429: a cooldown of at least 5 s (longer if Retry-After says so), doubling on consecutive 429s up to
//      15 minutes. The next call, in any process, waits for the cooldown. Nothing is ever retried immediately.
//
// A lock whose file has not been touched for `staleMs` (the holder refreshes it every few seconds) or whose process no
// longer exists is taken over. Locks are advisory and local: they do not coordinate between machines or between
// different data folders, and a process that is suspended for longer than `staleMs` can lose its lock.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

export const HOUR_MS=3600000;
export const MIN_429_WAIT_MS=5000;
export const MAX_COOLDOWN_MS=900000;
const held=new AsyncLocalStorage();
const realSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const duration=seconds=>seconds>=120?`${Math.ceil(seconds/60)} minute(s)`:`${seconds} second(s)`;

export class LocalLimitError extends Error{
  constructor(provider,max,waitMs){
    const seconds=Math.max(1,Math.ceil(waitMs/1000));
    super(`Local request limit reached for ${provider}: ${max} requests in the last hour (maxRequestsPerHour). Wait about ${duration(seconds)} before the next call, or raise the limit in config.json if your provider quota allows it.`);
    this.code='local_limit';this.provider=provider;this.limit=max;this.retryAfterSeconds=seconds;
  }
}
export class LimiterBusyError extends Error{
  constructor(provider,waitMs,why){
    const seconds=Math.max(1,Math.ceil(waitMs/1000));
    super(`The ${provider} key is busy or cooling down (${why}); waiting would take about ${duration(seconds)}, longer than the configured limit (limiterMaxWaitMs). Try again later.`);
    this.code='local_busy';this.provider=provider;this.retryAfterSeconds=seconds;
  }
}

// Retry-After is either seconds or an HTTP date. Returns milliseconds, 0 when absent or unreadable.
export function parseRetryAfterMs(value,now=Date.now()){
  if(value===null||value===undefined)return 0;
  const text=String(value).trim();if(!text)return 0;
  if(/^\d+(?:\.\d+)?$/.test(text))return Math.round(Number(text)*1000);
  const at=Date.parse(text);return Number.isNaN(at)?0:Math.max(0,at-now);
}
// The wait this release applies after the n-th consecutive 429: at least 5 s, at least Retry-After, doubling, capped.
export function cooldownMs(consecutive,retryAfterMs=0){
  return Math.min(MAX_COOLDOWN_MS,Math.max(MIN_429_WAIT_MS,retryAfterMs,MIN_429_WAIT_MS*2**Math.max(0,consecutive-1)));
}
export function rateLimitWaitSeconds(retryAfterHeader,now=Date.now()){return Math.ceil(cooldownMs(1,parseRetryAfterMs(retryAfterHeader,now))/1000);}

export function limiterId(provider,key){return `${provider}-${createHash('sha256').update('prh-limiter\0'+provider+'\0'+String(key||'')).digest('hex').slice(0,16)}`;}

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
function tryCreate(file,token){
  let fd;
  try{fd=fs.openSync(file,'wx');}catch(e){if(['EEXIST','EPERM','EACCES','EBUSY'].includes(e.code))return false;throw e;}
  try{fs.writeSync(fd,JSON.stringify({pid:process.pid,token,at:Date.now()}));}finally{fs.closeSync(fd);}
  return true;
}
function staleness(file,staleMs){
  let st;try{st=fs.statSync(file);}catch{return {gone:true};}
  const age=Date.now()-st.mtimeMs;
  if(age>staleMs)return {stale:true,st};
  if(age>2000){
    try{const pid=JSON.parse(fs.readFileSync(file,'utf8')).pid;if(Number.isInteger(pid)&&pid!==process.pid&&!alive(pid))return {stale:true,st};}catch{}
  }
  return {stale:false};
}
function breakStale(file,st){
  try{
    const again=fs.statSync(file);
    if(again.mtimeMs!==st.mtimeMs||again.ino!==st.ino)return;  // somebody refreshed or replaced it meanwhile
    const aside=`${file}.stale.${randomBytes(6).toString('hex')}`;
    fs.renameSync(file,aside);fs.rmSync(aside,{force:true});
  }catch{}
}
// Returns {release} or null when the deadline passes first.
async function acquire(file,{staleMs,deadline}){
  const token=randomBytes(12).toString('hex');
  for(;;){
    if(tryCreate(file,token))break;
    const s=staleness(file,staleMs);
    if(s.stale){breakStale(file,s.st);continue;}
    if(Date.now()>=deadline)return null;
    await realSleep(20+Math.floor(Math.random()*40));
  }
  const beat=setInterval(()=>{try{const now=new Date();fs.utimesSync(file,now,now);}catch{}},Math.max(200,Math.min(5000,Math.floor(staleMs/3))));
  beat.unref?.();
  return {release(){
    clearInterval(beat);
    for(let i=0;i<5;i++){
      try{
        const mine=JSON.parse(fs.readFileSync(file,'utf8')).token===token;
        if(mine)fs.unlinkSync(file);
        return;
      }catch(e){if(e.code==='ENOENT')return;if(!['EPERM','EACCES','EBUSY'].includes(e.code)&&!(e instanceof SyntaxError))return;}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
    }
  }};
}

const emptyState=()=>({requests:[],lastStartAt:0,cooldownUntil:0,consecutive429:0});
function loadState(file){
  try{
    const s=JSON.parse(fs.readFileSync(file,'utf8'));
    return {requests:Array.isArray(s.requests)?s.requests.filter(Number.isFinite):[],lastStartAt:Number(s.lastStartAt)||0,cooldownUntil:Number(s.cooldownUntil)||0,consecutive429:Number(s.consecutive429)||0};
  }catch{return emptyState();}
}
function saveState(file,state){
  const tmp=`${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(state));
  for(let i=0;;i++){
    try{fs.renameSync(tmp,file);return;}
    catch(e){if(i>=4||!['EPERM','EACCES','EBUSY'].includes(e.code)){fs.rmSync(tmp,{force:true});throw e;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
  }
}

const passthroughSlot={rateLimited(){}};
// Runs fn(slot) while holding this provider/key's turn. fn calls slot.rateLimited(retryAfterHeader) when the provider
// answered HTTP 429, which starts the cooldown for every process. Re-entrant within one async call chain.
export async function withProviderSlot({dir,provider,key,max=0,minIntervalMs=0,staleMs=30000,maxWaitMs=1200000,sleep=realSleep},fn){
  const id=limiterId(provider,key),outer=held.getStore();
  if(outer?.has(id))return fn(passthroughSlot);
  fs.mkdirSync(dir,{recursive:true});
  const begun=Date.now(),deadline=begun+maxWaitMs;
  const lock=await acquire(path.join(dir,id+'.lock'),{staleMs,deadline});
  if(!lock)throw new LimiterBusyError(provider,Date.now()-begun,'another process is using it');
  try{
    return await held.run(new Set([...(outer||[]),id]),async()=>{
      const stateFile=path.join(dir,id+'.json'),state=loadState(stateFile);
      let now=Date.now();
      state.requests=state.requests.filter(t=>now-t<HOUR_MS);
      if(max>0&&state.requests.length>=max)throw new LocalLimitError(provider,max,state.requests[0]+HOUR_MS-now);
      const until=Math.max(state.cooldownUntil,state.lastStartAt+minIntervalMs);
      if(until>now){
        const wait=until-now;
        if(wait>deadline-now)throw new LimiterBusyError(provider,wait,state.cooldownUntil>state.lastStartAt+minIntervalMs?'HTTP 429 cooldown':'pacing');
        await sleep(wait);
      }
      now=Date.now();
      if(max>0)state.requests.push(now);
      state.lastStartAt=now;
      try{saveState(stateFile,state);}catch{}
      const slot={rl:null,rateLimited(header){this.rl=parseRetryAfterMs(header);}};
      let threw=true;
      try{const result=await fn(slot);threw=false;return result;}
      finally{
        if(slot.rl!==null){state.consecutive429+=1;state.cooldownUntil=Date.now()+cooldownMs(state.consecutive429,slot.rl);}
        else if(!threw)state.consecutive429=0;
        try{saveState(stateFile,state);}catch{}
      }
    });
  }finally{lock.release();}
}
