import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import {govinfoPdfUrl,decodeGovinfoPdf,fetchGovinfoOpinionPdf} from '../src/govinfo-pdf.mjs';
import {buildLiveGovinfoCore,VALIDATE_CODE,PACK_CODE,IF_NODE,PDF_NODE,PACK_NODE} from '../extras/n8n/scripts/build-live-govinfo-core.mjs';

const P='USCOURTS-wiwd-3_09-cv-00665',G=P+'-0',U='https://api.govinfo.gov/packages/'+P+'/granules/'+G+'/pdf';
const pdf=Buffer.from('%PDF-1.7\n...body...'),env={status:200,url:U,contentType:'application/pdf',bytes:pdf.length,base64:pdf.toString('base64')};

test('GovInfo PDF url is bounded to USCOURTS granules of their own package',()=>{
  assert.equal(govinfoPdfUrl(P,G),U);
  for(const [p,g] of [[P,'USCOURTS-cafc-21-1-0'],['FR-2020-01-01','FR-2020-01-01-0'],[P,P],[P,G+'x'],['USCOURTS-x-..-y','USCOURTS-x-..-y-0']])assert.throws(()=>govinfoPdfUrl(p,g));
});
test('decoding verifies status, url, type, size, canonical base64 and signature',()=>{
  assert.equal(decodeGovinfoPdf(env,U).bytes.toString(),pdf.toString());
  assert.throws(()=>decodeGovinfoPdf({...env,status:404,error:'GovInfo PDF request failed (HTTP 404)'},U),/404/);
  assert.throws(()=>decodeGovinfoPdf({...env,url:U+'x'},U));
  assert.throws(()=>decodeGovinfoPdf({...env,contentType:'text/html'},U));
  assert.throws(()=>decodeGovinfoPdf({...env,bytes:1},U));
  const html=Buffer.from('<html>');assert.throws(()=>decodeGovinfoPdf({...env,bytes:html.length,base64:html.toString('base64')},U),/signature/);
});
test('fetch calls the govinfo route with a GET and a raised size limit',async()=>{
  let seen;const r=await fetchGovinfoOpinionPdf(P,G,{callGateway:async(route,body,opts)=>{seen={route,body,opts};return env;}});
  assert.equal(seen.route,'govinfo');assert.deepEqual(seen.body,{source:'govinfo',url:U,method:'GET'});assert.ok(seen.opts.maxBytes>13e6);
  assert.equal(r.sha256.length,64);
});

const live=()=>({id:'patent-research-govinfo-core',settings:{s:1},nodes:[
  {id:'a',name:'When Called by Another Workflow',type:'n8n-nodes-base.executeWorkflowTrigger',parameters:{},position:[0,0]},
  {id:'b',name:'Connection Settings',type:'n8n-nodes-base.set',parameters:{},position:[100,0]},
  {id:'c',name:'Validate Source Request',type:'n8n-nodes-base.code',parameters:{jsCode:"function validateWorkflowSource(j,route){};return [{json:validateWorkflowSource($input.first().json,'govinfo')}];"},position:[200,0]},
  {id:'d',name:'Provider — select credential here',type:'n8n-nodes-base.httpRequest',parameters:{method:'={{ $json.method }}'},credentials:{httpHeaderAuth:{id:'g1',name:'Patent Research — GovInfo'}},position:[350,0]},
  {id:'e',name:'Package Source Response',type:'n8n-nodes-base.code',parameters:{jsCode:'x'},position:[500,0]}],
  connections:{'When Called by Another Workflow':{main:[[{node:'Connection Settings',type:'main',index:0}]]},'Connection Settings':{main:[[{node:'Validate Source Request',type:'main',index:0}]]},
    'Validate Source Request':{main:[[{node:'Provider — select credential here',type:'main',index:0}]]},'Provider — select credential here':{main:[[{node:'Package Source Response',type:'main',index:0}]]}}});

test('live GovInfo core build: search path unchanged, PDF branch added',()=>{
  const w=live(),b=buildLiveGovinfoCore([w]);
  for(const name of ['When Called by Another Workflow','Connection Settings','Provider — select credential here','Package Source Response'])
    assert.deepEqual(b.nodes.find(n=>n.name===name),w.nodes.find(n=>n.name===name));
  assert.equal(b.nodes.find(n=>n.name==='Validate Source Request').parameters.jsCode,VALIDATE_CODE);
  assert.deepEqual(b.connections['Is Opinion PDF'].main.map(x=>x[0].node),[PDF_NODE,'Provider — select credential here']);
  assert.equal(b.connections['Validate Source Request'].main[0][0].node,IF_NODE);
  assert.equal(b.connections[PDF_NODE].main[0][0].node,PACK_NODE);
  assert.deepEqual(b.connections['Provider — select credential here'],w.connections['Provider — select credential here']);
  const h=b.nodes.find(n=>n.name===PDF_NODE);assert.equal(h.parameters.method,'GET');assert.equal(h.parameters.sendBody,undefined);
  assert.equal(h.credentials.httpHeaderAuth.id,'g1');assert.equal(h.parameters.options.redirect.redirect.followRedirects,false);
  assert.equal(b.nodes.find(n=>n.name===PACK_NODE).parameters.jsCode,PACK_CODE);
  assert.throws(()=>buildLiveGovinfoCore(b),/already has/);
  assert.throws(()=>buildLiveGovinfoCore({...live(),id:'x'}),/Expected/);
});
