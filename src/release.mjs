import fs from 'node:fs';
import path from 'node:path';
import {verifyBackupManifest} from './backups.mjs';

const root=path.resolve(import.meta.dirname,'..');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));

export function releaseStatus({hub,rootPath=root}={}){
  const manifest=readJson(path.join(rootPath,'config','release.json'));
  const candidatePath=path.join(rootPath,'config','review-candidate.json');
  const reviewCandidate=fs.existsSync(candidatePath)?readJson(candidatePath):null;
  const pkg=readJson(path.join(rootPath,'package.json'));
  const missingWorkflowFiles=manifest.portableWorkflowFiles.filter(file=>!fs.existsSync(path.join(rootPath,file)));
  const verificationArtifactFiles=manifest.verificationArtifactFiles||[];
  const missingVerificationArtifactFiles=verificationArtifactFiles.filter(file=>!fs.existsSync(path.join(rootPath,file)));
  const backupRoot=hub?.dataRoot?path.join(hub.dataRoot,'backups'):path.join(rootPath,'data','backups');
  const backupManifests=fs.existsSync(backupRoot)?fs.readdirSync(backupRoot).filter(name=>name.endsWith('.manifest.json')).sort().reverse():[];
  const latestBackupManifest=backupManifests.length?path.join(backupRoot,backupManifests[0]):null;
  const latestBackup=latestBackupManifest?readJson(latestBackupManifest):null;
  const latestBackupVerification=latestBackupManifest?verifyBackupManifest(latestBackupManifest,{backupRoot}):{valid:false,error:'No backup manifest found'};
  const checks={packageVersionMatches:pkg.version===manifest.version,portableWorkflowFilesPresent:missingWorkflowFiles.length===0,verificationArtifactFilesPresent:missingVerificationArtifactFiles.length===0,releaseManifestComplete:['complete','public-preview'].includes(manifest.status),verifiedBackupPresent:latestBackupVerification.valid===true,noPendingDeploymentCandidate:!reviewCandidate||reviewCandidate.status==='deployed'};
  const currentLocalState=hub?{records:hub.store.stats(),referencePins:(()=>{try{return hub.store.db.prepare('SELECT count(*) AS count FROM reference_pins').get().count;}catch{return 0;}})()  /* table is created with the reference library; absent on a fresh data directory */,cpcAggregateCache:hub.store.queryCacheStatus('cpc-trend'),examinerAggregateCache:hub.store.queryCacheStatus('examiner-trend')}:null;
  return {status:Object.values(checks).every(Boolean)?'complete':'local-verification-needed',manifest,reviewCandidate,checks,missingWorkflowFiles,missingVerificationArtifactFiles,latestBackup,latestBackupVerification,currentLocalState,note:'The newest backup file, size, SHA-256 and SQLite integrity are rechecked. A pending review candidate is never represented as deployed. n8n workflow publication and provider checks remain dated evidence; run the relevant source/status tool when current provider health matters.'};
}
