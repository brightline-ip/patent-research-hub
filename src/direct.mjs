// Direct transport: the Hub calls each provider itself with the user's own credentials from environment variables.
// Every route returns the same envelope the optional n8n workflows return (extras/n8n/workflows), so the existing
// validation and normalization in hub.mjs, bigquery.mjs, examiner.mjs, patent-documents.mjs, originals.mjs and
// govinfo-pdf.mjs produce identical MCP/CLI output on either transport.
//
// NOT VERIFIED AGAINST LIVE PROVIDERS: the direct transport is covered by offline tests with mocked responses only.
import fs from 'node:fs';
import {createHash,createSign} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from './net.mjs';
import {sources} from './sources.mjs';
import {validateWorkflowSource} from './workflow-validation.mjs';
import {requireProvider} from './providers.mjs';
import {configDefaults,dataDir} from './config.mjs';
import path from 'node:path';
import {withProviderSlot,rateLimitWaitSeconds} from './limiter.mjs';
import {selectOaAdapter} from './oa-adapter.mjs';
import {packageSearchResponse} from './uspto-search-response.mjs';

const bounded=createRequire(import.meta.url)('./bounded-download.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');
const BIGQUERY='https://bigquery.googleapis.com/bigquery/v2';
const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';
const EPO_TOKEN_URL='https://ops.epo.org/3.2/auth/accesstoken';

// Same source-to-route mapping as the n8n gateway (gateway.mjs gatewaySource).
export const routeForSource=source=>source==='odp'?'uspto':['ptab-trials','ptab-appeals'].includes(source)?'ptab':['govinfo','courtlistener','epo'].includes(source)?source:'public';
const providerForRoute={uspto:'uspto',ptab:'uspto','ptab-files':'uspto','application-documents':'uspto','application-pdf':'uspto',govinfo:'govinfo',courtlistener:'courtlistener',epo:'epo','oa-rejections':'uspto','google-bigquery':'bigquery','google-bigquery-query':'bigquery','examiner-bigquery':'bigquery','examiner-bigquery-query':'bigquery'};
function sourceUrls(route){
  const out={};
  for(const s of sources)if(!['external','reference'].includes(s.kind)&&routeForSource(s.id)===route)out[s.id]=s.url;
  return out;
}

// Pacing and limits. Keyed providers (uspto, epo, govinfo, courtlistener, bigquery) go through the cross-process limiter in
// limiter.mjs: one call at a time per key, minimum spacing (config.directMinIntervalMs[provider]), a request cap per hour
// (config.maxRequestsPerHour[provider]) and a cooldown after HTTP 429, all kept in <dataDir>/limiter so separate Hub
// processes share them. Keyless "public" pages keep a simple in-process spacing.
const pacing=new WeakMap();
const keyedProviders=new Set(['uspto','epo','govinfo','courtlistener','bigquery']);
function providerKey(provider,env){
  return {uspto:env.USPTO_API_KEY,epo:env.EPO_OPS_CONSUMER_KEY||env.EPO_ACCESS_TOKEN,govinfo:env.GOVINFO_API_KEY,courtlistener:env.COURTLISTENER_TOKEN,bigquery:env.GOOGLE_APPLICATION_CREDENTIALS}[provider]||'';
}
async function pace(provider,{config,fetchImpl}){
  const ms=Number((config.directMinIntervalMs||configDefaults.directMinIntervalMs)[provider]??1000);
  if(!(ms>0))return;
  let state=pacing.get(fetchImpl);if(!state){state=new Map();pacing.set(fetchImpl,state);}
  const now=Date.now(),at=Math.max(now,state.get(provider)||0);state.set(provider,at+ms);
  if(at>now)await sleep(at-now);
}
// Runs fn(slot) for one provider call. slot.rateLimited(retryAfterHeader) must be called when the provider answers HTTP 429.
async function limited(provider,ctx,fn){
  if(!keyedProviders.has(provider)){await pace(provider||'public',ctx);return fn({rateLimited(){}});}
  const {config,env}=ctx,intervals={...configDefaults.directMinIntervalMs,...(config.directMinIntervalMs||{})};
  return withProviderSlot({
    dir:ctx.limiterDir||path.join(dataDir(config,env.PATENT_RESEARCH_DATA_DIR?env:process.env),'limiter'),
    provider,key:providerKey(provider,env),
    max:Number({...configDefaults.maxRequestsPerHour,...(config.maxRequestsPerHour||{})}[provider]??0),
    minIntervalMs:Number(intervals[provider]??1000),
    staleMs:Number(config.limiterStaleLockMs)||30000,maxWaitMs:Number(config.limiterMaxWaitMs)||1200000,
    ...(ctx.sleepImpl?{sleep:ctx.sleepImpl}:{}),
  },fn);
}
const rateNote=(r,slot)=>{if(r.status===429){slot.rateLimited(r.retryAfter);return {retryAfterSeconds:rateLimitWaitSeconds(r.retryAfter)};}return {};};
const rateLimitedError=(error,slot)=>{if(/\bHTTP 429\b/.test(String(error?.message)))slot.rateLimited(null);};

