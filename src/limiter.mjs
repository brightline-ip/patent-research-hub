// Cross-process limiter for keyed providers. State lives in one per-user folder (see limiterDir in config.mjs), so every
// Hub process of this user shares it: the MCP server, the CLI, `gateway` children started by other tools, and code that
// imports the Hub as a module.
//
// What it enforces, per provider and key. The key itself is never written: files are named by a truncated SHA-256 of the
// provider, a random per-install salt (the `salt` file in the folder) and the key.
//   1. One call at a time ("burst 1"): a lock file held for the whole call. A caller that finds it taken WAITS for its turn
//      (and fails with `local_busy` only if that would take longer than the configured limit).
//   2. A minimum spacing between call starts (config.directMinIntervalMs[provider]), also across processes.
//   3. A cap on calls per rolling hour (config.maxRequestsPerHour[provider]; 0 = unlimited). It counts calls (turns at the
//      key), not HTTP attempts. Only when it is truly used up does the call fail, with the code `local_limit` and the wait.
//   4. After an HTTP 429: a cooldown of at least 5 s, as long as Retry-After says (up to 24 h), doubling on consecutive 429s
//      (the doubling is capped at 15 minutes). The next call, in any process, waits for it. Nothing is retried immediately.
//
// Locks: a lock file nobody has refreshed for `staleMs` (the holder refreshes it every few seconds) or whose process no
// longer exists is taken over. A takeover is serialised by an exclusive `<lock>.takeover` file with its own 5 s expiry, and
// the holder re-checks that the lock is still its own just before the call and before saving state. Locks are advisory and
// local: they do not coordinate between computers, and a process suspended for longer than `staleMs` can lose its lock.
// Times use the wall clock (Date.now): a clock that jumps by minutes can shorten or lengthen one wait or lock expiry.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

export const HOUR_MS=3600000;
export const MIN_429_WAIT_MS=5000;
export const MAX_COOLDOWN_MS=900000;           // cap on the doubling only
export const MAX_RETRY_AFTER_MS=86400000;      // upper bound on a Retry-After the Hub will honour in full
const TAKEOVER_EXPIRY_MS=5000;
const held=new AsyncLocalStorage();
const realSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const duration=seconds=>seconds>=120?`${Math.ceil(seconds/60)} minute(s)`:`${seconds} second(s)`;

