// Offline tests for the direct transport. Every provider response is a mocked fetch; no network is used.
// These tests establish request shapes and envelope parity with the n8n transport only. They do not show that the
// direct transport works against the live providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVerify,generateKeyPairSync} from 'node:crypto';
import {Hub} from '../src/hub.mjs';
import {callGateway} from '../src/gateway.mjs';
import {directGateway,resetDirectState} from '../src/direct.mjs';
import {doctor} from '../src/doctor.mjs';
import {estimateBigQuery,queryBigQueryTrend} from '../src/bigquery.mjs';
import {patentDocumentInventory} from '../src/patent-documents.mjs';
import {fetchGovinfoOpinionPdf} from '../src/govinfo-pdf.mjs';
import {readConfig,configDefaults} from '../src/config.mjs';

const fast={...configDefaults.directMinIntervalMs,uspto:0,epo:0,govinfo:0,courtlistener:0,bigquery:0,public:0};
const direct=(extra={})=>({transport:'direct',directMinIntervalMs:fast,...extra});
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
const odpPage={count:3,patentFileWrapperDataBag:[1,2].map(i=>({applicationNumberText:'1812345'+i,applicationMetaData:{inventionTitle:'Fixture invention '+i,filingDate:'2024-01-0'+i}}))};
function tempDir(prefix){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}
function withHub(options,fn){const dir=tempDir('patent-direct-');const hub=new Hub({dataRoot:dir,...options});return Promise.resolve().then(()=>fn(hub)).finally(()=>{hub.store.close();fs.rmSync(dir,{recursive:true,force:true});});}
const strip=result=>({records:result.records.map(({retrievedAt,snapshotId,...r})=>r),nextCursor:result.nextCursor,providerTotal:result.providerTotal,returned:result.returned,warning:result.warning});

test('Default configuration selects the direct transport with execution and CourtListener off',()=>{
  const config=readConfig({env:{PATENT_RESEARCH_CONFIG:path.join(os.tmpdir(),'no-such-patent-config.json')}});
  assert.equal(config.transport,'direct');assert.equal(config.googleBigQueryExecutionEnabled,false);assert.equal(config.googleBigQueryDryRunEnabled,true);
  assert.equal(config.courtlistenerEnabled,false);assert.equal(config.courtlistenerInternalUseAllowed,false);
});

test('USPTO search sends the key only to the provider and normalizes exactly like the n8n transport',async()=>{
  let seen;
  const directResult=await withHub({config:direct(),env:{USPTO_API_KEY:'fixture-key'},fetchImpl:async(url,options)=>{seen={url:String(url),options};return json(odpPage);}},hub=>hub.query('odp','inventionTitle:fixture',{limit:2}));
  assert.equal(seen.url,'https://api.uspto.gov/api/v1/patent/applications/search');
  assert.equal(seen.options.method,'POST');assert.equal(seen.options.headers['X-API-KEY'],'fixture-key');
  assert.deepEqual(JSON.parse(seen.options.body),{q:'inventionTitle:fixture',pagination:{offset:0,limit:2}});
  const auth=path.join(tempDir('patent-auth-'),'auth.env');fs.writeFileSync(auth,'RESEARCH_GATEWAY_AUTH_HEADER_VALUE=Bearer '+'x'.repeat(43)+'\n');
  let gatewayCall;
  const n8nResult=await withHub({config:{transport:'n8n',n8nBaseUrl:'http://127.0.0.1:59999',gatewayAuthFile:auth},env:{},fetchImpl:async(url,options)=>{gatewayCall={url:String(url),body:JSON.parse(options.body)};return json({text:JSON.stringify(odpPage),status:200,contentType:'application/json'});}},hub=>hub.query('odp','inventionTitle:fixture',{limit:2}));
  fs.rmSync(path.dirname(auth),{recursive:true,force:true});
  assert.equal(gatewayCall.url,'http://127.0.0.1:59999/webhook/patent-research-uspto');assert.equal(gatewayCall.body.source,'odp');
  assert.deepEqual(strip(directResult),strip(n8nResult));
  assert.equal(directResult.records.length,2);assert.equal(directResult.nextCursor,'2');
});

