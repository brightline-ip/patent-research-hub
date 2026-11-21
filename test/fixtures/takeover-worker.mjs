// Worker for test/takeover.test.mjs: for each round, at its start time, take the per-round limiter lock (which the parent
// pre-seeded as a STALE lock) and run a short critical section, logging enter and exit times.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {modulePath,root,rounds,slotMs,t0,log}=JSON.parse(process.argv[2]);
const {withProviderSlot}=await import(pathToFileURL(modulePath).href);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let r=0;r<rounds;r++){
  const wait=t0+r*slotMs-Date.now();if(wait>0)await sleep(wait);
  await withProviderSlot({dir:path.join(root,String(r)),provider:'uspto',key:'k',staleMs:30000,maxWaitMs:120000},async()=>{
    const enter=Date.now();await sleep(4);
    fs.appendFileSync(log,JSON.stringify({r,pid:process.pid,enter,exit:Date.now()})+'\n');
  });
}
