// Test helper: runs `node src/cli.mjs gateway <route> --json-in` as a real child process with global fetch replaced by the
// scripted fake in test/fixtures/mock-provider-preload.mjs. No network is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const repo=path.resolve(import.meta.dirname,'..','..');
const preload=pathToFileURL(path.join(repo,'test','fixtures','mock-provider-preload.mjs')).href;

const made=[];
process.on('exit',()=>{for(const dir of made)try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
export function scratchFolder(prefix='prh-child-'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));made.push(dir);
  return dir;
}
// A data folder with a config.json (read through PATENT_RESEARCH_CONFIG) and a request log.
export function childSetup({config={},rules=[]}={}){
  const dir=scratchFolder(),data=path.join(dir,'data'),log=path.join(dir,'requests.jsonl'),configFile=path.join(dir,'config.json');
  fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(configFile,JSON.stringify({directMinIntervalMs:{uspto:0},...config}));
  return {dir,data,log,configFile,rules,
    env:{...process.env,PATENT_RESEARCH_DATA_DIR:data,PATENT_RESEARCH_LIMITER_DIR:path.join(data,'limiter'),PATENT_RESEARCH_CONFIG:configFile,USPTO_API_KEY:'fixture-key-for-child-tests',PRH_MOCK_LOG:log,PRH_MOCK_RULES:JSON.stringify(rules),NODE_OPTIONS:`--import=${preload}`},
    requests(){return fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];}};
}
export function runChild(setup,{args=['uspto','--json-in'],input,env={},hold=false}={}){
  const child=spawn(process.execPath,[path.join(repo,'src','cli.mjs'),'gateway',...args],{env:{...setup.env,...env},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  if(input!==undefined)child.stdin.end(typeof input==='string'?input:JSON.stringify(input));
  const done=new Promise(resolve=>child.on('close',code=>{let json=null;try{json=JSON.parse(stdout);}catch{}resolve({code,stdout,stderr,json});}));
  return hold?{child,done}:done;
}
export const searchRequest={source:'odp',url:'https://api.uspto.gov/api/v1/patent/applications/search',method:'POST',body:{q:'inventionTitle:fixture',pagination:{offset:0,limit:10}}};
export const okSearch={count:1,patentFileWrapperDataBag:[{applicationNumberText:'17000001'}]};
