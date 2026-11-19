// Builds the GovInfo core for deployment from the LIVE workflow export: replaces only the validation code and adds a PDF
// branch for one USCOURTS opinion (granule) by id. The existing search path (provider node + package node) is unchanged.
//   Validate -> Is Opinion PDF (method GET) -> [true]  Provider PDF (literal GET, file response) -> Package Opinion PDF
//                                           -> [false] existing provider node -> existing Package Source Response
// Usage: node extras/n8n/scripts/build-live-govinfo-core.mjs <live-export.json> [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateWorkflowSource} from '../../../src/workflow-validation.mjs';

export const VALIDATE_NODE='Validate Source Request',IF_NODE='Is Opinion PDF',PDF_NODE='Provider PDF — GovInfo credential',PACK_NODE='Package Opinion PDF';
export {MAX_GOVINFO_PDF_BYTES} from '../../../src/govinfo-pdf.mjs';
import {MAX_GOVINFO_PDF_BYTES} from '../../../src/govinfo-pdf.mjs';
export const VALIDATE_CODE=validateWorkflowSource.toString()+`;return [{json:validateWorkflowSource($input.first().json,'govinfo')}];`;
export const PACK_CODE=`const r=$input.first().json,url=$('${VALIDATE_NODE}').first().json.url,ct=String(r.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();
if(r.statusCode!==200)return [{json:{status:Number(r.statusCode)||502,url,contentType:ct,error:'GovInfo PDF request failed (HTTP '+Number(r.statusCode||0)+')'}}];
const b=await this.helpers.getBinaryDataBuffer(0,'data');
if(ct!=='application/pdf'||b.length>${MAX_GOVINFO_PDF_BYTES}||b.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('GovInfo original is oversized or is not a PDF');
return [{json:{status:200,url,contentType:'application/pdf',bytes:b.length,base64:b.toString('base64')}}];`;

export function buildLiveGovinfoCore(live){
  const w=Array.isArray(live)?live[0]:live;
  if(w?.id!=='patent-research-govinfo-core')throw Error('Expected the live patent-research-govinfo-core export');
  const v=w.nodes.filter(n=>n.name===VALIDATE_NODE&&n.type==='n8n-nodes-base.code');
  if(v.length!==1||!/^function validateWorkflowSource\(/.test(v[0].parameters.jsCode)||!v[0].parameters.jsCode.endsWith(`'govinfo')}];`))throw Error('Live validation node has an unexpected form; refusing to patch');
  if(w.nodes.some(n=>[IF_NODE,PDF_NODE,PACK_NODE].includes(n.name)))throw Error('Live workflow already has the PDF branch');
  const providers=w.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');
  if(providers.length!==1||!providers[0].credentials?.httpHeaderAuth?.id)throw Error('Expected exactly one credentialed provider node');
  const provider=providers[0],next=w.connections[VALIDATE_NODE]?.main?.[0]?.[0]?.node;
  if(next!==provider.name)throw Error('Validation does not feed the provider node; refusing to patch');
  const [x,y]=provider.position;
  const nodes=[...w.nodes.map(n=>n===v[0]?{...n,parameters:{...n.parameters,jsCode:VALIDATE_CODE}}:n),
    {id:'govinfo-pdf-if',name:IF_NODE,type:'n8n-nodes-base.if',typeVersion:1,position:[x-120,y+180],parameters:{conditions:{string:[{value1:'={{ $json.method }}',value2:'GET'}]}}},
    {id:'govinfo-pdf-http',name:PDF_NODE,type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[x,y+180],
      parameters:{method:'GET',url:'={{ $json.url }}',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',
        options:{timeout:60000,redirect:{redirect:{followRedirects:false}},response:{response:{responseFormat:'file',outputPropertyName:'data',fullResponse:true,neverError:true}}}},
      credentials:{httpHeaderAuth:{...provider.credentials.httpHeaderAuth}}},
    {id:'govinfo-pdf-pack',name:PACK_NODE,type:'n8n-nodes-base.code',typeVersion:2,position:[x+150,y+180],parameters:{jsCode:PACK_CODE}}];
  const connections={...w.connections,
    [VALIDATE_NODE]:{main:[[{node:IF_NODE,type:'main',index:0}]]},
    [IF_NODE]:{main:[[{node:PDF_NODE,type:'main',index:0}],[{node:provider.name,type:'main',index:0}]]},
    [PDF_NODE]:{main:[[{node:PACK_NODE,type:'main',index:0}]]}};
  return {...w,nodes,connections};
}

// Re-deploy of an already patched core (size limit raised from 10 MB to 40 MB): replace only the package code, and only
// when the live code is exactly what this build produced with an earlier limit.
export function refreshPackCode(live){
  const w=Array.isArray(live)?live[0]:live;
  if(w?.id!=='patent-research-govinfo-core')throw Error('Expected the live patent-research-govinfo-core export');
  const p=w.nodes.filter(n=>n.name===PACK_NODE&&n.type==='n8n-nodes-base.code');
  if(p.length!==1)throw Error('Live workflow has no single '+PACK_NODE+' node');
  const old=p[0].parameters.jsCode,m=old.match(/b\.length>(\d+)/);
  if(!m||old.replace(m[0],'b.length>'+MAX_GOVINFO_PDF_BYTES)!==PACK_CODE)throw Error('Live package code differs from this build beyond the size limit; refusing to patch');
  return {...w,nodes:w.nodes.map(n=>n===p[0]?{...n,parameters:{...n.parameters,jsCode:PACK_CODE}}:n)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv[2]==='--refresh-pack'){
  const [,input,out='extras/n8n/deployment/govinfo-core.live.json']=process.argv.slice(2);
  fs.writeFileSync(out,JSON.stringify([refreshPackCode(JSON.parse(fs.readFileSync(input,'utf8')))],null,2)+'\n');
  console.log('Wrote '+out+' (package code only; import and publish the core).');
} else if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,out='extras/n8n/deployment/govinfo-core.live.json']=process.argv.slice(2);
  if(!input)throw Error('usage: node extras/n8n/scripts/build-live-govinfo-core.mjs <live-export.json> [out.json]');
  fs.writeFileSync(out,JSON.stringify([buildLiveGovinfoCore(JSON.parse(fs.readFileSync(input,'utf8')))],null,2)+'\n');
  console.log('Wrote '+out+' (import and publish the core only; the gateway is unchanged).');
}
