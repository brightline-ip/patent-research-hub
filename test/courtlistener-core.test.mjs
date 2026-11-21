import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveCourtListenerCore,VALIDATE_CODE,VALIDATE_NODE} from '../extras/n8n/scripts/build-live-courtlistener-core.mjs';

const live=()=>({id:'patent-research-courtlistener-core',name:'x',settings:{a:1},nodes:[
  {id:'n1',name:'When Called by Another Workflow',type:'n8n-nodes-base.executeWorkflowTrigger',parameters:{}},
  {id:'n2',name:VALIDATE_NODE,type:'n8n-nodes-base.code',parameters:{jsCode:"function validateWorkflowSource(j,route){return 1};return [{json:validateWorkflowSource($input.first().json,'courtlistener')}];"}},
  {id:'n3',name:'Provider — select credential here',type:'n8n-nodes-base.httpRequest',parameters:{url:'={{ $json.url }}'},credentials:{httpHeaderAuth:{id:'c1',name:'CL'}}}],connections:{k:1}});

test('live CourtListener core build replaces only the validation code',()=>{
  const w=live(),b=buildLiveCourtListenerCore([w]);
  assert.equal(b.nodes.find(n=>n.name===VALIDATE_NODE).parameters.jsCode,VALIDATE_CODE);
  for(const i of [0,2])assert.deepEqual(b.nodes[i],w.nodes[i]);
  assert.deepEqual(b.settings,w.settings);assert.deepEqual(b.connections,w.connections);assert.equal(b.id,w.id);
  const v=new Function('$input',VALIDATE_CODE);const base='https://www.courtlistener.com/api/rest/v4/search/';
  const j={sourceUrls:JSON.stringify({courtlistener:base}),internalUseAgreementConfirmed:true,source:'courtlistener',method:'GET'};
  assert.equal(v({first:()=>({json:{...j,url:'https://www.courtlistener.com/api/rest/v4/opinions/42/?fields=id,plain_text'}})})[0].json.method,'GET');
  assert.throws(()=>v({first:()=>({json:{...j,url:'https://www.courtlistener.com/api/rest/v4/opinions/42/?fields=secret'}})}));
});
test('refuses an unexpected live workflow',()=>{
  assert.throws(()=>buildLiveCourtListenerCore({...live(),id:'other'}),/Expected/);
  const w=live();w.nodes[1].parameters.jsCode='return 1';assert.throws(()=>buildLiveCourtListenerCore(w),/unexpected form/);
  const w2=live();w2.nodes.push({...w2.nodes[1],id:'dup'});assert.throws(()=>buildLiveCourtListenerCore(w2),/exactly one/);
});
