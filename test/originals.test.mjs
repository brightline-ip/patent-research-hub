import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validatePtabOriginal,validatePtabDownload,ptabOriginalRequest,decodePtabOriginal,stageOriginal,MAX_PTAB_PDF_BYTES} from '../src/originals.mjs';
import {buildOriginalWorkflows} from '../extras/n8n/scripts/build-original-workflows.mjs';
import {Hub} from '../src/hub.mjs';
import {record} from '../src/parsers.mjs';

const identity={trialNumber:'IPR2025-00673',documentIdentifier:'171365535'};
const url=validatePtabOriginal(identity).url;
const bytes=Buffer.from('%PDF-1.4\nTEST FIXTURE ONLY\n%%EOF');
const sha=createHash('sha256').update(bytes).digest('hex');
const envelope={status:200,url,contentType:'application/pdf',bytes:bytes.length,base64:bytes.toString('base64')};
const appealIdentity={appealNumber:'2025003334',documentIdentifier:'8896fb73-1ffb-4cc4-9507-eb4e54c6c687'};
const appealUrl='https://api.uspto.gov/api/v1/patent/ptab-files/APP/2025/003334/8896fb73-1ffb-4cc4-9507-eb4e54c6c687.pdf';

test('Original connector derives the exact provider path and rejects injected identities',()=>{
  assert.equal(url,'https://api.uspto.gov/api/v1/patent/ptab-files/IPR/2025/00673/171365535.pdf');
  assert.equal(validatePtabOriginal(appealIdentity).url,appealUrl);
  for(const bad of [{...identity,trialNumber:'../IPR2025-00673'},{...identity,documentIdentifier:'1?api_key=secret'},{...identity,documentIdentifier:'1/../../2'}])assert.throws(()=>validatePtabOriginal(bad));
  assert.throws(()=>ptabOriginalRequest({source:'ptab-trials',url:'https://example.org/a.pdf',metadata:{trialNumber:identity.trialNumber,documentData:identity}}));
  assert.equal(ptabOriginalRequest({source:'ptab-appeals',url:appealUrl,metadata:{appealNumber:appealIdentity.appealNumber,documentData:{documentIdentifier:appealIdentity.documentIdentifier}}}).url,appealUrl);
  for(const bad of [{...appealIdentity,appealNumber:'2025/003334'},{...appealIdentity,documentIdentifier:'8896fb73/../../secret'}])assert.throws(()=>validatePtabOriginal(bad));
  const core=buildOriginalWorkflows()[0],stream=core.nodes.find(n=>n.type==='n8n-nodes-patent-research.usptoOriginal');
  assert.equal(stream.parameters.operation,'ptab');assert.ok(stream.credentials.httpHeaderAuth);assert.equal(stream.parameters.maxBytes,10485760);assert.equal(stream.parameters.timeoutMs,60000);
  assert.equal(core.nodes.some(n=>n.type.endsWith('.httpRequest')),false);
});

test('Original decoding rejects response substitution, HTML, malformed base64 and oversize files',()=>{
  assert.equal(decodePtabOriginal(envelope,url).sha256,sha);
  for(const bad of [{...envelope,status:403},{...envelope,url:'https://example.org/'},{...envelope,contentType:'text/html'},{...envelope,bytes:0},{...envelope,base64:'SGVsbG8='},{...envelope,base64:envelope.base64+'!!!!'},{...envelope,base64:'A'.repeat(4*Math.ceil(MAX_PTAB_PDF_BYTES/3)+4)}])assert.throws(()=>decodePtabOriginal(bad,url));
});

