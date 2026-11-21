// Stale-lock takeover under contention: many processes find the same stale lock at the same moment. At most one of them may
// hold the lock at any time. (With the earlier unserialised takeover, two processes held it in about 3 of 120 rounds.)
// PRH_LIMITER_MODULE can point the test at another copy of limiter.mjs to check a suspect version.
import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {scratchFolder,repo} from './helpers/gateway-child.mjs';

const modulePath=process.env.PRH_LIMITER_MODULE||path.join(repo,'src','limiter.mjs');
const worker=path.join(repo,'test','fixtures','takeover-worker.mjs');

test('thirty-two processes finding the same stale lock never hold it together',{timeout:240000},async()=>{
  const mod=await import(pathToFileURL(modulePath).href);
  const root=scratchFolder('prh-takeover-'),log=path.join(root,'log.jsonl'),rounds=Number(process.env.PRH_TAKEOVER_ROUNDS||120),workers=Number(process.env.PRH_TAKEOVER_WORKERS||32),slotMs=Number(process.env.PRH_TAKEOVER_SLOT||330);
  for(let r=0;r<rounds;r++){
    const dir=path.join(root,String(r));fs.mkdirSync(dir,{recursive:true});
    const lock=mod.lockPath?mod.lockPath(dir,'uspto','k'):path.join(dir,mod.limiterId('uspto','k')+'.lock');
    fs.writeFileSync(lock,JSON.stringify({pid:999999,token:'dead-holder',at:0}));
    const old=new Date(Date.now()-120000);fs.utimesSync(lock,old,old);
  }
  const t0=Date.now()+2500,arg=JSON.stringify({modulePath,root,rounds,slotMs,t0,log});
  const exits=await Promise.all(Array.from({length:workers},()=>new Promise(resolve=>{
    const c=spawn(process.execPath,[worker,arg],{stdio:['ignore','ignore','pipe'],windowsHide:true});let err='';c.stderr.on('data',d=>err+=d);c.on('close',code=>resolve({code,err}));
  })));
  assert.deepEqual(exits.filter(e=>e.code!==0).map(e=>e.err.slice(0,300)),[]);
  const events=fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
  assert.equal(events.length,rounds*workers,'every process should have taken its turn in every round');
  const bad=[];
  for(let r=0;r<rounds;r++){
    const e=events.filter(x=>x.r===r).sort((a,b)=>a.enter-b.enter);
    for(let i=1;i<e.length;i++)if(e[i].enter<e[i-1].exit){bad.push(r);break;}
  }
  assert.deepEqual(bad,[],`rounds with two holders at once: ${bad.join(',')}`);
});
