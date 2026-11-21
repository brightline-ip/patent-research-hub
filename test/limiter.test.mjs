// Cross-process limiter: unit tests plus tests with several real Node processes sharing one data folder. The provider is a
// scripted fake fetch in each child (test/fixtures/mock-provider-preload.mjs); no network is used.
import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {withProviderSlot,limiterId,limiterSalt,lockPath,parseRetryAfterMs,cooldownMs,rateLimitWaitSeconds,LocalLimitError,LimiterBusyError} from '../src/limiter.mjs';
import {childSetup,runChild,searchRequest,okSearch,scratchFolder} from './helpers/gateway-child.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const okRule=(extra={})=>({match:'/applications/search',status:200,body:okSearch,...extra});
const overlaps=rows=>{const s=[...rows].sort((a,b)=>a.t0-b.t0);return s.some((x,i)=>i&&x.t0<s[i-1].t1);};

test('Retry-After and the 429 cooldown: at least 5 s, honour the header, double on repeats, capped',()=>{
  assert.equal(parseRetryAfterMs('7'),7000);assert.equal(parseRetryAfterMs(' 1.5 '),1500);assert.equal(parseRetryAfterMs(null),0);assert.equal(parseRetryAfterMs('garbage'),0);assert.equal(parseRetryAfterMs(''),0);
  const now=Date.parse('2026-11-20T10:00:00Z');assert.equal(parseRetryAfterMs('Fri, 20 Nov 2026 10:00:42 GMT',now),42000);assert.equal(parseRetryAfterMs('Fri, 20 Nov 2026 09:00:00 GMT',now),0);
  assert.equal(cooldownMs(1,0),5000);assert.equal(cooldownMs(1,1000),5000);assert.equal(cooldownMs(1,30000),30000);
  assert.deepEqual([1,2,3,4,5].map(n=>cooldownMs(n,0)),[5000,10000,20000,40000,80000]);
  assert.equal(cooldownMs(30,0),900000);                       // the doubling is capped at 15 minutes
  assert.equal(cooldownMs(1,1800000),1800000);assert.equal(cooldownMs(9,1800000),1800000);   // a longer Retry-After is honoured in full
  assert.equal(cooldownMs(1,99999999),86400000);                 // up to 24 hours
  assert.equal(rateLimitWaitSeconds(null),5);assert.equal(rateLimitWaitSeconds('12'),12);assert.equal(rateLimitWaitSeconds('2'),5);
});

test('limiter files are named by a truncated hash with a random per-install salt and never contain the key',async()=>{
  const dir=scratchFolder(),key='very-secret-key-value-123';
  await withProviderSlot({dir,provider:'uspto',key,max:5},async()=>1);
  const salt=limiterSalt(dir);assert.match(salt,/^[0-9a-f]{48}$/);assert.equal(limiterSalt(dir),salt);
  assert.ok(!limiterId('uspto',key,salt).includes('secret'));assert.notEqual(limiterId('uspto',key,salt),limiterId('uspto','other',salt));assert.notEqual(limiterId('uspto',key,salt),limiterId('epo',key,salt));assert.notEqual(limiterId('uspto',key,salt),limiterId('uspto',key,'another-install'));
  assert.ok(!fs.readFileSync(path.join(dir,'salt'),'utf8').includes(key));
  for(const f of fs.readdirSync(dir)){assert.ok(!f.includes('secret'));assert.ok(!fs.readFileSync(path.join(dir,f),'utf8').includes(key));}
});

test('in one process, calls with the same key run one at a time and in order, and different keys do not wait for each other',async()=>{
  const dir=scratchFolder();let active=0,max=0;const order=[];
  const job=(name,key)=>withProviderSlot({dir,provider:'uspto',key},async()=>{active++;max=Math.max(max,active);order.push(name);await sleep(40);active--;});
  await Promise.all(['a','b','c','d','e'].map(n=>job(n,'k1')));
  assert.equal(max,1);assert.equal(order.length,5);
  active=0;max=0;await Promise.all([job('x','k1'),job('y','k2')]);assert.equal(max,2);
});

