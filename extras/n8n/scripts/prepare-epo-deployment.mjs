import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseEpoBiblio} from '../../../src/parsers.mjs';
import {validateWorkflowSource} from '../../../src/workflow-validation.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const write=(file,value)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value,null,2)+'\n');
const digest=value=>createHash('sha256').update(value).digest('hex');
const core=read('extras/n8n/workflows/epo-core.json'),gateway=read('extras/n8n/workflows/epo.json');

if(core.id!=='patent-research-epo-core'||gateway.id!=='patent-research-epo')throw new Error('Unexpected EPO workflow identity');
core.active=false;gateway.active=false;
core.name='Patent Research — EPO OPS (callable tool)';
gateway.name='Patent Research — EPO OPS (MCP gateway)';
const validation=core.nodes.find(node=>node.name==='Validate Source Request');
const provider=core.nodes.find(node=>node.type.endsWith('.httpRequest'));
if(!validation||!provider)throw new Error('EPO core workflow nodes are missing');
validation.parameters.jsCode=validateWorkflowSource.toString()+`;return [{json:validateWorkflowSource($input.first().json,'epo')}];`;
provider.parameters.authentication='genericCredentialType';
provider.parameters.genericAuthType='oAuth2Api';
provider.parameters.sendHeaders=true;
provider.parameters.headerParameters={parameters:[{name:'Accept',value:'application/exchange+xml'}]};
provider.parameters.options={timeout:25000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat:'text'}}};
delete provider.credentials;
write('extras/n8n/workflows/epo-core.json',core);write('extras/n8n/workflows/epo.json',gateway);

const sourceUrls=core.nodes.find(node=>node.name==='Connection Settings').parameters.assignments.assignments.find(item=>item.name==='sourceUrls').value;
const run=json=>vm.runInNewContext('(function(){'+validation.parameters.jsCode+'})()',{$input:{first:()=>({json:{...json,sourceUrls}})}})[0].json;
const canonical='https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/EP1000000.A1/biblio';
const accepted=run({source:'epo',url:canonical,method:'GET'});
for(const invalid of [canonical+'?x=1',canonical.replace('ops.epo.org','ops.epo.org.evil.test'),canonical.replace('/biblio','/full-cycle')]){
  let rejected=false;try{run({source:'epo',url:invalid,method:'GET'});}catch{rejected=true;}if(!rejected)throw new Error('EPO validation accepted an unsafe request');
}
const fixture=fs.readFileSync(path.join(root,'test','fixtures','epo-biblio.xml'),'utf8');
const parsed=parseEpoBiblio(fixture,'EP1000000');
if(parsed.documents.length!==2||parseEpoBiblio(fixture,'EP1000000.A1').documents.length!==1)throw new Error('EPO schema fixture validation failed');

const gatewayTrigger=gateway.nodes.find(node=>node.type.endsWith('.webhook'));
const gatewayCall=gateway.nodes.find(node=>node.type.endsWith('.executeWorkflow'));
const checks={
  portableCoreInactive:core.active===false,
  portableGatewayInactive:gateway.active===false,
  providerCredentialUnbound:provider.credentials===undefined,
  oauthClientCredentialsNode:provider.parameters.genericAuthType==='oAuth2Api',
  exchangeXmlRequested:provider.parameters.sendHeaders===true&&provider.parameters.headerParameters.parameters.some(item=>item.name==='Accept'&&item.value==='application/exchange+xml'),
  redirectsDisabled:provider.parameters.options.redirect.redirect.followRedirects===false,
  providerErrorsPreserved:provider.parameters.options.response.response.fullResponse===true&&provider.parameters.options.response.response.neverError===true,
  requestAllowlistPassed:accepted.url===canonical&&accepted.method==='GET',
  responseSchemaFixturePassed:parsed.documents.length===2,
  authenticatedGateway:gatewayTrigger?.parameters.authentication==='headerAuth',
  gatewayCallsCore:gatewayCall?.parameters.workflowId?.value==='patent-research-epo-core'&&gatewayCall?.parameters.options?.waitForSubWorkflow===true,
  executionRetentionDisabled:[core,gateway].every(workflow=>workflow.settings.saveDataSuccessExecution==='none'&&workflow.settings.saveDataErrorExecution==='none'&&workflow.settings.saveExecutionProgress===false)
};
if(!Object.values(checks).every(Boolean))throw new Error('EPO readiness checks failed: '+JSON.stringify(checks));

const workflows=fs.readdirSync(path.join(root,'extras','n8n','workflows')).filter(file=>file.endsWith('.json')).map(file=>JSON.parse(fs.readFileSync(path.join(root,'extras','n8n','workflows',file),'utf8')));
if(new Set(workflows.map(workflow=>workflow.id)).size!==workflows.length)throw new Error('Duplicate workflow ID');
write('extras/n8n/deployment/workflows.json',workflows);
write('extras/n8n/deployment/epo-workflows.json',[core,gateway]);
const readiness={
  generatedAt:new Date().toISOString(),
  status:'portable-ready',
  accountState:'current installation approved and live-verified; portable exports intentionally omit provider credentials',
  checks,
  workflowFiles:{
    core:{path:'extras/n8n/workflows/epo-core.json',sha256:digest(fs.readFileSync(path.join(root,'extras','n8n','workflows','epo-core.json')))},
    gateway:{path:'extras/n8n/workflows/epo.json',sha256:digest(fs.readFileSync(path.join(root,'extras','n8n','workflows','epo.json')))},
    deploymentBundle:{path:'extras/n8n/deployment/epo-workflows.json',sha256:digest(fs.readFileSync(path.join(root,'extras','n8n','deployment','epo-workflows.json')))}
  },
  credential:{type:'OAuth2 API',grantType:'Client Credentials',accessTokenUrl:'https://ops.epo.org/3.2/auth/accesstoken',authentication:'Header',scope:'',allowedDomains:['ops.epo.org'],storage:'n8n credential store; no secret values in repository artifacts'},
  pending:['On a new installation, create or reuse an approved EPO OPS application','Create the named n8n credential without exporting its values','Bind and publish the core, then publish the gateway','Repeat the bounded live query and unauthenticated-gateway rejection check']
};
write('data/epo-readiness.json',readiness);
console.log(JSON.stringify(readiness,null,2));
