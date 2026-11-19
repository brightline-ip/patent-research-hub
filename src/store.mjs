import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './parsers.mjs';
import {stageVerifiedRestore} from './backups.mjs';
import {assertNotReservedName} from './names.mjs';
import {assertNoSensitiveText} from './security.mjs';
export class Store{
  constructor(root){mkdirSync(root,{recursive:true});this.root=root;this.file=path.join(root,'research.sqlite');this.db=new DatabaseSync(this.file,{timeout:5000});this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,source TEXT NOT NULL,title TEXT NOT NULL,excerpt TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_source ON records(source);
    CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,source TEXT NOT NULL,created TEXT NOT NULL,request TEXT NOT NULL,response TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,source TEXT NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS acquisitions(record_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,job_id TEXT NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(record_id,snapshot_id,job_id));
    CREATE TABLE IF NOT EXISTS bigquery_usage(id TEXT PRIMARY KEY,month TEXT NOT NULL,created TEXT NOT NULL,status TEXT NOT NULL,reserved_bytes INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bigquery_usage_month ON bigquery_usage(month,status);
    CREATE TABLE IF NOT EXISTS query_cache(kind TEXT NOT NULL,cache_key TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,cache_key));
    CREATE INDEX IF NOT EXISTS query_cache_kind_updated ON query_cache(kind,updated);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,updated TEXT NOT NULL,sealed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created TEXT NOT NULL,sealed TEXT NOT NULL);`);}
  ingest(source,query,raw,records,coverage){
    const now=new Date().toISOString(),snapshotId=hash(JSON.stringify({source,query,raw})),runId=randomUUID();this.db.exec('BEGIN');
    try{this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)').run(snapshotId,source,now,JSON.stringify(query),raw);
      const insert=this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,excerpt=excluded.excerpt,body=excluded.body,updated=excluded.updated');
      for(const r of records)insert.run(r.id,r.source,r.title,r.excerpt,JSON.stringify({...r,snapshotId}),now);
      const run={id:runId,source,created:now,snapshotId,returned:records.length,coverage,recordIds:records.map(r=>r.id),query};
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(runId,source,now,JSON.stringify(run));this.db.exec('COMMIT');return run;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  search(q='',source='',limit=30){const words=q.toLowerCase().match(/[\p{L}\p{N}-]+/gu)||[];const terms=words.slice(0,12);const filter=terms.map(()=>"lower(title || ' ' || excerpt) LIKE ? ESCAPE '\\'").join(' AND ');const params=terms.map(w=>'%'+w.replace(/[\\%_]/g,'\\$&')+'%');if(source)params.push(source);params.push(Math.max(1,Math.min(100,limit)));const rows=this.db.prepare('SELECT body FROM records WHERE '+(filter||'1=1')+(source?' AND source=?':'')+' ORDER BY updated DESC LIMIT ?').all(...params);return rows.map(r=>JSON.parse(r.body));}
  get(id){const row=this.db.prepare('SELECT body FROM records WHERE id=?').get(id);if(!row)throw new Error('Record not found');const record=JSON.parse(row.body);return {...record,acquisition:this.lastAcquisition(id,record.snapshotId)};}
  lastAcquisition(id,snapshotId){const row=this.db.prepare('SELECT body FROM acquisitions WHERE record_id=? AND snapshot_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id,snapshotId);return row?JSON.parse(row.body):null;}
  saveAcquisition(record,job,extra={}){if(!job?.job_id)throw new Error('Corpus did not return a job identifier');const body={...extra,jobId:job.job_id,recordId:record.id,sourceSnapshotId:record.snapshotId,sourceUrl:record.url,createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO acquisitions VALUES(?,?,?,?,?)').run(record.id,record.snapshotId,job.job_id,body.createdAt,JSON.stringify(body));this.updateAcquisition(job);return this.lastAcquisition(record.id,record.snapshotId);}
  updateAcquisition(job){for(const row of this.db.prepare('SELECT rowid,body FROM acquisitions WHERE job_id=?').all(job.job_id)){const old=JSON.parse(row.body);if(old.expectedSha256&&job.document_id&&job.document_id!==old.expectedSha256)throw new Error('Corpus document hash differs from the retrieved original');if(old.expectedSha256&&job.original?.sha256&&job.original.sha256!==old.expectedSha256)throw new Error('Corpus original hash differs from the retrieved PDF');const body={...old,status:job.status,checkedAt:new Date().toISOString(),documentId:job.document_id||old.documentId||null,original:job.original||old.original||null,extractionWarnings:job.extraction_warnings||old.extractionWarnings||[],error:job.error_message||job.context_error||null,textRead:old.textRead===true};this.db.prepare('UPDATE acquisitions SET body=? WHERE rowid=?').run(JSON.stringify(body),row.rowid);}}
  markDocumentRead(documentId,{offset,nextOffset,locators=[]}){if(!/^[a-f0-9]{64}$/.test(documentId)||!Number.isInteger(offset)||offset<0)throw new Error('Invalid document read marker');const now=new Date().toISOString();for(const row of this.db.prepare('SELECT rowid,body FROM acquisitions').all()){const old=JSON.parse(row.body);if(old.documentId!==documentId)continue;const readOffsets=[...new Set([...(Array.isArray(old.readOffsets)?old.readOffsets:[]),offset])].filter(Number.isInteger).sort((a,b)=>a-b);const body={...old,textRead:true,textReadAt:now,readOffsets,lastRead:{offset,nextOffset:Number.isInteger(nextOffset)?nextOffset:null,locators:locators.filter(x=>typeof x==='string').slice(0,20)}};this.db.prepare('UPDATE acquisitions SET body=? WHERE rowid=?').run(JSON.stringify(body),row.rowid);}}
  reserveBigQuery({id,month,estimatedBytes,monthlyLimit,parameters}){const estimate=Number(estimatedBytes),limit=Number(monthlyLimit);if(!/^[0-9a-f-]{36}$/.test(id)||!/^\d{4}-\d{2}$/.test(month)||!Number.isSafeInteger(estimate)||estimate<=0||!Number.isSafeInteger(limit)||limit<=0)throw new Error('Invalid BigQuery usage reservation');this.db.exec('BEGIN IMMEDIATE');try{const used=this.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM bigquery_usage WHERE month=? AND status IN ('reserved','complete','unknown')").get(month).bytes;if(used+estimate>limit)throw new Error('BigQuery tracked monthly byte limit would be exceeded');const created=new Date().toISOString(),body={id,month,created,status:'reserved',estimatedBytes:String(estimate),parameters};this.db.prepare('INSERT INTO bigquery_usage VALUES(?,?,?,?,?,?)').run(id,month,created,'reserved',estimate,JSON.stringify(body));this.db.exec('COMMIT');return {month,monthlyLimitBytes:String(limit),trackedBytesBefore:String(used),reservedBytes:String(estimate),trackedBytesAfterReservation:String(used+estimate)};}catch(error){this.db.exec('ROLLBACK');throw error;}}
  completeBigQuery(id,{status,usageBytes,jobReference=null,cacheHit=false,error=null}){if(!['complete','unknown'].includes(status)||!Number.isSafeInteger(Number(usageBytes))||Number(usageBytes)<0)throw new Error('Invalid BigQuery usage completion');const row=this.db.prepare('SELECT rowid,month,body FROM bigquery_usage WHERE id=?').get(id);if(!row)throw new Error('BigQuery usage reservation not found');const old=JSON.parse(row.body),bytes=Number(usageBytes),body={...old,status,completedAt:new Date().toISOString(),usageBytes:String(bytes),jobReference,cacheHit,error:error||null};this.db.prepare('UPDATE bigquery_usage SET status=?,reserved_bytes=?,body=? WHERE rowid=?').run(status,bytes,JSON.stringify(body),row.rowid);const tracked=this.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM bigquery_usage WHERE month=? AND status IN ('reserved','complete','unknown')").get(row.month).bytes;return {reservationId:id,status,trackedMonth:row.month,trackedBytesAfter:String(tracked),usageBytes:String(bytes)};}
  bigQueryUsage(month=new Date().toISOString().slice(0,7)){if(!/^\d{4}-\d{2}$/.test(month))throw new Error('Invalid BigQuery usage month');const rows=this.db.prepare('SELECT body FROM bigquery_usage WHERE month=? ORDER BY created').all(month).map(x=>JSON.parse(x.body));const tracked=this.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM bigquery_usage WHERE month=? AND status IN ('reserved','complete','unknown')").get(month).bytes;const cutoff=Date.now()-60*60*1000,needsReconciliation=rows.filter(x=>x.status==='reserved'&&Date.parse(x.created)<cutoff).map(x=>({id:x.id,created:x.created,estimatedBytes:x.estimatedBytes,parameters:x.parameters}));return {month,trackedBytes:String(tracked),queries:rows,needsReconciliation,warning:needsReconciliation.length?'Interrupted reservations remain conservatively charged until an operator verifies actual provider usage and reconciles them.':null};}
  reconcileBigQuery(id,{actualBytes,evidence,forceZero=false}){if(actualBytes===undefined||actualBytes===null||actualBytes==='')throw new Error('Reconciliation requires actualBytes (exact processed/billed bytes from the provider job history)');const bytes=Number(actualBytes);if(!/^[0-9a-f-]{36}$/.test(id)||!Number.isSafeInteger(bytes)||bytes<0||typeof evidence!=='string'||evidence.trim().length<20||evidence.length>1000)throw new Error('Reconciliation requires a reservation ID, exact actual bytes, and concise verification evidence');assertNoSensitiveText(evidence);const row=this.db.prepare('SELECT rowid,month,status,reserved_bytes,body FROM bigquery_usage WHERE id=?').get(id);if(!row)throw new Error('BigQuery reservation not found');if(!['reserved','unknown'].includes(row.status))throw new Error('Only interrupted or unknown BigQuery reservations can be reconciled');const estimate=Number(row.reserved_bytes);if(bytes<estimate&&forceZero!==true)throw new Error('Reconciled bytes are below the dry-run estimate ('+estimate+'). The monthly ledger is a local safeguard: pass --force-zero only after the provider job history shows the query never ran or billed less');const old=JSON.parse(row.body),body={...old,status:'complete',completedAt:new Date().toISOString(),usageBytes:String(bytes),reconciliation:{evidence:evidence.trim(),reconciledAt:new Date().toISOString()}};this.db.prepare('UPDATE bigquery_usage SET status=?,reserved_bytes=?,body=? WHERE rowid=?').run('complete',bytes,JSON.stringify(body),row.rowid);return {reservationId:id,status:'complete',trackedMonth:row.month,usageBytes:String(bytes),reconciled:true};}
  saveQueryCache(kind,key,value){
    if(!/^[a-z][a-z0-9-]{2,63}$/.test(kind)||!/^[a-f0-9]{64}$/.test(key)||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid persistent query-cache entry');
    const serialized=JSON.stringify(value),payloadSha256=hash(serialized),now=new Date().toISOString();
    const old=this.db.prepare('SELECT created FROM query_cache WHERE kind=? AND cache_key=?').get(kind,key);
    const body=JSON.stringify({kind,key,createdAt:old?.created||now,updatedAt:now,payloadSha256,value});
    this.db.prepare(`INSERT INTO query_cache VALUES(?,?,?,?,?) ON CONFLICT(kind,cache_key) DO UPDATE SET updated=excluded.updated,body=excluded.body`).run(kind,key,old?.created||now,now,body);
    return {kind,key,createdAt:old?.created||now,updatedAt:now,payloadSha256};
  }
  getQueryCache(kind,key){
    if(!/^[a-z][a-z0-9-]{2,63}$/.test(kind)||!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid persistent query-cache lookup');
    const row=this.db.prepare('SELECT body FROM query_cache WHERE kind=? AND cache_key=?').get(kind,key);if(!row)return null;
    const entry=JSON.parse(row.body),serialized=JSON.stringify(entry.value);
    if(entry.kind!==kind||entry.key!==key||entry.payloadSha256!==hash(serialized))throw new Error('Persistent query-cache integrity check failed');
    return entry;
  }
  queryCacheStatus(kind){
    if(!/^[a-z][a-z0-9-]{2,63}$/.test(kind))throw new Error('Invalid persistent query-cache kind');
    const summary=this.db.prepare('SELECT count(*) AS entries,min(created) AS firstCreatedAt,max(updated) AS lastUpdatedAt FROM query_cache WHERE kind=?').get(kind);
    return {kind,entries:summary.entries,firstCreatedAt:summary.firstCreatedAt||null,lastUpdatedAt:summary.lastUpdatedAt||null,integrity:'SHA-256 checked whenever an entry is read'};
  }
  backup(){
    const sourceIntegrity=this.db.prepare('PRAGMA integrity_check').get()?.integrity_check;if(sourceIntegrity!=='ok')throw new Error('Research state integrity check failed; backup was not created');
    const directory=path.join(this.root,'backups');mkdirSync(directory,{recursive:true});
    const stamp=new Date().toISOString().replace(/[-:]/g,'').replace('.','-').replace('Z','Z'),id=`research-${stamp}-${randomUUID()}`;
    const database=path.join(directory,id+'.sqlite'),escaped=database.replaceAll("'","''");this.db.exec(`VACUUM INTO '${escaped}'`);
    const verified=new DatabaseSync(database);let backupIntegrity;try{backupIntegrity=verified.prepare('PRAGMA integrity_check').get()?.integrity_check;}finally{verified.close();}
    if(backupIntegrity!=='ok')throw new Error('Research state backup verification failed');
    const createdAt=new Date().toISOString(),bytes=statSync(database).size,sha256=hash(readFileSync(database));
    const counts={records:this.db.prepare('SELECT count(*) AS n FROM records').get().n,snapshots:this.db.prepare('SELECT count(*) AS n FROM snapshots').get().n,queryCache:this.db.prepare('SELECT count(*) AS n FROM query_cache').get().n,reports:this.db.prepare('SELECT count(*) AS n FROM reports').get().n};
    const manifest=path.join(directory,id+'.manifest.json'),body={format:'patent-research-state-backup',version:1,createdAt,database:path.basename(database),bytes,sha256,sqliteIntegrity:'ok',counts,contents:'Public research metadata, source snapshots, handoffs, usage ledger and validated aggregate caches. n8n credentials and provider datasets are not included.'};writeFileSync(manifest,JSON.stringify(body,null,2));
    return {...body,manifest};
  }
  stageRestore(manifestName){if(typeof manifestName!=='string'||!/^[A-Za-z0-9._-]+\.manifest\.json$/.test(manifestName))throw new Error('Use a backup manifest filename from data/backups');assertNotReservedName(manifestName,'backup manifest name');return stageVerifiedRestore(path.join(this.root,'backups',manifestName),{backupRoot:path.join(this.root,'backups'),recoveryRoot:path.join(this.root,'recovery')});}
  stats(){return this.db.prepare('SELECT source,count(*) AS records FROM records GROUP BY source').all();}
  lastRuns(){return this.db.prepare('SELECT body FROM runs ORDER BY created DESC LIMIT 25').all().map(r=>JSON.parse(r.body));}
  lastSourceRun(source,transport){const row=this.db.prepare("SELECT body FROM runs WHERE source=? AND json_extract(body,'$.coverage.transport')=? ORDER BY created DESC LIMIT 1").get(source,transport);return row?JSON.parse(row.body):null;}
  close(){this.db.close();}
}
