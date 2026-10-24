import {parentPort,workerData} from 'node:worker_threads';
import {queryPatentsView} from './patentsview.mjs';
try{const result=queryPatentsView(workerData.input,{dataRoot:workerData.dataRoot}),text=JSON.stringify(result);if(Buffer.byteLength(text)>2*1024*1024)throw Error('RESULT_TOO_LARGE');parentPort.postMessage({ok:true,result});}catch{parentPort.postMessage({ok:false,error:'PATENTSVIEW_QUERY_REJECTED'});}