function context(options={}){
  const config={...configDefaults,...(options.config||{})};
  return {config,env:options.env||process.env,fetchImpl:options.fetchImpl||fetch,requestImpl:options.requestImpl,lookupImpl:options.lookupImpl,limiterDir:options.limiterDir,sleepImpl:options.sleep,now:options.now||Date.now};
}

// ---- OAuth token caches (in memory only; never written to disk or logs) ----
const tokenCache=new Map();
export function resetDirectState(){tokenCache.clear();}
function cached(key,ctx){const t=tokenCache.get(key);return t&&t.expiresAt>ctx.now()+60000?t.token:null;}
function remember(key,token,expiresIn,ctx){
  const seconds=Number(expiresIn);
  if(typeof token!=='string'||!token||token.length>8192||/[\s]/.test(token))throw new Error('Provider returned an invalid access token');
  tokenCache.set(key,{token,expiresAt:ctx.now()+(Number.isFinite(seconds)&&seconds>0?Math.min(seconds,86400):300)*1000});
  return token;
}
async function tokenRequest(url,form,headers,ctx){
  const r=await request(url,{method:'POST',body:new URLSearchParams(form).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json',...headers},timeout:ctx.config.requestTimeoutMs,maxBytes:65536,fetchImpl:ctx.fetchImpl,allowHttpError:true});
  if(r.status!==200)throw new Error(`Provider token request failed (HTTP ${r.status}); check the credential`);
  try{return JSON.parse(r.text);}catch{throw new Error('Provider token response was not JSON');}
}

export async function epoAccessToken(options={},{refresh=false}={}){
  const ctx=options.config&&options.now?options:context(options);
  const key=ctx.env.EPO_OPS_CONSUMER_KEY,secret=ctx.env.EPO_OPS_CONSUMER_SECRET;
  if(!key||!secret){if(ctx.env.EPO_ACCESS_TOKEN)return ctx.env.EPO_ACCESS_TOKEN;requireProvider('epo',ctx);}
  const cacheKey='epo:'+digest(key+'\n'+secret);
  if(!refresh){const hit=cached(cacheKey,ctx);if(hit)return hit;}
  const body=await limited('epo',ctx,slot=>tokenRequest(EPO_TOKEN_URL,{grant_type:'client_credentials'},{Authorization:'Basic '+Buffer.from(key+':'+secret).toString('base64')},ctx));
  return remember(cacheKey,body.access_token,body.expires_in,ctx);
}

const b64url=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
export async function googleAccessToken(options={}){
  const ctx=options.config&&options.now?options:context(options);
  const file=ctx.env.GOOGLE_APPLICATION_CREDENTIALS;
  if(!file||!fs.existsSync(file))requireProvider('bigquery',ctx);
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>65536)throw new Error('GOOGLE_APPLICATION_CREDENTIALS must name a small JSON credential file');
  const raw=fs.readFileSync(file,'utf8'),cacheKey='google:'+digest(raw);
  const hit=cached(cacheKey,ctx);if(hit)return hit;
  let credential;try{credential=JSON.parse(raw);}catch{throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not a JSON credential file');}
  let body;
  if(credential.type==='service_account'){
    const tokenUri=credential.token_uri||GOOGLE_TOKEN_URL;
    if(tokenUri!==GOOGLE_TOKEN_URL)throw new Error('Unsupported service-account token endpoint');
    if(typeof credential.client_email!=='string'||typeof credential.private_key!=='string')throw new Error('Service-account file lacks client_email or private_key');
    const iat=Math.floor(ctx.now()/1000);
    const unsigned=b64url({alg:'RS256',typ:'JWT'})+'.'+b64url({iss:credential.client_email,scope:'https://www.googleapis.com/auth/bigquery',aud:GOOGLE_TOKEN_URL,iat,exp:iat+3600});
    let signature;try{signature=createSign('RSA-SHA256').update(unsigned).sign(credential.private_key).toString('base64url');}catch{throw new Error('Service-account private key could not sign the token request');}
    body=await tokenRequest(GOOGLE_TOKEN_URL,{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature},{},ctx);
  }else if(credential.type==='authorized_user'){
    if(![credential.client_id,credential.client_secret,credential.refresh_token].every(x=>typeof x==='string'&&x))throw new Error('Authorized-user credential file is incomplete');
    body=await tokenRequest(GOOGLE_TOKEN_URL,{grant_type:'refresh_token',client_id:credential.client_id,client_secret:credential.client_secret,refresh_token:credential.refresh_token},{},ctx);
  }else throw new Error('GOOGLE_APPLICATION_CREDENTIALS must be a service_account or authorized_user JSON file');
  return remember(cacheKey,body.access_token,body.expires_in,ctx);
}

// ---- Source routes: uspto, ptab, govinfo, courtlistener, epo, public ----
const GOVINFO_PDF_TIMEOUT_MS=180000;  // up to 40 MB over a slow link; matches the application-original deadline
const MAX_ORIGINAL_BYTES=40*1024*1024;  // GovInfo opinion PDFs and USPTO application originals; same limit as the n8n workflows
function isGovinfoPdf(url){return /^https:\/\/api\.govinfo\.gov\/packages\/[^/]+\/granules\/[^/]+\/pdf$/.test(url);}
async function sourceRoute(route,body,ctx,maxBytes){
  const provider=providerForRoute[route];
  if(provider)requireProvider(provider,ctx);
  const validated=validateWorkflowSource({...(body||{}),sourceUrls:JSON.stringify(sourceUrls(route)),internalUseAgreementConfirmed:ctx.config.courtlistenerEnabled===true&&ctx.config.courtlistenerInternalUseAllowed===true},route);
  const pdf=route==='govinfo'&&isGovinfoPdf(validated.url);
  const headers={};
  if(route==='uspto'||route==='ptab')headers['X-API-KEY']=ctx.env.USPTO_API_KEY;
  if(route==='govinfo')headers['X-Api-Key']=ctx.env.GOVINFO_API_KEY;
  if(route==='courtlistener')headers.Authorization='Token '+ctx.env.COURTLISTENER_TOKEN;
  if(route==='epo')headers.Accept=validated.url.includes('/classification/cpc/')?'application/cpc+xml':'application/exchange+xml';
  if(pdf)headers.Accept='application/pdf';
  const send=()=>limited(provider||'public',ctx,async slot=>{
    if(route==='epo')headers.Authorization='Bearer '+await epoAccessToken(ctx);
    const r=await request(validated.url,{method:validated.method,body:validated.method==='POST'?validated.body:undefined,headers:validated.method==='POST'?{'Content-Type':'application/json',...headers}:headers,timeout:pdf?GOVINFO_PDF_TIMEOUT_MS:ctx.config.requestTimeoutMs,maxBytes:pdf?MAX_ORIGINAL_BYTES+1:Math.min(maxBytes||6e6,6e6),fetchImpl:ctx.fetchImpl,allowHttpError:true,binary:pdf});
    r.rateLimit=rateNote(r,slot);
    return r;
  });
  let r=await send();
  // A cached EPO token can be revoked early; renew it once for this idempotent GET.
  if(route==='epo'&&(r.status===401||r.status===403)&&ctx.env.EPO_OPS_CONSUMER_KEY){await epoAccessToken(ctx,{refresh:true});r=await send();}
  if(pdf){
    const contentType=String(r.contentType).split(';')[0].trim().toLowerCase();
    if(r.status!==200)return {status:r.status||502,url:validated.url,contentType,error:'GovInfo PDF request failed (HTTP '+Number(r.status||0)+')'};
    const bytes=r.buffer;
    if(contentType!=='application/pdf'||bytes.length>MAX_ORIGINAL_BYTES||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('GovInfo original is oversized or is not a PDF');
    return {status:200,url:validated.url,contentType:'application/pdf',bytes:bytes.length,base64:bytes.toString('base64')};
  }
  // "No matching records" is an HTTP 404 from the ODP search API, not an error: turn it into a valid zero-count result, as
  // the n8n workflow does (uspto-search-response.mjs). The status comes from the HTTP response; the body is only read for its
  // message, and any other 404 keeps its status.
  if(route==='uspto'&&r.status===404){
    let parsed=null;try{parsed=JSON.parse(r.text);}catch{}
    const packaged=packageSearchResponse({...(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}),code:404});
    if(packaged.status===200)return packaged;
  }
  return {text:r.text,status:r.status,contentType:r.contentType,...r.rateLimit};
}

const referenceIndexes={'mpep-index':'https://www.uspto.gov/web/offices/pac/mpep/index.html','frcp-index':'https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure','patent-guidance':'https://www.uspto.gov/patents/laws/patent-legal-administration'};
async function referenceIndex(body,ctx){
  const url=referenceIndexes[body?.source];if(!url)throw new Error('Unknown official reference index');
  const r=await limited('public',ctx,()=>request(url,{timeout:ctx.config.requestTimeoutMs,fetchImpl:ctx.fetchImpl,allowHttpError:true}));
  return {status:r.status,text:r.text,contentType:r.contentType};
}

// ---- USPTO originals and document inventory (same bounded, identity-checked downloader as the n8n node) ----
// PTAB decisions keep 10 MiB / 60 s; application originals (reexamination requests, affidavits) get 40 MiB / 180 s (USPTO downloads can be slow).
const downloadOptions=(ctx,application=false)=>({apiKey:ctx.env.USPTO_API_KEY,maxBytes:application?bounded.MAX_APPLICATION_BYTES:bounded.MAX_BYTES,timeoutMs:application?bounded.APPLICATION_TIMEOUT_MS:60000,...(ctx.requestImpl?{requestImpl:ctx.requestImpl}:{}),...(ctx.lookupImpl?{lookupImpl:ctx.lookupImpl}:{})});
async function ptabFiles(body,ctx){
  requireProvider('uspto',ctx);
  return limited('uspto',ctx,async slot=>{try{return await bounded.downloadPtabOriginal({trial_number:body?.trialNumber||'',appeal_number:body?.appealNumber||'',document_identifier:body?.documentIdentifier},downloadOptions(ctx));}catch(e){rateLimitedError(e,slot);throw e;}});
}
async function applicationPdf(body,ctx){
  requireProvider('uspto',ctx);
  if(body?.file_id||body?.format)throw new Error('File-form and XML-archive downloads are available only with the optional n8n transport in this release');
  const result=await limited('uspto',ctx,async slot=>{try{return await bounded.downloadOriginal({application_number:body?.application_number,document_identifier:body?.document_identifier,...(body?.native_filename?{native_filename:body.native_filename}:{})},downloadOptions(ctx,true));}catch(e){rateLimitedError(e,slot);throw e;}});
  return {...result,file_id:null};
}
async function applicationDocuments(body,ctx){
  requireProvider('uspto',ctx);
  if(!/^\d{8}$/.test(body?.application_number||''))throw new Error('Public US application number must contain eight digits');
  const url='https://api.uspto.gov/api/v1/patent/applications/'+body.application_number+'/documents';
  const r=await limited('uspto',ctx,async slot=>{const x=await request(url,{headers:{'X-API-KEY':ctx.env.USPTO_API_KEY,Accept:'application/json'},timeout:60000,maxBytes:8*1024*1024,fetchImpl:ctx.fetchImpl,allowHttpError:true});rateNote(x,slot);return x;});
  if(r.status!==200)throw new Error('USPTO document list HTTP '+Number(r.status||0)+(r.status===429?`; wait at least ${rateLimitWaitSeconds(r.retryAfter)} s before retrying`:''));
  let parsed;try{parsed=JSON.parse(r.text);}catch{throw new Error('USPTO document list was not JSON');}
  return {application_number:body.application_number,source_url:url,retrieved_at:new Date().toISOString(),status:200,body:parsed};
}

// ---- Office action rejections (USPTO ODP) ----
// {action:'records', application_numbers:[8-digit...], field?, start?, rows?} or {action:'fields'}. The adapter (oa-adapter.mjs)
// builds the fixed-endpoint request and packages the answer: HTTP status from the response, fail closed on an unexpected shape.
async function oaRejections(body,ctx){
  requireProvider('uspto',ctx);
  const adapter=selectOaAdapter(ctx.config),action=body?.action??'records',spec=adapter.buildRequest(body);
  const r=await limited('uspto',ctx,async slot=>{
    const x=await request(spec.url,{method:spec.method,...(spec.body?{body:spec.body}:{}),headers:{'X-API-KEY':ctx.env.USPTO_API_KEY,Accept:'application/json',...(spec.contentType?{'Content-Type':spec.contentType}:{})},timeout:ctx.config.requestTimeoutMs,maxBytes:8e6,fetchImpl:ctx.fetchImpl,allowHttpError:true});
    x.rateLimit=rateNote(x,slot);
    return x;
  });
  return {...adapter.packageResponse(action,r.status,r.text),...r.rateLimit};
}

// ---- Google BigQuery: fixed parameterized SQL only, dry run by default ----
const projectPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export function bigQueryExecutionAllowed(config){return config.googleBigQueryExecutionEnabled===true&&['sandbox-no-billing','billing-enabled-capped'].includes(config.googleBigQueryBillingMode);}
function bigQueryProject(ctx){
  requireProvider('bigquery',ctx);
  const projectId=ctx.config.googleBigQueryProjectId||ctx.env.BIGQUERY_PROJECT_ID;
  if(!projectPattern.test(projectId||''))throw new Error('Set BIGQUERY_PROJECT_ID (or googleBigQueryProjectId) to your own Google Cloud project ID');
  return projectId;
}
async function bigQueryCall(method,url,body,ctx){
  const r=await limited('bigquery',ctx,async slot=>{const token=await googleAccessToken(ctx);const x=await request(url,{method,body,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),Accept:'application/json'},timeout:180000,maxBytes:2e6,fetchImpl:ctx.fetchImpl,allowHttpError:true});rateNote(x,slot);return x;});
  let parsed={};try{parsed=r.text?JSON.parse(r.text):{};}catch{parsed={};}
  return {statusCode:r.status,body:parsed};
}
function executionCeiling(ctx){
  if(!bigQueryExecutionAllowed(ctx.config))throw new Error('BigQuery data-query execution is disabled; set googleBigQueryExecutionEnabled and googleBigQueryBillingMode in config.json');
  const ceiling=String(ctx.config.googleBigQueryPerQueryMaxBytes);if(!/^[1-9]\d*$/.test(ceiling))throw new Error('Invalid BigQuery per-query byte ceiling');
  return ceiling;
}
async function googleBigQueryDryRun(body,ctx){
  if(ctx.config.googleBigQueryDryRunEnabled!==true)throw new Error('BigQuery dry runs are disabled in config');
  const projectId=bigQueryProject(ctx),{externalAccess}=await import('./external-access.mjs');
  const plan=externalAccess({source:'google-bigquery',cpc:body?.cpc,from:body?.from,to:body?.to});
  if(plan.request.configuration.dryRun!==true)throw new Error('Dry-run guard failed');
  const r=await bigQueryCall('POST',`${BIGQUERY}/projects/${projectId}/jobs`,plan.request,ctx),b=r.body;
  return {status:r.statusCode,dryRun:true,executedDataQuery:false,jobReference:b.jobReference,statistics:b.statistics,error:b.error,warning:'This checks permissions, SQL/schema and estimated bytes only. It cannot run a data query.'};
}
async function tableMetadata(dataset,table,ctx){
  const r=await bigQueryCall('GET',`${BIGQUERY}/projects/patents-public-data/datasets/${dataset}/tables/${table}`,undefined,ctx),b=r.body,t=b.tableReference;
  return {statusCode:r.statusCode,metadata:{projectId:t?.projectId,datasetId:t?.datasetId,tableId:t?.tableId,lastModifiedTime:b.lastModifiedTime,numRows:b.numRows,numBytes:b.numBytes,schema:(b.schema?.fields||[]).map(f=>({name:f.name,type:f.type,mode:f.mode}))}};
}
const digits=value=>/^(0|[1-9]\d*)$/.test(value||'');
const queryEnvelope=(r,maximumBytesBilled,metadata)=>{const b=r.body;return {status:r.statusCode,dryRun:false,executedDataQuery:r.statusCode===200&&b.jobComplete===true&&!b.error&&!(b.errors?.length),jobComplete:b.jobComplete===true,jobReference:b.jobReference,schema:b.schema,rows:b.rows||[],totalRows:b.totalRows,totalBytesProcessed:b.totalBytesProcessed,totalBytesBilled:b.totalBytesBilled,cacheHit:b.cacheHit===true,error:b.error,errors:b.errors,maximumBytesBilled,tableMetadataStatus:200,tableMetadata:metadata};};
async function googleBigQueryQuery(body,ctx){
  const maximumBytesBilled=executionCeiling(ctx),projectId=bigQueryProject(ctx);
  const [{externalAccess},{buildBigQueryExecutionRequest}]=await Promise.all([import('./external-access.mjs'),import('./bigquery.mjs')]);
  const plan=externalAccess({source:'google-bigquery',cpc:body?.cpc,from:body?.from,to:body?.to}),requestBody=buildBigQueryExecutionRequest(plan,maximumBytesBilled);
  const meta=await tableMetadata('patents','publications',ctx),m=meta.metadata;
  if(meta.statusCode!==200||m.projectId!=='patents-public-data'||m.datasetId!=='patents'||m.tableId!=='publications'||!digits(m.lastModifiedTime)||!digits(m.numRows)||!digits(m.numBytes))throw new Error('Google Patents table metadata could not be verified');
  const r=await bigQueryCall('POST',`${BIGQUERY}/projects/${projectId}/queries`,requestBody,ctx);
  const {schema,...tableMeta}=m;
  return queryEnvelope(r,maximumBytesBilled,tableMeta);
}
const patexRequired={application_number:'STRING',filing_date:'STRING',invention_subject_matter:'STRING',application_type:'STRING',examiner_name_last:'STRING',examiner_name_first:'STRING',examiner_name_middle:'STRING',examiner_id:'STRING',examiner_art_unit:'STRING',patent_issue_date:'STRING',abandon_date:'STRING',disposal_type:'STRING'};
async function examinerPlan(body){
  const {buildExaminerPlan}=await import('./examiner.mjs');
  return buildExaminerPlan({scope:body?.scope,examiner:body?.value,artUnit:body?.value,from:body?.from,to:body?.to});
}
const setCutoff=(parameters,lastModifiedTime)=>{const cutoff=new Date(Number(lastModifiedTime)).toISOString().slice(0,10),p=parameters.find(x=>x.name==='data_cutoff');if(!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)||!p)throw new Error('Hosted PatEx cutoff could not be derived');p.parameterValue.value=cutoff;};
async function examinerDryRun(body,ctx){
  if(ctx.config.googleBigQueryDryRunEnabled!==true)throw new Error('BigQuery dry runs are disabled in config');
  const projectId=bigQueryProject(ctx),plan=await examinerPlan(body);
  const meta=await tableMetadata('uspto_oce_pair','application_data',ctx);
  setCutoff(plan.request.configuration.query.queryParameters,meta.metadata.lastModifiedTime);
  const r=await bigQueryCall('POST',`${BIGQUERY}/projects/${projectId}/jobs`,plan.request,ctx),b=r.body;
  return {status:r.statusCode,dryRun:true,executedDataQuery:false,jobReference:b.jobReference,statistics:b.statistics,error:b.error,errors:b.errors,tableMetadataStatus:meta.statusCode,tableMetadata:meta.metadata,warning:'This checks the fixed PatEx query and estimated bytes only.'};
}
async function examinerQuery(body,ctx){
  const maximumBytesBilled=executionCeiling(ctx),projectId=bigQueryProject(ctx),plan=await examinerPlan(body);
  const {buildExaminerExecutionRequest}=await import('./examiner.mjs');
  const requestBody=buildExaminerExecutionRequest(plan,maximumBytesBilled);
  const meta=await tableMetadata('uspto_oce_pair','application_data',ctx),m=meta.metadata;
  if(meta.statusCode!==200||m.projectId!=='patents-public-data'||m.datasetId!=='uspto_oce_pair'||m.tableId!=='application_data'||!digits(m.lastModifiedTime)||!digits(m.numRows)||!digits(m.numBytes)||Object.entries(patexRequired).some(([name,type])=>!m.schema.some(f=>f.name===name&&f.type===type)))throw new Error('Hosted PatEx table identity or schema could not be verified');
  setCutoff(requestBody.queryParameters,m.lastModifiedTime);
  const r=await bigQueryCall('POST',`${BIGQUERY}/projects/${projectId}/queries`,requestBody,ctx);
  return queryEnvelope(r,maximumBytesBilled,m);
}

