// Cross-process limiter for keyed providers. State lives in one per-user folder (see limiterDir in config.mjs), so every
// Hub process of this user shares it: the MCP server, the CLI, `gateway` children started by other tools, and code that
// imports the Hub as a module. (A host that gives each app a private view of %LOCALAPPDATA%, such as a sandboxed or packaged
// app, gets a separate folder and therefore a separate limiter.)
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
// longer exists is taken over. A takeover is serialised by an exclusive `<lock>.takeover` file with its own 5 s expiry. The
// holder confirms that the lock still carries its token before EVERY write of state and before the call; it declares the lock
// lost only on a different token or a missing file (a read that merely fails is retried and never counts as loss), and a holder
// that lost its lock writes nothing. Locks are advisory and local: they do not coordinate between computers, and a process
// suspended for longer than `staleMs` can lose its lock. Times use the wall clock (Date.now): a clock that jumps by minutes can
// shorten or lengthen one wait or lock expiry.
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
const hex=n=>randomBytes(n).toString('hex');

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

const NOT_SUPPORTED=['ENOTSUP','ENOSYS','EXDEV','EOPNOTSUPP'];
const LOCKED_CODES=['EEXIST','EPERM','EACCES','EBUSY'];
// Creates `file` with `content` so that it is never visible empty or half written: the content goes to a temporary name first
// and is then hard-linked into place (link fails if the target exists). A file system without hard links falls back to
// exclusive create. true: created. false: the file exists. Otherwise the error (EPERM/EACCES/EBUSY).
function createFileAtomically(file,content){
  const tmp=`${file}.${hex(6)}.tmp`;
  try{fs.writeFileSync(tmp,content,{flag:'wx',mode:0o600});}
  catch(e){if(LOCKED_CODES.includes(e.code))return e;throw e;}
  try{fs.linkSync(tmp,file);return true;}
  catch(e){
    if(e.code==='EEXIST')return false;
    if(NOT_SUPPORTED.includes(e.code)){
      try{const fd=fs.openSync(file,'wx');try{fs.writeSync(fd,content);}finally{fs.closeSync(fd);}return true;}
      catch(x){if(x.code==='EEXIST')return false;if(LOCKED_CODES.includes(x.code))return x;throw x;}
    }
    if(LOCKED_CODES.includes(e.code))return e;
    throw e;
  }finally{try{fs.unlinkSync(tmp);}catch{}}
}

const salts=new Map();
const SALT_FORMAT=/^[0-9a-f]{48}$/;
// A random per-install salt, created on first use next to the state. It is written atomically. The file is mode 0600 on POSIX;
// on Windows it takes the ACL of the folder it is in, which for the default folder under %LOCALAPPDATA% is the user's own
// profile. A folder you choose yourself with limiterDir / PATENT_RESEARCH_LIMITER_DIR gets no extra protection from the Hub.
export function limiterSalt(dir){
  if(salts.has(dir))return salts.get(dir);
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'salt');
  const created=createFileAtomically(file,randomBytes(24).toString('hex'));
  if(created instanceof Error)throw created;
  let value='';
  for(let i=0;i<5;i++){
    try{value=fs.readFileSync(file,'utf8').trim();break;}catch(e){if(e.code!=='ENOENT'&&i===4)throw e;pause(20);}
  }
  if(!SALT_FORMAT.test(value))throw new LimiterStateError(`The limiter salt file ${file} is empty or damaged. Stop all Hub processes (MCP server, gateway children, anything that imports the Hub), delete that file and try again.`);
  salts.set(dir,value);return value;
}
export function limiterId(provider,key,salt=''){return `${provider}-${createHash('sha256').update('prh-limiter\0'+salt+'\0'+provider+'\0'+String(key||'')).digest('hex').slice(0,16)}`;}
export const lockPath=(dir,provider,key)=>path.join(dir,limiterId(provider,key,limiterSalt(dir))+'.lock');

