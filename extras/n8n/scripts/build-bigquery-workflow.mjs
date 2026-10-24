import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {externalAccess} from '../../../src/external-access.mjs';
import {buildBigQueryExecutionRequest} from '../../../src/bigquery.mjs';

const base=JSON.parse(fs.readFileSync('extras/n8n/workflows/reference-index-core.json','utf8'));
const gatewayTemplate=JSON.parse(fs.readFileSync('extras/n8n/workflows/external-access.json','utf8'));
const config=JSON.parse(fs.readFileSync('config.json','utf8'));
const projectId=config.googleBigQueryProjectId||'';
const maximumBytesBilled=config.googleBigQueryPerQueryMaxBytes||'';
const node=(name,type,parameters,position,version=2)=>({id:randomUUID(),name,type:'n8n-nodes-base.'+type,typeVersion:version,position,parameters});
const main=nodeName=>({main:[[{node:nodeName,type:'main',index:0}]]});
const authRequest=(name,method,url,position,body)=>node(name,'httpRequest',{method,url,authentication:'predefinedCredentialType',nodeCredentialType:'googleBigQueryOAuth2Api',...(body?{sendBody:true,specifyBody:'json',jsonBody:body}:{}),options:{timeout:180000,redirect:{redirect:{followRedirects:false}},response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}}}},position,4.2);

function gateway(core,id,name){
 const result=structuredClone(gatewayTemplate);result.id=id;result.name=name;result.active=false;
 const webhook=result.nodes.find(n=>n.type.endsWith('.webhook'));webhook.id=randomUUID();webhook.webhookId=randomUUID();webhook.parameters.path=id;
 const call=result.nodes.find(n=>n.type.endsWith('.executeWorkflow'));call.id=randomUUID();call.parameters.workflowId.value=core.id;
 result.nodes.find(n=>n.type.endsWith('.respondToWebhook')).id=randomUUID();return result;
}