test('USPTO redirects allow only the same document on its file host without API credentials',()=>{
  const expected=validatePtabOriginal(identity);
  const location='https://data.uspto.gov/ptab-files/IPR/2025/00673/171365535.pdf?Expires=9999999999&Signature=fixture_only~_-&Key-Pair-Id=fixture';
  const response={statusCode:302,headers:{location}};
  assert.equal(validatePtabDownload(response,expected).downloadUrl,location);
  for(const bad of [location.replace('data.uspto.gov','data.uspto.gov.evil.example'),location.replace('171365535','999'),location.replace('https:','http:'),location.replace('data.uspto.gov/','data.uspto.gov:443/'),location+'&Signature=duplicate',location+'&next=https://evil.example',location+'#fragment',location.replace('Signature=fixture_only~_-&',''),location.replace('Expires=9999999999','Expires=not-a-date')])assert.throws(()=>validatePtabDownload({statusCode:302,headers:{location:bad}},expected));
  assert.throws(()=>validatePtabDownload({...response,statusCode:403},expected),/403/);
  assert.throws(()=>validatePtabDownload({statusCode:302,headers:{},body:location},expected));
  const core=buildOriginalWorkflows()[0],stream=core.nodes.find(n=>n.type==='n8n-nodes-patent-research.usptoOriginal');
  assert.ok(stream.credentials.httpHeaderAuth);assert.equal(core.nodes.some(n=>n.type.endsWith('.httpRequest')),false);
});

