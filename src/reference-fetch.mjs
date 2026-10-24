// Downloads official reference PDFs listed in config/reference-manifest.json and checks each against its pinned
// SHA-256. Originals are never shipped with the software. Files land in <dataDir>/references; nothing is indexed here
// (full-text reference search uses the optional Get Files integration, see docs/REFERENCE_LIBRARY.md).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {request} from './net.mjs';
import {validateReferenceUrl} from './references.mjs';
import {dataDir,installRoot,readConfig} from './config.mjs';

export function referenceManifest(file=path.join(installRoot,'config','reference-manifest.json')){
  const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.references))throw new Error('Unsupported reference manifest');
  for(const r of manifest.references){if(!/^[a-z0-9-]+$/.test(r.id)||(r.sha256!==null&&!/^[a-f0-9]{64}$/.test(r.sha256)))throw new Error('Invalid reference manifest entry');validateReferenceUrl(r.url);}
  return manifest;
}

export async function fetchReferences({family='',id='',limit=100}={},{config=readConfig(),fetchImpl=fetch,manifestFile,directory,intervalMs=1000}={}){
  const manifest=referenceManifest(manifestFile);
  const selected=manifest.references.filter(r=>(!family||r.family===family)&&(!id||r.id===id)).slice(0,limit);
  if(!selected.length)throw new Error('No manifest references match that family or id');
  const target=directory||path.join(dataDir(config),'references');fs.mkdirSync(target,{recursive:true});
  const results=[];
  for(const [index,r] of selected.entries()){
    const verified=path.join(target,`${r.id}-${r.sha256}.pdf`);
    if(r.sha256&&fs.existsSync(verified)&&createHash('sha256').update(fs.readFileSync(verified)).digest('hex')===r.sha256){results.push({id:r.id,status:'already-verified',path:verified});continue;}
    if(index&&intervalMs>0)await new Promise(resolve=>setTimeout(resolve,intervalMs));
    try{
      const response=await request(r.url,{headers:{Accept:'application/pdf'},timeout:120000,maxBytes:64*1024*1024,fetchImpl,binary:true});
      const bytes=response.buffer;
      if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('Response is not a PDF');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      if(sha256===r.sha256){fs.writeFileSync(verified,bytes);results.push({id:r.id,status:'verified',sha256,bytes:bytes.length,path:verified});}
      else{const candidate=path.join(target,`${r.id}-${sha256}.candidate.pdf`);fs.writeFileSync(candidate,bytes);results.push({id:r.id,status:'hash-changed',expectedSha256:r.sha256,sha256,bytes:bytes.length,path:candidate,note:'The publisher may have updated this document. Review its edition and effective dates before relying on it.'});}
    }catch(error){results.push({id:r.id,status:'failed',error:error.message});}
  }
  return {directory:target,requested:selected.length,verified:results.filter(x=>['verified','already-verified'].includes(x.status)).length,changed:results.filter(x=>x.status==='hash-changed').length,failed:results.filter(x=>x.status==='failed').length,results,policy:manifest.policy};
}
