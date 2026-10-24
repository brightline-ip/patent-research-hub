import test from 'node:test';
import assert from 'node:assert/strict';
import {packageSearchResponse} from '../src/uspto-search-response.mjs';
import {buildLiveUsptoCore,PACKAGE_CODE} from '../extras/n8n/scripts/build-live-uspto-core.mjs';

const OLD_PACKAGE=json=>({text:JSON.stringify(json),status:200,contentType:'application/json'}); // the pre-2026-10-17 live code

test('success bodies are packaged exactly as before',()=>{
  for(const body of [{count:199,patentFileWrapperDataBag:[{applicationNumberText:'1'}],requestIdentifier:'r'},{count:0,patentFileWrapperDataBag:[]}])
    assert.deepEqual(packageSearchResponse(body),OLD_PACKAGE(body));
});
test('ODP 404 "No matching records" (live body shape) becomes an explicit zero result',()=>{
  const r=packageSearchResponse({code:404,message:'Not Found',detailedMessage:'No matching records found, refine your search criteria and try again',requestIdentifier:'x'});
  assert.equal(r.status,200);const p=JSON.parse(r.text);
  assert.deepEqual([p.count,p.patentFileWrapperDataBag,p.provider_status],[0,[],404]);
  assert.equal(packageSearchResponse({code:'404',message:'Not Found',detailedMessage:'No matching records found'}).status,200);
});
test('other provider errors keep their status; unrecognized bodies never pass as success',()=>{
  for(const [body,status] of [[{code:404,message:'Not Found',detailedMessage:'Resource missing'},404],[{code:400,message:'Bad Request',detailedMessage:'Invalid query'},400],
    [{code:429,message:'Too Many Requests'},429],[{code:500,message:'x'.repeat(5000)},500],[{data:'<html>bad gateway</html>'},502],[null,502],[[],502],[{code:404,count:3},404]]){
    const r=packageSearchResponse(body);assert.equal(r.status,status,JSON.stringify(body).slice(0,60));
    const p=JSON.parse(r.text);assert.equal(p.count,undefined);assert.ok(String(p.provider_message).length<=300);
  }
});
test('live build sets only neverError on the provider node and replaces only the package code',()=>{
  const live={id:'patent-research-uspto-core',name:'x',settings:{a:1},connections:{c:1},nodes:[
    {name:'Validate Source Request',type:'n8n-nodes-base.code',parameters:{jsCode:'keep'}},
    {name:'Provider',type:'n8n-nodes-base.httpRequest',parameters:{url:'={{ $json.url }}',options:{timeout:25000,redirect:{redirect:{followRedirects:false}}}},credentials:{httpHeaderAuth:{id:'k'}}},
    {name:'Package Source Response',type:'n8n-nodes-base.code',parameters:{jsCode:'old'}}]};
  const out=buildLiveUsptoCore([live]);
  assert.deepEqual(out.nodes[0],live.nodes[0]);assert.deepEqual(out.connections,live.connections);assert.deepEqual(out.settings,live.settings);
  assert.deepEqual(out.nodes[1].parameters.options,{timeout:25000,redirect:{redirect:{followRedirects:false}},response:{response:{neverError:true}}});
  assert.deepEqual(out.nodes[1].credentials,live.nodes[1].credentials);
  const run=new Function('$input',out.nodes[2].parameters.jsCode);
  const [{json}]=run({first:()=>({json:{code:404,message:'Not Found',detailedMessage:'No matching records found'}})});
  assert.equal(JSON.parse(json.text).count,0);assert.equal(out.nodes[2].parameters.jsCode,PACKAGE_CODE);
});