const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
// Three answers about a lock file: 'mine', 'other' (a different token or no file: the lock is lost) and 'unknown' (the read
// failed or the content is not readable yet: nothing is concluded from that).
function tokenState(file,token){
  let raw;
  try{raw=fs.readFileSync(file,'utf8');}catch(e){return e.code==='ENOENT'?'other':'unknown';}
  let j;try{j=JSON.parse(raw);}catch{return 'unknown';}
  return j&&j.token===token?'mine':'other';
}
function readLockInfo(file){try{const j=JSON.parse(fs.readFileSync(file,'utf8'));return {pid:j.pid,token:j.token??null};}catch{return {pid:null,token:null};}}
function staleness(file,staleMs){
  let st;try{st=fs.statSync(file);}catch{return {gone:true};}
  const age=Date.now()-st.mtimeMs,{pid,token}=readLockInfo(file);
  if(age>staleMs)return {stale:true,st,token};
  if(age>2000&&Number.isInteger(pid)&&pid!==process.pid&&!alive(pid))return {stale:true,st,token};
  return {stale:false};
}
// An expired takeover file (its owner crashed) is renamed to a unique name, checked to really be old, then deleted; a fresh one
// that we moved by mistake is put back.
function expireTakeover(mutex){
  try{
    if(Date.now()-fs.statSync(mutex).mtimeMs<=TAKEOVER_EXPIRY_MS)return;
    const aside=`${mutex}.${hex(6)}.stale`;
    fs.renameSync(mutex,aside);
    if(Date.now()-fs.statSync(aside).mtimeMs<=TAKEOVER_EXPIRY_MS){try{fs.linkSync(aside,mutex);}catch{}}
    fs.rmSync(aside,{force:true});
  }catch{}
}
// Removes a stale lock and creates ours, all while holding the exclusive takeover file, so two waiters cannot both break the
// same stale lock and both think they own the replacement. Returns true when the lock is now ours.
function takeOver(file,token,staleMs){
  const mutex=file+'.takeover';
  const got=createFileAtomically(mutex,JSON.stringify({pid:process.pid,token,at:Date.now()}));
  if(got!==true){expireTakeover(mutex);return false;}
  try{
    const s=staleness(file,staleMs);
    if(!s.gone){
      if(!s.stale)return false;                                            // refreshed or replaced meanwhile
      const aside=`${file}.stale.${hex(6)}`;
      try{fs.renameSync(file,aside);}catch(e){if(e.code!=='ENOENT')return false;}
      if(readLockInfo(aside).token!==s.token){                             // we moved a live lock after all: put it back
        try{fs.linkSync(aside,file);}catch{}
        try{fs.rmSync(aside,{force:true});}catch{}
        return false;
      }
      try{fs.rmSync(aside,{force:true});}catch{}
    }
    return createFileAtomically(file,JSON.stringify({pid:process.pid,token,at:Date.now()}))===true;
  }finally{
    // delete the takeover file only if it is still ours
    if(tokenState(mutex,token)==='mine'){try{fs.unlinkSync(mutex);}catch{}}
  }
}
// Only the Hub's own leftovers, by exact name, and only when old: <provider>-<16 hex>.json.<12 hex>.tmp, .lock.<12 hex>.tmp,
// .lock.takeover.<12 hex>.tmp, .lock.stale.<12 hex>, .lock.takeover.<12 hex>.stale and salt.<12 hex>.tmp. Nothing else in the
// folder is touched, whatever its extension.
const OWN_LEFTOVER=/^(?:[a-z]+-[0-9a-f]{16}\.(?:json\.[0-9a-f]{12}\.tmp|lock\.[0-9a-f]{12}\.tmp|lock\.takeover\.[0-9a-f]{12}\.tmp|lock\.stale\.[0-9a-f]{12}|lock\.takeover\.[0-9a-f]{12}\.stale)|salt\.[0-9a-f]{12}\.tmp)$/;
function sweep(dir){
  try{
    const cutoff=Date.now()-60000;
    for(const name of fs.readdirSync(dir)){
      if(!OWN_LEFTOVER.test(name))continue;
      try{const p=path.join(dir,name);if(fs.statSync(p).mtimeMs<cutoff)fs.rmSync(p,{force:true});}catch{}
    }
  }catch{}
}
// Returns the lock ({release, confirm, lost}) or null when the deadline passes first. Throws the real error when the lock file
// cannot be created for a reason other than another holder (for example a folder the account cannot write to).
async function acquire(file,{staleMs,deadline,dir}){
  sweep(dir);
  const token=hex(12);
  let denied=0;
  for(;;){
    const made=createFileAtomically(file,JSON.stringify({pid:process.pid,token,at:Date.now()}));
    if(made===true)break;
    const s=staleness(file,staleMs);
    if(made!==false&&s.gone){if(++denied>=100)throw made;}else denied=0;
    if(s.stale&&takeOver(file,token,staleMs))break;
    if(Date.now()>=deadline)return null;                   // a failed takeover waits like any other failed attempt
    await realSleep(20+Math.floor(Math.random()*40));
  }
  const lock={lost:false};
  // 'mine' | 'lost' | 'unknown'; an unreadable file is retried a few times and never counts as loss
  const check=()=>{
    for(let i=0;i<5;i++){const s=tokenState(file,token);if(s==='mine')return 'mine';if(s==='other')return 'lost';pause(30);}
    return 'unknown';
  };
  const beat=setInterval(()=>{
    try{
      const s=tokenState(file,token);
      if(s==='other'){lock.lost=true;clearInterval(beat);return;}
      const now=new Date();fs.utimesSync(file,now,now);              // also when the read was unknown: keep the lock fresh
    }catch{}
  },Math.max(200,Math.min(5000,Math.floor(staleMs/3))));
  beat.unref?.();
  // Refresh the lock and confirm it is still ours. True only when it certainly is.
  lock.confirm=()=>{
    if(lock.lost)return false;
    try{const now=new Date();fs.utimesSync(file,now,now);}catch{}
    const s=check();
    if(s==='lost')lock.lost=true;
    return s==='mine';
  };
  lock.release=()=>{
    clearInterval(beat);
    for(let i=0;i<6;i++){
      const s=tokenState(file,token);
      if(s==='other')return;                                       // gone, or somebody else's now
      if(s==='mine'){try{fs.unlinkSync(file);return;}catch(e){if(e.code==='ENOENT')return;}}
      pause(30);                                                   // unknown or a failed delete: try again
    }
  };
  return lock;
}