test('a call made while holding the same key (token request inside an API call) does not deadlock',async()=>{
  const dir=scratchFolder();
  const r=await withProviderSlot({dir,provider:'epo',key:'k'},async()=>withProviderSlot({dir,provider:'epo',key:'k'},async()=>'inner'));
  assert.equal(r,'inner');
});

test('the hourly cap fails with local_limit and a stated wait only when it is used up; expired entries free it',async()=>{
  const dir=scratchFolder(),opts={dir,provider:'uspto',key:'k',max:2};
  await withProviderSlot(opts,async()=>1);await withProviderSlot(opts,async()=>1);
  const e=await withProviderSlot(opts,async()=>1).then(()=>null,x=>x);
  assert.ok(e instanceof LocalLimitError);assert.equal(e.code,'local_limit');assert.equal(e.limit,2);assert.ok(e.retryAfterSeconds>3500&&e.retryAfterSeconds<=3600);assert.match(e.message,/Wait about \d+ minute\(s\)/);
  const file=path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  state.requests=state.requests.map(t=>t-3601000);fs.writeFileSync(file,JSON.stringify(state));
  assert.equal(await withProviderSlot(opts,async()=>'again'),'again');
  assert.equal(await withProviderSlot({...opts,max:0},async()=>'unlimited'),'unlimited');
});

test('a 429 starts a cooldown the next call waits out; consecutive 429s double it; success resets it',async()=>{
  const dir=scratchFolder(),waits=[],opts={dir,provider:'uspto',key:'k',sleep:async ms=>{waits.push(ms);}};
  await withProviderSlot(opts,async slot=>slot.rateLimited('1'));
  await withProviderSlot(opts,async slot=>slot.rateLimited(null));
  await withProviderSlot(opts,async()=>'ok');
  await withProviderSlot(opts,async()=>'ok');
  assert.equal(waits.length,3);
  assert.ok(waits[0]>4500&&waits[0]<=5000,'first wait '+waits[0]);
  assert.ok(waits[1]>9500&&waits[1]<=10000,'second wait doubles: '+waits[1]);
  assert.ok(waits[2]>=0);
  const state=JSON.parse(fs.readFileSync(path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json'),'utf8'));assert.equal(state.consecutive429,0);
});

test('a wait longer than limiterMaxWaitMs fails with local_busy and says how long, instead of hanging',async()=>{
  const dir=scratchFolder(),opts={dir,provider:'uspto',key:'k',sleep:async()=>{}};
  await withProviderSlot(opts,async slot=>slot.rateLimited('60'));
  const e=await withProviderSlot({...opts,maxWaitMs:2000},async()=>1).then(()=>null,x=>x);
  assert.ok(e instanceof LimiterBusyError);assert.equal(e.code,'local_busy');assert.ok(e.retryAfterSeconds>50);assert.match(e.message,/cooldown/);
});

test('a lock held by a live process is waited for and then used; a lock left by a dead process is taken over',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'other',at:Date.now()}));
  const released=sleep(600).then(()=>fs.unlinkSync(lock));
  const t0=Date.now();await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);await released;
  assert.ok(Date.now()-t0>=550,'did not wait for the holder');
  // dead holder: a finished child's pid, lock file a few seconds old
  const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout;
  fs.writeFileSync(lock,JSON.stringify({pid:Number(dead),token:'dead',at:Date.now()}));fs.utimesSync(lock,new Date(Date.now()-5000),new Date(Date.now()-5000));
  const t1=Date.now();await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);assert.ok(Date.now()-t1<1500,'dead holder was not taken over');
  assert.ok(!fs.existsSync(lock),'lock released');
  // untouched for longer than the stale timeout, even with a live pid (a hung holder)
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'hung',at:Date.now()}));fs.utimesSync(lock,new Date(Date.now()-60000),new Date(Date.now()-60000));
  await withProviderSlot({dir,provider:'uspto',key:'k',staleMs:30000},async()=>1);assert.ok(!fs.existsSync(lock));
  // a lock that is not stale and not abandoned: the caller waits only as long as it is willing to
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'busy',at:Date.now()}));
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:300},async()=>1).then(()=>null,x=>x);
  assert.equal(e?.code,'local_busy');fs.unlinkSync(lock);
});

