import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectionsRequest,packageRejectionsResponse} from '../src/oa-rejections.mjs';
import {buildOaRejectionsWorkflows,VALIDATE_CODE,CORE_ID,GATEWAY_ID} from '../extras/n8n/scripts/build-oa-rejections-workflows.mjs';

test('records requests build the criteria from application numbers only',()=>{
  const r=rejectionsRequest({action:'records',application_numbers:['17000001','17000002','17000001'],rows:50});
  assert.equal(r.url,'https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/records');assert.equal(r.method,'POST');
  assert.equal(decodeURIComponent(r.body.split('&')[0].slice('criteria='.length)),'patentApplicationNumber:(17000001 OR 17000002)');
  assert.match(r.body,/&start=0&rows=50$/);
  assert.equal(rejectionsRequest({action:'fields'}).url,'https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/fields');
});
test('anything outside the bounded contract is refused',()=>{
  for(const b of [{action:'records',application_numbers:[]},{action:'records',application_numbers:['1631904']},{action:'records',application_numbers:['17000001) OR (*']},
    {action:'records',application_numbers:Array(101).fill('17000001')},{action:'records',application_numbers:['17000001'],rows:101},{action:'records',application_numbers:['17000001'],start:-1},
    {action:'records',application_numbers:['17000001'],field:'*:*'},{action:'delete'},{action:'records',application_numbers:'17000001'}])
    assert.throws(()=>rejectionsRequest(b),JSON.stringify(b).slice(0,60));
});
test('responses: success passes through, provider errors keep status, unknown is 502',()=>{
  const ok={response:{numFound:2,start:0,docs:[{hasRej101:1}]}};
  assert.deepEqual(packageRejectionsResponse(ok),{text:JSON.stringify(ok),status:200,contentType:'application/json'});
  assert.equal(packageRejectionsResponse({code:400,message:'Bad Request',detailedMessage:'bad criteria'}).status,400);
  assert.equal(packageRejectionsResponse({code:'404',message:'Not Found'}).status,404);
  assert.equal(packageRejectionsResponse(null).status,502);assert.equal(packageRejectionsResponse([]).status,502);
  // a non-JSON provider page arrives from n8n as {data:'<html>...'}: an error, not a 200 (live 2026-10-17)
  const html=packageRejectionsResponse({data:'<html><head><title>Error</title></head><body>Request failed.</body></html>'});
  assert.equal(html.status,502);assert.match(JSON.parse(html.text).provider_message,/Request failed/);
  assert.equal(packageRejectionsResponse({error:'x',response:'nope'}).status,502);
  // the field list has no {response}: it must stay a 200 (live shape 2026-10-17)
  assert.equal(packageRejectionsResponse({apiKey:'oa_rejections',apiStatus:'PUBLISHED',fieldCount:2,fields:['hasRej101','patentApplicationNumber']}).status,200);
});
test('workflows: core uses the existing credential, gateway calls core, embedded code runs',()=>{
  const [core,gw]=buildOaRejectionsWorkflows();
  assert.equal(core.id,CORE_ID);assert.equal(gw.id,GATEWAY_ID);
  const http=core.nodes.find(n=>n.type==='n8n-nodes-base.httpRequest');
  assert.equal(http.credentials.httpHeaderAuth.id,'REPLACE_WITH_USPTO_CREDENTIAL_ID');assert.deepEqual(http.parameters.options.response,{response:{neverError:true}});
  assert.equal(http.parameters.options.redirect.redirect.followRedirects,false);
  // method, sendBody and content type must be literals (expressions there broke the live POST on 2026-10-17)
  const [rec,fld]=core.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');
  assert.equal(rec.parameters.method,'POST');assert.equal(rec.parameters.sendBody,true);assert.equal(rec.parameters.rawContentType,'application/x-www-form-urlencoded');
  assert.equal(fld.parameters.method,'GET');assert.equal(fld.parameters.sendBody,undefined);assert.equal(fld.credentials.httpHeaderAuth.id,'REPLACE_WITH_USPTO_CREDENTIAL_ID');
  assert.deepEqual(core.connections['Is Records Request'].main.map(b=>b[0].node),[rec.name,fld.name]);
  for(const n of [rec,fld])assert.equal(core.connections[n.name].main[0][0].node,'Package Rejections Response');
  assert.equal(gw.nodes.find(n=>n.type.endsWith('.executeWorkflow')).parameters.workflowId.value,CORE_ID);
  assert.equal(gw.nodes[0].parameters.path,'patent-research-oa-rejections');assert.equal(gw.nodes[0].parameters.authentication,'headerAuth');
  const run=new Function('$input',VALIDATE_CODE);
  const [{json}]=run({first:()=>({json:{body:{action:'records',application_numbers:['17000001']}}})});
  assert.equal(json.method,'POST');assert.throws(()=>run({first:()=>({json:{body:{action:'records',application_numbers:['x']}}})}));
});
