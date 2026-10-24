import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {examinerTable} from '../../../src/examiner.mjs';

const base = JSON.parse(fs.readFileSync('extras/n8n/workflows/reference-index-core.json', 'utf8'));
const gatewayTemplate = JSON.parse(fs.readFileSync('extras/n8n/workflows/external-access.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const projectId = config.googleBigQueryProjectId || '';
const maximumBytesBilled = config.googleBigQueryPerQueryMaxBytes || '';
const node = (name, type, parameters, position, version = 2) => ({id: randomUUID(), name, type: 'n8n-nodes-base.' + type, typeVersion: version, position, parameters});
const main = nodeName => ({main: [[{node: nodeName, type: 'main', index: 0}]]});
const authRequest = (name, method, url, position, body) => node(name, 'httpRequest', {method, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleBigQueryOAuth2Api', ...(body ? {sendBody: true, specifyBody: 'json', jsonBody: body} : {}), options: {timeout: 180000, redirect: {redirect: {followRedirects: false}}, response: {response: {fullResponse: true, neverError: true, responseFormat: 'json'}}}}, position, 4.2);

const sql = `
WITH raw AS (
  SELECT application_number, examiner_name_last, examiner_name_first, examiner_name_middle, examiner_id, examiner_art_unit, disposal_type,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', filing_date), SAFE.PARSE_DATE('%Y%m%d', filing_date), SAFE.PARSE_DATE('%m/%d/%Y', filing_date)) AS filing_date_parsed,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', patent_issue_date), SAFE.PARSE_DATE('%Y%m%d', patent_issue_date), SAFE.PARSE_DATE('%m/%d/%Y', patent_issue_date)) AS patent_issue_date_parsed,
    COALESCE(SAFE.PARSE_DATE('%Y-%m-%d', abandon_date), SAFE.PARSE_DATE('%Y%m%d', abandon_date), SAFE.PARSE_DATE('%m/%d/%Y', abandon_date)) AS abandon_date_parsed
  FROM \`${examinerTable}\`
  WHERE application_type = 'REGULAR' AND invention_subject_matter = 'UTL'
),
eligible AS (
  SELECT * EXCEPT(filing_date_parsed, patent_issue_date_parsed, abandon_date_parsed),
    IF(filing_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, filing_date_parsed, NULL) AS filing_date,
    IF(patent_issue_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, patent_issue_date_parsed, NULL) AS patent_issue_date,
    IF(abandon_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff, abandon_date_parsed, NULL) AS abandon_date,
    COUNTIF(filing_date_parsed IS NOT NULL AND NOT (filing_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_filing_dates,
    COUNTIF(patent_issue_date_parsed IS NOT NULL AND NOT (patent_issue_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_issue_dates,
    COUNTIF(abandon_date_parsed IS NOT NULL AND NOT (abandon_date_parsed BETWEEN DATE '1900-01-01' AND @data_cutoff)) OVER () AS invalid_abandon_dates
  FROM raw
),
bounds AS (
  SELECT MAX(filing_date) AS max_filing_date, MAX(COALESCE(patent_issue_date, abandon_date)) AS max_disposal_date,
    MAX(invalid_filing_dates) AS invalid_filing_dates, MAX(invalid_issue_dates) AS invalid_issue_dates, MAX(invalid_abandon_dates) AS invalid_abandon_dates FROM eligible
),
scoped AS (
  SELECT application_number, disposal_type,
    CASE WHEN disposal_type = 'ISS' THEN EXTRACT(YEAR FROM patent_issue_date) WHEN disposal_type = 'ABN' THEN EXTRACT(YEAR FROM abandon_date) END AS disposal_year
  FROM eligible
  WHERE disposal_type IN ('ISS', 'ABN')
    AND ((@scope_type = 'examiner' AND UPPER(TRIM(REGEXP_REPLACE(CONCAT(COALESCE(examiner_name_last, ''), ', ', COALESCE(examiner_name_first, ''), ' ', COALESCE(examiner_name_middle, '')), r'\\s+', ' '))) = @scope_value) OR (@scope_type = 'art-unit' AND TRIM(examiner_art_unit) = @scope_value))
),
yearly AS (
  SELECT disposal_year AS year,
    COUNT(DISTINCT IF(disposal_type = 'ISS', application_number, NULL)) AS issued,
    COUNT(DISTINCT IF(disposal_type = 'ABN', application_number, NULL)) AS abandoned
  FROM scoped WHERE disposal_year BETWEEN @from_year AND @to_year GROUP BY year
)
SELECT year, COALESCE(issued, 0) AS issued, COALESCE(abandoned, 0) AS abandoned, bounds.max_filing_date, bounds.max_disposal_date,
  bounds.invalid_filing_dates, bounds.invalid_issue_dates, bounds.invalid_abandon_dates
FROM UNNEST(GENERATE_ARRAY(@from_year, @to_year)) AS year CROSS JOIN bounds LEFT JOIN yearly USING (year) ORDER BY year`;

const buildCode = ({execution}) => `
const j=$input.first().json,b=j.body||j;
if(j.executionEnabled!==${execution ? 'true' : 'false'}||j.billingMode!=='sandbox-no-billing')throw new Error('PatEx sandbox policy mismatch');
if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(j.projectId))throw new Error('Set the isolated Google Cloud project ID');
if(!['examiner','art-unit'].includes(b.scope))throw new Error('Scope must be examiner or art-unit');
const from=Number(b.from),to=Number(b.to);if(!Number.isInteger(from)||!Number.isInteger(to)||from<1900||to>new Date().getUTCFullYear()+1||from>to||to-from>30)throw new Error('Invalid year range');
let value;if(b.scope==='examiner'){value=String(b.value||b.examiner||'').trim().replace(/\\s+/g,' ').toUpperCase();if(value.length<3||value.length>120||!/^[\\p{L}\\p{N} .,'’-]+$/u.test(value))throw new Error('Supply the exact PatEx examiner name');}else{value=String(b.value||b.artUnit||'').trim();if(!/^\\d{4}$/.test(value))throw new Error('Art unit must contain four digits');}
const query=${JSON.stringify(sql)};
const fixed={query,useLegacySql:false,parameterMode:'NAMED',queryParameters:[{name:'scope_type',parameterType:{type:'STRING'},parameterValue:{value:b.scope}},{name:'scope_value',parameterType:{type:'STRING'},parameterValue:{value}},{name:'from_year',parameterType:{type:'INT64'},parameterValue:{value:String(from)}},{name:'to_year',parameterType:{type:'INT64'},parameterValue:{value:String(to)}},{name:'data_cutoff',parameterType:{type:'DATE'},parameterValue:{value:new Date().toISOString().slice(0,10)}}]};
const request=${execution ? `{...fixed,dryRun:false,useQueryCache:true,maxResults:31,timeoutMs:120000,jobTimeoutMs:'180000',maximumBytesBilled:j.maximumBytesBilled,labels:{application:'patent_research',operation:'patex_examiner_outcomes'}}` : `{configuration:{dryRun:true,query:fixed}}`};
return [{json:{${execution ? "queryUrl:'https://bigquery.googleapis.com/bigquery/v2/projects/'+j.projectId+'/queries',metadataUrl:'https://bigquery.googleapis.com/bigquery/v2/projects/patents-public-data/datasets/uspto_oce_pair/tables/application_data'," : "url:'https://bigquery.googleapis.com/bigquery/v2/projects/'+j.projectId+'/jobs',metadataUrl:'https://bigquery.googleapis.com/bigquery/v2/projects/patents-public-data/datasets/uspto_oce_pair/tables/application_data',"}request,maximumBytesBilled:j.maximumBytesBilled}}];`;

function gateway(core, id, name) {
  const result = structuredClone(gatewayTemplate); result.id = id; result.name = name; result.active = false;
  const webhook = result.nodes.find(n => n.type.endsWith('.webhook')); webhook.id = randomUUID(); webhook.webhookId = randomUUID(); webhook.parameters.path = id;
  const call = result.nodes.find(n => n.type.endsWith('.executeWorkflow')); call.id = randomUUID(); call.parameters.workflowId.value = core.id;
  result.nodes.find(n => n.type.endsWith('.respondToWebhook')).id = randomUUID();
  return result;
}

export function buildExaminerWorkflows() {
  const called = node('When Called by Another Workflow', 'executeWorkflowTrigger', {inputSource: 'passthrough'}, [-700, 0], 1.1);
  const drySettings = node('Capped Sandbox Policy', 'set', {assignments: {assignments: [{id: randomUUID(), name: 'projectId', type: 'string', value: projectId}, {id: randomUUID(), name: 'executionEnabled', type: 'boolean', value: false}, {id: randomUUID(), name: 'billingMode', type: 'string', value: 'sandbox-no-billing'}, {id: randomUUID(), name: 'maximumBytesBilled', type: 'string', value: maximumBytesBilled}]}, includeOtherFields: true, options: {}}, [-470, 0], 3.4);
  const dryBuild = node('Build Fixed PatEx Examiner Dry Run', 'code', {jsCode: buildCode({execution: false})}, [-220, 0]);
  const dryMetadata = authRequest('Read hosted PatEx schema for dry run', 'GET', '={{ $json.metadataUrl }}', [20, 0]);
  const attachDryMetadata = node('Attach hosted PatEx schema', 'code', {jsCode: "const r=$input.first().json,b=r.body??r.data??{},built=$('Build Fixed PatEx Examiner Dry Run').first().json,t=b.tableReference,cutoff=new Date(Number(b.lastModifiedTime)).toISOString().slice(0,10),p=built.request.configuration.query.queryParameters.find(x=>x.name==='data_cutoff');if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(cutoff)||!p)throw new Error('Hosted PatEx cutoff could not be derived');p.parameterValue.value=cutoff;return [{json:{...built,tableMetadataStatus:r.statusCode,tableMetadata:{projectId:t?.projectId,datasetId:t?.datasetId,tableId:t?.tableId,lastModifiedTime:b.lastModifiedTime,numRows:b.numRows,numBytes:b.numBytes,schema:(b.schema?.fields||[]).map(f=>({name:f.name,type:f.type,mode:f.mode}))}}}];"}, [270, 0]);
  const dryRequest = authRequest('BigQuery — select dedicated OAuth credential', 'POST', '={{ $json.url }}', [520, 0], '={{ $json.request }}');
  const dryResult = node('Return PatEx Dry Run Estimate', 'code', {jsCode: "const r=$input.first().json,b=r.body??r.data??{},meta=$('Attach hosted PatEx schema').first().json;return [{json:{status:r.statusCode,dryRun:true,executedDataQuery:false,jobReference:b.jobReference,statistics:b.statistics,error:b.error,errors:b.errors,tableMetadataStatus:meta.tableMetadataStatus,tableMetadata:meta.tableMetadata,warning:'This checks the fixed PatEx query and estimated bytes only.'}}];"}, [790, 0]);
  const dryCore = {...base, id: 'patent-research-examiner-bigquery-core', name: 'Patent Research — PatEx examiner dry run (callable tool)', active: false, nodes: [called, drySettings, dryBuild, dryMetadata, attachDryMetadata, dryRequest, dryResult], connections: {[called.name]: main(drySettings.name), [drySettings.name]: main(dryBuild.name), [dryBuild.name]: main(dryMetadata.name), [dryMetadata.name]: main(attachDryMetadata.name), [attachDryMetadata.name]: main(dryRequest.name), [dryRequest.name]: main(dryResult.name)}};
  const dryGateway = gateway(dryCore, 'patent-research-examiner-bigquery', 'Patent Research — PatEx examiner dry run (MCP gateway)');

  const queryCalled = node('When Called by Another Workflow', 'executeWorkflowTrigger', {inputSource: 'passthrough'}, [-820, 0], 1.1);
  const querySettings = node('Capped Sandbox Policy', 'set', {assignments: {assignments: [{id: randomUUID(), name: 'projectId', type: 'string', value: projectId}, {id: randomUUID(), name: 'executionEnabled', type: 'boolean', value: true}, {id: randomUUID(), name: 'billingMode', type: 'string', value: 'sandbox-no-billing'}, {id: randomUUID(), name: 'maximumBytesBilled', type: 'string', value: maximumBytesBilled}]}, includeOtherFields: true, options: {}}, [-600, 0], 3.4);
  const queryBuild = node('Build Fixed PatEx Examiner Query', 'code', {jsCode: buildCode({execution: true})}, [-350, 0]);
  const metadata = authRequest('Read hosted PatEx table metadata', 'GET', '={{ $json.metadataUrl }}', [-80, 0]);
  const validateMetadata = node('Validate hosted PatEx table metadata', 'code', {jsCode: `const r=$input.first().json,b=r.body??r.data??{},built=$('Build Fixed PatEx Examiner Query').first().json,t=b.tableReference,required={application_number:'STRING',filing_date:'STRING',invention_subject_matter:'STRING',application_type:'STRING',examiner_name_last:'STRING',examiner_name_first:'STRING',examiner_name_middle:'STRING',examiner_id:'STRING',examiner_art_unit:'STRING',patent_issue_date:'STRING',abandon_date:'STRING',disposal_type:'STRING'},fields=b.schema?.fields;if(r.statusCode!==200||t?.projectId!=='patents-public-data'||t?.datasetId!=='uspto_oce_pair'||t?.tableId!=='application_data'||!/^(0|[1-9]\\d*)$/.test(b.lastModifiedTime||'')||!/^(0|[1-9]\\d*)$/.test(b.numRows||'')||!/^(0|[1-9]\\d*)$/.test(b.numBytes||'')||!Array.isArray(fields)||Object.entries(required).some(([name,type])=>!fields.some(f=>f.name===name&&f.type===type)))throw new Error('Hosted PatEx table identity or schema could not be verified');const cutoff=new Date(Number(b.lastModifiedTime)).toISOString().slice(0,10),p=built.request.queryParameters.find(x=>x.name==='data_cutoff');if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(cutoff)||!p)throw new Error('Hosted PatEx cutoff could not be derived');p.parameterValue.value=cutoff;return [{json:{...built,tableMetadata:{projectId:t.projectId,datasetId:t.datasetId,tableId:t.tableId,lastModifiedTime:b.lastModifiedTime,numRows:b.numRows,numBytes:b.numBytes,schema:fields.map(f=>({name:f.name,type:f.type,mode:f.mode}))}}}];`}, [190, 0]);
  const execute = authRequest('Execute capped PatEx examiner query', 'POST', '={{ $json.queryUrl }}', [470, 0], '={{ $json.request }}');
  const packageResult = node('Return Verified PatEx Query Envelope', 'code', {jsCode: `const r=$input.first().json,b=r.body??r.data??{},built=$('Validate hosted PatEx table metadata').first().json;return [{json:{status:r.statusCode,dryRun:false,executedDataQuery:r.statusCode===200&&b.jobComplete===true&&!b.error&&!(b.errors?.length),jobComplete:b.jobComplete===true,jobReference:b.jobReference,schema:b.schema,rows:b.rows||[],totalRows:b.totalRows,totalBytesProcessed:b.totalBytesProcessed,totalBytesBilled:b.totalBytesBilled,cacheHit:b.cacheHit===true,error:b.error,errors:b.errors,maximumBytesBilled:built.maximumBytesBilled,tableMetadataStatus:200,tableMetadata:built.tableMetadata}}];`}, [750, 0]);
  const queryCore = {...base, id: 'patent-research-examiner-bigquery-query-core', name: 'Patent Research — PatEx examiner outcomes (callable tool)', active: false, nodes: [queryCalled, querySettings, queryBuild, metadata, validateMetadata, execute, packageResult], connections: {[queryCalled.name]: main(querySettings.name), [querySettings.name]: main(queryBuild.name), [queryBuild.name]: main(metadata.name), [metadata.name]: main(validateMetadata.name), [validateMetadata.name]: main(execute.name), [execute.name]: main(packageResult.name)}};
  const queryGateway = gateway(queryCore, 'patent-research-examiner-bigquery-query', 'Patent Research — PatEx examiner outcomes (MCP gateway)');
  return {dryCore, dryGateway, queryCore, queryGateway};
}

const {dryCore, dryGateway, queryCore, queryGateway} = buildExaminerWorkflows();
fs.writeFileSync('extras/n8n/workflows/examiner-bigquery-core.json', JSON.stringify(dryCore, null, 2));
fs.writeFileSync('extras/n8n/workflows/examiner-bigquery.json', JSON.stringify(dryGateway, null, 2));
fs.writeFileSync('extras/n8n/deployment/examiner-bigquery-setup.json', JSON.stringify([dryCore, dryGateway], null, 2));
fs.writeFileSync('extras/n8n/workflows/examiner-bigquery-query-core.json', JSON.stringify(queryCore, null, 2));
fs.writeFileSync('extras/n8n/workflows/examiner-bigquery-query.json', JSON.stringify(queryGateway, null, 2));
fs.writeFileSync('extras/n8n/deployment/examiner-bigquery-query-setup.json', JSON.stringify([queryCore, queryGateway], null, 2));
console.log('Prepared portable PatEx examiner dry-run and capped-query workflows without provider credential bindings.');