test('releasing never removes a lock that another process has since taken',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k');
  await withProviderSlot({dir,provider:'uspto',key:'k',staleMs:30000},async()=>{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'someone-else',at:Date.now()}));});
  assert.ok(fs.existsSync(lock),'a foreign lock must survive our release');
});

// ---- several real processes sharing one data folder ----

test('processes at the same key run strictly one at a time (burst 1)',async()=>{
  const s=childSetup({rules:[okRule({delayMs:200})]});
  const runs=await Promise.all(Array.from({length:6},()=>runChild(s,{input:searchRequest})));
  assert.deepEqual(runs.map(r=>r.code),[0,0,0,0,0,0],runs.map(r=>r.stdout+r.stderr).join('\n'));
  const rows=s.requests();assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.pid)).size,6,'six different processes');
  assert.equal(overlaps(rows),false,'two calls overlapped: '+JSON.stringify(rows.map(r=>[r.t0,r.t1])));
});

test('processes at different keys do not wait for each other',async()=>{
  const s=childSetup({rules:[okRule({delayMs:600})]});
  const runs=await Promise.all([runChild(s,{input:searchRequest,env:{USPTO_API_KEY:'key-one-fixture'}}),runChild(s,{input:searchRequest,env:{USPTO_API_KEY:'key-two-fixture'}})]);
  assert.deepEqual(runs.map(r=>r.code),[0,0]);assert.equal(overlaps(s.requests()),true,'independent keys should run in parallel');
});

test('the minimum spacing between calls holds across processes',async()=>{
  const s=childSetup({config:{directMinIntervalMs:{uspto:400}},rules:[okRule()]});
  const runs=await Promise.all(Array.from({length:3},()=>runChild(s,{input:searchRequest})));
  assert.deepEqual(runs.map(r=>r.code),[0,0,0]);
  const t=s.requests().map(r=>r.t0).sort((a,b)=>a-b);
  assert.ok(t[1]-t[0]>=350&&t[2]-t[1]>=350,'gaps '+[t[1]-t[0],t[2]-t[1]]);
});

test('the hourly cap is shared by processes: the extra ones fail with local_limit and never call the provider',async()=>{
  const s=childSetup({config:{maxRequestsPerHour:{uspto:2}},rules:[okRule({delayMs:50})]});
  const runs=await Promise.all(Array.from({length:5},()=>runChild(s,{input:searchRequest})));
  const codes=runs.map(r=>r.code).sort();assert.deepEqual(codes,[0,0,75,75,75]);
  for(const r of runs.filter(x=>x.code===75)){assert.equal(r.json.error.code,'local_limit');assert.ok(r.json.error.retry_after_seconds>3000);}
  assert.equal(s.requests().length,2);
  // a later process, a new minute: still exhausted until the hour passes
  assert.equal((await runChild(s,{input:searchRequest})).code,75);
});

test('after an HTTP 429 in one process, another process waits out the cooldown instead of calling at once',async()=>{
  const s=childSetup({config:{limiterMaxWaitMs:1500},rules:[okRule({status:429,headers:{'retry-after':'1'},body:{code:429,message:'Too Many Requests'},times:1}),okRule()]});
  const first=await runChild(s,{input:searchRequest});
  assert.equal(first.json.status,429);assert.ok(first.json.retryAfterSeconds>=5);
  const second=await runChild(s,{input:searchRequest});   // patience (1.5 s) is shorter than the 5 s cooldown
  assert.equal(second.code,75);assert.equal(second.json.error.code,'local_busy');assert.ok(second.json.error.retry_after_seconds>=3);assert.match(second.json.error.message,/429 cooldown/);
  assert.equal(s.requests().length,1,'no second request while cooling down');
});

test('a waiting process does not throw: it sleeps until the cooldown ends, then calls',async()=>{
  const s=childSetup({rules:[okRule()]});
  const dir=path.join(s.data,'limiter');fs.mkdirSync(dir,{recursive:true});const id=limiterId('uspto','fixture-key-for-child-tests',limiterSalt(dir));
  const until=Date.now()+1500;fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({requests:[],lastStartAt:0,cooldownUntil:until,consecutive429:1}));
  const r=await runChild(s,{input:searchRequest});
  assert.equal(r.code,0,r.stdout+r.stderr);assert.ok(s.requests()[0].t0>=until-50,'called before the cooldown ended');
});

