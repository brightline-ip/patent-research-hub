// Loaded by `npm test` (node --import) into every test process: each test process gets a throwaway data folder and a throwaway
// limiter folder (the limiter otherwise uses one per-user folder under %LOCALAPPDATA%) instead of writing into the install tree
// or the real profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if(!process.env.PATENT_RESEARCH_DATA_DIR){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prh-test-data-'));
  process.env.PATENT_RESEARCH_DATA_DIR=dir;
  process.env.PATENT_RESEARCH_LIMITER_DIR??=path.join(dir,'limiter');
  process.on('exit',()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
}
