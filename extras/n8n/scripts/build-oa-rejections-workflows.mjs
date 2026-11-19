// Builds the two n8n workflows of the Office Action Rejections route, mirroring the existing search route:
//   patent-research-oa-rejections       webhook POST /webhook/patent-research-oa-rejections (inbound header auth) -> core
//   patent-research-oa-rejections-core  validate (src/oa-rejections.mjs) -> records (POST) or fields (GET) HTTP node with the USPTO ODP credential
//                                       (neverError, no redirects) -> package
// Usage: node extras/n8n/scripts/build-oa-rejections-workflows.mjs [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {rejectionsRequest,packageRejectionsResponse} from '../../../src/oa-rejections.mjs';

export const CORE_ID='patent-research-oa-rejections-core', GATEWAY_ID='patent-research-oa-rejections';
const SETTINGS={executionTimeout:270,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveExecutionProgress:false,saveManualExecutions:false,callerPolicy:'workflowsFromSameOwner'};
export const VALIDATE_CODE=`const j=$input.first().json;const b=j.action||j.application_numbers?j:j.body||{};const req=${rejectionsRequest.toString()};return [{json:req(b)}];`;
export const PACKAGE_CODE=`const pack=${packageRejectionsResponse.toString()};return [{json:pack($input.first().json)}];`;

export function buildOaRejectionsWorkflows({credential={id:'REPLACE_WITH_USPTO_CREDENTIAL_ID',name:'USPTO ODP API Key'},inbound={id:'REPLACE_WITH_GATEWAY_CREDENTIAL_ID',name:'Research Gateway - Inbound Header Auth'}}={}){
  const core={id:CORE_ID,name:'Patent Research - USPTO Office Action Rejections (callable tool)',settings:SETTINGS,staticData:null,pinData:null,meta:null,
    nodes:[
      {id:'r1',name:'When Called by Another Workflow',type:'n8n-nodes-base.executeWorkflowTrigger',typeVersion:1.1,position:[-650,0],parameters:{inputSource:'passthrough'}},
      {id:'r2',name:'Validate Rejections Request',type:'n8n-nodes-base.code',typeVersion:2,position:[-400,0],parameters:{jsCode:VALIDATE_CODE}},
      // Fixed method/sendBody/content type per branch, like the search node: with these as expressions the
      // provider received no usable POST body and answered "Request failed".
      {id:'r5',name:'Is Records Request',type:'n8n-nodes-base.if',typeVersion:1,position:[-275,0],
        parameters:{conditions:{string:[{value1:'={{ $json.method }}',value2:'POST'}]}}},
      {id:'r3',name:'Provider - USPTO ODP credential',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[-150,-100],
        parameters:{method:'POST',url:'={{ $json.url }}',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',
          sendBody:true,contentType:'raw',rawContentType:'application/x-www-form-urlencoded',body:'={{ $json.body }}',
          options:{timeout:60000,redirect:{redirect:{followRedirects:false}},response:{response:{neverError:true}}}},
        credentials:{httpHeaderAuth:credential}},
      {id:'r6',name:'Provider fields - USPTO ODP credential',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[-150,100],
        parameters:{method:'GET',url:'={{ $json.url }}',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',
          options:{timeout:60000,redirect:{redirect:{followRedirects:false}},response:{response:{neverError:true}}}},
        credentials:{httpHeaderAuth:credential}},
      {id:'r4',name:'Package Rejections Response',type:'n8n-nodes-base.code',typeVersion:2,position:[100,0],parameters:{jsCode:PACKAGE_CODE}}],
    connections:{'When Called by Another Workflow':{main:[[{node:'Validate Rejections Request',type:'main',index:0}]]},
      'Validate Rejections Request':{main:[[{node:'Is Records Request',type:'main',index:0}]]},
      'Is Records Request':{main:[[{node:'Provider - USPTO ODP credential',type:'main',index:0}],[{node:'Provider fields - USPTO ODP credential',type:'main',index:0}]]},
      'Provider fields - USPTO ODP credential':{main:[[{node:'Package Rejections Response',type:'main',index:0}]]},
      'Provider - USPTO ODP credential':{main:[[{node:'Package Rejections Response',type:'main',index:0}]]}}};
  const gateway={id:GATEWAY_ID,name:'Patent Research - USPTO Office Action Rejections (authenticated gateway)',settings:SETTINGS,staticData:null,pinData:null,meta:null,
    nodes:[
      {id:'g1',name:'Research Webhook',type:'n8n-nodes-base.webhook',typeVersion:2,position:[-400,0],webhookId:'7d0c1a52-6f3e-4b8a-9e21-a0b1c2000001',
        parameters:{httpMethod:'POST',path:GATEWAY_ID,authentication:'headerAuth',responseMode:'responseNode',options:{}},credentials:{httpHeaderAuth:inbound}},
      {id:'g2',name:'Call Shared Source Tool',type:'n8n-nodes-base.executeWorkflow',typeVersion:1.2,position:[-150,0],parameters:{workflowId:{__rl:true,value:CORE_ID,mode:'id'},mode:'each',options:{waitForSubWorkflow:true}}},
      {id:'g3',name:'Return Result',type:'n8n-nodes-base.respondToWebhook',typeVersion:1.4,position:[100,0],parameters:{respondWith:'json',responseBody:'={{ $json }}',options:{}}}],
    connections:{'Research Webhook':{main:[[{node:'Call Shared Source Tool',type:'main',index:0}]]},'Call Shared Source Tool':{main:[[{node:'Return Result',type:'main',index:0}]]}}};
  return [core,gateway];
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const out=process.argv[2]||'extras/n8n/deployment/oa-rejections.workflows.json';
  fs.writeFileSync(out,JSON.stringify(buildOaRejectionsWorkflows(),null,2)+'\n');
  console.log('Wrote '+out+' (import both, publish core first, then gateway).');
}
