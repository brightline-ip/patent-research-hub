// Builds the EPO OPS core for deployment from the LIVE workflow export, adding CPC scheme lookups
// (GET /classification/cpc/{symbol}[?depth=...]) to the existing connector. Two changes only:
//   1. the validation node gets the current validateWorkflowSource (CPC path + depth allowed; biblio rule unchanged);
//   2. the provider node's Accept header becomes request-dependent: application/cpc+xml for the CPC scheme,
//      application/exchange+xml (unchanged) for bibliographic lookups.
// The credential binding, gateway, trigger and response packaging are untouched.
// Usage: node extras/n8n/scripts/build-live-epo-core.mjs <live-export.json> [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateWorkflowSource} from '../../../src/workflow-validation.mjs';

export const VALIDATE_NODE='Validate Source Request';
export const VALIDATE_CODE=validateWorkflowSource.toString()+`;return [{json:validateWorkflowSource($input.first().json,'epo')}];`;
export const ACCEPT_EXPR="={{ String($json.url).includes('/classification/cpc/') ? 'application/cpc+xml' : 'application/exchange+xml' }}";

export function buildLiveEpoCore(live){
  const w=Array.isArray(live)?live[0]:live;
  if(w?.id!=='patent-research-epo-core')throw Error('Expected the live patent-research-epo-core export');
  const v=w.nodes.filter(n=>n.name===VALIDATE_NODE&&n.type==='n8n-nodes-base.code');
  if(v.length!==1||!/^function validateWorkflowSource\(/.test(v[0].parameters.jsCode)||!v[0].parameters.jsCode.endsWith(`'epo')}];`))throw Error('Live validation node has an unexpected form; refusing to patch');
  const providers=w.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest');
  if(providers.length!==1||!providers[0].credentials?.oAuth2Api?.id)throw Error('Expected exactly one OAuth2-credentialed provider node');
  const p=providers[0],headers=p.parameters?.headerParameters?.parameters||[];
  const accept=headers.filter(h=>h.name==='Accept');
  if(accept.length!==1||![ 'application/exchange+xml',ACCEPT_EXPR].includes(accept[0].value))throw Error('Provider Accept header has an unexpected form; refusing to patch');
  if(w.connections[VALIDATE_NODE]?.main?.[0]?.[0]?.node!==p.name)throw Error('Validation does not feed the provider node; refusing to patch');
  const nodes=w.nodes.map(n=>n===v[0]?{...n,parameters:{...n.parameters,jsCode:VALIDATE_CODE}}
    :n===p?{...n,parameters:{...n.parameters,headerParameters:{parameters:headers.map(h=>h.name==='Accept'?{...h,value:ACCEPT_EXPR}:h)}}}:n);
  return {...w,nodes};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,out='extras/n8n/deployment/epo-core.live.json']=process.argv.slice(2);
  if(!input)throw Error('usage: node extras/n8n/scripts/build-live-epo-core.mjs <live-export.json> [out.json]');
  fs.writeFileSync(out,JSON.stringify([buildLiveEpoCore(JSON.parse(fs.readFileSync(input,'utf8')))],null,2)+'\n');
  console.log('Wrote '+out+' (import and publish the core only; the gateway is unchanged).');
}
