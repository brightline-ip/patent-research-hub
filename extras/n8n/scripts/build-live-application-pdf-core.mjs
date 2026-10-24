// Builds the deployable version of the LIVE workflow patent-research-application-pdf-core (standard Code +
// HTTP Request nodes; it does not use the custom UsptoOriginal node). Takes a workflow exported from n8n and
// replaces only the three Code nodes' source with the tested functions in src/application-original.mjs.
// Usage: node extras/n8n/scripts/build-live-application-pdf-core.mjs <exported-live.json> [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {originalRequest,signedDownload,verifyOriginal} from '../../../src/application-original.mjs';

export const IDENTITY_NODE='Validate PTAB Document Identity';
export const CODE={
  [IDENTITY_NODE]:`const j=$input.first().json;const b=j.application_number?j:j.body||{};const request=${originalRequest.toString()};return [{json:request(b)}];`,
  'Validate USPTO signed download':`const validate=${signedDownload.toString()};return [{json:validate($input.first().json,$('${IDENTITY_NODE}').first().json)}];`,
  'Package Verified Original':`if($input.first().json.statusCode!==200)throw Error('USPTO original download failed');const b=await this.helpers.getBinaryDataBuffer(0,'data');const i=$('${IDENTITY_NODE}').first().json;const verify=${verifyOriginal.toString()};const contentType=verify(b,i);return [{json:{status:200,application_number:i.application_number,document_identifier:i.document_identifier,file_id:i.file_id??null,extension:i.extension,url:i.url,retrieved_at:new Date().toISOString(),contentType,bytes:b.length,base64:b.toString('base64')}}];`
};

export function buildLiveCore(exported){
  const w=Array.isArray(exported)?exported[0]:exported;
  if(w?.id!=='patent-research-application-pdf-core')throw Error('Expected the exported patent-research-application-pdf-core workflow');
  const seen=new Set();
  const nodes=w.nodes.map(n=>{
    if(!(n.name in CODE))return n;
    if(n.type!=='n8n-nodes-base.code')throw Error('Unexpected node type for '+n.name);
    seen.add(n.name);return {...n,parameters:{...n.parameters,jsCode:CODE[n.name]}};
  });
  for(const name of Object.keys(CODE))if(!seen.has(name))throw Error('Live workflow lacks node '+name);
  // HTTP Request nodes, credentials, connections and settings are carried over unchanged.
  return {id:w.id,name:w.name,nodes,connections:w.connections,settings:w.settings,staticData:w.staticData??null,pinData:w.pinData??null,meta:w.meta??null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,output='extras/n8n/deployment/application-pdf-core.live.json']=process.argv.slice(2);
  if(!input)throw Error('usage: node extras/n8n/scripts/build-live-application-pdf-core.mjs <exported-live.json> [out.json]');
  const raw=fs.readFileSync(input,'utf8');
  fs.writeFileSync(output,JSON.stringify(buildLiveCore(JSON.parse(raw.slice(raw.indexOf('[')>=0&&raw.indexOf('[')<raw.indexOf('{')?raw.indexOf('['):raw.indexOf('{')))),null,2)+'\n');
  console.log('Wrote '+output+' (import, then publish; credentials and HTTP nodes unchanged).');
}
