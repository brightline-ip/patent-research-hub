import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {dataDir,readConfig} from './config.mjs';
const checkpointRoot=()=>path.join(dataDir(readConfig()),'checkpoints');
import {assertNoSensitiveText} from './security.mjs';
import {assertNotReservedName} from './names.mjs';
export const sessionKey=id=>{if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('Use a short session name containing letters, numbers, hyphens or underscores');return assertNotReservedName(id,'session name');};
export async function checkpoint(data){
  const id=sessionKey(data.session),serialized=JSON.stringify(data);
  if(serialized.length>40000)throw new Error('Checkpoint exceeds 40,000 characters; keep sources in the corpus');
  assertNoSensitiveText(serialized);
  const dir=path.join(checkpointRoot(),id);await fs.mkdir(dir,{recursive:true});
  const state={...data,createdAt:new Date().toISOString(),version:randomUUID(),notice:'Research handoff, not a source of legal authority. Original conversation history is managed by the originating client.'};
  const target=path.join(dir,state.version+'.json');await fs.writeFile(target,JSON.stringify(state,null,2),{flag:'wx'});return {path:target,...state};
}
export async function resume(session){const dir=path.join(checkpointRoot(),sessionKey(session));let files;try{files=await fs.readdir(dir);}catch(e){if(e.code==='ENOENT')return {found:false,session};throw e;}const entries=await Promise.all(files.filter(x=>x.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))));entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return {found:!!entries.length,checkpoint:entries[0]||null,versions:entries.length};}
