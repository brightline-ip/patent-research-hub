// Loaded by npm test (node --import) and imported by every test file: each test process gets throwaway data and limiter folders (the limiter otherwise uses one per-user folder under %LOCALAPPDATA%) instead of writing into the install tree or the real profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The limiter folder is FORCED, even if the environment already names one: every process started from a test inherits it.
const limiter=fs.mkdtempSync(path.join(os.tmpdir(),'prh-test-limiter-'));
process.env.PATENT_RESEARCH_LIMITER_DIR=limiter;
process.on('exit',()=>{try{fs.rmSync(limiter,{recursive:true,force:true});}catch{}});
if(!process.env.PATENT_RESEARCH_DATA_DIR){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prh-test-data-'));
  process.env.PATENT_RESEARCH_DATA_DIR=dir;
    process.on('exit',()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
}
