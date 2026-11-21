// `cli.mjs gateway <route> --json-in`: real child processes, global fetch replaced by a scripted fake. No network.
import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {childSetup,runChild,searchRequest,okSearch,scratchFolder} from './helpers/gateway-child.mjs';
import {GATEWAY_ROUTES} from '../src/gateway-routes.mjs';

const okRule={match:'/applications/search',status:200,body:okSearch};

test('a JSON request on stdin returns the provider envelope on stdout with exit 0, and nothing else is printed',async()=>{
  const s=childSetup({rules:[okRule]});
  const r=await runChild(s,{input:searchRequest});
  assert.equal(r.code,0,r.stdout+r.stderr);
  assert.equal(r.json.status,200);assert.equal(r.json.contentType,'application/json');assert.deepEqual(JSON.parse(r.json.text),okSearch);
  assert.equal(r.stderr,'');
  assert.deepEqual(s.requests().map(x=>[x.method,x.url,x.key]),[['POST',searchRequest.url,'fixture-key-for-child-tests']]);
  assert.ok(!r.stdout.includes('fixture-key-for-child-tests'),'the key must never be echoed');
  // The Hub store is not opened and nothing is retained: only the limiter folder exists (this test points it into the data folder).
  assert.deepEqual(fs.readdirSync(s.data),['limiter']);
});

test('the oa-rejections route works through the child and a provider 429 is a normal envelope, not a command failure',async()=>{
  const s=childSetup({rules:[{match:'/oa_rejections/v2/records',status:429,headers:{'retry-after':'30'},body:{code:429,message:'Too Many Requests'}}]});
  const r=await runChild(s,{args:['oa-rejections','--json-in'],input:{action:'records',application_numbers:['17000001']}});
  assert.equal(r.code,0);assert.equal(r.json.status,429);assert.ok(r.json.retryAfterSeconds>=30);
});

test('bad usage and bad requests exit 64 and never reach the provider',async()=>{
  const s=childSetup({rules:[okRule]});
  const cases=[
    [{args:['uspto']},'missing flag'],[{args:['--json-in']},'missing route'],[{args:['nope','--json-in'],input:'{}'},'unknown route'],
    [{args:['google-bigquery-query','--json-in'],input:'{}'},'cost-incurring route'],[{args:['model','--json-in'],input:'{}'},'n8n-only route'],
    [{args:['uspto','--json-in','--extra'],input:'{}'},'extra flag'],[{args:['uspto','--json-in','x'],input:'{}'},'extra argument'],
    [{input:'not json'},'invalid JSON'],[{input:'[]'},'array'],[{input:'null'},'null'],[{input:'"text"'},'string'],[{input:'{"a":"'+'x'.repeat(300000)+'"}'},'over 256 KB'],
  ];
  for(const [opts,name] of cases){
    const r=await runChild(s,{input:'{}',...opts});
    assert.equal(r.code,64,name+' '+r.stdout+r.stderr);assert.equal(r.json.error.code,'bad_request',name);
  }
  assert.deepEqual(s.requests(),[]);
});

test('a request the route validation refuses is an error with exit 1 and the key stays out of the output',async()=>{
  const s=childSetup({rules:[okRule]});
  const r=await runChild(s,{input:{...searchRequest,url:'https://evil.example/applications/search'}});
  assert.equal(r.code,1);assert.equal(r.json.error.code,'error');assert.ok(!r.stdout.includes('fixture-key'));
  assert.deepEqual(s.requests(),[]);
});