test('a holder that dies mid-call does not block the key forever',async()=>{
  const s=childSetup({rules:[okRule({delayMs:60000})]});
  const hung=runChild(s,{input:searchRequest,hold:true});
  const lock=lockPath(path.join(s.data,'limiter'),'uspto','fixture-key-for-child-tests');
  for(let i=0;i<100&&!fs.existsSync(lock);i++)await sleep(50);
  assert.ok(fs.existsSync(lock),'the first process should hold the lock');
  hung.child.kill('SIGKILL');await hung.done;
  assert.ok(fs.existsSync(lock),'a killed process leaves its lock behind');
  const s2={...s,env:{...s.env,PRH_MOCK_RULES:JSON.stringify([okRule()])}};
  const t0=Date.now(),r=await runChild(s2,{input:searchRequest});
  assert.equal(r.code,0,r.stdout+r.stderr);assert.ok(Date.now()-t0<15000);
});

test('a long call keeps its lock fresh, so a waiter does not take it over while the call is still running',async()=>{
  const s=childSetup({config:{limiterStaleLockMs:5000},rules:[okRule()]});      // 5000 is the smallest accepted setting
  const a=runChild(s,{input:searchRequest,hold:true,env:{PRH_MOCK_RULES:JSON.stringify([okRule({delayMs:7500})])}});
  await sleep(700);
  const b=runChild(s,{input:searchRequest});
  const [ra,rb]=await Promise.all([a.done,b]);
  assert.deepEqual([ra.code,rb.code],[0,0]);assert.equal(overlaps(s.requests()),false,'the waiter took the lock while the first call was still running');
});

// ---- review fixes: state errors, lost locks, sweeping, takeover mutex ----

test('a damaged or unreadable state file is an error (local_state), not an empty state',async()=>{
  const dir=scratchFolder(),opts={dir,provider:'uspto',key:'k'},state=path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json');
  fs.writeFileSync(state,'{not json');
  const damaged=await withProviderSlot(opts,async()=>1).then(()=>null,e=>e);
  assert.equal(damaged?.code,'local_state');assert.match(damaged.message,/damaged/);
  fs.rmSync(state);fs.mkdirSync(state);                       // reading a directory fails with EISDIR, not ENOENT
  const unreadable=await withProviderSlot(opts,async()=>1).then(()=>null,e=>e);
  assert.equal(unreadable?.code,'local_state');assert.match(unreadable.message,/cannot be read/);
  fs.rmdirSync(state);assert.equal(await withProviderSlot(opts,async()=>'fine'),'fine');   // a missing file is simply empty
});

test('if the 429 cooldown cannot be saved the call fails instead of carrying on',async()=>{
  const dir=scratchFolder(),state=path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json');
  const e=await withProviderSlot({dir,provider:'uspto',key:'k'},async slot=>{fs.rmSync(state,{force:true});fs.mkdirSync(state);slot.rateLimited('9');return 'sent';}).then(()=>null,x=>x);
  assert.equal(e?.code,'local_state');assert.match(e.message,/could not be saved/);
  fs.rmdirSync(state);
});

test('a holder that has lost its lock neither overwrites newer state nor releases the successor\'s lock, and says so if a 429 cannot be recorded',async()=>{
  const dir=scratchFolder(),id=limiterId('uspto','k',limiterSalt(dir)),lock=path.join(dir,id+'.lock'),state=path.join(dir,id+'.json');
  const newer={requests:[],lastStartAt:1,cooldownUntil:123456789,consecutive429:7};
  const r=await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>{
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'successor',at:Date.now()}));fs.writeFileSync(state,JSON.stringify(newer));return 'done';
  });
  assert.equal(r,'done');assert.deepEqual(JSON.parse(fs.readFileSync(state,'utf8')),newer);assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).token,'successor');
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:200},async()=>1).then(()=>null,x=>x);assert.equal(e?.code,'local_busy');   // the successor's lock still stands
  fs.unlinkSync(lock);
  const lost=await withProviderSlot({dir,provider:'uspto',key:'k'},async slot=>{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'successor2',at:Date.now()}));slot.rateLimited('5');}).then(()=>null,x=>x);
  assert.equal(lost?.code,'local_state');assert.match(lost.message,/lock was lost/);fs.unlinkSync(lock);
});

