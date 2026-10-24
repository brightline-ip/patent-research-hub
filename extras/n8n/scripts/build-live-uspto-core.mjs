// Builds the deployable version of the LIVE workflow patent-research-uspto-core from an n8n export: the provider
// HTTP node does not throw on provider errors (neverError; no fullResponse, which yields an unread stream here), and 'Package Source Response' embeds
// src/uspto-search-response.mjs. Every other node, the credential binding, connections and settings are unchanged.
// Usage: node extras/n8n/scripts/build-live-uspto-core.mjs <exported-live.json> [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {packageSearchResponse} from '../../../src/uspto-search-response.mjs';

export const PACKAGE_NODE='Package Source Response';
export const PACKAGE_CODE=`const pack=${packageSearchResponse.toString()};return [{json:pack($input.first().json)}];`;

export function buildLiveUsptoCore(exported){
  const w=Array.isArray(exported)?exported[0]:exported;
  if(w?.id!=='patent-research-uspto-core')throw Error('Expected the exported patent-research-uspto-core workflow');
  const http=w.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');
  if(http.length!==1||!http[0].credentials?.httpHeaderAuth)throw Error('Expected exactly one credentialed provider HTTP node');
  if(!w.nodes.some(n=>n.name===PACKAGE_NODE&&n.type==='n8n-nodes-base.code'))throw Error('Live workflow lacks '+PACKAGE_NODE);
  const nodes=w.nodes.map(n=>{
    if(n===http[0]){const options={...(n.parameters.options||{}),response:{response:{neverError:true}}};return {...n,parameters:{...n.parameters,options}};}
    if(n.name===PACKAGE_NODE)return {...n,parameters:{...n.parameters,jsCode:PACKAGE_CODE}};
    return n;
  });
  return {id:w.id,name:w.name,nodes,connections:w.connections,settings:w.settings,staticData:w.staticData??null,pinData:w.pinData??null,meta:w.meta??null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,output='extras/n8n/deployment/uspto-core.live.json']=process.argv.slice(2);
  if(!input)throw Error('usage: node extras/n8n/scripts/build-live-uspto-core.mjs <exported-live.json> [out.json]');
  const raw=fs.readFileSync(input,'utf8');
  fs.writeFileSync(output,JSON.stringify(buildLiveUsptoCore(JSON.parse(raw.slice(raw.indexOf('[')))),null,2)+'\n');
  console.log('Wrote '+output+' (import, then publish).');
}
