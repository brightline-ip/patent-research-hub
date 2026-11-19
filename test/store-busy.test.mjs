import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';

// Two Hub processes (an assistant's MCP server and a command-line run) can share one database. A write that meets
// the other's short transaction must wait, not fail at once with "database is locked".
const holder=file=>`
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL');db.exec('BEGIN IMMEDIATE');
console.log('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);db.exec('COMMIT');`;

async function withHolder(file,fn){
  const child=spawn(process.execPath,['-e',holder(file),file],{stdio:['ignore','pipe','inherit'],windowsHide:true});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('lock holder exited early')));});
  try{return await fn();}finally{child.removeAllListeners('exit');await new Promise(r=>{child.once('exit',r);child.kill();});}
}

test('a write that meets another process\'s transaction waits instead of failing at once',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'patent-busy-')),store=new Store(dir);
  try{
    const insert=(db,id)=>db.prepare('INSERT INTO runs(id,source,created,body) VALUES(?,?,?,?)').run(id,'fixture','2026-01-01T00:00:00.000Z','{}');
    // Without a busy timeout the same situation fails immediately (documents what the setting prevents).
    await withHolder(store.file,async()=>{
      const plain=new DatabaseSync(store.file);
      try{assert.throws(()=>insert(plain,'plain'),/locked|busy/i);}finally{plain.close();}
    });
    await withHolder(store.file,async()=>{
      const started=Date.now();insert(store.db,'waited');
      assert.ok(Date.now()-started>=300,'the write should have waited for the other transaction');
    });
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs WHERE id=?').get('waited').n,1);
  }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