test('if the lock is taken over while a caller waits for its turn, the caller queues again instead of sending',async()=>{
  const dir=scratchFolder(),id=limiterId('uspto','k',limiterSalt(dir)),lock=path.join(dir,id+'.lock'),state=path.join(dir,id+'.json');
  fs.writeFileSync(state,JSON.stringify({requests:[],lastStartAt:0,cooldownUntil:Date.now()+300,consecutive429:1}));
  let calls=0,foreignReleased=0;
  const out=await withProviderSlot({dir,provider:'uspto',key:'k',sleep:async()=>{
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'taker',at:Date.now()}));        // somebody replaced our lock during the wait
    setTimeout(()=>{foreignReleased=Date.now();fs.unlinkSync(lock);},400);
  }},async()=>{calls++;assert.ok(foreignReleased>0&&Date.now()>=foreignReleased,'sent while the other holder still held the lock');return 'sent';});
  assert.equal(out,'sent');assert.equal(calls,1);
});

test('a lock file that can never be created (permission problem) fails with the real error, not "busy" after 20 minutes',async()=>{
  const dir=scratchFolder(),real=fs.linkSync;
  fs.linkSync=(src,dest)=>{if(String(dest).endsWith('.lock'))throw Object.assign(new Error('denied'),{code:'EACCES'});return real(src,dest);};
  try{
    const t0=Date.now(),e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:600000},async()=>1).then(()=>null,x=>x);
    assert.equal(e?.code,'EACCES');assert.ok(Date.now()-t0<30000);
  }finally{fs.linkSync=real;}
});

test('a stuck takeover file expires on its own and does not block a takeover for good',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k'),old=new Date(Date.now()-120000);
  fs.writeFileSync(lock,JSON.stringify({pid:999999,token:'dead',at:0}));fs.utimesSync(lock,old,old);
  fs.writeFileSync(lock+'.takeover','x');fs.utimesSync(lock+'.takeover',new Date(Date.now()-60000),new Date(Date.now()-60000));
  const t0=Date.now();assert.equal(await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>'ok'),'ok');assert.ok(Date.now()-t0<3000);
  assert.ok(!fs.existsSync(lock+'.takeover'));
});

test('the Retry-After of a long ban is honoured in full (up to 24 hours), not cut to 15 minutes',async()=>{
  const dir=scratchFolder(),waits=[];
  await withProviderSlot({dir,provider:'uspto',key:'k'},async slot=>slot.rateLimited('7200'));
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:1000,sleep:async ms=>waits.push(ms)},async()=>1).then(()=>null,x=>x);
  assert.equal(e?.code,'local_busy');assert.ok(e.retryAfterSeconds>7100,'reported wait '+e.retryAfterSeconds);
});

// ---- second review round ----

test('a read of the lock file that merely fails once is not "lost": the heartbeat goes on and a 429 cooldown is still recorded',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k'),real=fs.readFileSync;let armed=false,failed=0;
  fs.readFileSync=(p,...a)=>{if(armed&&failed<1&&String(p)===lock){failed++;throw Object.assign(new Error('busy'),{code:'EBUSY'});}return real(p,...a);};
  try{
    await withProviderSlot({dir,provider:'uspto',key:'k',staleMs:5000},async slot=>{armed=true;await sleep(2300);slot.rateLimited('9');});   // the heartbeat runs at 1.7 s
  }finally{fs.readFileSync=real;}
  assert.equal(failed,1,'the injected read error should have hit the heartbeat');
  const state=JSON.parse(fs.readFileSync(path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json'),'utf8'));
  assert.equal(state.consecutive429,1);assert.ok(state.cooldownUntil>Date.now());
});

test('a holder that lost its lock while waiting writes nothing: the successor\'s cooldown survives and the call is not sent or counted',async()=>{
  const dir=scratchFolder(),id=limiterId('uspto','k',limiterSalt(dir)),lock=path.join(dir,id+'.lock'),state=path.join(dir,id+'.json');
  fs.writeFileSync(state,JSON.stringify({requests:[],lastStartAt:0,cooldownUntil:Date.now()+200,consecutive429:1}));
  const newer={requests:[],lastStartAt:5,cooldownUntil:Date.now()+3600000,consecutive429:4};
  let seen=null,calls=0;
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:3000,sleep:async()=>{
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token:'successor',at:Date.now()}));fs.writeFileSync(state,JSON.stringify(newer));
    setTimeout(()=>{seen=JSON.parse(fs.readFileSync(state,'utf8'));fs.unlinkSync(lock);},300);
  }},async()=>{calls++;}).then(()=>null,x=>x);
  assert.deepEqual(seen,newer,'the successor\'s state was overwritten');
  assert.equal(calls,0);assert.equal(e?.code,'local_busy');            // queued again, and the 1 hour cooldown now applies
});

