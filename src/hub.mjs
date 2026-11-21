import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sources,sourceById,sourceStatus} from './sources.mjs';
import {parseCafc,parseSourceLinks,parseEpoBiblio,normalizeEpodocPublication,record,arr} from './parsers.mjs';
import {Store} from './store.mjs';
import {readConfig,gatewaySource,callGateway} from './gateway.mjs';
import {configDefaults,dataDir,intakeDir,installRoot} from './config.mjs';
import {NotConfiguredError} from './providers.mjs';
import {ptabOriginalRequest,decodePtabOriginal,stageOriginal} from './originals.mjs';
export const root=installRoot;
export class Hub{
  constructor({dataRoot,env=process.env,fetchImpl=fetch,config=readConfig({env})}={}){this.config={...configDefaults,...config};this.env=env;this.fetch=fetchImpl;this.dataRoot=dataRoot||dataDir(this.config,env);this.store=new Store(this.dataRoot);}
  list(){return {transport:this.config.transport,sources:sources.map(s=>{if(this.config.transport!=='n8n'||['external','reference'].includes(s.kind))return sourceStatus(s,this.env,this.config);const last=this.store.lastSourceRun(s.id,'n8n');return {...s,status:last?'previously_retrieved_via_n8n':s.optional?'optional_disabled':'n8n_access_unverified',lastSuccessfulRetrieval:last?{at:last.created,returned:last.returned,snapshotId:last.snapshotId}:null,missing:[],setup:last&&s.optional?'The optional connector is configured and has dated live-retrieval evidence. Run a current query when present health matters.':s.optional?'Optional connector is excluded until its provider credential or use authorization is configured in n8n and live-verified.':'Connection and publication are managed in n8n. A past retrieval is historical evidence, not a current health check.'};}),localRecords:this.store.stats(),recentRuns:this.store.lastRuns().slice(0,8).map(({recordIds,...r})=>r),privacy:this.config.transport==='n8n'?'Public source index stored locally. Provider credentials stay in n8n. The calling application controls model and memory traffic; session encryption is not asserted.':'Public source index stored locally. Provider credentials are read from environment variables at call time and are never stored. Direct transport has not been verified against live providers in this release. The calling application controls model and memory traffic; session encryption is not asserted.'};}
  async request(source,url,options={}){
    if(this.config.transport==='n8n'&&source==='uspto-guidance'&&this.config.referenceGatewayEnabled){
      const response=await callGateway('reference-index',{source:'patent-guidance'},{config:this.config,fetchImpl:this.fetch});
      if(typeof response.text!=='string'||typeof response.contentType!=='string'||response.status<200||response.status>=300)throw new Error('Official guidance index gateway returned an invalid response');
      return response;
    }
    return gatewaySource(source,url,options,this.config,{env:this.env,fetchImpl:this.fetch});
  }
  async json(source,url,options={}){const r=await this.request(source,url,{...options,headers:{'Content-Type':'application/json',...options.headers}});try{return JSON.parse(r.text);}catch{throw new Error('Provider returned invalid JSON');}}
  async sync(id){const s=sourceById(id);if(!['rss','links','directory'].includes(s.kind))throw new Error('Use query for API sources; external sources require their own access setup');const r=await this.request(id,s.url);if(!/xml|html/.test(r.contentType))throw new Error('Unexpected source content type');const records=s.kind==='rss'?parseCafc(r.text):parseSourceLinks(s,r.text);return this.store.ingest(id,{url:s.url},r.text,records,{transport:this.config.transport,exhaustive:false,scope:s.kind==='rss'?'current RSS feed':'links visible on official index',notes:s.coverage});}
  async query(id,q,{cursor='',limit=25}={}){
    if(typeof q!=='string'||q.length>2000)throw new Error('Query must contain at most 2000 characters');
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Limit must be 1–100');
    if(typeof cursor!=='string'||cursor.length>2000)throw new Error('Invalid cursor');
    const s=sourceById(id);if(s.kind==='courtlistener'&&limit!==20)throw new Error('CourtListener search uses fixed 20-result provider pages; set limit to 20 and follow the returned cursor');
    const state=sourceStatus(s,this.env,this.config);if(this.config.transport!=='n8n'&&state.status!=='ready'){if(s.provider)throw new NotConfiguredError(s.provider,state.missing);throw new Error(`${s.name}: ${state.status}`);}
    const headers={},options={fetchImpl:this.fetch};let data,rows,nextCursor=null,total=null;
    if(s.kind==='odp'){
      const offset=cursor?Number(cursor):0;if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('Invalid offset');
      const url=new URL(s.url);if(id!=='odp')url.search=new URLSearchParams({q,offset:String(offset),limit:String(limit)});
      data=await this.json(id,url,{...options,...(id==='odp'?{method:'POST',body:{q,pagination:{offset,limit}}}:{})});
      const bag=id==='odp'?'patentFileWrapperDataBag':id==='ptab-appeals'?'patentAppealDataBag':Array.isArray(data.patentTrialDecisionDataBag)?'patentTrialDecisionDataBag':'patentTrialDocumentDataBag';
      if(!Array.isArray(data[bag]))throw new Error('USPTO response schema not recognized; no records imported');
      rows=data[bag].map(x=>{const meta=x.applicationMetaData||x.appealMetaData||x.trialMetaData||{},doc=x.decisionDocumentData||x.documentData||{};const ident=x.applicationNumberText||x.appealNumber||x.trialNumber;return record(id,{title:meta.inventionTitle||doc.documentTitleText||ident||'USPTO record',url:doc.fileDownloadURI||(id==='odp'?'https://data.uspto.gov/patent-file-wrapper/search/details/'+encodeURIComponent(ident||''):id==='ptab-appeals'?'https://data.uspto.gov/ptab/appeals':'https://data.uspto.gov/ptab/trials/proceedings'),type:id==='odp'?'application':id==='ptab-appeals'?'appeal-decision':'trial-document',date:x.decisionData?.decisionIssueDate||doc.decisionIssueDate||doc.documentFilingDate||meta.filingDate,dateBasis:id==='odp'?'filing':'decision-or-document',excerpt:JSON.stringify(x).slice(0,10000),metadata:{...x,recordIdentifier:ident}});});
      // Different proceedings can share the same generic landing URL. Preserve their identities.
      rows=rows.map((r,i)=>{const x=data[bag][i],doc=x.decisionDocumentData||x.documentData||{};return {...r,id:record(id,{url:s.url+'#'+(x.applicationNumberText||x.appealNumber||x.trialNumber||'')+':'+(doc.documentIdentifier||doc.fileDownloadURI||JSON.stringify(doc))}).id};});
      total=typeof data.count==='number'?data.count:null;if(data[bag].length===limit&&(total===null||offset+limit<total))nextCursor=String(offset+limit);
    }else if(s.kind==='govinfo'){
      data=await this.json(id,s.url,{...options,method:'POST',body:{query:'collection:USCOURTS '+q,pageSize:String(limit),offsetMark:cursor||'*',sorts:[{field:'score',sortOrder:'DESC'}]}});
      if(!Array.isArray(data.results))throw new Error('GovInfo search schema changed');
      rows=data.results.map(x=>record(id,{title:x.title,url:x.resultLink||('https://www.govinfo.gov/app/details/'+encodeURIComponent(x.packageId)),date:x.dateIssued,dateBasis:'issued',type:'court-opinion-index',excerpt:x.summary||'',metadata:x}));
      total=typeof data.count==='number'?data.count:null;nextCursor=data.offsetMark&&data.offsetMark!==(cursor||'*')?data.offsetMark:null;
    }else if(s.kind==='courtlistener'){
      const u=new URL(s.url);u.search=new URLSearchParams({q,type:'o',...(cursor?{cursor}:{} )});
      data=await this.json(id,u,options);
      if(!Array.isArray(data.results))throw new Error('CourtListener search schema changed');
      rows=data.results.map(x=>record(id,{title:x.caseName,url:new URL(x.absolute_url,'https://www.courtlistener.com').href,date:x.dateFiled,dateBasis:'decision-filed',type:'court-opinion-index',precedentialStatus:x.status||'not-verified',excerpt:x.snippet||arr(x.opinions).map(o=>o.snippet||'').join('\n'),metadata:x}));
      total=typeof data.count==='number'?data.count:null;if(data.next){const n=new URL(data.next);if(n.origin!=='https://www.courtlistener.com'||n.pathname!=='/api/rest/v4/search/')throw new Error('Unrecognized pagination URL');nextCursor=n.searchParams.get('cursor');}
    }else if(s.kind==='epo'){
      if(cursor)throw new Error('EPO bibliographic lookup has no cursor');const publication=normalizeEpodocPublication(q);
      const endpoint=s.url+'/published-data/publication/epodoc/'+encodeURIComponent(publication.path)+'/biblio';
      const r=await this.request(id,endpoint,{...options,headers:{Accept:'application/exchange+xml'}});
      if(!/xml/i.test(r.contentType))throw new Error('EPO returned an unexpected content type');
      const parsed=parseEpoBiblio(r.text,publication.normalized);data={xml:r.text,requestedPublication:publication.normalized};rows=parsed.documents.map(document=>{const row=record(id,{title:document.title||document.publication,url:endpoint+'#'+document.publication,date:document.date,dateBasis:'publication',type:'bibliographic-record',excerpt:document.abstract||'',metadata:{...document,requestedPublication:publication.normalized,responseFormat:'EPO exchange XML',sourceEndpoint:endpoint}});return row;});total=rows.length;
    }else throw new Error('This source is an index or external service, not a connected query API');
    const run=this.store.ingest(id,{q,cursor,limit},JSON.stringify(data),rows,{transport:this.config.transport,exhaustive:false,scope:'one provider response page',providerTotal:total,nextCursor,notes:s.coverage});return {...run,records:rows,nextCursor,providerTotal:total,warning:s.kind==='epo'?'OPS returned bibliographic metadata for the requested publication identity. It is not a legal-status opinion, ownership determination, or normalized patent family.':'Search matches are retrieval leads, not a statistical population. Full opinion text and later treatment have not been checked.'};
  }
  // Optional Get Files integration (a separate tool): archiving, passages and reference indexing need it.
  async corpus(){const file=this.env.RESEARCH_GET_FILES_CLIENT||this.config.getFilesClientModule;if(!file)throw Object.assign(new Error('The optional Get Files integration is not configured. Set RESEARCH_GET_FILES_CLIENT or getFilesClientModule to its get-files-client.mjs (see docs/INTEGRATION.md).'),{code:'NOT_CONFIGURED',notConfigured:{status:'not_configured',provider:'get-files',missing:['RESEARCH_GET_FILES_CLIENT'],docs:'docs/INTEGRATION.md'}});const module=await import(pathToFileURL(path.resolve(root,file)));return new module.GetFilesClient();}
  async archive(id,{retry=false}={}){
    const r=this.store.get(id),client=await this.corpus();
    if(r.acquisition){let result=await this.jobs([r.acquisition.jobId]);if(retry&&['failed','needs_access','needs_resolution'].includes(result.jobs?.[0]?.status)){await client.request('/v1/jobs/'+encodeURIComponent(r.acquisition.jobId)+'/retry',{});result=await this.jobs([r.acquisition.jobId]);}return {...result,reused:true,recordId:id,acquisition:this.store.lastAcquisition(id,r.snapshotId)};}
    let result,extra={};
    if(['ptab-trials','ptab-appeals'].includes(r.source)){
      if(this.config.ptabOriginalsEnabled!==true)throw new Error('PTAB original downloads are disabled (ptabOriginalsEnabled)');
      const identity=ptabOriginalRequest(r);
      const envelope=await callGateway('ptab-files',{...(identity.trialNumber?{trialNumber:identity.trialNumber}:{appealNumber:identity.appealNumber}),documentIdentifier:identity.documentIdentifier},{config:this.config,maxBytes:15*1024*1024,fetchImpl:this.fetch,env:this.env});
      const verified=decodePtabOriginal(envelope,identity.url);
      const file=await stageOriginal(verified.bytes,verified.sha256,intakeDir(this.config,this.env));
      const submission=await client.ingest('legal',[{path:file,title:r.title,source_url:r.url,source_system:'patent-research',source_id:r.id,source_date:r.date,expected_sha256:verified.sha256,mode:'both',tags:['patent-research',r.source],idempotency_key:'ptab-original:'+r.id+':'+r.snapshotId}]);
      const jobId=submission.items?.[0]?.job_id;if(!jobId)throw new Error('Corpus rejected the verified original; the staged PDF is preserved in its intake folder');
      extra={expectedSha256:verified.sha256,acquisitionMethod:this.config.transport==='n8n'?'n8n-authenticated-pdf':'direct-authenticated-pdf',stagedPath:file};
      this.store.saveAcquisition(r,{job_id:jobId,status:'queued'},extra);
      result=await this.jobs([jobId]);
    }else{
      result=await client.getFiles({items:[{url:r.url,title:r.title,tags:['patent-research',r.source],idempotency_key:'patent-research:'+r.id+':'+r.snapshotId}],mode:'both',collection:'legal',wait_seconds:2});
      const job=result.jobs?.[0];if(!job)throw new Error('Corpus did not return an acquisition job');this.store.saveAcquisition(r,job,{acquisitionMethod:'get-files-public-url'});
    }
    return {...result,recordId:id,acquisition:this.store.lastAcquisition(id,r.snapshotId)};
  }
  async jobs(ids){const result=await (await this.corpus()).getJobs(ids,{wait_seconds:2});for(const job of result.jobs||[])this.store.updateAcquisition(job);return result;}
  async corpusSearch(query){return (await this.corpus()).search('legal',query,8,{tags:['patent-research']});}
  async corpusRead(id,offset=0){if(!/^[a-f0-9]{64}$/.test(id)||!Number.isInteger(offset)||offset<0)throw new Error('Invalid document identifier or offset');const client=await this.corpus(),doc=await client.document('legal',id),chunks=await client.request('/v1/documents/'+id+'/chunks?'+new URLSearchParams({collection:'legal',offset:String(offset),limit:'3'}));this.store.markDocumentRead(id,{offset,nextOffset:chunks.next_offset,locators:(chunks.chunks||[]).map(x=>x.locator)});return {document_id:id,title:doc.title,status:doc.status,extraction_warnings:doc.manifest?.warnings||[],origins:doc.origins,...chunks};}
}
