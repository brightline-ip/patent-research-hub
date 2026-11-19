import {randomUUID} from 'node:crypto';
import {externalAccess} from './external-access.mjs';
import {callGateway,readConfig} from './gateway.mjs';
import {hash} from './parsers.mjs';
import {exportReport,probeChartRenderer} from './reports.mjs';

export const bigQueryContractVersion=1;
export const bigQueryPublicationTable='patents-public-data.patents.publications';
const bigQueryCacheKind='cpc-trend';

function exactBytes(value,label){
 const text=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
 if(typeof text!=='string'||!/^(0|[1-9]\d*)$/.test(text)||BigInt(text)>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('BigQuery returned an invalid '+label);
 return text;
}
function configuredBytes(value,label){
 const text=exactBytes(value,label);
 if(text==='0')throw new Error(label+' must be positive');
 return text;
}
const isoFromMillis=(value,label)=>{const text=exactBytes(value,label),date=new Date(Number(text));if(Number.isNaN(date.valueOf()))throw new Error('BigQuery returned invalid '+label);return date.toISOString();};

export function buildBigQueryExecutionRequest(plan,maximumBytesBilled){
 if(!plan?.request?.configuration?.query||plan.request.configuration.dryRun!==true)throw new Error('BigQuery execution requires the fixed dry-run plan');
 if(typeof maximumBytesBilled!=='string'||!/^[1-9]\d*$/.test(maximumBytesBilled))throw new Error('Invalid BigQuery execution ceiling');
 const query=plan.request.configuration.query;
 return {...query,dryRun:false,useQueryCache:true,maxResults:31,timeoutMs:120000,jobTimeoutMs:'180000',maximumBytesBilled,labels:{application:'patent_research',operation:'cpc_publication_trend'}};
}

export function validateBigQueryEstimate(response,{plan,projectId}){
 if(!response||response.status!==200)throw new Error('BigQuery dry run failed');
 if(response.error)throw new Error('BigQuery dry run returned an error');
 if(response.dryRun!==true||response.executedDataQuery!==false)throw new Error('BigQuery response did not prove dry-run-only execution');
 if(response.jobReference?.projectId!==projectId)throw new Error('BigQuery dry run used an unexpected project');
 if('rows' in response||'queryResults' in response)throw new Error('BigQuery estimator returned unexpected query results');
 const processed=exactBytes(response.statistics?.totalBytesProcessed,'processed-byte estimate');
 const billed=exactBytes(response.statistics?.query?.totalBytesBilled,'billed-byte value');
 if(billed!=='0')throw new Error('BigQuery dry run reported billed bytes');
 return {
  source:'google-bigquery',mode:'dry-run-estimate',projectId,table:plan.table,parameters:plan.parameters,
  countingUnit:plan.countingUnit,cpcMatch:plan.cpcMatch,status:response.status,dryRun:true,executedDataQuery:false,
  totalBytesProcessed:processed,estimatedGiB:Number(processed)/(1024**3),totalBytesBilled:'0',
  estimateAccuracy:response.statistics?.query?.totalBytesProcessedAccuracy||null,
  warning:'Cost/permission estimate only. No publication counts or query rows were produced.'
 };
}

export async function estimateBigQuery(input,{config=readConfig(),call=callGateway}={}){
 if(config.googleBigQueryDryRunEnabled!==true)throw new Error('BigQuery dry-run gateway is not enabled');
 if(typeof config.googleBigQueryProjectId!=='string'||!config.googleBigQueryProjectId)throw new Error('BigQuery project is not configured: set BIGQUERY_PROJECT_ID or googleBigQueryProjectId (see docs/BIGQUERY_SETUP.md)');
 const plan=externalAccess({source:'google-bigquery',cpc:input.cpc,from:input.from,to:input.to});
 const response=await call('google-bigquery',plan.parameters,{config,maxBytes:200000});
 return validateBigQueryEstimate(response,{plan,projectId:config.googleBigQueryProjectId});
}

export function bigQueryCacheKey(input){
 const plan=externalAccess({source:'google-bigquery',cpc:input.cpc,from:input.from,to:input.to});
 return hash(JSON.stringify({contract:'patent-research/cpc-publication-trend',version:bigQueryContractVersion,table:plan.table,parameters:plan.parameters}));
}

export function bigQuerySourceStatus({config=readConfig(),store}={}){
 const cache=store?.queryCacheStatus?store.queryCacheStatus(bigQueryCacheKind):{kind:bigQueryCacheKind,entries:0,firstCreatedAt:null,lastUpdatedAt:null,integrity:'unavailable'};
 return {
  contract:{name:'patent-research/cpc-publication-trend',version:bigQueryContractVersion,interfaces:['MCP','CLI','n8n']},
  strategy:'hosted query on demand with a validated local aggregate cache',downloadRequired:false,
  hosted:{provider:'Google BigQuery',table:bigQueryPublicationTable,executionEnabled:config.googleBigQueryExecutionEnabled===true,billingMode:config.googleBigQueryBillingMode||null,queryCache:true,perQueryMaximumBytes:config.googleBigQueryPerQueryMaxBytes||null,trackedMonthlyMaximumBytes:config.googleBigQueryMonthlyTrackedMaxBytes||null},
  localPersistence:{...cache,contents:'Only validated yearly CPC aggregates and provenance; no patent publication rows or provider credentials.'},
  limitation:'An exact CPC and year-range query must succeed once before it is available as a local outage fallback.',
 };
}

export function validateBigQueryTrend(response,{plan,projectId,maximumBytesBilled}){
 if(!response||response.status!==200||response.error||response.errors?.length)throw new Error('BigQuery CPC trend query failed');
 if(response.dryRun!==false||response.executedDataQuery!==true||response.jobComplete!==true)throw new Error('BigQuery did not return a completed data query');
 if(response.jobReference?.projectId!==projectId)throw new Error('BigQuery trend query used an unexpected project');
 if(response.maximumBytesBilled!==maximumBytesBilled)throw new Error('BigQuery trend query did not preserve the configured byte ceiling');
 const fields=response.schema?.fields;
 if(!Array.isArray(fields)||fields.length!==2||fields[0]?.name!=='year'||fields[0]?.type!=='INTEGER'||fields[1]?.name!=='publications'||fields[1]?.type!=='INTEGER')throw new Error('BigQuery CPC trend schema changed');
 const totalRows=Number(exactBytes(response.totalRows,'result-row count'));
 if(totalRows>plan.parameters.to-plan.parameters.from+1||!Array.isArray(response.rows)||response.rows.length!==totalRows)throw new Error('BigQuery CPC trend result was truncated or oversized');
 const seen=new Set(),returned=[];
 for(const row of response.rows){
  if(!Array.isArray(row?.f)||row.f.length!==2)throw new Error('BigQuery CPC trend row shape changed');
  const year=Number(exactBytes(row.f[0]?.v,'year')),count=Number(exactBytes(row.f[1]?.v,'publication count'));
  if(!Number.isInteger(year)||year<plan.parameters.from||year>plan.parameters.to||seen.has(year))throw new Error('BigQuery returned an invalid or duplicate year');
  seen.add(year);returned.push({year,count});
 }
 returned.sort((a,b)=>a.year-b.year);
 const byYear=new Map(returned.map(x=>[x.year,x.count]));let prior=null;
 const series=[];for(let year=plan.parameters.from;year<=plan.parameters.to;year++){const count=byYear.get(year)||0;series.push({year,count,yoyPercent:prior===null||prior===0?null:Math.round((count-prior)/prior*10000)/100});prior=count;}
 const processed=exactBytes(response.totalBytesProcessed,'processed-byte total'),billed=exactBytes(response.totalBytesBilled,'billed-byte total');
 if(BigInt(processed)>BigInt(maximumBytesBilled)||BigInt(billed)>BigInt(maximumBytesBilled))throw new Error('BigQuery exceeded the configured byte ceiling');
 if(response.tableMetadataStatus!==200||response.tableMetadata?.projectId!=='patents-public-data'||response.tableMetadata?.datasetId!=='patents'||response.tableMetadata?.tableId!=='publications')throw new Error('Google Patents table metadata was not verified');
 const tableLastModifiedAt=isoFromMillis(response.tableMetadata.lastModifiedTime,'table update time');
 return {
  source:'google-bigquery',mode:'capped-cpc-publication-trend',projectId,table:plan.table,parameters:plan.parameters,
  countingUnit:plan.countingUnit,cpcMatch:plan.cpcMatch,status:response.status,dryRun:false,executedDataQuery:true,jobComplete:true,
  jobReference:response.jobReference,totalBytesProcessed:processed,totalBytesBilled:billed,cacheHit:response.cacheHit===true,
  maximumBytesBilled,series,providerRows:returned,tableLastModifiedAt,
  tableMetadata:{numRows:exactBytes(response.tableMetadata.numRows,'table row count'),numBytes:exactBytes(response.tableMetadata.numBytes,'table byte count')},
  coverage:'Distinct US publication numbers in the Google Patents Public Datasets publications table, grouped by publication year and filtered by the selected CPC subclass prefix or exact symbol. This is not an application-filing, patent-family, or unique-invention count.',
  warnings:['The result describes the hosted table as retrieved, not every patent application filed. Application publications and grants can represent the same invention; unpublished applications are absent.','The local monthly ledger covers this research tool only. BigQuery activity outside it is not included. Zero-cost operation depends on the isolated project remaining a no-billing sandbox.']
 };
}

export async function queryBigQueryTrend(input,{config=readConfig(),call=callGateway,store,estimate=estimateBigQuery}={}){
 if(!store?.reserveBigQuery||!store?.completeBigQuery)throw new Error('BigQuery execution requires the local usage ledger');
 const plan=externalAccess({source:'google-bigquery',cpc:input.cpc,from:input.from,to:input.to}),cacheKey=bigQueryCacheKey(input);
 const cached=store.getQueryCache?store.getQueryCache(bigQueryCacheKind,cacheKey):null;
 const cachedFallback=(error,providerAttempted=true)=>{
  if(!cached)throw error;
  const servedAt=new Date().toISOString();
  return {...cached.value,delivery:{mode:'local-validated-aggregate-cache',servedAt,cachedAt:cached.updatedAt,payloadSha256:cached.payloadSha256,providerAttempted,providerError:error.message},warnings:[`This request used the locally persisted aggregate because the hosted provider call did not complete: ${error.message}`,...cached.value.warnings]};
 };
 if(config.googleBigQueryExecutionEnabled!==true)return cachedFallback(new Error('BigQuery data-query execution is disabled'),false);
 if(!['sandbox-no-billing','billing-enabled-capped'].includes(config.googleBigQueryBillingMode))return cachedFallback(new Error('BigQuery execution requires the confirmed no-billing sandbox policy (googleBigQueryBillingMode "sandbox-no-billing") or an acknowledged capped billing mode ("billing-enabled-capped")'),false);
 const projectId=config.googleBigQueryProjectId,maximumBytesBilled=configuredBytes(config.googleBigQueryPerQueryMaxBytes,'BigQuery per-query byte ceiling'),monthlyLimit=configuredBytes(config.googleBigQueryMonthlyTrackedMaxBytes,'BigQuery monthly tracked limit');
 let preflight,reservationId,budget;
 try{
  preflight=await estimate(plan.parameters,{config,call});
  if(BigInt(preflight.totalBytesProcessed)>BigInt(maximumBytesBilled))throw new Error('BigQuery dry-run estimate exceeds the per-query byte ceiling');
  // Track the reservation only after it exists, so a refused reservation reports its own error.
  const pendingId=randomUUID(),month=new Date().toISOString().slice(0,7);
  budget=store.reserveBigQuery({id:pendingId,month,estimatedBytes:preflight.totalBytesProcessed,monthlyLimit,parameters:plan.parameters});reservationId=pendingId;
  const response=await call('google-bigquery-query',plan.parameters,{config,maxBytes:500000});
  const result=validateBigQueryTrend(response,{plan,projectId,maximumBytesBilled});
  const usage=BigInt(result.totalBytesProcessed)>BigInt(result.totalBytesBilled)?result.totalBytesProcessed:result.totalBytesBilled;
  const ledger=store.completeBigQuery(reservationId,{status:'complete',usageBytes:usage,jobReference:result.jobReference,cacheHit:result.cacheHit});
  reservationId=null;
  const servedAt=new Date().toISOString(),trend={...result,preflight:{totalBytesProcessed:preflight.totalBytesProcessed,estimateAccuracy:preflight.estimateAccuracy},budget:{...budget,...ledger},delivery:{mode:'hosted-query',servedAt,providerAttempted:true}};
  if(store.saveQueryCache){try{const saved=store.saveQueryCache(bigQueryCacheKind,cacheKey,trend);trend.delivery={...trend.delivery,persistedAt:saved.updatedAt,payloadSha256:saved.payloadSha256};}catch(error){trend.delivery={...trend.delivery,persistenceError:error.message};trend.warnings=[`The hosted query succeeded, but its local aggregate could not be persisted: ${error.message}`,...trend.warnings];}}
  return trend;
 }catch(error){if(reservationId)store.completeBigQuery(reservationId,{status:'unknown',usageBytes:preflight.totalBytesProcessed,error:error.message});return cachedFallback(error);}
}

export function bigQueryTrendReportInput(trend){
 const sourceUrl='https://console.cloud.google.com/marketplace/product/google_patents_public_datasets/google-patents-public-data',sourceDocumentation='https://docs.cloud.google.com/bigquery/public-data';
 const snapshotDate=trend.tableLastModifiedAt.slice(0,10),dataset={source:trend.table,sourceUrl,sourceDocumentation,snapshotDate,retrievedAt:trend.delivery?.servedAt||new Date().toISOString(),coverage:trend.coverage,parameters:trend.parameters,tableLastModifiedAt:trend.tableLastModifiedAt,aggregateRows:trend.series,delivery:trend.delivery||null,execution:{jobReference:trend.jobReference,totalBytesProcessed:trend.totalBytesProcessed,totalBytesBilled:trend.totalBytesBilled,cacheHit:trend.cacheHit,maximumBytesBilled:trend.maximumBytesBilled,preflight:trend.preflight,trackedMonthlyBudget:trend.budget}};
 const analysis={title:`${trend.parameters.cpc}: US publication counts by publication year`,source:trend.table,sourceUrl,sourceDocumentation,snapshotDate,coverage:trend.coverage,datasetSha256:hash(JSON.stringify(dataset)),definition:{cpc:trend.parameters.cpc,classificationScope:trend.cpcMatch,dateBasis:'publication',unit:'US publication number',from:trend.parameters.from,to:trend.parameters.to},series:trend.series,duplicatesRemoved:0,excludedMissing:0,warnings:trend.warnings,methodVersion:2};
 return {dataset,analysis};
}

export async function exportBigQueryTrendReport(trend,input={},options={}){
 const {dataset,analysis}=bigQueryTrendReportInput(trend);
 const executionFact=trend.delivery?.mode==='local-validated-aggregate-cache'?`The tool served its locally persisted, SHA-256-checked aggregate saved at ${trend.delivery.cachedAt}; no hosted data query completed for this request. The aggregate remains tied to the ${trend.tableLastModifiedAt} hosted-table snapshot.`:trend.cacheHit?`BigQuery served this execution from its result cache and reported zero additional processed and billed bytes; the dry-run estimate remained ${trend.preflight.totalBytesProcessed} bytes.`:`BigQuery processed ${trend.totalBytesProcessed} bytes and reported ${trend.totalBytesBilled} billed bytes; the enforced per-query ceiling was ${trend.maximumBytesBilled} bytes.`;
 const ledgerFact=trend.delivery?.mode==='local-validated-aggregate-cache'?`The cached aggregate records a ${trend.budget.trackedMonth} tool-ledger value of ${trend.budget.trackedBytesAfter} of ${trend.budget.monthlyLimitBytes} bytes at its original acquisition; this is not a fresh usage reading.`:`The tool's conservative ${trend.budget.trackedMonth} ledger stands at ${trend.budget.trackedBytesAfter} of ${trend.budget.monthlyLimitBytes} bytes.`;
 const files=await exportReport({title:input.title||analysis.title,question:`How many distinct US publication numbers in ${trend.table} matched ${trend.parameters.cpc} by publication year from ${trend.parameters.from} through ${trend.parameters.to}?`,facts:[`The fixed aggregate query returned ${trend.series.reduce((n,x)=>n+x.count,0).toLocaleString('en-US')} year-count memberships across ${trend.series.length} calendar years.`,executionFact,ledgerFact,`Google reported the hosted publications table last modified at ${trend.tableLastModifiedAt}.`],inferences:[],openQuestions:['Dataset coverage and classification practices should be reviewed before treating changes as changes in inventive activity.'],analysis,dataset,renderer:options.renderer});
 return {warnings:files.warnings,trend,analysis,files};
}

// The chart renderer is probed before the provider call, so a missing Python is known (and reported) before any query runs; it never blocks the report.
export async function queryBigQueryTrendReport(input,options={}){const renderer=(options.probeRenderer||probeChartRenderer)();return exportBigQueryTrendReport(await queryBigQueryTrend(input,options),input,{renderer});}
