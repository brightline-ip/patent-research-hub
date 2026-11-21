// Limit settings are validated loudly; the limiter folder is one per-user location; hardening of small lookups and parsing.
import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {readConfig,effectiveLimits,limiterDir,configDefaults} from '../src/config.mjs';
import {directGateway} from '../src/direct.mjs';
import {selectOaAdapter,oaAdapters} from '../src/oa-adapter.mjs';
import {childSetup,runChild,searchRequest,okSearch,scratchFolder,repo} from './helpers/gateway-child.mjs';

const configWith=obj=>{const dir=scratchFolder('prh-cfg-'),file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(obj));return {env:{PATENT_RESEARCH_CONFIG:file}};};
const reads=obj=>readConfig(configWith(obj));

test('limit settings that are not finite, non-negative numbers fail loudly (a "1s" must not switch pacing off)',()=>{
  for(const bad of [{directMinIntervalMs:{uspto:'1s'}},{directMinIntervalMs:{uspto:-1}},{directMinIntervalMs:{uspto:null}},{directMinIntervalMs:'1s'},{directMinIntervalMs:[1000]},
    {maxRequestsPerHour:{uspto:'many'}},{maxRequestsPerHour:{uspto:-5}},{maxRequestsPerHour:{uspto:1.5}},{maxRequestsPerHour:{uspto:null}},{maxRequestsPerHour:5},
    {limiterStaleLockMs:'30s'},{limiterStaleLockMs:1000},{limiterStaleLockMs:null},{limiterMaxWaitMs:'20m'},{limiterMaxWaitMs:-1},{limiterMaxWaitMs:null}])
    assert.throws(()=>reads(bad),/config\.json: \w+/,JSON.stringify(bad));
  assert.throws(()=>effectiveLimits({directMinIntervalMs:{uspto:NaN}}),/directMinIntervalMs\.uspto/);
  assert.throws(()=>effectiveLimits({limiterStaleLockMs:Infinity}),/limiterStaleLockMs/);
  assert.equal(reads({directMinIntervalMs:{uspto:0},maxRequestsPerHour:{uspto:0},limiterStaleLockMs:5000,limiterMaxWaitMs:0}).limiterStaleLockMs,5000);
  assert.equal(effectiveLimits({}).providers.uspto.maxRequestsPerHour,1800);
});

test('the direct transport refuses to run with an invalid limit instead of ignoring it',async()=>{
  const e=await directGateway('oa-rejections',{application_numbers:['17000001']},{config:{directMinIntervalMs:{uspto:'1s'}},env:{USPTO_API_KEY:'fixture'},fetchImpl:async()=>{throw new Error('must not be called');}}).then(()=>null,x=>x);
  assert.match(e?.message,/directMinIntervalMs\.uspto/);
});

