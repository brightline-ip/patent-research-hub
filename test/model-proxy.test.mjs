import test from 'node:test';
import assert from 'node:assert/strict';
import {createProxy} from '../src/model-proxy.mjs';

// The shipped default settings define no models. The proxy must answer, not crash with an unhandled TypeError.
test('model proxy with no models configured lists none and refuses chat requests cleanly',async()=>{
  const auth='Bearer test-only';
  const srv=createProxy({config:{},auth,call:async()=>{throw new Error('must not be called');}});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+srv.address().port;
  const headers={Authorization:auth,'Content-Type':'application/json'};
  try{
    const list=await fetch(base+'/v1/models',{headers});
    assert.equal(list.status,200);assert.deepEqual((await list.json()).data,[]);
    const chat=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'anything',messages:[{role:'user',content:'hi'}]})});
    assert.equal(chat.status,400);assert.match((await chat.json()).error.message,/unconfigured model/);
    const noModel=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'hi'}]})});
    assert.equal(noModel.status,400);
    assert.equal((await fetch(base+'/health')).status,200);
  }finally{await new Promise(r=>srv.close(r));}
});