test('a failed takeover waits instead of spinning: the event loop stays free while a fresh takeover file blocks it',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k'),old=new Date(Date.now()-120000);
  fs.writeFileSync(lock,JSON.stringify({pid:999999,token:'dead',at:0}));fs.utimesSync(lock,old,old);
  fs.writeFileSync(lock+'.takeover',JSON.stringify({pid:999999,token:'crashed',at:Date.now()}));      // left by a crashed process just now
  let last=Date.now(),maxGap=0;const t=setInterval(()=>{const n=Date.now();maxGap=Math.max(maxGap,n-last);last=n;},10);
  await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);
  clearInterval(t);
  assert.ok(maxGap<500,'the event loop was blocked for '+maxGap+' ms');
  // and with a deadline it gives up on time instead of looping forever
  fs.writeFileSync(lock,JSON.stringify({pid:999999,token:'dead',at:0}));fs.utimesSync(lock,old,old);fs.writeFileSync(lock+'.takeover',JSON.stringify({pid:1,token:'x',at:Date.now()}));
  const t0=Date.now(),e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:600},async()=>1).then(()=>null,x=>x);
  assert.equal(e?.code,'local_busy');assert.ok(Date.now()-t0<2500);
});

test('the sweep touches only the Hub\'s own leftover names; other files with any extension stay',async()=>{
  const dir=scratchFolder();limiterSalt(dir);
  const old=new Date(Date.now()-300000),mk=(n,when=old)=>{const p=path.join(dir,n);fs.writeFileSync(p,'x');fs.utimesSync(p,when,when);return p;};
  const own=[mk('uspto-0123456789abcdef.json.0123456789ab.tmp'),mk('uspto-0123456789abcdef.lock.stale.0123456789ab'),mk('epo-0123456789abcdef.lock.0123456789ab.tmp'),mk('salt.0123456789ab.tmp')];
  const keep=[mk('quarterly-report.tmp'),mk('notes.stale.1'),mk('uspto-0123456789abcdef.json'),mk('x.json.abc123.tmp'),mk('uspto-0123456789abcdef.json.0123456789ab.tmp.bak'),mk('uspto-0123456789abcdef.json.fedcba987654.tmp',new Date())];
  await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);
  assert.deepEqual(own.map(p=>fs.existsSync(p)),[false,false,false,false]);assert.deepEqual(keep.map(p=>fs.existsSync(p)),[true,true,true,true,true,true]);
});

test('a takeover file that is not ours is never deleted by a failed takeover that is not yet expired',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k'),old=new Date(Date.now()-120000);
  fs.writeFileSync(lock,JSON.stringify({pid:999999,token:'dead',at:0}));fs.utimesSync(lock,old,old);
  const foreign=lock+'.takeover';fs.writeFileSync(foreign,JSON.stringify({pid:process.pid,token:'foreign',at:Date.now()}));
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',maxWaitMs:400},async()=>1).then(()=>null,x=>x);
  assert.equal(e?.code,'local_busy');assert.equal(JSON.parse(fs.readFileSync(foreign,'utf8')).token,'foreign');
});

