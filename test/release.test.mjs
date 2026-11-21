import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {releaseStatus} from '../src/release.mjs';
import {Store} from '../src/store.mjs';

test('release status verifies package, portable workflows, evidence artifacts, backup receipt, and local caches',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'patent-release-'));
  try{
    fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'n8n'));fs.mkdirSync(path.join(root,'data','backups'),{recursive:true});
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.0.0'}));
    fs.writeFileSync(path.join(root,'n8n','core.json'),'{}');
    fs.writeFileSync(path.join(root,'data','evidence.json'),'{}');
    fs.writeFileSync(path.join(root,'config','release.json'),JSON.stringify({version:'1.0.0',status:'complete',portableWorkflowFiles:['n8n/core.json'],verificationArtifactFiles:['data/evidence.json']}));
    const backupStore=new Store(path.join(root,'data'));const backup=backupStore.backup();backupStore.close();
    const hub={store:{stats:()=>({records:1}),db:{prepare:()=>({get:()=>({count:2})})},queryCacheStatus:kind=>({kind,entries:1})}};
    const status=releaseStatus({hub,rootPath:root});assert.equal(status.status,'complete');assert.deepEqual(status.checks,{packageVersionMatches:true,portableWorkflowFilesPresent:true,verificationArtifactFilesPresent:true,releaseManifestComplete:true,verifiedBackupPresent:true,noPendingDeploymentCandidate:true});assert.equal(status.currentLocalState.referencePins,2);
    assert.equal(status.latestBackupVerification.valid,true);fs.appendFileSync(path.join(root,'data','backups',backup.database),'tampered');assert.equal(releaseStatus({hub,rootPath:root}).checks.verifiedBackupPresent,false);
    fs.rmSync(path.join(root,'n8n','core.json'));assert.equal(releaseStatus({hub,rootPath:root}).status,'local-verification-needed');
    fs.writeFileSync(path.join(root,'n8n','core.json'),'{}');fs.rmSync(path.join(root,'data','evidence.json'));assert.deepEqual(releaseStatus({hub,rootPath:root}).missingVerificationArtifactFiles,['data/evidence.json']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