export class LocalLimitError extends Error{
  constructor(provider,max,waitMs){
    const seconds=Math.max(1,Math.ceil(waitMs/1000));
    super(`Local request limit reached for ${provider}: ${max} calls in the last hour (maxRequestsPerHour counts calls, not HTTP attempts). Wait about ${duration(seconds)} before the next call, or raise the limit in config.json if your provider quota allows it.`);
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
export class LimiterStateError extends Error{
  constructor(message){super(message);this.code='local_state';}
}

// Retry-After is either seconds or an HTTP date. Returns milliseconds, 0 when absent or unreadable.
export function parseRetryAfterMs(value,now=Date.now()){
  if(value===null||value===undefined)return 0;
  const text=String(value).trim();if(!text)return 0;
  if(/^\d+(?:\.\d+)?$/.test(text))return Math.round(Number(text)*1000);
  const at=Date.parse(text);return Number.isNaN(at)?0:Math.max(0,at-now);
}
// The wait applied after the n-th consecutive 429: at least 5 s; Retry-After in full (up to 24 h); otherwise doubling, with
// the doubling capped at 15 minutes.
export function cooldownMs(consecutive,retryAfterMs=0){
  return Math.max(MIN_429_WAIT_MS,Math.min(MAX_RETRY_AFTER_MS,retryAfterMs),Math.min(MAX_COOLDOWN_MS,MIN_429_WAIT_MS*2**Math.max(0,consecutive-1)));
}
export function rateLimitWaitSeconds(retryAfterHeader,now=Date.now()){return Math.ceil(cooldownMs(1,parseRetryAfterMs(retryAfterHeader,now))/1000);}

const salts=new Map();
// A random per-install salt, created on first use next to the state (readable only by the account that owns the folder; the
// folder sits in the user's profile, and on POSIX the file is mode 0600).
export function limiterSalt(dir){
  if(salts.has(dir))return salts.get(dir);
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'salt');let value='';
  for(let i=0;i<5&&!value;i++){
    try{fs.writeFileSync(file,randomBytes(24).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    try{value=fs.readFileSync(file,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!value)pause(20);
  }
  if(!value)throw new LimiterStateError('The limiter salt file could not be read; delete '+file+' and try again.');
  salts.set(dir,value);return value;
}
export function limiterId(provider,key,salt=''){return `${provider}-${createHash('sha256').update('prh-limiter\0'+salt+'\0'+provider+'\0'+String(key||'')).digest('hex').slice(0,16)}`;}
export const lockPath=(dir,provider,key)=>path.join(dir,limiterId(provider,key,limiterSalt(dir))+'.lock');

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const LOCKED_CODES=['EEXIST','EPERM','EACCES','EBUSY'];
// true: created. false: the file exists. Otherwise the error (EPERM/EACCES/EBUSY): either a file being deleted, or a real
// permission problem; the caller decides which by looking for the file.
function tryCreate(file,token){
  let fd;
  try{fd=fs.openSync(file,'wx');}catch(e){if(e.code==='EEXIST')return false;if(LOCKED_CODES.includes(e.code))return e;throw e;}
  try{fs.writeSync(fd,JSON.stringify({pid:process.pid,token,at:Date.now()}));}finally{fs.closeSync(fd);}
  return true;
}
function readToken(file){try{return JSON.parse(fs.readFileSync(file,'utf8')).token??null;}catch{return null;}}
function staleness(file,staleMs){
  let st;try{st=fs.statSync(file);}catch{return {gone:true};}
  const age=Date.now()-st.mtimeMs;
  let pid=null,token=null;
  try{const j=JSON.parse(fs.readFileSync(file,'utf8'));pid=j.pid;token=j.token??null;}catch{}
  if(age>staleMs)return {stale:true,st,token};
  if(age>2000&&Number.isInteger(pid)&&pid!==process.pid&&!alive(pid))return {stale:true,st,token};
  return {stale:false};
}
// Removes a stale lock and creates ours, all while holding the exclusive takeover file, so two waiters cannot both break the
// same stale lock and both think they own the replacement. Returns true when the lock is now ours.
function takeOver(file,token,staleMs){
  const mutex=file+'.takeover';
  const got=tryCreate(mutex,token);
  if(got!==true){
    try{if(Date.now()-fs.statSync(mutex).mtimeMs>TAKEOVER_EXPIRY_MS)fs.unlinkSync(mutex);}catch{}   // its own short expiry
    return false;
  }
  try{
    const s=staleness(file,staleMs);
    if(!s.gone){
      if(!s.stale)return false;                                            // refreshed or replaced meanwhile
      const aside=`${file}.stale.${randomBytes(6).toString('hex')}`;
      try{fs.renameSync(file,aside);}catch(e){if(e.code!=='ENOENT')return false;}
      if(readToken(aside)!==s.token){                                      // we moved a live lock after all: put it back
        try{fs.linkSync(aside,file);}catch{}
        try{fs.rmSync(aside,{force:true});}catch{}
        return false;
      }
      try{fs.rmSync(aside,{force:true});}catch{}
    }
    return tryCreate(file,token)===true;
  }finally{try{fs.unlinkSync(mutex);}catch{}}
}
function sweep(dir){
  try{
    const cutoff=Date.now()-60000;
    for(const name of fs.readdirSync(dir)){
      if(!/\.tmp$|\.stale\.[0-9a-f]+$/.test(name))continue;
      try{const p=path.join(dir,name);if(fs.statSync(p).mtimeMs<cutoff)fs.rmSync(p,{force:true});}catch{}
    }
  }catch{}
}
// Returns {release, mine, lost} or null when the deadline passes first. Throws the real error when the lock file cannot be
// created for a reason other than another holder (for example a folder the account cannot write to).
async function acquire(file,{staleMs,deadline,dir}){
  sweep(dir);
  const token=randomBytes(12).toString('hex');
  let denied=0;
  for(;;){
    const made=tryCreate(file,token);
    if(made===true)break;
    const s=staleness(file,staleMs);
    if(made!==false&&s.gone){if(++denied>=100)throw made;}else denied=0;
    if(s.stale){if(takeOver(file,token,staleMs))break;continue;}
    if(Date.now()>=deadline)return null;
    await realSleep(20+Math.floor(Math.random()*40));
  }
  const lock={lost:false,mine:()=>readToken(file)===token};
  const beat=setInterval(()=>{
    try{if(!lock.mine()){lock.lost=true;clearInterval(beat);return;}const now=new Date();fs.utimesSync(file,now,now);}catch{}
  },Math.max(200,Math.min(5000,Math.floor(staleMs/3))));
  beat.unref?.();
  lock.release=()=>{
    clearInterval(beat);
    for(let i=0;i<5;i++){
      try{if(lock.mine())fs.unlinkSync(file);return;}
      catch(e){if(e.code==='ENOENT')return;if(!LOCKED_CODES.includes(e.code))return;}
      pause(30);
    }
  };
  return lock;
}

const emptyState=()=>({requests:[],lastStartAt:0,cooldownUntil:0,consecutive429:0});
// Only a missing file is an empty state. Other read errors are retried, then reported; a damaged file is reported, not ignored.
function loadState(file){
  let raw;
  for(let i=0;;i++){
    try{raw=fs.readFileSync(file,'utf8');break;}
    catch(e){if(e.code==='ENOENT')return emptyState();if(i>=4)throw new LimiterStateError(`The limiter state file ${file} cannot be read (${e.code||'error'}).`);pause(30);}
  }
  let s;try{s=JSON.parse(raw);}catch{throw new LimiterStateError(`The limiter state file ${file} is damaged; delete it (no Hub process may be running) and try again.`);}
  if(!s||typeof s!=='object')throw new LimiterStateError(`The limiter state file ${file} is damaged; delete it and try again.`);
  return {requests:Array.isArray(s.requests)?s.requests.filter(Number.isFinite):[],lastStartAt:Number(s.lastStartAt)||0,cooldownUntil:Number(s.cooldownUntil)||0,consecutive429:Number(s.consecutive429)||0};
}
function saveState(file,state){
  const tmp=`${file}.${randomBytes(6).toString('hex')}.tmp`;
  try{
    fs.writeFileSync(tmp,JSON.stringify(state));
    for(let i=0;;i++){
      try{fs.renameSync(tmp,file);return;}
      catch(e){if(i>=4||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;pause(20);}
    }
  }catch(e){try{fs.rmSync(tmp,{force:true});}catch{}throw new LimiterStateError(`The limiter state could not be saved in ${path.dirname(file)} (${e.code||'error'}).`);}
}

const passthroughSlot={rateLimited(){}};
const LOST=Symbol('lock lost');
// Runs fn(slot) while holding this provider/key's turn. fn calls slot.rateLimited(retryAfterHeader) when the provider
// answered HTTP 429, which starts the cooldown for every process. Re-entrant within one async call chain.
export async function withProviderSlot({dir,provider,key,max=0,minIntervalMs=0,staleMs=30000,maxWaitMs=1200000,sleep=realSleep},fn){
  const id=limiterId(provider,key,limiterSalt(dir)),outer=held.getStore();
  if(outer?.has(id))return fn(passthroughSlot);
  const begun=Date.now(),deadline=begun+maxWaitMs;
  for(;;){
    const lock=await acquire(path.join(dir,id+'.lock'),{staleMs,deadline,dir});
    if(!lock)throw new LimiterBusyError(provider,Date.now()-begun,'another process is using it');
    try{
      const outcome=await held.run(new Set([...(outer||[]),id]),async()=>{
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
        saveState(stateFile,state);
        if(lock.lost||!lock.mine())return LOST;                // somebody took the lock over while we waited: queue again
        const slot={rl:null,rateLimited(header){this.rl=parseRetryAfterMs(header);}};
        let threw=true;
        try{const result=await fn(slot);threw=false;return {result};}
        finally{
          if(slot.rl!==null){state.consecutive429+=1;state.cooldownUntil=Date.now()+cooldownMs(state.consecutive429,slot.rl);}
          else if(!threw)state.consecutive429=0;
          if(!lock.lost&&lock.mine())saveState(stateFile,state);   // never overwrite newer state after losing the lock
          else if(slot.rl!==null)throw new LimiterStateError('The lock was lost during the call, so the HTTP 429 cooldown could not be recorded safely.');
        }
      });
      if(outcome!==LOST)return outcome.result;
    }finally{lock.release();}
  }
}