test('A missing key reports not configured with the registration link and makes no request',async()=>{
  let calls=0;
  await withHub({config:direct(),env:{},fetchImpl:async()=>{calls++;return json({});}},async hub=>{
    const error=await hub.query('odp','x').then(()=>null,e=>e);
    assert.equal(error.code,'NOT_CONFIGURED');assert.deepEqual(error.notConfigured.missing,['USPTO_API_KEY']);
    assert.match(error.notConfigured.register,/^https:\/\/data\.uspto\.gov\//);assert.match(error.message,/Register: https:/);
    const status=hub.list().sources.find(s=>s.id==='odp');assert.equal(status.status,'not_configured');assert.ok(status.register);
  });
  assert.equal(calls,0);
});

test('CourtListener stays disabled until enabled and the Free Law terms are acknowledged in config',async()=>{
  let calls=0;
  await withHub({config:direct(),env:{COURTLISTENER_TOKEN:'fixture-token'},fetchImpl:async()=>{calls++;return json({results:[]});}},async hub=>{
    const error=await hub.query('courtlistener','patent',{limit:20}).then(()=>null,e=>e);
    assert.equal(error.code,'NOT_CONFIGURED');assert.match(error.notConfigured.terms,/free\.law/);
    assert.ok(error.notConfigured.missing.some(x=>x.includes('courtlistenerInternalUseAllowed')));
    assert.equal(hub.list().sources.find(s=>s.id==='courtlistener').status,'disabled_until_terms_acknowledged');
  });
  await withHub({config:direct({courtlistenerEnabled:true}),env:{COURTLISTENER_TOKEN:'fixture-token'},fetchImpl:async()=>{calls++;return json({results:[]});}},async hub=>{
    await assert.rejects(hub.query('courtlistener','patent',{limit:20}),/not configured/);
  });
  assert.equal(calls,0);
  let seen;
  await withHub({config:direct({courtlistenerEnabled:true,courtlistenerInternalUseAllowed:true}),env:{COURTLISTENER_TOKEN:'fixture-token'},fetchImpl:async(url,options)=>{seen={url:String(url),options};return json({count:0,results:[]});}},hub=>hub.query('courtlistener','patent',{limit:20}));
  assert.equal(seen.options.headers.Authorization,'Token fixture-token');assert.equal(new URL(seen.url).searchParams.get('type'),'o');
});

test('EPO OPS uses client-credentials OAuth, caches the token, and renews it once after a 401',async()=>{
  resetDirectState();
  const xml=fs.readFileSync(new URL('fixtures/epo-biblio.xml',import.meta.url),'utf8');
  const calls=[];let reject=false,issued=0;
  const fetchImpl=async(url,options)=>{
    const u=String(url);calls.push({url:u,options});
    if(u==='https://ops.epo.org/3.2/auth/accesstoken'){issued++;return json({access_token:'fixture-access-'+issued,expires_in:'1199'});}
    if(reject){reject=false;return new Response('expired',{status:401});}
    return new Response(xml,{headers:{'content-type':'application/exchange+xml'}});
  };
  await withHub({config:direct(),env:{EPO_OPS_CONSUMER_KEY:'fixture-consumer',EPO_OPS_CONSUMER_SECRET:'fixture-secret'},fetchImpl},async hub=>{
    await hub.query('epo','EP1000000.A1');await hub.query('epo','EP1000000.A1');
    assert.equal(issued,1);
    const tokenCall=calls[0];assert.equal(tokenCall.options.method,'POST');
    assert.equal(tokenCall.options.headers.Authorization,'Basic '+Buffer.from('fixture-consumer:fixture-secret').toString('base64'));
    assert.equal(tokenCall.options.body,'grant_type=client_credentials');
    const lookup=calls[1];assert.equal(lookup.options.headers.Authorization,'Bearer fixture-access-1');assert.equal(lookup.options.headers.Accept,'application/exchange+xml');
    reject=true;const r=await hub.query('epo','EP1000000.A1');assert.equal(r.records.length,1);assert.equal(issued,2);
  });
  resetDirectState();
});

test('GovInfo search posts the fixed USCOURTS body with the GovInfo key header',async()=>{
  let seen;
  await withHub({config:direct(),env:{GOVINFO_API_KEY:'fixture-govinfo'},fetchImpl:async(url,options)=>{seen={url:String(url),options};return json({count:1,results:[{title:'Fixture v. Example',packageId:'USCOURTS-cafc-24-1000',dateIssued:'2025-01-02'}]});}},async hub=>{
    const r=await hub.query('govinfo','patent eligibility',{limit:5});assert.equal(r.records.length,1);
  });
  assert.equal(seen.url,'https://api.govinfo.gov/search');assert.equal(seen.options.headers['X-Api-Key'],'fixture-govinfo');
  assert.deepEqual(JSON.parse(seen.options.body),{query:'collection:USCOURTS patent eligibility',pageSize:'5',offsetMark:'*',sorts:[{field:'score',sortOrder:'DESC'}]});
});

test('GovInfo opinion PDFs are fetched as bytes and verified like the n8n envelope',async()=>{
  const pdf=Buffer.from('%PDF-1.7 fixture opinion');
  const r=await fetchGovinfoOpinionPdf('USCOURTS-cafc-24-1000','USCOURTS-cafc-24-1000-0',{config:direct(),callGateway:(route,body,opts)=>callGateway(route,body,{...opts,env:{GOVINFO_API_KEY:'fixture'},fetchImpl:async url=>{assert.equal(String(url),'https://api.govinfo.gov/packages/USCOURTS-cafc-24-1000/granules/USCOURTS-cafc-24-1000-0/pdf');return new Response(pdf,{headers:{'content-type':'application/pdf'}});}})});
  assert.equal(r.bytes.toString(),pdf.toString());assert.match(r.sha256,/^[a-f0-9]{64}$/);
});

test('Idempotent GETs retry after 503 with backoff; POST searches are never retried',async()=>{
  let gets=0,posts=0;
  const fixture={count:1,patentTrialDocumentDataBag:[{trialNumber:'IPR2025-00001',documentData:{documentIdentifier:'1',documentTitleText:'Decision'}}]};
  await withHub({config:direct(),env:{USPTO_API_KEY:'fixture'},fetchImpl:async(url,options)=>{if(options.method==='POST'){posts++;return new Response('busy',{status:503});}gets++;return gets===1?new Response('busy',{status:503,headers:{'retry-after':'1'}}):json(fixture);}},async hub=>{
    const r=await hub.query('ptab-trials','trialNumber:IPR2025-00001',{limit:1});assert.equal(r.records.length,1);assert.equal(gets,2);
    await assert.rejects(hub.query('odp','x',{limit:1}),/HTTP 503/);assert.equal(posts,1);
  });
});

test('Requests to one provider are paced by the configured minimum interval',async()=>{
  const times=[];
  await withHub({config:direct({directMinIntervalMs:{...fast,uspto:120}}),env:{USPTO_API_KEY:'fixture'},fetchImpl:async()=>{times.push(Date.now());return json(odpPage);}},async hub=>{
    await hub.query('odp','a',{limit:2});await hub.query('odp','b',{limit:2});
  });
  assert.equal(times.length,2);assert.ok(times[1]-times[0]>=100,'second request was not paced');
});

test('maxRequestsPerHour stops a keyed provider with a clear local error and leaves other providers alone',async()=>{
  let calls=0;
  await withHub({config:direct({maxRequestsPerHour:{uspto:2}}),env:{USPTO_API_KEY:'fixture'},fetchImpl:async()=>{calls++;return json(odpPage);}},async hub=>{
    await hub.query('odp','a',{limit:2});await hub.query('odp','b',{limit:2});
    await assert.rejects(hub.query('odp','c',{limit:2}),/Local request limit reached for uspto: 2 requests in the last hour/);
  });
  assert.equal(calls,2);
  assert.equal(readConfig({env:{PATENT_RESEARCH_CONFIG:path.join(os.tmpdir(),'absent-config.json')}}).maxRequestsPerHour.uspto,1800);
});

test('Patent Genius gateway contract: callGateway returns provider status instead of throwing on 413',async()=>{
  const r=await callGateway('uspto',{source:'odp',url:'https://api.uspto.gov/api/v1/patent/applications/search',method:'POST',body:{q:'x',pagination:{offset:0,limit:100}}},{config:direct(),env:{USPTO_API_KEY:'fixture'},fetchImpl:async()=>new Response('too large',{status:413})});
  assert.equal(r.status,413);assert.equal(typeof r.text,'string');assert.equal(typeof r.contentType,'string');
  await assert.rejects(callGateway('model',{messages:[]},{config:direct()}),/only with the optional n8n transport/);
});

test('Application document inventory works on the direct transport',async()=>{
  let seen,saved;
  const result=await patentDocumentInventory({applicationNumber:'18123456',maxDocuments:5},{config:direct(),store:{saveQueryCache:(kind,key,value)=>{saved={kind,key};}},gateway:(route,body,opts)=>callGateway(route,body,{...opts,env:{USPTO_API_KEY:'fixture'},fetchImpl:async(url,options)=>{seen={url:String(url),options};return json({documentBag:[]});}})}).then(r=>r,e=>e);
  assert.equal(seen.url,'https://api.uspto.gov/api/v1/patent/applications/18123456/documents');assert.equal(seen.options.headers['X-API-KEY'],'fixture');
  assert.ok(result instanceof Error?!/not enabled|n8n/.test(result.message):saved.kind==='patent-document-inventory');
});

function serviceAccount(){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const dir=tempDir('patent-gcp-'),file=path.join(dir,'service-account.json');
  fs.writeFileSync(file,JSON.stringify({type:'service_account',client_email:'fixture@example-project-123.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'}),token_uri:'https://oauth2.googleapis.com/token'}));
  return {file,dir,publicKey};
}
function bigQueryFetch({publicKey,estimate='1234',calls}){
  return async(url,options)=>{
    const u=String(url);calls.push({url:u,options});
    if(u==='https://oauth2.googleapis.com/token'){
      const form=new URLSearchParams(options.body);assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h,p,s]=form.get('assertion').split('.');assert.ok(createVerify('RSA-SHA256').update(h+'.'+p).verify(publicKey,Buffer.from(s,'base64url')));
      assert.equal(JSON.parse(Buffer.from(p,'base64url')).scope,'https://www.googleapis.com/auth/bigquery');
      return json({access_token:'fixture-google-token',expires_in:3599});
    }
    assert.equal(options.headers.Authorization,'Bearer fixture-google-token');
    if(u.endsWith('/projects/example-project-123/jobs')){const body=JSON.parse(options.body);assert.equal(body.configuration.dryRun,true);return json({jobReference:{projectId:'example-project-123'},statistics:{totalBytesProcessed:estimate,query:{totalBytesBilled:'0',totalBytesProcessedAccuracy:'PRECISE'}}});}
    if(u.endsWith('/datasets/patents/tables/publications'))return json({tableReference:{projectId:'patents-public-data',datasetId:'patents',tableId:'publications'},lastModifiedTime:'1790000000000',numRows:'100',numBytes:'1000'});
    if(u.endsWith('/projects/example-project-123/queries')){const body=JSON.parse(options.body);assert.equal(body.dryRun,false);assert.equal(body.maximumBytesBilled,'5000');return json({jobComplete:true,jobReference:{projectId:'example-project-123'},schema:{fields:[{name:'year',type:'INTEGER'},{name:'publications',type:'INTEGER'}]},rows:[{f:[{v:'2024'},{v:'10'}]}],totalRows:'1',totalBytesProcessed:'1234',totalBytesBilled:'0',cacheHit:false});}
    throw new Error('unexpected request '+u);
  };
}