const emptyState=()=>({requests:[],lastStartAt:0,cooldownUntil:0,consecutive429:0});
// Only a missing file is an empty state. Other read errors are retried, then reported; a damaged file is reported, not ignored.
// A zero-length file (a write that did not reach the disk before a crash) is not trusted either way: it becomes the cautious
// state "no calls left this hour and a 5 s cooldown" (see `reset`), so it neither blocks the key forever nor opens it wide.
function loadState(file){
  let raw;
  for(let i=0;;i++){
    try{raw=fs.readFileSync(file,'utf8');break;}
    catch(e){if(e.code==='ENOENT')return emptyState();if(i>=4)throw new LimiterStateError(`The limiter state file ${file} cannot be read (${e.code||'error'}).`);pause(30);}
  }
  if(raw.trim()==='')return {...emptyState(),reset:true};
  let s;try{s=JSON.parse(raw);}catch{throw new LimiterStateError(`The limiter state file ${file} is damaged; delete it (no Hub process may be running) and try again.`);}
  if(!s||typeof s!=='object')throw new LimiterStateError(`The limiter state file ${file} is damaged; delete it and try again.`);
  return {requests:Array.isArray(s.requests)?s.requests.filter(Number.isFinite):[],lastStartAt:Number(s.lastStartAt)||0,cooldownUntil:Number(s.cooldownUntil)||0,consecutive429:Number(s.consecutive429)||0};
}
function saveState(file,state){
  const tmp=`${file}.${hex(6)}.tmp`;
  try{
    const fd=fs.openSync(tmp,'w');
    try{fs.writeSync(fd,JSON.stringify({requests:state.requests,lastStartAt:state.lastStartAt,cooldownUntil:state.cooldownUntil,consecutive429:state.consecutive429}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
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
        if(state.reset){                                          // zero-length state file: cautious defaults
          if(max>0)state.requests=Array(max).fill(now);
          state.cooldownUntil=Math.max(state.cooldownUntil,now+MIN_429_WAIT_MS);
        }
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
        if(!lock.confirm())return LOST;                           // lost the lock while waiting: write nothing, queue again
        saveState(stateFile,state);
        const slot={rl:null,rateLimited(header){this.rl=parseRetryAfterMs(header);}};
        let threw=true;
        try{const result=await fn(slot);threw=false;return {result};}
        finally{
          if(slot.rl!==null){state.consecutive429+=1;state.cooldownUntil=Date.now()+cooldownMs(state.consecutive429,slot.rl);}
          else if(!threw)state.consecutive429=0;
          if(lock.confirm())saveState(stateFile,state);            // never overwrite newer state after losing the lock
          else if(slot.rl!==null)throw new LimiterStateError('The lock was lost during the call, so the HTTP 429 cooldown could not be recorded safely.');
        }
      });
      if(outcome!==LOST)return outcome.result;
    }finally{lock.release();}
  }
}
