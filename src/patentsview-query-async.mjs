import {Worker} from 'node:worker_threads';
const SCRIPT=new URL('./patentsview-query-worker.mjs',import.meta.url);
export function createPatentsViewAsyncQuery({dataRoot,WorkerImpl=Worker,timeoutMs=15000}={}){
 if(typeof dataRoot!=='string'||!dataRoot||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>15000)throw Error('PATENTSVIEW_ASYNC_NOT_CONFIGURED');let active=false;
 return async function query(input){if(active)throw Error('PATENTSVIEW_QUERY_BUSY');active=true;let worker;
  try{return await new Promise((resolve,reject)=>{let settled=false;const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};worker=new WorkerImpl(SCRIPT,{workerData:{dataRoot,input:structuredClone(input)},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});const timer=setTimeout(()=>{worker.terminate();finish(reject,Error('PATENTSVIEW_QUERY_TIMEOUT'));},timeoutMs);timer.unref?.();worker.once('message',message=>{if(message?.ok===true&&message.result&&Buffer.byteLength(JSON.stringify(message.result))<=2*1024*1024)finish(resolve,message.result);else finish(reject,Error('PATENTSVIEW_QUERY_REJECTED'));});worker.once('error',()=>finish(reject,Error('PATENTSVIEW_QUERY_REJECTED')));worker.once('exit',code=>{if(code!==0)finish(reject,Error('PATENTSVIEW_QUERY_REJECTED'));});});}
  finally{if(worker)try{await worker.terminate();}catch{}active=false;}
 };
}