test('BigQuery dry run signs a service-account token and returns a zero-billed byte estimate',async()=>{
  resetDirectState();const sa=serviceAccount(),calls=[];
  try{
    const env={GOOGLE_APPLICATION_CREDENTIALS:sa.file,BIGQUERY_PROJECT_ID:'example-project-123'};
    const config=readConfig({env:{...env,PATENT_RESEARCH_CONFIG:path.join(sa.dir,'absent.json')}});config.directMinIntervalMs=fast;
    const estimate=await estimateBigQuery({cpc:'G06N',from:2024,to:2024},{config,call:(route,body,opts)=>callGateway(route,body,{...opts,env,fetchImpl:bigQueryFetch({publicKey:sa.publicKey,calls})})});
    assert.equal(estimate.totalBytesProcessed,'1234');assert.equal(estimate.totalBytesBilled,'0');assert.equal(estimate.dryRun,true);
    assert.ok(!calls.some(c=>c.url.endsWith('/queries')),'a dry run must not execute a data query');
  }finally{fs.rmSync(sa.dir,{recursive:true,force:true});resetDirectState();}
});

test('BigQuery data queries need explicit enablement and stay under per-query and monthly caps',async()=>{
  resetDirectState();const sa=serviceAccount(),env={GOOGLE_APPLICATION_CREDENTIALS:sa.file};
  const dir=tempDir('patent-bq-'),hub=new Hub({dataRoot:dir,config:direct({googleBigQueryProjectId:'example-project-123'}),env});
  try{
    let calls=[];const call=(route,body,opts)=>callGateway(route,body,{...opts,env,fetchImpl:bigQueryFetch({publicKey:sa.publicKey,calls,estimate:opts.config.__estimate||'1234'})});
    await assert.rejects(queryBigQueryTrend({cpc:'G06N',from:2024,to:2024},{config:hub.config,store:hub.store,call}),/disabled/);
    assert.equal(calls.length,0);
    await assert.rejects(directGateway('google-bigquery-query',{country:'US',cpc:'G06N',from:2024,to:2024},{config:hub.config,env,fetchImpl:bigQueryFetch({publicKey:sa.publicKey,calls})}),/execution is disabled/);
    const enabled={...hub.config,googleBigQueryExecutionEnabled:true,googleBigQueryBillingMode:'sandbox-no-billing',googleBigQueryPerQueryMaxBytes:'5000',googleBigQueryMonthlyTrackedMaxBytes:'3000'};
    const trend=await queryBigQueryTrend({cpc:'G06N',from:2024,to:2024},{config:enabled,store:hub.store,call});
    assert.equal(trend.series[0].count,10);assert.equal(trend.maximumBytesBilled,'5000');assert.equal(trend.delivery.mode,'hosted-query');
    calls=[];
    const over=await queryBigQueryTrend({cpc:'G06N',from:2023,to:2024},{config:{...enabled,__estimate:'9999'},store:hub.store,call}).then(()=>null,e=>e);
    assert.match(over.message,/per-query byte ceiling/);assert.ok(!calls.some(c=>c.url.endsWith('/queries')));
    calls=[];
    const monthly=await queryBigQueryTrend({cpc:'G06N',from:2022,to:2024},{config:{...enabled,__estimate:'2500'},store:hub.store,call}).then(()=>null,e=>e);
    assert.match(monthly.message,/monthly byte limit/);assert.ok(!calls.some(c=>c.url.endsWith('/queries')));
  }finally{hub.store.close();fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(sa.dir,{recursive:true,force:true});resetDirectState();}
});

