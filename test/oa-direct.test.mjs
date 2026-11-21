// Offline tests: the direct oa-rejections route and the empty-search-result handling. Every provider answer is a mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {directGateway} from '../src/direct.mjs';
import {callGateway} from '../src/gateway.mjs';
import {Hub} from '../src/hub.mjs';
import {configDefaults} from '../src/config.mjs';
import {oaAdapters,selectOaAdapter} from '../src/oa-adapter.mjs';

const fast={...configDefaults.directMinIntervalMs,uspto:0};
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'prh-oa-'));
process.on('exit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});
let n=0;
const options=(fetchImpl,extra={})=>({config:{transport:'direct',directMinIntervalMs:fast,...(extra.config||{})},env:{USPTO_API_KEY:'fixture-key'},fetchImpl,limiterDir:path.join(scratch,'l'+(n++)),...extra.rest});
const reply=(body,status=200,headers={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const records={response:{numFound:2,start:0,docs:[{patentApplicationNumber:'17000001',hasRej103:1},{patentApplicationNumber:'17000001',hasRej101:1}]}};
const call=(body,fetchImpl)=>directGateway('oa-rejections',body,options(fetchImpl));

test('oa-rejections sends one fixed-endpoint form POST with the key header and returns the provider envelope',async()=>{
  let seen;
  const r=await call({action:'records',application_numbers:['17000001','17000002'],rows:50},async(url,o)=>{seen={url:String(url),o};return reply(records);});
  assert.equal(seen.url,'https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/records');
  assert.equal(seen.o.method,'POST');assert.equal(seen.o.headers['X-API-KEY'],'fixture-key');assert.equal(seen.o.headers['Content-Type'],'application/x-www-form-urlencoded');
  const form=new URLSearchParams(seen.o.body);
  assert.equal(form.get('criteria'),'patentApplicationNumber:(17000001 OR 17000002)');assert.equal(form.get('rows'),'50');assert.equal(form.get('start'),'0');
  assert.equal(r.status,200);assert.equal(r.contentType,'application/json');assert.deepEqual(JSON.parse(r.text),records);
});

test('oa-rejections field list is a GET to the fixed /fields endpoint',async()=>{
  let seen;
  const r=await call({action:'fields'},async(url,o)=>{seen={url:String(url),o};return reply({apiKey:'oa_rejections',apiStatus:'PUBLISHED',fields:['hasRej101','hasRej103']});});
  assert.equal(seen.url,'https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/fields');assert.equal(seen.o.method,'GET');assert.equal(seen.o.body,undefined);
  assert.equal(r.status,200);assert.equal(JSON.parse(r.text).fields.length,2);
});

test('oa-rejections refuses anything but 8-digit application numbers before any request or key use',async()=>{
  let calls=0;const f=async()=>{calls++;return reply(records);};
  for(const bad of [{application_numbers:['1631904']},{application_numbers:['17000001) OR (*']},{application_numbers:[]},{application_numbers:['17/000,001']},{application_numbers:Array(101).fill('17000001')},{application_numbers:['17000001'],field:'*:*'},{action:'delete'},{application_numbers:['17000001'],rows:1000}])
    await assert.rejects(call(bad,f),/eight-digit|Unsupported|Invalid paging/,JSON.stringify(bad).slice(0,50));
  assert.equal(calls,0);
  const noKey=await directGateway('oa-rejections',{application_numbers:['17000001']},{...options(f),env:{}}).then(()=>null,e=>e);
  assert.equal(noKey.code,'NOT_CONFIGURED');assert.deepEqual(noKey.notConfigured.missing,['USPTO_API_KEY']);assert.equal(calls,0);
});

test('an empty but well-formed answer is zero records; every other shape fails closed (502), never zero',async()=>{
  const zero=await call({application_numbers:['17000001']},async()=>reply({response:{numFound:0,start:0,docs:[]}}));
  assert.equal(zero.status,200);assert.equal(JSON.parse(zero.text).response.numFound,0);
  for(const [name,body] of [['empty object',{}],['html page','<html><body>Request failed</body></html>'],['empty text',''],['array','[]'],['response missing docs',{response:{numFound:3}}],['docs without numFound',{response:{docs:[]}}],['numFound as text',{response:{numFound:'0',docs:[]}}],['numFound above docs',{response:{numFound:4,start:0,docs:[]}}],['negative numFound',{response:{numFound:-1,docs:[]}}],['response is an array',{response:[]}],['error object in a 200',{code:500,message:'server error'}],['error plus records',{code:503,message:'x',response:{numFound:0,docs:[]}}],['null','null']]){
    const r=await call({application_numbers:['17000001']},async()=>reply(body));
    assert.equal(r.status,502,name);assert.ok(!('response' in JSON.parse(r.text)),name);
  }
  const fields=await call({action:'fields'},async()=>reply({apiKey:'x'}));assert.equal(fields.status,502);
});

test('the status comes from the HTTP response, not the body',async()=>{
  const lying={response:{numFound:0,start:0,docs:[]},code:200,status:200};
  for(const status of [400,401,403,404,413,500,503]){
    const r=await call({application_numbers:['17000001']},async()=>reply(lying,status));
    assert.equal(r.status,status);assert.ok(!('response' in JSON.parse(r.text)),'an error status must not carry records');
  }
  const r=await call({application_numbers:['17000001']},async()=>reply({code:404,message:'Not Found',detailedMessage:'No matching records found'},404));
  assert.equal(r.status,404);   // the rejections route does not invent a zero result from a 404
  const noContent=await call({application_numbers:['17000001']},async()=>new Response(null,{status:204}));
  assert.equal(noContent.status,502);
  const message=JSON.parse((await call({application_numbers:['17000001']},async()=>reply({message:'Bad\u0000Request'+'x'.repeat(500)},400))).text).provider_message;
  assert.ok(message.length<=300&&!/\u0000/.test(message));
});

test('HTTP 429 comes back as 429 with a wait of at least 5 seconds, and the next call is held back',async()=>{
  const waits=[];let calls=0;
  const o=options(async()=>{calls++;return calls===1?reply({code:429,message:'Too Many Requests'},429):reply(records);},{rest:{sleep:async ms=>{waits.push(ms);}}});
  const first=await directGateway('oa-rejections',{application_numbers:['17000001']},o);
  assert.equal(first.status,429);assert.ok(first.retryAfterSeconds>=5);
  const second=await directGateway('oa-rejections',{application_numbers:['17000001']},o);
  assert.equal(second.status,200);assert.equal(waits.length,1);assert.ok(waits[0]>4500,`waited ${waits[0]} ms`);
});

test('callGateway reaches the route and the adapter is selectable but only the legacy service exists',async()=>{
  const r=await callGateway('oa-rejections',{application_numbers:['17000001']},options(async()=>reply(records)));
  assert.equal(r.status,200);
  assert.deepEqual(Object.keys(oaAdapters),['legacy-rejections-v2']);
  assert.equal(selectOaAdapter({}).id,'legacy-rejections-v2');
  assert.throws(()=>selectOaAdapter({oaRejectionsAdapter:'office-action-search'}),/Unknown oaRejectionsAdapter/);
  await assert.rejects(callGateway('oa-rejections',{application_numbers:['17000001']},options(async()=>reply(records),{config:{oaRejectionsAdapter:'office-action-search'}})),/Unknown oaRejectionsAdapter/);
});

const noMatch={code:404,message:'Not Found',detailedMessage:'No matching records found, refine your search criteria and try again',requestIdentifier:'fixture'};
const search={source:'odp',url:'https://api.uspto.gov/api/v1/patent/applications/search',method:'POST',body:{q:'x',pagination:{offset:0,limit:10}}};
function withHub(fetchImpl,fn){
  const dir=fs.mkdtempSync(path.join(scratch,'hub-'));
  const hub=new Hub({dataRoot:dir,config:{transport:'direct',directMinIntervalMs:fast,dataDir:dir},env:{USPTO_API_KEY:'fixture-key'},fetchImpl});
  return Promise.resolve().then(()=>fn(hub)).finally(()=>hub.store.close());
}
test('an empty ODP search window (HTTP 404 "no matching records") is a valid zero-count result',async()=>{
  const r=await withHub(async()=>reply(noMatch,404),hub=>hub.query('odp','applicationMetaData.filingDate:[2030-01-01 TO 2030-01-02]',{limit:10}));
  assert.deepEqual(r.records,[]);assert.equal(r.providerTotal,0);assert.equal(r.nextCursor,null);
  const env=await directGateway('uspto',search,options(async()=>reply(noMatch,404)));
  assert.equal(env.status,200);const body=JSON.parse(env.text);
  assert.equal(body.count,0);assert.deepEqual(body.patentFileWrapperDataBag,[]);assert.equal(body.provider_status,404);
  // The body's own code is not trusted: the HTTP 404 decides.
  const bodyOnlyMessage=await directGateway('uspto',search,options(async()=>reply({message:'No matching records found'},404)));
  assert.equal(bodyOnlyMessage.status,200);assert.equal(JSON.parse(bodyOnlyMessage.text).count,0);
});

test('only the real "no matching records" 404 becomes zero: other 404s, other statuses and odd 200s stay errors',async()=>{
  const other404=await directGateway('uspto',search,options(async()=>reply({code:404,message:'Not Found',detailedMessage:'Resource missing'},404)));
  assert.equal(other404.status,404);
  const empty404=await directGateway('uspto',search,options(async()=>new Response('',{status:404})));
  assert.equal(empty404.status,404);
  const message200=await directGateway('uspto',search,options(async()=>reply(noMatch,200)));      // a 200 carrying that text is not a zero result
  assert.equal(message200.status,200);assert.ok(!('count' in JSON.parse(message200.text)));
  await assert.rejects(withHub(async()=>reply(noMatch,200),hub=>hub.query('odp','x',{limit:10})),Error);
  for(const status of [400,401,413,500,503])assert.equal((await directGateway('uspto',search,options(async()=>reply(noMatch,status)))).status,status);
  const ptab=await directGateway('ptab',{source:'ptab-trials',url:'https://api.uspto.gov/api/v1/patent/trials/decisions/search',method:'GET'},options(async()=>reply(noMatch,404)));
  assert.equal(ptab.status,404);
});