// One entry point with the n8n gateway's (route, body) contract.
export async function directGateway(route,body,options={}){
  const ctx=context(options);
  switch(route){
    case 'uspto':case 'ptab':case 'govinfo':case 'courtlistener':case 'epo':case 'public':return sourceRoute(route,body,ctx,options.maxBytes);
    case 'reference-index':return referenceIndex(body,ctx);
    case 'ptab-files':return ptabFiles(body,ctx);
    case 'oa-rejections':return oaRejections(body,ctx);
    case 'application-documents':return applicationDocuments(body,ctx);
    case 'application-pdf':return applicationPdf(body,ctx);
    case 'google-bigquery':return googleBigQueryDryRun(body,ctx);
    case 'google-bigquery-query':return googleBigQueryQuery(body,ctx);
    case 'examiner-bigquery':return examinerDryRun(body,ctx);
    case 'examiner-bigquery-query':return examinerQuery(body,ctx);
    default:throw new Error(`The "${route}" route is available only with the optional n8n transport`);
  }
}

// Hub-facing source call: same contract and failure behaviour as gateway.mjs gatewaySource.
export async function directSource(source,url,options={},context_={}){
  const r=await directGateway(routeForSource(source),{source,url:String(url),method:options.method||'GET',body:options.body},context_);
  if(typeof r.text!=='string'||typeof r.contentType!=='string')throw new Error('Provider response schema changed');
  if(r.status<200||r.status>=300)throw new Error('Provider HTTP '+r.status+'; check access and retry later');
  return r;
}