test('the limiter folder is one per-user location: not under the data folder, install folder or config',()=>{
  const url=new URL('../src/config.mjs',import.meta.url).href;
  const code="import('"+url+"').then(m=>console.log(JSON.stringify([m.limiterDir({}),m.limiterDir({dataDir:'C:/somewhere/else'}),m.limiterDir({dataDir:'other'},{PATENT_RESEARCH_DATA_DIR:'C:/elsewhere'}),m.limiterDir({limiterDir:'C:/explicit'})])))";
  const base=scratchFolder('prh-home-'),env={...process.env,LOCALAPPDATA:base,XDG_STATE_HOME:base,HOME:base,USERPROFILE:base};
  delete env.PATENT_RESEARCH_LIMITER_DIR;delete env.PATENT_RESEARCH_DATA_DIR;
  const r=spawnSync(process.execPath,['-e',code],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const [plain,otherData,otherEnv,explicit]=JSON.parse(r.stdout);
  const expected=process.platform==='win32'?path.join(base,'PatentResearchHub','limiter'):path.join(base,'patent-research-hub','limiter');
  assert.equal(plain,expected);assert.equal(otherData,expected);assert.equal(otherEnv,expected);assert.equal(explicit,path.resolve('C:/explicit'));
  const forced=spawnSync(process.execPath,['-e',code],{env:{...env,PATENT_RESEARCH_LIMITER_DIR:path.join(base,'forced')},encoding:'utf8'});
  assert.equal(JSON.parse(forced.stdout)[0],path.join(base,'forced'));
  assert.equal(configDefaults.limiterDir,'');
});

test('gateway --limits reports exactly what the direct transport enforces, including the limiter folder',async()=>{
  const s=childSetup({config:{directMinIntervalMs:{uspto:250},maxRequestsPerHour:{uspto:77,epo:0},limiterMaxWaitMs:90000,limiterStaleLockMs:7000}});
  const r=await runChild(s,{args:['--limits']});
  assert.equal(r.code,0,r.stderr);
  const e=effectiveLimits(readConfig({env:{PATENT_RESEARCH_CONFIG:s.configFile}}));
  const shown=Object.fromEntries(Object.entries(r.json.providers).map(([k,v])=>[k,[v.max_calls_per_hour,v.min_interval_ms]]));
  const enforced=Object.fromEntries(Object.entries(e.providers).map(([k,v])=>[k,[v.maxRequestsPerHour,v.minIntervalMs]]));
  assert.deepEqual(shown,enforced);
  assert.equal(r.json.providers.uspto.min_interval_ms,250);assert.equal(r.json.providers.epo.max_calls_per_hour,0);
  assert.equal(r.json.limiter_max_wait_ms,90000);assert.equal(r.json.limiter_stale_lock_ms,7000);assert.equal(r.json.limiter_dir,path.join(s.data,'limiter'));
  assert.match(r.json.note,/calls/);
  const bad=childSetup({config:{directMinIntervalMs:{uspto:'1s'}}});
  const failed=await runChild(bad,{args:['--limits']});assert.equal(failed.code,1);assert.match(failed.json.error.message,/directMinIntervalMs\.uspto/);
});

test('lookups by name cannot reach inherited properties',async()=>{
  for(const source of ['constructor','toString','__proto__','hasOwnProperty'])
    await assert.rejects(directGateway('reference-index',{source},{config:{},env:{},fetchImpl:async()=>{throw new Error('must not be called');}}),/Unknown official reference index/,source);
  for(const id of ['constructor','toString','__proto__'])assert.throws(()=>selectOaAdapter({oaRejectionsAdapter:id}),/Unknown oaRejectionsAdapter/,id);
  assert.equal(Object.hasOwn(oaAdapters,'legacy-rejections-v2'),true);
});

test('an empty docs list with numFound above zero is accepted only for a start beyond the results (the requested start, not the body\'s)',async()=>{
  const body={response:{numFound:5,start:5,docs:[]}};
  const call=start=>directGateway('oa-rejections',{application_numbers:['17000001'],start},{config:{directMinIntervalMs:{uspto:0}},env:{USPTO_API_KEY:'fixture'},limiterDir:scratchFolder(),fetchImpl:async()=>new Response(JSON.stringify(body),{status:200})});
  assert.equal((await call(5)).status,200);assert.equal((await call(9)).status,200);
  assert.equal((await call(0)).status,502);assert.equal((await call(4)).status,502);   // the body claims start 5, but 0 was asked for
});

test('a request on stdin that starts with a byte order mark is accepted',async()=>{
  const s=childSetup({rules:[{match:'/applications/search',status:200,body:okSearch}]});
  const r=await runChild(s,{input:'\uFEFF'+JSON.stringify(searchRequest)});
  assert.equal(r.code,0,r.stdout+r.stderr);assert.equal(r.json.status,200);
});

test('the gateway child stops by itself when the process that started it disappears',{timeout:60000},async()=>{
  const s=childSetup({rules:[{match:'/applications/search',status:200,delayMs:120000,body:okSearch}]});
  const script="const {spawn}=require('node:child_process');const c=spawn(process.execPath,["+JSON.stringify(path.join(repo,'src','cli.mjs'))+",'gateway','uspto','--json-in'],{stdio:['pipe','ignore','ignore']});c.stdin.end("+JSON.stringify(JSON.stringify(searchRequest))+");console.log(c.pid);setInterval(()=>{},1000);";
  const p=spawn(process.execPath,['-e',script],{env:s.env,stdio:['ignore','pipe','ignore'],windowsHide:true});
  let out='';p.stdout.on('data',d=>out+=d);
  for(let i=0;i<100&&!/\d+\s/.test(out);i++)await new Promise(r=>setTimeout(r,100));
  const childPid=Number(out.trim());assert.ok(childPid>0,'child pid not reported');
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
  await new Promise(r=>setTimeout(r,1500));assert.ok(alive(childPid),'the child should be running');
  p.kill('SIGKILL');
  let gone=false;for(let i=0;i<100&&!gone;i++){await new Promise(r=>setTimeout(r,200));gone=!alive(childPid);}
  assert.ok(gone,'the gateway child outlived its parent');
});

test('a relative limiter folder is refused (in the config file, the environment and the function)',()=>{
  assert.throws(()=>reads({limiterDir:'limiter'}),/limiterDir must be an absolute path/);
  assert.throws(()=>reads({limiterDir:42}),/limiterDir must be an absolute path/);
  assert.throws(()=>limiterDir({},{PATENT_RESEARCH_LIMITER_DIR:'relative\\folder'}),/must be an absolute path/);
  // The config.limiterDir branch of limiterDir() itself, with the environment variable out of the way
  const saved=process.env.PATENT_RESEARCH_LIMITER_DIR;delete process.env.PATENT_RESEARCH_LIMITER_DIR;
  try{
    assert.throws(()=>limiterDir({limiterDir:'limiter'},{}),/limiterDir must be an absolute path/);
    assert.throws(()=>limiterDir({limiterDir:42},{}),/limiterDir must be an absolute path/);
    const inside=path.resolve(scratchFolder('prh-cfgdir-'));assert.equal(limiterDir({limiterDir:inside},{}),inside);
  }finally{process.env.PATENT_RESEARCH_LIMITER_DIR=saved;}
  const here=path.resolve(scratchFolder('prh-abs-'));
  assert.equal(reads({limiterDir:here}).limiterDir,here);assert.equal(limiterDir({limiterDir:here},{}),process.env.PATENT_RESEARCH_LIMITER_DIR?path.resolve(process.env.PATENT_RESEARCH_LIMITER_DIR):here);
});

test('an EPO token request answered with HTTP 429 starts the limiter cooldown like any other 429',async()=>{
  const limiterFolder=scratchFolder('prh-epo-'),waits=[];
  const o=fetchImpl=>({config:{directMinIntervalMs:{epo:0}},env:{EPO_OPS_CONSUMER_KEY:'fixture-consumer',EPO_OPS_CONSUMER_SECRET:'fixture-secret'},fetchImpl,limiterDir:limiterFolder,sleep:async ms=>waits.push(ms)});
  const body={source:'epo',url:'https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/EP1000000.A1/biblio',method:'GET'};
  const first=await directGateway('epo',body,o(async url=>String(url).includes('accesstoken')?new Response('slow down',{status:429,headers:{'retry-after':'40'}}):new Response('x',{status:200}))).then(()=>null,e=>e);
  assert.match(first?.message,/rate limited \(HTTP 429\); wait at least 40 s/);assert.equal(first.retryAfterSeconds,40);
  await directGateway('epo',body,o(async url=>String(url).includes('accesstoken')?new Response('{"access_token":"t","expires_in":"1200"}',{status:200}):new Response('<x/>',{status:200}))).catch(()=>{});
  assert.ok(waits.length>=1&&waits[0]>35000,'the next call did not wait for the 429 cooldown: '+waits);
});

test('on Windows the limiter folder needs a drive letter: rooted paths without one and network paths are refused',{skip:process.platform!=='win32'&&'Windows path rules'},()=>{
  for(const bad of ['\folder','\\server\share\limiter','C:folder','/folder'])
    assert.throws(()=>limiterDir({},{PATENT_RESEARCH_LIMITER_DIR:bad}),/absolute path.*drive letter/,bad);
  const saved=process.env.PATENT_RESEARCH_LIMITER_DIR;delete process.env.PATENT_RESEARCH_LIMITER_DIR;
  try{for(const bad of ['\folder','\\server\share\limiter'])assert.throws(()=>limiterDir({limiterDir:bad},{}),/drive letter/,bad);}finally{process.env.PATENT_RESEARCH_LIMITER_DIR=saved;}
  assert.throws(()=>reads({limiterDir:'\\server\share\limiter'}),/drive letter/);
  assert.equal(limiterDir({},{PATENT_RESEARCH_LIMITER_DIR:'D:/limiter'}),path.resolve('D:/limiter'));
});
