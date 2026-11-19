import fs from 'node:fs/promises';
import {parseJsonText} from './json-text.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {importPatentsView} from './patentsview.mjs';
import {installRoot,intakeDir,readConfig} from './config.mjs';

const catalog='https://data.uspto.gov/bulkdata/datasets/pvannual';
const active=new Set(['queued','working','retry_wait']);
const digest=s=>createHash('sha256').update(s).digest('hex');

// Administrative local intake only. Never accept caller-supplied success receipts
// through MCP or n8n: query the authenticated shared corpus for every chunk.
export async function normalizePatentsViewCohort({manifestPath,install=false},{client,dataRoot,intakeRoot=path.join(intakeDir(readConfig()),'patentsview'),onProgress=()=>{},clientModule=process.env.RESEARCH_CORPUS_CLIENT||readConfig().corpusClientModule}={}){
  intakeRoot=await fs.realpath(intakeRoot);
  const resolvedManifest=await fs.realpath(manifestPath);
  const relativeManifest=path.relative(intakeRoot,resolvedManifest);
  if(relativeManifest.startsWith('..')||path.isAbsolute(relativeManifest)||(await fs.stat(resolvedManifest)).size>4*1024*1024)throw Error('PatentsView manifest must be in the public intake folder');
  manifestPath=resolvedManifest;
  if(!client){if(!clientModule)throw Error('PatentsView intake needs the optional corpus integration: set RESEARCH_CORPUS_CLIENT or corpusClientModule (see docs/INTEGRATION.md)');const module=await import(pathToFileURL(path.resolve(installRoot,clientModule)));client=new module.CorpusClient();}
  const manifest=parseJsonText(await fs.readFile(manifestPath,'utf8'));
  if(!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>2000)throw Error('Invalid PatentsView chunk manifest');
  const receipts=[];
  for(const [index,chunk] of manifest.chunks.entries()){
    const file=await fs.realpath(path.resolve(path.dirname(manifestPath),chunk.path||chunk.name||chunk.file||chunk.filename||''));
    const relative=path.relative(path.dirname(manifestPath),file);
    if(relative.startsWith('..')||path.isAbsolute(relative)||!file.endsWith('.jsonl')||(await fs.stat(file)).size>2*1024*1024)throw Error('PatentsView chunk is outside the bounded public cohort');
    const hash=chunk.hash||chunk.sha256;
    if(!/^[a-f0-9]{64}$/.test(hash||'')||digest(await fs.readFile(file))!==hash)throw Error('PatentsView chunk original changed');
    const operation=digest('patentsview-corpus-v1:'+hash);
    const expected={path:file,title:'PatentsView annualized grants '+manifest.year+' chunk '+(index+1),source_url:catalog,source_system:'patentsview',source_id:hash,expected_sha256:hash,mode:'both',tags:['patent-research','patentsview','landscape-data','grant-year-'+manifest.year],idempotency_key:operation};
    const submission=await client.ingest('legal',[expected]);
    const jobId=submission.items?.[0]?.job_id;
    if(!/^[a-f0-9]{32}$/.test(jobId||''))throw Error('Corpus did not accept PatentsView chunk');
    const deadline=Date.now()+180000;
    let job;
    do{
      job=await client.job(jobId);
      if(!active.has(job.status))break;
      if(Date.now()>deadline)throw Error('PatentsView normalization still pending; resume to reuse existing corpus job');
      await new Promise(resolve=>setTimeout(resolve,500));
    }while(true);
    if(job.id!==jobId||job.collection!=='legal'||job.status!=='ready'||job.document_id!==hash||job.input?.expected_sha256!==hash||job.input?.idempotency_key!==operation)throw Error('PatentsView corpus job identity or normalization failed');
    const doc=await client.document('legal',hash);
    if(doc.id!==hash||doc.status!=='ready'||doc.manifest?.document_id!==hash||doc.manifest?.status!=='ready'||doc.manifest?.format!=='.jsonl'||!String(doc.manifest?.extractor).startsWith('Context Forge /')||!doc.manifest?.non_whitespace_preserved)throw Error('PatentsView normalized document is not ready or hash-bound');
    const warnings=doc.manifest.warnings||[];
    if(warnings.length)throw Error('PatentsView CSV extraction warnings require review before import');
    receipts.push({source_sha256:hash,original_sha256:hash,status:'completed',quality_status:'ready',job_id:jobId,document_id:hash,normalizer:'source-corpus/context-forge',warnings,normalized_sha256:doc.manifest.normalized_sha256,extractor_code_sha256:doc.manifest.extractor_code_sha256});
    onProgress({completed:index+1,total:manifest.chunks.length,job_id:jobId});
  }
  const receiptText=JSON.stringify(receipts,null,2)+'\n';
  const receiptPath=path.join(path.dirname(manifestPath),'corpus-receipts-'+digest(receiptText).slice(0,16)+'.json');
  try{await fs.writeFile(receiptPath,receiptText,{flag:'wx'});}catch(error){
    if(error.code!=='EEXIST')throw error;
    const info=await fs.lstat(receiptPath);
    if(!info.isFile()||info.isSymbolicLink()||await fs.readFile(receiptPath,'utf8')!==receiptText)throw Error('Existing PatentsView receipt file conflicts');
  }
  const result=install?await importPatentsView({manifestPath,normalizationReceipts:receipts},{dataRoot}):{status:'NORMALIZED_NOT_INSTALLED'};
  return {...result,corpus_receipts:receiptPath,normalized_chunks:receipts.length};
}