test('doctor lists missing credentials by name only and never echoes values',()=>{
  const secret='fixture-value-that-must-not-appear';
  const report=doctor({config:{...configDefaults},env:{USPTO_API_KEY:secret,PATENT_RESEARCH_CONFIG:path.join(os.tmpdir(),'absent-patent-config.json')}});
  const text=JSON.stringify(report);
  assert.ok(!text.includes(secret));
  const uspto=report.providers.find(p=>p.provider==='uspto'),epo=report.providers.find(p=>p.provider==='epo'),cl=report.providers.find(p=>p.provider==='courtlistener');
  assert.equal(uspto.configured,true);assert.equal(epo.configured,false);assert.deepEqual(epo.missing,['EPO_OPS_CONSUMER_KEY','EPO_OPS_CONSUMER_SECRET']);
  assert.equal(cl.configured,false);assert.equal(report.bigQuery.mode,'dry-run estimates only');assert.match(report.verification,/NOT been verified against live providers/);
});

test('The bundled n8n node and the direct transport share one bounded downloader',()=>{
  const a=fs.readFileSync(new URL('../src/bounded-download.cjs',import.meta.url)),b=fs.readFileSync(new URL('../extras/n8n/custom-nodes/n8n-nodes-patent-research/nodes/bounded-download.js',import.meta.url));
  assert.ok(a.equals(b),'src/bounded-download.cjs and the n8n node copy must stay identical');
});
