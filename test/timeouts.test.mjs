import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {callGateway} from '../src/gateway.mjs';
import {fetchGovinfoOpinionPdf} from '../src/govinfo-pdf.mjs';
import {configDefaults} from '../src/config.mjs';
import bounded from '../src/bounded-download.cjs';

// Large originals need proportionate deadlines. These tests record the deadline that is actually armed.
const MB=1024*1024;
const lookup=(host,options,cb)=>cb(null,[{address:'8.8.8.8',family:4}]);
function transport(total){
  return {request(url,options,callback){
    const req=new EventEmitter();let res;
    req.destroy=()=>{res?.destroy();};
    req.end=()=>queueMicrotask(()=>{
      res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/pdf','content-length':String(total)};res.destroy=()=>{};
      callback(res);const c=Buffer.alloc(total);c.write('%PDF-1.7');res.emit('data',c);res.emit('end');
    });
    return req;}};
}
async function recordDelays(fn){
  const delays=[],realSet=globalThis.setTimeout,realAbort=AbortSignal.timeout;
  globalThis.setTimeout=(f,ms,...a)=>{delays.push(ms);return realSet(f,ms,...a);};
  AbortSignal.timeout=ms=>{delays.push(ms);return realAbort.call(AbortSignal,ms);};
  try{await fn();}finally{globalThis.setTimeout=realSet;AbortSignal.timeout=realAbort;}
  return delays;
}

test('bounded downloader: an omitted deadline is 180 s for application originals and 60 s for PTAB decisions',async()=>{
  const app={application_number:'18123456',document_identifier:'ABC'},ptab={trial_number:'IPR2025-00673',document_identifier:'171365535'};
  const appDelays=await recordDelays(()=>bounded.downloadOriginal(app,{apiKey:'fixture-key',requestImpl:transport(MB).request,lookupImpl:lookup}));
  assert.ok(appDelays.includes(180000),'application download should arm a 180000 ms deadline, got '+appDelays);
  const ptabDelays=await recordDelays(()=>bounded.downloadPtabOriginal(ptab,{apiKey:'fixture-key',requestImpl:transport(MB).request,lookupImpl:lookup}));
  assert.ok(ptabDelays.includes(60000)&&!ptabDelays.includes(180000),'PTAB download should arm 60000 ms, got '+ptabDelays);
});

test('the n8n node leaves the deadline to the downloader by default and passes an explicit one through',async()=>{
  const file=new URL('../extras/n8n/custom-nodes/n8n-nodes-patent-research/nodes/UsptoOriginal.node.js',import.meta.url);
  const source=fs.readFileSync(file,'utf8');
  const calls=[];
  const sandbox={module:{exports:{}},require:name=>name==='./bounded-download.js'?{downloadOriginal:async(i,o)=>{calls.push(o);return {};},downloadPtabOriginal:async(i,o)=>{calls.push(o);return {};}}:require(name),Error,String};
  vm.runInNewContext(source,sandbox);
  const node=new sandbox.module.exports.UsptoOriginal();
  const timeoutProperty=node.description.properties.find(p=>p.name==='timeoutMs');
  assert.equal(timeoutProperty.default,0,'0 means: use the operation default (180 s application, 60 s PTAB)');assert.equal(timeoutProperty.typeOptions.minValue,0);
  const run=timeout=>{const params={operation:'application',applicationNumber:'18123456',documentIdentifier:'ABC',maxBytes:1000,timeoutMs:timeout};
    return node.execute.call({getInputData:()=>[{}],getCredentials:async()=>({name:'x-api-key',value:'k'}),getNodeParameter:(name,i,fallback)=>params[name]??fallback});};
  return run(0).then(()=>run(90000)).then(()=>{assert.equal(calls[0].timeoutMs,undefined);assert.equal(calls[1].timeoutMs,90000);});
});

test('direct transport: a GovInfo opinion PDF gets a deadline proportionate to its 40 MB limit',async()=>{
  const pdf=Buffer.from('%PDF-1.7 fixture opinion');
  const cfg={transport:'direct',directMinIntervalMs:{...configDefaults.directMinIntervalMs,govinfo:0}};
  const delays=await recordDelays(()=>fetchGovinfoOpinionPdf('USCOURTS-cafc-24-1000','USCOURTS-cafc-24-1000-0',{config:cfg,callGateway:(route,body,opts)=>callGateway(route,body,{...opts,env:{GOVINFO_API_KEY:'fixture'},fetchImpl:async()=>new Response(pdf,{headers:{'content-type':'application/pdf'}})})}));
  assert.ok(delays.includes(180000),'GovInfo PDF should arm a 180000 ms deadline, got '+delays);
  assert.ok(!delays.includes(60000));
});
