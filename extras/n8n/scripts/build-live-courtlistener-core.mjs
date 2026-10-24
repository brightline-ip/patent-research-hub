// Builds the CourtListener core for deployment from the LIVE workflow export, replacing only the validation code (so the
// bounded opinion-text fetch, /api/rest/v4/opinions/<id>/, is accepted). Credentials, settings, node ids and the provider
// node stay exactly as live. Same pattern as build-live-uspto-core.mjs.
// Usage: node extras/n8n/scripts/build-live-courtlistener-core.mjs <live-export.json> [out.json]
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateWorkflowSource} from '../../../src/workflow-validation.mjs';

export const VALIDATE_NODE='Validate Source Request';
export const VALIDATE_CODE=validateWorkflowSource.toString()+`;return [{json:validateWorkflowSource($input.first().json,'courtlistener')}];`;

export function buildLiveCourtListenerCore(live){
  const w=Array.isArray(live)?live[0]:live;
  if(w?.id!=='patent-research-courtlistener-core')throw Error('Expected the live patent-research-courtlistener-core export');
  const v=w.nodes.filter(n=>n.name===VALIDATE_NODE&&n.type==='n8n-nodes-base.code');
  if(v.length!==1)throw Error('Live workflow lacks exactly one '+VALIDATE_NODE+' code node');
  if(!/^function validateWorkflowSource\(/.test(v[0].parameters.jsCode)||!v[0].parameters.jsCode.endsWith(`'courtlistener')}];`))throw Error('Live validation code has an unexpected form; refusing to patch');
  const nodes=w.nodes.map(n=>n===v[0]?{...n,parameters:{...n.parameters,jsCode:VALIDATE_CODE}}:n);
  return {...w,nodes};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [input,out='extras/n8n/deployment/courtlistener-core.live.json']=process.argv.slice(2);
  if(!input)throw Error('usage: node extras/n8n/scripts/build-live-courtlistener-core.mjs <live-export.json> [out.json]');
  fs.writeFileSync(out,JSON.stringify([buildLiveCourtListenerCore(JSON.parse(fs.readFileSync(input,'utf8')))],null,2)+'\n');
  console.log('Wrote '+out+' (import and publish the core only; the gateway is unchanged).');
}
