import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {normalizePatentsViewCohort} from '../src/patentsview-intake.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('intake rejects changed chunks before corpus submission',async()=>{
  const intakeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'pv-intake-'));
  const dir=path.join(intakeRoot,'test-intake');
  try{
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir,'chunk.jsonl'),'{}\n');
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({year:2025,chunks:[{name:'chunk.jsonl',sha256:'0'.repeat(64)}]}));
    let called=false;
    await assert.rejects(normalizePatentsViewCohort({manifestPath:path.join(dir,'manifest.json')},{client:{ingest(){called=true;}},intakeRoot}),/changed/);
    assert.equal(called,false);
  }finally{await fs.rm(intakeRoot,{recursive:true});}
});
test('intake refuses incomplete corpus normalization and does not import',async()=>{
  const intakeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'pv-intake-'));
  const dir=path.join(intakeRoot,'test-intake');
  try{
    await fs.mkdir(dir);
    const text='{}\n',hash=sha(text),jobId='a'.repeat(32);
    await fs.writeFile(path.join(dir,'chunk.jsonl'),text);
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({year:2025,chunks:[{name:'chunk.jsonl',sha256:hash}]}));
    const client={ingest:async()=>({items:[{job_id:jobId}]}),job:async()=>({id:jobId,collection:'legal',status:'needs_review',document_id:hash})};
    await assert.rejects(normalizePatentsViewCohort({manifestPath:path.join(dir,'manifest.json')},{client,intakeRoot}),/identity or normalization/);
  }finally{await fs.rm(intakeRoot,{recursive:true});}
});