export function buildBigQueryWorkflows(){
 const callable=node('When Called by Another Workflow','executeWorkflowTrigger',{inputSource:'passthrough'},[-700,-120],1.1);
 const manual=node('Manual Dry Run','manualTrigger',{},[-700,160],1);
 const sample=node('Manual Test Parameters','set',{assignments:{assignments:[{id:randomUUID(),name:'cpc',type:'string',value:'G06N'},{id:randomUUID(),name:'from',type:'number',value:2024},{id:randomUUID(),name:'to',type:'number',value:2024}]},includeOtherFields:true,options:{}},[-470,160],3.4);
 const settings=node('Google Cloud Connection Settings','set',{assignments:{assignments:[{id:randomUUID(),name:'projectId',type:'string',value:projectId},{id:randomUUID(),name:'executionEnabled',type:'boolean',value:false}]},includeOtherFields:true,options:{}},[-230,0],3.4);
 const build=node('Build Fixed CPC Dry Run','code',{jsCode:externalAccess.toString()+`;const j=$input.first().json,b=j.body||j;if(j.executionEnabled!==false)throw new Error('This workflow is permanently restricted to dry-run mode');if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(j.projectId))throw new Error('Set your Google Cloud project ID in Connection Settings');const plan=externalAccess({source:'google-bigquery',cpc:b.cpc,from:b.from,to:b.to});if(plan.request.configuration.dryRun!==true)throw new Error('Dry-run guard failed');return [{json:{url:'https://bigquery.googleapis.com/bigquery/v2/projects/'+j.projectId+'/jobs',request:plan.request,countingUnit:plan.countingUnit}}];`},[20,0]);
 const request=authRequest('BigQuery — select dedicated OAuth credential','POST','={{ $json.url }}',[280,0],'={{ $json.request }}');
 const result=node('Return Dry Run Estimate','code',{jsCode:"const r=$input.first().json,b=r.body??r.data??{};return [{json:{status:r.statusCode,dryRun:true,executedDataQuery:false,jobReference:b.jobReference,statistics:b.statistics,error:b.error,warning:'This checks permissions, SQL/schema and estimated bytes only. It cannot run a data query.'}}];"},[550,0]);
 const dryCore={...base,id:'patent-research-google-bigquery-core',name:'Patent Research — Google BigQuery dry run (credential setup required)',active:false,nodes:[callable,manual,sample,settings,build,request,result],connections:{[callable.name]:main(settings.name),[manual.name]:main(sample.name),[sample.name]:main(settings.name),[settings.name]:main(build.name),[build.name]:main(request.name),[request.name]:main(result.name)}};
 const dryGateway=gateway(dryCore,'patent-research-google-bigquery','Patent Research — Google BigQuery dry-run estimator (MCP gateway)');

 const called=node('When Called by Another Workflow','executeWorkflowTrigger',{inputSource:'passthrough'},[-820,0],1.1);
 const executionSettings=node('Capped Sandbox Policy','set',{assignments:{assignments:[{id:randomUUID(),name:'projectId',type:'string',value:projectId},{id:randomUUID(),name:'executionEnabled',type:'boolean',value:true},{id:randomUUID(),name:'billingMode',type:'string',value:'sandbox-no-billing'},{id:randomUUID(),name:'maximumBytesBilled',type:'string',value:maximumBytesBilled}]},includeOtherFields:true,options:{}},[-600,0],3.4);
 const buildExecution=node('Build Fixed CPC Trend Query','code',{jsCode:externalAccess.toString()+'\n'+buildBigQueryExecutionRequest.toString()+`;const j=$input.first().json,b=j.body||j;if(j.executionEnabled!==true||j.billingMode!=='sandbox-no-billing')throw new Error('Capped sandbox execution policy is disabled');if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(j.projectId))throw new Error('Set the isolated Google Cloud project ID');const plan=externalAccess({source:'google-bigquery',cpc:b.cpc,from:b.from,to:b.to});const request=buildBigQueryExecutionRequest(plan,j.maximumBytesBilled);return [{json:{queryUrl:'https://bigquery.googleapis.com/bigquery/v2/projects/'+j.projectId+'/queries',metadataUrl:'https://bigquery.googleapis.com/bigquery/v2/projects/patents-public-data/datasets/patents/tables/publications',request,maximumBytesBilled:j.maximumBytesBilled}}];`},[-350,0]);
 const metadata=authRequest('Read Google Patents table metadata','GET','={{ $json.metadataUrl }}',[-80,0]);
 const validateMetadata=node('Validate Google Patents table metadata','code',{jsCode:`const r=$input.first().json,b=r.body??r.data??{},built=$('Build Fixed CPC Trend Query').first().json,t=b.tableReference;if(r.statusCode!==200||t?.projectId!=='patents-public-data'||t?.datasetId!=='patents'||t?.tableId!=='publications'||!/^(0|[1-9]\\d*)$/.test(b.lastModifiedTime||'')||!/^(0|[1-9]\\d*)$/.test(b.numRows||'')||!/^(0|[1-9]\\d*)$/.test(b.numBytes||''))throw new Error('Google Patents table metadata could not be verified');return [{json:{...built,tableMetadata:{projectId:t.projectId,datasetId:t.datasetId,tableId:t.tableId,lastModifiedTime:b.lastModifiedTime,numRows:b.numRows,numBytes:b.numBytes}}}];`},[190,0]);
 const execute=authRequest('Execute capped CPC trend query','POST','={{ $json.queryUrl }}',[470,0],'={{ $json.request }}');
 const packageResult=node('Return Verified Query Envelope','code',{jsCode:`const r=$input.first().json,b=r.body??r.data??{},built=$('Validate Google Patents table metadata').first().json;return [{json:{status:r.statusCode,dryRun:false,executedDataQuery:r.statusCode===200&&b.jobComplete===true&&!b.error&&!(b.errors?.length),jobComplete:b.jobComplete===true,jobReference:b.jobReference,schema:b.schema,rows:b.rows||[],totalRows:b.totalRows,totalBytesProcessed:b.totalBytesProcessed,totalBytesBilled:b.totalBytesBilled,cacheHit:b.cacheHit===true,error:b.error,errors:b.errors,maximumBytesBilled:built.maximumBytesBilled,tableMetadataStatus:200,tableMetadata:built.tableMetadata}}];`},[750,0]);
 const queryCore={...base,id:'patent-research-google-bigquery-query-core',name:'Patent Research — Google BigQuery capped CPC trend (credential setup required)',active:false,nodes:[called,executionSettings,buildExecution,metadata,validateMetadata,execute,packageResult],connections:{[called.name]:main(executionSettings.name),[executionSettings.name]:main(buildExecution.name),[buildExecution.name]:main(metadata.name),[metadata.name]:main(validateMetadata.name),[validateMetadata.name]:main(execute.name),[execute.name]:main(packageResult.name)}};
 const queryGateway=gateway(queryCore,'patent-research-google-bigquery-query','Patent Research — Google BigQuery capped CPC trend (MCP gateway)');
 return {dryCore,dryGateway,queryCore,queryGateway};
}

const {dryCore,dryGateway,queryCore,queryGateway}=buildBigQueryWorkflows();
fs.writeFileSync('extras/n8n/workflows/google-bigquery-core.json',JSON.stringify(dryCore,null,2));
fs.writeFileSync('extras/n8n/workflows/google-bigquery.json',JSON.stringify(dryGateway,null,2));
fs.writeFileSync('extras/n8n/deployment/google-bigquery-setup.json',JSON.stringify([dryCore,dryGateway],null,2));
fs.writeFileSync('extras/n8n/workflows/google-bigquery-query-core.json',JSON.stringify(queryCore,null,2));
fs.writeFileSync('extras/n8n/workflows/google-bigquery-query.json',JSON.stringify(queryGateway,null,2));
fs.writeFileSync('extras/n8n/deployment/google-bigquery-query-setup.json',JSON.stringify([queryCore,queryGateway],null,2));
console.log('Prepared dry-run and separate capped-query workflows. Portable cores contain no provider credential bindings or values.');
