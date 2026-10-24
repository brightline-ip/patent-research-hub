import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'parse5';
import {sourceRequest} from './net.mjs';
import {callGateway} from './gateway.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
const active=new Set(['queued','working','retry_wait','unavailable']);
export function blankPageReview(doc,reviews){const review=reviews[doc.id],empty=doc.manifest?.empty_pages,warnings=doc.manifest?.warnings;if(!review||!Array.isArray(empty)||!empty.length||!Array.isArray(warnings)||warnings.length!==empty.length)return null;if(empty.some(p=>!review.blankPages.includes(typeof p==='number'?p:/^page:\d+$/.test(p)?Number(p.slice(5)):NaN))||warnings.some(w=>!/^Page \d+ has no native text; blank or image content needs review\/OCR$/.test(w)))return null;return review;}
export function validateReferenceUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.uspto.gov','www.uscourts.gov','uscode.house.gov','www.govinfo.gov','www.ecfr.gov'].includes(u.hostname))throw new Error('Reference URL must be an approved official HTTPS source');return u.href;}
export function monitorContent(html,url){
 const root=parse(html),links=new Set();let text='';
 function walk(n){if(['script','style','nav','header','footer','noscript'].includes(n.tagName))return;if(n.nodeName==='#text')text+=' '+n.value;const href=n.attrs?.find(a=>a.name==='href')?.value;if(href){try{const u=new URL(href,url);if(u.protocol==='https:'&&(/\.pdf$/i.test(u.pathname)||/mpep|guidance|rules|notices|exam/.test(u.pathname)))links.add(u.href);}catch{}}for(const c of n.childNodes||[])walk(c);}
 function find(n){if(n.tagName==='main'||n.attrs?.some(a=>a.name==='role'&&a.value==='main'))return n;for(const c of n.childNodes||[]){const x=find(c);if(x)return x;}}
 walk(find(root)||root);text=text.replace(/\s+/g,' ').trim();if(text.length<100)throw new Error('Official index returned insufficient content');return {text,links:[...links].sort()};
}
export class ReferenceLibrary{
 constructor(hub,{catalogPath=path.resolve(import.meta.dirname,'../config/references.json')}={}){
  this.hub=hub;this.db=hub.store.db;this.catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
  const reviewsPath=path.join(path.dirname(catalogPath),'reference-reviews.json');this.reviews=fs.existsSync(reviewsPath)?JSON.parse(fs.readFileSync(reviewsPath,'utf8')):{};
  for(const r of [...this.catalog.references,...this.catalog.monitors]){if(!/^[a-z0-9-]+$/.test(r.id))throw new Error('Invalid reference ID');validateReferenceUrl(r.url);}
  if(new Set(this.catalog.references.map(x=>x.id)).size!==this.catalog.references.length)throw new Error('Duplicate reference IDs');
  this.db.exec(`CREATE TABLE IF NOT EXISTS reference_jobs(ref_id TEXT NOT NULL,cycle TEXT NOT NULL,job_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(ref_id,cycle));
   CREATE TABLE IF NOT EXISTS reference_versions(ref_id TEXT NOT NULL,document_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(ref_id,document_id));
   CREATE TABLE IF NOT EXISTS reference_pins(ref_id TEXT PRIMARY KEY,document_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS reference_pin_history(ref_id TEXT NOT NULL,document_id TEXT NOT NULL,selected_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS reference_chunks(id INTEGER PRIMARY KEY,document_id TEXT NOT NULL,sequence INTEGER NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,UNIQUE(document_id,sequence));
   CREATE VIRTUAL TABLE IF NOT EXISTS reference_fts USING fts5(text);
   CREATE TABLE IF NOT EXISTS reference_monitors(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS reference_monitor_history(id TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,hash));`);
 }
 list(){return {policy:this.catalog.policy,references:this.catalog.references.map(r=>({...r,pin:this.db.prepare('SELECT v.body FROM reference_pins p JOIN reference_versions v USING(ref_id,document_id) WHERE p.ref_id=?').get(r.id)?.body?JSON.parse(this.db.prepare('SELECT v.body FROM reference_pins p JOIN reference_versions v USING(ref_id,document_id) WHERE p.ref_id=?').get(r.id).body):null,jobs:this.db.prepare('SELECT body FROM reference_jobs WHERE ref_id=? ORDER BY cycle DESC LIMIT 2').all(r.id).map(x=>JSON.parse(x.body))})),monitors:this.catalog.monitors.map(m=>({...m,lastCheck:JSON.parse(this.db.prepare('SELECT body FROM reference_monitors WHERE id=?').get(m.id)?.body||'null')}))};}
 async queue({family='',cycle='initial'}={}){
  if(!/^[a-z0-9-]{1,40}$/.test(cycle))throw new Error('Invalid acquisition cycle');
  const refs=this.catalog.references.filter(r=>!family||r.family===family);if(!refs.length)throw new Error('Unknown reference family');
  const needed=refs.filter(r=>!this.db.prepare('SELECT 1 FROM reference_jobs WHERE ref_id=? AND cycle=?').get(r.id,cycle));
  if(needed.length){const client=await this.hub.corpus();const result=await client.request('/v1/get-files',{collection:'legal',mode:'both',items:needed.map(r=>({url:r.url,title:r.title,tags:['patent-research','authority-library',r.family],idempotency_key:'authority-v1:'+r.id+':'+cycle}))});
   for(const item of result.items||[]){const r=needed[item.index];if(!r||!item.job_id)continue;this.db.prepare('INSERT OR IGNORE INTO reference_jobs VALUES(?,?,?,?)').run(r.id,cycle,item.job_id,JSON.stringify({refId:r.id,cycle,job_id:item.job_id,status:item.status}));}
  }
  return {cycle,submitted:needed.length,jobs:this.db.prepare('SELECT body FROM reference_jobs WHERE cycle=?').all(cycle).map(x=>JSON.parse(x.body)),warning:'Queued jobs are not indexed documents. Poll references-poll to complete indexing.'};
 }
 async poll(){
  const client=await this.hub.corpus(),rows=this.db.prepare('SELECT * FROM reference_jobs').all();let indexed=0;
  for(const row of rows){const old=JSON.parse(row.body);if(old.indexed||(!active.has(old.status)&&!['ready','needs_ocr'].includes(old.status)))continue;
   const result=await client.getJobs([row.job_id],{wait_seconds:0}),job=result.jobs[0];let body={...old,...job,checkedAt:new Date().toISOString()};
   if(['ready','needs_ocr'].includes(job.status)&&job.document_id&&!job.context_error){
    const doc=await client.document('legal',job.document_id);if(doc.id!==job.document_id||job.original?.sha256!==doc.id)throw new Error('Reference original hash mismatch');
    const review=blankPageReview(doc,this.reviews);if(job.status==='needs_ocr'&&!review){this.db.prepare('UPDATE reference_jobs SET body=? WHERE ref_id=? AND cycle=?').run(JSON.stringify(body),row.ref_id,row.cycle);continue;}
    const chunks=[];let offset=0;
    while(true){const page=await client.request('/v1/documents/'+doc.id+'/chunks?'+new URLSearchParams({collection:'legal',offset:String(offset),limit:'100'}));if(!page.chunks?.length)break;chunks.push(...page.chunks);offset+=page.chunks.length;if(offset>20000)throw new Error('Reference chunk count exceeds bound');}
    if(chunks.length!==doc.manifest?.chunks||!chunks.length)throw new Error('Incomplete corpus chunk coverage');
    for(let i=0;i<chunks.length;i++)if(chunks[i].sequence!==i||sha(chunks[i].text)!==chunks[i].sha256)throw new Error('Reference chunk integrity mismatch');
    const ref=this.catalog.references.find(x=>x.id===row.ref_id);const version={...ref,documentId:doc.id,originalSha256:doc.id,normalizedSha256:doc.manifest.normalized_sha256,originalPath:job.original.path,acquiredAt:body.checkedAt,corpusCreatedAt:doc.created_at,pages:doc.manifest.metadata?.pages,chunks:chunks.length,warnings:doc.manifest.warnings||[],extractionStatus:doc.status,blankPageReview:review,fullTextRead:false,legalCurrency:'Verify effective dates and subsequent amendments; pin is source identity only'};
    this.db.exec('BEGIN');try{
     this.db.prepare('INSERT OR IGNORE INTO reference_versions VALUES(?,?,?)').run(ref.id,doc.id,JSON.stringify(version));
     for(const c of chunks){const inserted=this.db.prepare('INSERT OR IGNORE INTO reference_chunks(document_id,sequence,locator,text,hash) VALUES(?,?,?,?,?)').run(doc.id,c.sequence,c.locator,c.text,c.sha256);if(inserted.changes)this.db.prepare('INSERT INTO reference_fts(rowid,text) VALUES(?,?)').run(inserted.lastInsertRowid,c.text);}
     this.db.prepare('INSERT OR IGNORE INTO reference_pins VALUES(?,?)').run(ref.id,doc.id);
     body={...body,indexed:true,documentId:doc.id,candidate:doc.id!==this.db.prepare('SELECT document_id FROM reference_pins WHERE ref_id=?').get(ref.id).document_id};
     this.db.prepare('UPDATE reference_jobs SET body=? WHERE ref_id=? AND cycle=?').run(JSON.stringify(body),row.ref_id,row.cycle);this.db.exec('COMMIT');indexed++;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
   }else this.db.prepare('UPDATE reference_jobs SET body=? WHERE ref_id=? AND cycle=?').run(JSON.stringify(body),row.ref_id,row.cycle);
  }
  const jobs=this.db.prepare('SELECT body FROM reference_jobs').all().map(r=>JSON.parse(r.body));return {newlyIndexed:indexed,pinned:this.db.prepare('SELECT count(*) AS n FROM reference_pins').get().n,pending:jobs.filter(j=>active.has(j.status)).length,failures:jobs.filter(j=>!j.indexed&&!active.has(j.status)),candidates:jobs.filter(j=>j.indexed&&j.documentId!==this.db.prepare('SELECT document_id FROM reference_pins WHERE ref_id=?').get(j.refId)?.document_id),jobs:jobs.map(({refId,status,indexed,job_id,documentId})=>({refId,status,indexed,job_id,documentId}))};
 }
 pin(refId,documentId){
  const row=this.db.prepare('SELECT body FROM reference_versions WHERE ref_id=? AND document_id=?').get(refId,documentId);if(!row)throw new Error('Choose a completely indexed reference version');
  const previous=this.db.prepare('SELECT document_id FROM reference_pins WHERE ref_id=?').get(refId)?.document_id;
  this.db.exec('BEGIN');try{this.db.prepare('INSERT INTO reference_pin_history VALUES(?,?,?)').run(refId,documentId,new Date().toISOString());this.db.prepare('INSERT INTO reference_pins VALUES(?,?) ON CONFLICT(ref_id) DO UPDATE SET document_id=excluded.document_id').run(refId,documentId);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  return {previous,pin:JSON.parse(row.body),warning:'Explicit version selection recorded; legal currency and applicability require review.'};
 }
 search(query,{family='',limit=8}={}){
  if(typeof query!=='string'||query.length>1000||!Number.isInteger(limit)||limit<1||limit>30)throw new Error('Invalid reference search');
  const words=query.match(/[\p{L}\p{N}]+/gu)?.slice(0,20)||[];if(!words.length)throw new Error('Supply citation words or a search phrase');
  const expression=words.map(x=>'"'+x+'"').join(' AND ');
  const rows=this.db.prepare(`SELECT c.*,v.ref_id,v.body,bm25(reference_fts) AS score FROM reference_fts JOIN reference_chunks c ON c.id=reference_fts.rowid JOIN reference_pins p ON p.document_id=c.document_id JOIN reference_versions v ON v.ref_id=p.ref_id AND v.document_id=p.document_id WHERE reference_fts MATCH ? AND (?='' OR json_extract(v.body,'$.family')=?) ORDER BY score,v.ref_id,c.sequence LIMIT ?`).all(expression,family,family,limit);
  return {query,matching:'All literal tokens, pinned versions only',results:rows.map(({body,...r})=>({...r,source:JSON.parse(body)})),pinCount:this.db.prepare('SELECT count(*) AS n FROM reference_pins').get().n,warning:'Search hits may be cross-references or superseded text within a manual. Verify the operative provision, date and subsequent guidance.'};
 }
 async check(){
  const results=[];
  for(const monitor of this.catalog.monitors){const previous=this.db.prepare('SELECT * FROM reference_monitors WHERE id=?').get(monitor.id);try{
    const response=this.hub.config.transport==='n8n'&&this.hub.config.referenceGatewayEnabled?await callGateway('reference-index',{source:monitor.id},{config:this.hub.config,fetchImpl:this.hub.fetch}):await sourceRequest(monitor.url,{fetchImpl:this.hub.fetch});if(response.status!==200||!/html/.test(response.contentType))throw new Error('Expected official HTML index');
    const content=monitorContent(response.text,monitor.url),hash=sha(JSON.stringify(content)),checkedAt=new Date().toISOString();const body={...monitor,checkedAt,hash,changed:!!previous&&previous.hash!==hash,baseline:!previous,links:content.links,text:content.text};
    this.db.prepare('INSERT OR IGNORE INTO reference_monitor_history VALUES(?,?,?)').run(monitor.id,hash,JSON.stringify(body));this.db.prepare('INSERT INTO reference_monitors VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,body=excluded.body').run(monitor.id,hash,JSON.stringify(body));results.push({...body,text:undefined,links:undefined});
   }catch(error){results.push({id:monitor.id,url:monitor.url,error:error.message,lastSuccessfulCheck:previous?JSON.parse(previous.body).checkedAt:null});}
  }
  return {checkedAt:new Date().toISOString(),results,changed:results.filter(x=>x.changed),errors:results.filter(x=>x.error),pinPolicy:'Monitoring never overwrites a pinned reference. Page changes are review leads, not proof of a legal amendment.'};
 }
}
