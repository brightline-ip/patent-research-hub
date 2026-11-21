import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import {cpcSchemeUrl,parseCpcScheme,fetchCpcScheme} from '../src/epo-cpc.mjs';
import {validateWorkflowSource} from '../src/workflow-validation.mjs';

const XML=`<?xml version="1.0" encoding="UTF-8"?>
<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:cpc="http://www.epo.org/cpcexport"><cpc:class-scheme scheme-type="cpc">
<cpc:classification-item level="7" sort-key="H04W4/70"><cpc:classification-symbol>H04W4/70</cpc:classification-symbol>
<cpc:class-title><cpc:title-part><cpc:text scheme="ipc">Services for machine-to-machine communication [M2M] &amp; MTC</cpc:text></cpc:title-part></cpc:class-title>
 <cpc:classification-item level="8"><cpc:classification-symbol>H04W4/80</cpc:classification-symbol>
 <cpc:class-title><cpc:title-part><cpc:text>Child one</cpc:text></cpc:title-part></cpc:class-title>
  <cpc:classification-item level="9"><cpc:classification-symbol>H04W4/801</cpc:classification-symbol></cpc:classification-item>
 </cpc:classification-item>
</cpc:classification-item></cpc:class-scheme></ops:world-patent-data>`;

const req=(url)=>({sourceUrls:JSON.stringify({epo:'https://ops.epo.org/3.2/rest-services'}),source:'epo',url,method:'GET'});

test('CPC scheme URL is bounded to one symbol and a depth', () => {
  assert.equal(cpcSchemeUrl('H04W4/70'),'https://ops.epo.org/3.2/rest-services/classification/cpc/H04W4/70?depth=all');
  assert.equal(cpcSchemeUrl('G16Y',1),'https://ops.epo.org/3.2/rest-services/classification/cpc/G16Y?depth=1');
  assert.throws(()=>cpcSchemeUrl('H04W/../x'));
  assert.throws(()=>cpcSchemeUrl('H04W','999'));
});

test('parser returns symbols in scheme order with levels and titles', () => {
  const items=parseCpcScheme(XML);
  assert.deepEqual(items.map(i=>[i.symbol,i.level]),[['H04W4/70',7],['H04W4/80',8],['H04W4/801',9]]);
  assert.equal(items[0].title,'Services for machine-to-machine communication [M2M] & MTC');
  assert.equal(items[2].title,'');
});

test('parser rejects DTDs, entities and empty or foreign responses', () => {
  assert.throws(()=>parseCpcScheme('<!DOCTYPE x [<!ENTITY a "b">]>'+XML),/DTD/);
  assert.throws(()=>parseCpcScheme(''),/Empty/);
  assert.throws(()=>parseCpcScheme('<error><code>400</code></error>'),/no classification items/);
});

test('fetch goes through the epo gateway route and checks the requested symbol', async () => {
  const calls=[];
  const source=async(src,url,opt)=>{calls.push([src,url,opt.method]);return {status:200,contentType:'application/cpc+xml',text:XML};};
  const r=await fetchCpcScheme('H04W4/70',{config:{},source});
  assert.deepEqual(calls,[['epo','https://ops.epo.org/3.2/rest-services/classification/cpc/H04W4/70?depth=all','GET']]);
  assert.equal(r.items.length,3);
  await assert.rejects(fetchCpcScheme('G16Y',{config:{},source}),/does not contain the requested symbol/);
});

test('workflow validation allows the CPC path with depth only, and keeps the biblio rule', () => {
  for(const u of ['https://ops.epo.org/3.2/rest-services/classification/cpc/H04W','https://ops.epo.org/3.2/rest-services/classification/cpc/H04W4/70?depth=all',
    'https://ops.epo.org/3.2/rest-services/classification/cpc/G16Y?depth=2','https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/EP1000000.A1/biblio'])
    assert.doesNotThrow(()=>validateWorkflowSource(req(u),'epo'),u);
  for(const u of ['https://ops.epo.org/3.2/rest-services/classification/cpc/H04W?depth=all&x=1','https://ops.epo.org/3.2/rest-services/classification/cpc/H04W?navigation=true',
    'https://ops.epo.org/3.2/rest-services/classification/cpc/H04W4/70/../x','https://ops.epo.org/3.2/rest-services/classification/ipc/H04W',
    'https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/EP1000000/biblio?x=1'])
    assert.throws(()=>validateWorkflowSource(req(u),'epo'),undefined,u);
});

test('live EPO core build changes only the validation code and the Accept header', async () => {
  const {buildLiveEpoCore,VALIDATE_CODE,ACCEPT_EXPR}=await import('../extras/n8n/scripts/build-live-epo-core.mjs');
  const live={id:'patent-research-epo-core',nodes:[
    {name:'Validate Source Request',type:'n8n-nodes-base.code',parameters:{jsCode:"function validateWorkflowSource(j,route){};return [{json:validateWorkflowSource($input.first().json,'epo')}];"}},
    {name:'Provider',type:'n8n-nodes-base.httpRequest',credentials:{oAuth2Api:{id:'c1',name:'EPO'}},parameters:{url:'={{ $json.url }}',headerParameters:{parameters:[{name:'Accept',value:'application/exchange+xml'}]}}},
    {name:'Package Source Response',type:'n8n-nodes-base.code',parameters:{jsCode:'x'}}],
    connections:{'Validate Source Request':{main:[[{node:'Provider',type:'main',index:0}]]}}};
  const out=buildLiveEpoCore([live]);
  assert.equal(out.nodes[0].parameters.jsCode,VALIDATE_CODE);
  assert.deepEqual(out.nodes[1].parameters.headerParameters.parameters,[{name:'Accept',value:ACCEPT_EXPR}]);
  assert.deepEqual(out.nodes[1].credentials,live.nodes[1].credentials);
  assert.deepEqual(out.nodes[2],live.nodes[2]);
  assert.deepEqual(out.connections,live.connections);
  assert.doesNotThrow(()=>buildLiveEpoCore(out));  // idempotent on an already patched export
  assert.throws(()=>buildLiveEpoCore({...live,id:'other'}),/Expected/);
});