test('Original staging preserves identical bytes and replaces a damaged staged file atomically',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptab-stage-'));
  try{
    const file=await stageOriginal(bytes,sha,dir);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(await stageOriginal(bytes,sha,dir),file);
    // A truncated or damaged file under the verified hash name (for example from an interrupted earlier write) must not block the original for good.
    fs.writeFileSync(file,'conflict');
    assert.equal(await stageOriginal(bytes,sha,dir),file);assert.deepEqual(fs.readFileSync(file),bytes);
    fs.writeFileSync(file,bytes.subarray(0,10));
    assert.equal(await stageOriginal(bytes,sha,dir),file);assert.deepEqual(fs.readFileSync(file),bytes);
    // No temporary file is left behind, and only the final name is in the intake folder.
    assert.deepEqual(fs.readdirSync(path.dirname(file)),[path.basename(file)]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Original staging never exposes a partial file under the final name and cleans up after a failed write',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptab-stage-'));
  try{
    const file=path.join(dir,'patent-research',sha+'.pdf');
    // A directory occupying the final name makes the rename fail; the temporary file must not remain and nothing partial appears.
    fs.mkdirSync(file,{recursive:true});
    await assert.rejects(stageOriginal(bytes,sha,dir));
    assert.ok(fs.statSync(file).isDirectory());
    assert.deepEqual(fs.readdirSync(path.dirname(file)),[path.basename(file)]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Archive links the queued job to its snapshot, later records extraction warnings, and avoids a second download',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptab-archive-')),auth=path.join(dir,'auth.env');fs.writeFileSync(auth,'RESEARCH_GATEWAY_AUTH_HEADER_VALUE=Bearer '+ 'a'.repeat(43));
  let providerCalls=0,imports=0,polls=0;
  const hub=new Hub({dataRoot:path.join(dir,'data'),config:{transport:'n8n',ptabOriginalsEnabled:true,n8nBaseUrl:'http://127.0.0.1:59999',gatewayAuthFile:auth,corpusIntakeRoot:path.join(dir,'intake')},fetchImpl:async(input,options)=>{providerCalls++;assert.ok(String(input).endsWith('/webhook/patent-research-ptab-files'));assert.deepEqual(JSON.parse(options.body),identity);return new Response(JSON.stringify(envelope),{headers:{'content-type':'application/json'}});}});
  const corpus={ingest:async(collection,items)=>{imports++;assert.equal(collection,'legal');assert.equal(items[0].source_url,url);assert.equal(items[0].expected_sha256,sha);assert.deepEqual(fs.readFileSync(items[0].path),bytes);assert.ok(!('headers' in items[0]));return {items:[{job_id:'fixture-job',status:'queued'}]};},getJobs:async()=>{polls++;return {pending:polls===1,jobs:[polls===1?{job_id:'fixture-job',status:'working'}:{job_id:'fixture-job',status:'needs_ocr',document_id:sha,original:{sha256:sha,bytes:bytes.length},extraction_warnings:['Page 2 requires OCR']}]};},document:async()=>({title:'PTAB fixture',status:'needs_ocr',manifest:{warnings:['Page 2 requires OCR']},origins:[]}),request:async()=>({chunks:[{locator:'page:1'},{locator:'page:2'},{locator:'page:3'}],next_offset:3})};
  hub.corpus=async()=>corpus;
  const r=record('ptab-trials',{url,title:'PTAB fixture',metadata:{trialNumber:identity.trialNumber,documentData:{documentIdentifier:identity.documentIdentifier}}});
  try{const first=hub.store.ingest(r.source,{},'metadata fixture',[r],{exhaustive:false});const queued=await hub.archive(r.id);assert.equal(queued.pending,true);assert.equal(hub.store.get(r.id).acquisition.documentId,null);const ready=await hub.archive(r.id);assert.equal(ready.reused,true);let linked=hub.store.get(r.id);assert.equal(linked.acquisition.sourceSnapshotId,first.snapshotId);assert.equal(linked.acquisition.documentId,sha);assert.deepEqual(linked.acquisition.extractionWarnings,['Page 2 requires OCR']);assert.equal(linked.acquisition.textRead,false);assert.equal(linked.fullText,false);await hub.corpusRead(sha,0);linked=hub.store.get(r.id);assert.equal(linked.acquisition.textRead,true);assert.deepEqual(linked.acquisition.readOffsets,[0]);assert.deepEqual(linked.acquisition.lastRead,{offset:0,nextOffset:3,locators:['page:1','page:2','page:3']});await hub.archive(r.id);assert.equal(hub.store.get(r.id).acquisition.textRead,true);assert.equal(providerCalls,1);assert.equal(imports,1);assert.throws(()=>hub.store.updateAcquisition({job_id:'fixture-job',document_id:'b'.repeat(64),status:'ready'}),/hash differs/);hub.store.ingest(r.source,{},'changed metadata',[r],{exhaustive:false});assert.equal(hub.store.get(r.id).acquisition,null);}finally{hub.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Appeal archive sends the appeal number and document UUID to the shared file gateway',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ptab-appeal-archive-')),auth=path.join(dir,'auth.env');fs.writeFileSync(auth,'RESEARCH_GATEWAY_AUTH_HEADER_VALUE=Bearer '+ 'a'.repeat(43));
  const appealBytes=Buffer.from('%PDF-1.4\nAPPEAL FIXTURE ONLY\n%%EOF'),appealSha=createHash('sha256').update(appealBytes).digest('hex');
  let sent;
  const hub=new Hub({dataRoot:path.join(dir,'data'),config:{transport:'n8n',ptabOriginalsEnabled:true,n8nBaseUrl:'http://127.0.0.1:59999',gatewayAuthFile:auth,corpusIntakeRoot:path.join(dir,'intake')},fetchImpl:async(input,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({status:200,url:appealUrl,contentType:'application/pdf',bytes:appealBytes.length,base64:appealBytes.toString('base64')}),{headers:{'content-type':'application/json'}});}});
  hub.corpus=async()=>({ingest:async()=>({items:[{job_id:'appeal-job',status:'queued'}]}),getJobs:async()=>({pending:true,jobs:[{job_id:'appeal-job',status:'working'}]})});
  const r=record('ptab-appeals',{url:appealUrl,title:'PTAB appeal fixture',metadata:{appealNumber:appealIdentity.appealNumber,documentData:{documentIdentifier:appealIdentity.documentIdentifier}}});
  try{hub.store.ingest(r.source,{},'appeal metadata fixture',[r],{exhaustive:false});await hub.archive(r.id);assert.deepEqual(sent,appealIdentity);}finally{hub.store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
