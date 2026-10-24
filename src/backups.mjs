import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const hashFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contained=(candidate,root)=>{const relative=path.relative(path.resolve(root),path.resolve(candidate));return relative!==''&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};

export function verifyBackupManifest(manifestPath,{backupRoot=path.dirname(manifestPath)}={}){
  const root=path.resolve(backupRoot),manifestFile=path.resolve(manifestPath);
  try{
    if(!contained(manifestFile,root)||!manifestFile.endsWith('.manifest.json'))throw new Error('Backup manifest is outside the backup directory');
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if(manifest.format!=='patent-research-state-backup'||manifest.version!==1||manifest.sqliteIntegrity!=='ok'||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0||!/^[a-f0-9]{64}$/.test(manifest.sha256||''))throw new Error('Backup manifest schema is invalid');
    if(typeof manifest.database!=='string'||/[\u0000-\u001f\u007f]/.test(manifest.database)||!path.basename(manifest.database).endsWith('.sqlite'))throw new Error('Backup database identity is invalid');
    const database=path.join(root,path.basename(manifest.database));
    if(!contained(database,root)||path.extname(database)!=='.sqlite'||!fs.existsSync(database))throw new Error('Backup database is missing or outside the backup directory');
    const stat=fs.statSync(database);if(!stat.isFile()||stat.size!==manifest.bytes)throw new Error('Backup byte count does not match its manifest');
    if(hashFile(database)!==manifest.sha256)throw new Error('Backup SHA-256 does not match its manifest');
    const db=new DatabaseSync(database,{readOnly:true});let integrity;try{integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;}finally{db.close();}
    if(integrity!=='ok')throw new Error('Backup SQLite integrity check failed');
    return {valid:true,manifestFile,database,bytes:stat.size,sha256:manifest.sha256,sqliteIntegrity:'ok',manifest};
  }catch(error){return {valid:false,manifestFile,error:error.message};}
}

export function stageVerifiedRestore(manifestPath,{backupRoot,recoveryRoot}={}){
  const verification=verifyBackupManifest(manifestPath,{backupRoot});
  if(!verification.valid)throw new Error('Backup cannot be staged: '+verification.error);
  const root=path.resolve(recoveryRoot);fs.mkdirSync(root,{recursive:true});
  const target=path.join(root,`research-restore-${new Date().toISOString().replace(/[-:]/g,'').replace('.','-')}-${randomUUID()}.sqlite`);
  fs.copyFileSync(verification.database,target,fs.constants.COPYFILE_EXCL);
  const stagedHash=hashFile(target);let integrity;
  const db=new DatabaseSync(target,{readOnly:true});try{integrity=db.prepare('PRAGMA integrity_check').get()?.integrity_check;}finally{db.close();}
  if(stagedHash!==verification.sha256||integrity!=='ok'){fs.rmSync(target,{force:true});throw new Error('Staged restore verification failed');}
  const receipt={format:'patent-research-staged-restore',version:1,createdAt:new Date().toISOString(),sourceManifest:path.basename(verification.manifestFile),sourceSha256:verification.sha256,database:target,bytes:verification.bytes,sqliteIntegrity:'ok',activated:false,note:'Verified recovery copy only. Stop the service and follow the recovery runbook before replacing active state.'};
  const receiptPath=target+'.receipt.json';fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2),{flag:'wx'});
  return {...receipt,receipt:receiptPath};
}
