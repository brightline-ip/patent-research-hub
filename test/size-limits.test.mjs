import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {verifyOriginal} from '../src/application-original.mjs';
import {MAX_PATENT_DOCUMENT_BYTES} from '../src/patent-documents.mjs';
import {MAX_GOVINFO_PDF_BYTES} from '../src/govinfo-pdf.mjs';
import {PACK_CODE} from '../extras/n8n/scripts/build-live-govinfo-core.mjs';
import {directGateway,resetDirectState} from '../src/direct.mjs';
import {configDefaults} from '../src/config.mjs';
import bounded from '../src/bounded-download.cjs';

// Reexamination requests, third-party affidavits and long court opinions exceed 10 MB; the limit is 40 MB on the
// client, the direct transport and the n8n workflows alike. PTAB decisions stay at 10 MB / 60 s.
const MB=1024*1024;
const pdf=n=>{const b=Buffer.alloc(n);b.write('%PDF-1.7');return b;};
const fast={...configDefaults.directMinIntervalMs,uspto:0,govinfo:0};
const cfg={transport:'direct',directMinIntervalMs:fast};
// A fake https transport that streams one 1 MiB chunk at a time.
function transport(total,{contentLength=true}={}){
  const seen=[];
  return {seen,request(url,options,callback){
    const req=new EventEmitter();let res;
    req.destroy=()=>{req.destroyed=true;res?.destroy();};
    req.end=()=>{seen.push({url:String(url),timeout:null});queueMicrotask(()=>{
      res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/pdf',...(contentLength?{'content-length':String(total)}:{})};res.destroy=()=>{res.destroyed=true;};
      callback(res);let sent=0;
      const push=()=>{if(res.destroyed)return;if(sent>=total)return res.emit('end');const n=Math.min(MB,total-sent);const c=Buffer.alloc(n);if(sent===0)c.write('%PDF-1.7');sent+=n;res.emit('data',c);queueMicrotask(push);};push();
    });};
    return req;}};
}
const lookup=(host,options,cb)=>cb(null,[{address:'8.8.8.8',family:4}]);

test('application originals: 20 MB accepted, just over 40 MB rejected; client limits agree', ()=>{
  assert.equal(MAX_PATENT_DOCUMENT_BYTES,40*MB);
  assert.equal(verifyOriginal(pdf(20*MB),{extension:'pdf'}),'application/pdf');
  assert.throws(()=>verifyOriginal(pdf(40*MB+1),{extension:'pdf'}),/size or signature/);
});
test('GovInfo opinion PDFs: the workflow package code uses the same 40 MB limit as the client', ()=>{
  assert.equal(MAX_GOVINFO_PDF_BYTES,40*MB);
  assert.ok(PACK_CODE.includes('b.length>'+(40*MB)));
});
test('portable application-pdf workflow: 40 MB and 180 s on the bounded node, inside the 270 s workflow limit', ()=>{
  const w=JSON.parse(fs.readFileSync(new URL('../extras/n8n/workflows/application-pdf-core.json',import.meta.url),'utf8'));
  const node=w.nodes.find(n=>n.type==='n8n-nodes-patent-research.usptoOriginal');
  assert.equal(node.parameters.maxBytes,40*MB);assert.equal(node.parameters.timeoutMs,180000);
  assert.equal(w.settings.executionTimeout,270);
  const ptab=JSON.parse(fs.readFileSync(new URL('../extras/n8n/workflows/ptab-files-core.json',import.meta.url),'utf8')).nodes.find(n=>n.type==='n8n-nodes-patent-research.usptoOriginal');
  assert.equal(ptab.parameters.maxBytes,10*MB);assert.equal(ptab.parameters.timeoutMs,60000);
});
test('bounded downloader: application originals may use 40 MB / 180 s; PTAB decisions are held to 10 MB / 60 s', async()=>{
  assert.equal(bounded.MAX_APPLICATION_BYTES,40*MB);assert.equal(bounded.APPLICATION_TIMEOUT_MS,180000);
  const app={application_number:'18123456',document_identifier:'ABC'},ptab={trial_number:'IPR2025-00673',document_identifier:'171365535'};
  const t=transport(12*MB);
  const ok=await bounded.downloadOriginal(app,{apiKey:'fixture-key',requestImpl:t.request,lookupImpl:lookup,timeoutMs:180000});
  assert.equal(ok.bytes,12*MB);
  const big=transport(40*MB+1,{contentLength:false});
  await assert.rejects(bounded.downloadOriginal(app,{apiKey:'fixture-key',requestImpl:big.request,lookupImpl:lookup}),/byte limit/);
  await assert.rejects(bounded.downloadOriginal(app,{apiKey:'fixture-key',maxBytes:40*MB+1}),/Invalid download bounds/);
  await assert.rejects(bounded.downloadOriginal(app,{apiKey:'fixture-key',timeoutMs:180001}),/Invalid download bounds/);
  await assert.rejects(bounded.downloadPtabOriginal(ptab,{apiKey:'fixture-key',maxBytes:10*MB+1}),/Invalid download bounds/);
  await assert.rejects(bounded.downloadPtabOriginal(ptab,{apiKey:'fixture-key',timeoutMs:61000}),/Invalid download bounds/);
});
test('direct transport: application-pdf passes a 12 MB original; PTAB files stay at 10 MB', async()=>{
  resetDirectState();
  const t=transport(12*MB);
  const r=await directGateway('application-pdf',{application_number:'18123456',document_identifier:'ABC'},{config:cfg,env:{USPTO_API_KEY:'fixture-key'},requestImpl:t.request,lookupImpl:lookup});
  assert.equal(r.bytes,12*MB);assert.equal(r.status,200);
  const p=transport(12*MB);
  await assert.rejects(directGateway('ptab-files',{trialNumber:'IPR2025-00673',documentIdentifier:'171365535'},{config:cfg,env:{USPTO_API_KEY:'fixture-key'},requestImpl:p.request,lookupImpl:lookup}),/byte limit/);
});
test('direct transport: GovInfo opinion PDF accepts 12 MB and rejects over 40 MB', async()=>{
  resetDirectState();
  const url='https://api.govinfo.gov/packages/USCOURTS-cafc-24-1000/granules/USCOURTS-cafc-24-1000-0/pdf';
  const reply=n=>async()=>new Response(pdf(n),{headers:{'content-type':'application/pdf'}});
  const ok=await directGateway('govinfo',{source:'govinfo',url,method:'GET'},{config:cfg,env:{GOVINFO_API_KEY:'fixture'},fetchImpl:reply(12*MB)});
  assert.equal(ok.bytes,12*MB);
  await assert.rejects(directGateway('govinfo',{source:'govinfo',url,method:'GET'},{config:cfg,env:{GOVINFO_API_KEY:'fixture'},fetchImpl:reply(40*MB+1)}),/oversized/);
});