test('lock files are created whole: written under a temporary name and hard-linked into place, never visible empty',async()=>{
  const dir=scratchFolder(),real=fs.linkSync,seen=[];
  fs.linkSync=(src,dest)=>{if(String(dest).endsWith('.lock'))seen.push(JSON.parse(fs.readFileSync(src,'utf8')));return real(src,dest);};
  try{await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);}finally{fs.linkSync=real;}
  assert.equal(seen.length,1);assert.equal(seen[0].pid,process.pid);assert.match(seen[0].token,/^[0-9a-f]{24}$/);
});

test('the lock is refreshed just before the call, so a long wait cannot leave it stale',async()=>{
  const dir=scratchFolder(),id=limiterId('uspto','k',limiterSalt(dir)),lock=path.join(dir,id+'.lock');
  fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({requests:[],lastStartAt:0,cooldownUntil:Date.now()+900,consecutive429:1}));
  let age=null;
  await withProviderSlot({dir,provider:'uspto',key:'k',staleMs:30000},async()=>{age=Date.now()-fs.statSync(lock).mtimeMs;});   // heartbeat is every 5 s: only the pre-send refresh can make this small
  assert.ok(age<400,'the lock was '+age+' ms old when the call started');
});

test('release retries a failed read of the lock file instead of leaving the lock behind',async()=>{
  const dir=scratchFolder(),lock=lockPath(dir,'uspto','k'),real=fs.readFileSync;let armed=false,failed=0;
  fs.readFileSync=(p,...a)=>{if(armed&&failed<2&&String(p)===lock){failed++;throw Object.assign(new Error('busy'),{code:'EBUSY'});}return real(p,...a);};
  try{await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>{armed=true;});}finally{fs.readFileSync=real;}
  assert.ok(failed>=1);assert.ok(!fs.existsSync(lock),'the lock was left behind');
});

test('an empty or damaged salt file is a clear error that says to stop all Hub processes first; a good one is written atomically',()=>{
  const dir=scratchFolder(),salt=path.join(dir,'salt');
  fs.writeFileSync(salt,'');
  assert.throws(()=>limiterSalt(path.join(dir)),/empty or damaged.*Stop all Hub processes/s);
  const dir2=scratchFolder();fs.writeFileSync(path.join(dir2,'salt'),'not-hex-at-all');
  assert.throws(()=>limiterSalt(dir2),/empty or damaged/);
  const dir3=scratchFolder(),real=fs.linkSync,linked=[];fs.linkSync=(s,d)=>{linked.push(String(d));return real(s,d);};
  try{assert.match(limiterSalt(dir3),/^[0-9a-f]{48}$/);}finally{fs.linkSync=real;}
  assert.ok(linked.some(x=>x.endsWith('salt')),'the salt must be linked into place');
});

test('a zero-length state file becomes cautious defaults: no calls left this hour with a cap, a 5 s cooldown without one',async()=>{
  const dir=scratchFolder(),state=path.join(dir,limiterId('uspto','k',limiterSalt(dir))+'.json');
  fs.writeFileSync(state,'');
  const e=await withProviderSlot({dir,provider:'uspto',key:'k',max:3},async()=>1).then(()=>null,x=>x);
  assert.equal(e?.code,'local_limit');
  fs.writeFileSync(state,'');const waits=[];
  assert.equal(await withProviderSlot({dir,provider:'uspto',key:'k',max:0,sleep:async ms=>waits.push(ms)},async()=>'ok'),'ok');
  assert.ok(waits.length===1&&waits[0]>4000&&waits[0]<=5000,'waits '+waits);
  fs.writeFileSync(state,'  \n');assert.equal(await withProviderSlot({dir,provider:'uspto',key:'k',max:0,sleep:async()=>{}},async()=>'ok'),'ok');   // never blocks for good
});

test('the state is flushed to disk before it replaces the old one',async()=>{
  const dir=scratchFolder(),real=fs.fsyncSync;let synced=0;
  fs.fsyncSync=fd=>{synced++;return real(fd);};
  try{await withProviderSlot({dir,provider:'uspto',key:'k'},async()=>1);}finally{fs.fsyncSync=real;}
  assert.ok(synced>=2);
});
