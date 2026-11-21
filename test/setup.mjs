// Loaded by `npm test` (node --import) into every test process: limiter state for keyed provider calls lives in
// <dataDir>/limiter, so each test process gets a throwaway data folder instead of writing into the install tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
if(!process.env.PATENT_RESEARCH_DATA_DIR){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prh-test-data-'));
  process.env.PATENT_RESEARCH_DATA_DIR=dir;
  process.on('exit',()=>{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
}