test('a missing key is exit 2 not_configured with the registration link, and nothing is sent',async()=>{
  const s=childSetup({rules:[okRule]});
  const r=await runChild(s,{input:searchRequest,env:{USPTO_API_KEY:''}});
  assert.equal(r.code,2);assert.equal(r.json.error.code,'not_configured');assert.deepEqual(r.json.error.missing,['USPTO_API_KEY']);assert.match(r.json.error.register,/^https:\/\/data\.uspto\.gov\//);
  assert.deepEqual(s.requests(),[]);
});

test('an empty search window is a zero-count result through the child as well',async()=>{
  const s=childSetup({rules:[{match:'/applications/search',status:404,body:{code:404,message:'Not Found',detailedMessage:'No matching records found, refine your search criteria and try again'}}]});
  const r=await runChild(s,{input:searchRequest});
  assert.equal(r.code,0);assert.equal(r.json.status,200);assert.equal(JSON.parse(r.json.text).count,0);
});

test('a test-module override in the environment is ignored: the gateway never loads a module named by the environment',async()=>{
  const s=childSetup({rules:[okRule]}),marker=path.join(s.dir,'loaded.txt'),module_=path.join(s.dir,'fake-gateway.mjs');
  fs.writeFileSync(module_,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'loaded');export const callGateway=async()=>({text:'{}',status:200,contentType:'application/json'});export const readConfig=()=>({});`);
  const r=await runChild(s,{input:searchRequest,env:{FRAME_GATEWAY_MODULE:module_,PG_GATEWAY_MODULE:module_}});
  assert.equal(r.code,0);assert.ok(!fs.existsSync(marker),'the override module must not be imported');
  assert.match(r.stderr,/FRAME_GATEWAY_MODULE.*ignored/);assert.equal(s.requests().length,1,'the real route ran');
  assert.ok(!/fixture-key/.test(r.stderr));
});

test('the hourly cap is reported as local_limit (exit 75) with the wait time, and the provider is not called',async()=>{
  const s=childSetup({config:{maxRequestsPerHour:{uspto:1}},rules:[okRule]});
  assert.equal((await runChild(s,{input:searchRequest})).code,0);
  const r=await runChild(s,{input:searchRequest});
  assert.equal(r.code,75);assert.equal(r.json.error.code,'local_limit');assert.equal(r.json.error.limit,1);
  assert.ok(r.json.error.retry_after_seconds>3000&&r.json.error.retry_after_seconds<=3600);assert.match(r.json.error.message,/minute\(s\)/);
  assert.equal(s.requests().length,1);
});

test('the supported routes are the source and document routes only',()=>{
  assert.ok(GATEWAY_ROUTES.includes('oa-rejections')&&GATEWAY_ROUTES.includes('uspto')&&GATEWAY_ROUTES.includes('application-pdf'));
  assert.ok(!GATEWAY_ROUTES.some(r=>/bigquery|model|catalog|external-access/.test(r)));
});

test('other CLI commands still run through the same entry point',async()=>{
  const dir=scratchFolder();
  const {spawnSync}=await import('node:child_process');
  const r=spawnSync(process.execPath,[path.join(import.meta.dirname,'..','src','cli.mjs'),'doctor'],{env:{...process.env,PATENT_RESEARCH_DATA_DIR:path.join(dir,'d'),PATENT_RESEARCH_CONFIG:path.join(dir,'none.json'),USPTO_API_KEY:''},encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).providers.some(p=>p.provider==='uspto'));
});

test('gateway --limits prints the effective limits from configuration only: no key, no request, no files',async()=>{
  const s=childSetup({config:{maxRequestsPerHour:{uspto:77}},rules:[okRule]});
  const r=await runChild(s,{args:['--limits'],env:{USPTO_API_KEY:''}});
  assert.equal(r.code,0,r.stdout+r.stderr);
  assert.equal(r.json.providers.uspto.max_calls_per_hour,77);assert.equal(r.json.providers.epo.max_calls_per_hour,1800);
  assert.equal(r.json.providers.uspto.concurrent_calls_per_key,1);assert.equal(r.json.providers.uspto.min_interval_ms,0);
  assert.equal(r.json.limiter_applies,true);assert.equal(r.json.min_wait_after_429_seconds,5);assert.match(r.json.hub_version,/^\d+\.\d+\.\d+$/);
  assert.deepEqual(s.requests(),[]);assert.deepEqual(fs.readdirSync(s.data),[]);
  assert.equal((await runChild(s,{args:['--limits','uspto']})).code,64);
});
