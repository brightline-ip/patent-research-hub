// Configuration and install-relative locations. Nothing here contains or reads a secret: provider credentials are
// read from environment variables at call time (see src/direct.mjs and .env.example).
import {parseJsonText} from './json-text.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export const installRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// Every setting with its safe default. config.json (optional, git-ignored) overrides these; see config.example.json.
export const configDefaults=Object.freeze({
  transport:'direct',                       // 'direct' (Hub calls providers itself) or 'n8n' (optional, see extras/n8n)
  dataDir:'',                               // empty = <install>/data; PATENT_RESEARCH_DATA_DIR overrides
  exportsDir:'',                            // empty = <install>/exports; PATENT_RESEARCH_EXPORTS_DIR overrides
  requestTimeoutMs:25000,
  directMinIntervalMs:{uspto:1000,epo:1000,govinfo:3600,courtlistener:1000,bigquery:1000,public:1000},
  maxRequestsPerHour:{uspto:120,epo:120,govinfo:120,courtlistener:120,bigquery:120}, // per provider and key, shared by every Hub process using this data folder; 0 = unlimited. Local safeguard, not the provider's quota
  limiterMaxWaitMs:1200000,                 // longest a call waits for its turn, the pacing gap or a 429 cooldown before failing with local_busy
  limiterStaleLockMs:30000,                 // a call lock not refreshed for this long (holder died or hung) is taken over
  oaRejectionsAdapter:'legacy-rejections-v2', // which USPTO service answers the oa-rejections route (src/oa-adapter.mjs)
  courtlistenerEnabled:false,               // CourtListener stays off until enabled AND terms acknowledged
  courtlistenerInternalUseAllowed:false,    // set true only after reading https://free.law/membership/allowed-api-usage/
  googleBigQueryProjectId:'',               // your own GCP project; BIGQUERY_PROJECT_ID overrides
  googleBigQueryDryRunEnabled:true,         // dry runs are free byte estimates
  googleBigQueryExecutionEnabled:false,     // data queries are off by default
  googleBigQueryBillingMode:'disabled',     // 'sandbox-no-billing' | 'billing-enabled-capped' | 'disabled'
  googleBigQueryPerQueryMaxBytes:'26843545600',      // 25 GiB per query (maximumBytesBilled)
  googleBigQueryMonthlyTrackedMaxBytes:'274877906944', // 256 GiB per calendar month, tracked by this tool only
  ptabOriginalsEnabled:true,
  patentDocumentsEnabled:true,
  patentDocumentOriginalsEnabled:true,
  referenceGatewayEnabled:false,            // n8n transport only
  corpusIntakeRoot:'',                      // empty = <dataDir>/intake
  getFilesClientModule:'',                  // optional Get Files integration; RESEARCH_GET_FILES_CLIENT overrides
  corpusClientModule:'',                    // optional corpus client for PatentsView intake; RESEARCH_CORPUS_CLIENT overrides
  pythonExecutable:'',                      // absolute path; RESEARCH_PYTHON overrides; empty = python on PATH
  n8nBaseUrl:'http://127.0.0.1:5678',       // n8n transport only (loopback)
  n8nRemoteHost:'',                         // n8n transport only; optional hostname of a remote https n8n (exact match); empty = loopback only
  gatewayAuthFile:'',                       // n8n transport only; RESEARCH_GATEWAY_AUTH_FILE overrides
  modelProxyPort:8769,                      // n8n transport only
});

export function configPath(env=process.env){return env.PATENT_RESEARCH_CONFIG?path.resolve(env.PATENT_RESEARCH_CONFIG):path.join(installRoot,'config.json');}

export function readConfig({env=process.env,file=configPath(env)}={}){
  let local={};
  if(fs.existsSync(file)){
    try{local=parseJsonText(fs.readFileSync(file,'utf8'));}catch{throw new Error('config.json is not valid JSON; compare it with config.example.json');}
    if(!local||typeof local!=='object'||Array.isArray(local))throw new Error('config.json must contain one JSON object');
  }
  const config={...configDefaults,...local,directMinIntervalMs:{...configDefaults.directMinIntervalMs,...(local.directMinIntervalMs||{})},maxRequestsPerHour:{...configDefaults.maxRequestsPerHour,...(local.maxRequestsPerHour||{})}};
  if(env.PATENT_RESEARCH_TRANSPORT)config.transport=env.PATENT_RESEARCH_TRANSPORT;
  if(env.BIGQUERY_PROJECT_ID)config.googleBigQueryProjectId=env.BIGQUERY_PROJECT_ID;
  if(env.RESEARCH_GATEWAY_AUTH_FILE)config.gatewayAuthFile=env.RESEARCH_GATEWAY_AUTH_FILE;
  if(!['direct','n8n'].includes(config.transport))throw new Error('transport must be "direct" or "n8n"');
  return config;
}

const resolveFrom=(value,fallback)=>value?path.resolve(installRoot,value):fallback;
export function dataDir(config={},env=process.env){return env.PATENT_RESEARCH_DATA_DIR?path.resolve(env.PATENT_RESEARCH_DATA_DIR):resolveFrom(config.dataDir,path.join(installRoot,'data'));}
export function exportsDir(config={},env=process.env){return env.PATENT_RESEARCH_EXPORTS_DIR?path.resolve(env.PATENT_RESEARCH_EXPORTS_DIR):resolveFrom(config.exportsDir,path.join(installRoot,'exports'));}
export function intakeDir(config={},env=process.env){return resolveFrom(config.corpusIntakeRoot,path.join(dataDir(config,env),'intake'));}

// An absolute Python interpreter: RESEARCH_PYTHON, config.pythonExecutable, the install's .venv, then python on PATH.
export function pythonExecutable(config={},env=process.env){
  const configured=env.RESEARCH_PYTHON||config.pythonExecutable;
  if(configured)return path.resolve(configured);
  for(const candidate of [path.join(installRoot,'.venv','Scripts','python.exe'),path.join(installRoot,'.venv','bin','python')])if(fs.existsSync(candidate))return candidate;
  for(const name of process.platform==='win32'?['python','py']:['python3','python']){
    const probe=spawnSync(name,['-c','import sys;print(sys.executable)'],{encoding:'utf8',windowsHide:true,timeout:10000});
    const found=probe.status===0?probe.stdout.trim():'';
    if(found&&path.isAbsolute(found))return found;
  }
  return null;
}
