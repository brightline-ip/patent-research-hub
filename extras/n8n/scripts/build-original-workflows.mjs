import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function buildOriginalWorkflows(){
  const template=JSON.parse(fs.readFileSync(new URL('../workflows/ptab-core.json',import.meta.url),'utf8'));
  const gateway=JSON.parse(fs.readFileSync(new URL('../workflows/ptab.json',import.meta.url),'utf8'));
  const node=(name,type,parameters,x,version=2)=>({id:randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:version,position:[x,0],parameters});
  const stream={id:randomUUID(),name:'Stream and Verify PTAB Original',type:'n8n-nodes-patent-research.usptoOriginal',typeVersion:1,position:[0,0],parameters:{operation:'ptab',trialNumber:'={{ $json.trialNumber || $json.body?.trialNumber }}',appealNumber:'={{ $json.appealNumber || $json.body?.appealNumber }}',documentIdentifier:'={{ $json.documentIdentifier || $json.body?.documentIdentifier }}',maxBytes:10485760,timeoutMs:60000},credentials:template.nodes.find(n=>n.type.endsWith('.httpRequest')).credentials};
  const note={id:randomUUID(),name:'Streaming Boundary',type:'n8n-nodes-base.stickyNote',typeVersion:1,position:[-50,260],parameters:{width:800,height:230,content:'## Reviewed streaming PTAB original connector\nInstall the local n8n node package before publishing this workflow. The node derives the exact trial/appeal URL from identity fields, keeps the API key on the authorization request, validates one exact signed redirect, caps bytes while streaming, checks MIME/length/PDF signature, pins public provider DNS, applies one 60-second deadline, and allows two in-flight originals per process. Signed URLs never become outputs.'}};
  const core={...template,id:'patent-research-ptab-files-core',name:'Patent Research — PTAB original PDFs (callable tool)',active:false,nodes:[node('When Called by Another Workflow','executeWorkflowTrigger',{inputSource:'passthrough'},-450,1.1),stream,note],connections:{}};
  core.connections['When Called by Another Workflow']={main:[[{node:'Stream and Verify PTAB Original',type:'main',index:0}]]};
  gateway.id='patent-research-ptab-files';gateway.name='Patent Research — PTAB original PDFs (MCP gateway)';gateway.active=false;
  const webhook=gateway.nodes.find(n=>n.type.endsWith('.webhook'));webhook.webhookId=randomUUID();webhook.parameters.path='patent-research-ptab-files';
  gateway.nodes.find(n=>n.type.endsWith('.executeWorkflow')).parameters.workflowId.value=core.id;
  return [core,gateway];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const workflows=buildOriginalWorkflows();
  fs.mkdirSync('extras/n8n/deployment',{recursive:true});
  for(const w of workflows)fs.writeFileSync('extras/n8n/workflows/'+w.id.replace('patent-research-','')+'.json',JSON.stringify(w,null,2));
  fs.writeFileSync('extras/n8n/deployment/original-workflows.json',JSON.stringify(workflows,null,2));
  console.log('Prepared only the two PTAB original-file workflows; existing workflows are not modified.');
}
