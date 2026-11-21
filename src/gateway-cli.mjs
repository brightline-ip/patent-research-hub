// `Hub.cmd gateway <route> --json-in`: the supported way for another tool to use the Hub's provider access without ever
// holding the provider keys. The caller starts this as a short-lived child process, writes ONE JSON request to stdin and
// reads ONE JSON document from stdout, then the child exits:
//   stdin   the route body, exactly what callGateway(route, body) takes (JSON object, at most 256 KB)
//   stdout  exit 0: the provider envelope callGateway returns, e.g. {text,status,contentType} (a provider status such as
//           404 or 429 is RETURNED in the envelope; it is not a failure of the command)
//           otherwise: {"error":{"code":...,"message":...}} and a non-zero exit code
//   `gateway --limits` prints the effective limits (config only; no key used) and exits 0.
//   exit    0 ok | 1 failed | 2 not_configured (key missing) | 64 bad request | 75 local_limit or local_busy (wait, then retry)
// The keys come from this process's environment (Hub.cmd loads keys.env); they are never echoed. The command takes no module
// path from the environment or the request: FRAME_GATEWAY_MODULE-style test overrides belong to callers, and are ignored here.
// Retention: nothing is written to the Hub store; the only files touched are the limiter state in <dataDir>/limiter.
import {readConfig} from './config.mjs';
import {callGateway} from './gateway.mjs';
import {safeErrorMessage} from './security.mjs';
import {GATEWAY_ROUTES} from './gateway-routes.mjs';
import {effectiveLimits,limiterDir} from './config.mjs';
import {parseJsonText} from './json-text.mjs';
import fs from 'node:fs';

const MAX_REQUEST_BYTES=262144,READ_TIMEOUT_MS=30000;
const OVERRIDES=['FRAME_GATEWAY_MODULE','PG_GATEWAY_MODULE'];

function finish(code,payload){
  process.exitCode=code;
  return new Promise(resolve=>process.stdout.write(JSON.stringify(payload),resolve));
}
const fail=(exit,code,message,extra={})=>finish(exit,{error:{code,message,...extra}});

function readRequest(stream){
  return new Promise((resolve,reject)=>{
    if(stream.isTTY)return reject(Object.assign(new Error('Pipe one JSON request to stdin (this command does not prompt).'),{bad:true}));
    const chunks=[];let size=0;
    const timer=setTimeout(()=>{reject(Object.assign(new Error('No complete JSON request arrived on stdin within 30 seconds.'),{bad:true}));stream.destroy();},READ_TIMEOUT_MS);
    stream.on('data',c=>{size+=c.length;if(size>MAX_REQUEST_BYTES){clearTimeout(timer);reject(Object.assign(new Error('Request is larger than 256 KB.'),{bad:true}));stream.destroy();}else chunks.push(c);});
    stream.on('end',()=>{clearTimeout(timer);resolve(Buffer.concat(chunks).toString('utf8'));});
    stream.on('error',e=>{clearTimeout(timer);reject(e);});
  });
}

// `gateway --limits`: the effective limits as JSON. Reads configuration only: no key is read or used, no request is made, no
// file is written.
function limitsReport(config){
  const limits=effectiveLimits(config);   // the same function the direct transport enforces with
  let version=null;try{version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;}catch{}
  const providers={};
  for(const [id,p] of Object.entries(limits.providers))providers[id]={max_calls_per_hour:p.maxRequestsPerHour,min_interval_ms:p.minIntervalMs,concurrent_calls_per_key:p.concurrentCallsPerKey};
  return {hub_version:version,transport:config.transport,limiter_applies:config.transport==='direct',providers,limiter_dir:limiterDir(config,process.env),limiter_max_wait_ms:limits.maxWaitMs,limiter_stale_lock_ms:limits.staleMs,min_wait_after_429_seconds:5,note:'max_calls_per_hour counts calls (turns at the key), not HTTP attempts, and 0 means unlimited; the cap is shared by every Hub process of this user (state in limiter_dir); these are local limits, not the provider quota'};
}

const args=process.argv.slice(3);
const route=args.find(a=>!a.startsWith('--')),flags=args.filter(a=>a.startsWith('--'));
if(args.length===1&&args[0]==='--limits'){
  try{await finish(0,limitsReport(readConfig({env:process.env})));}catch(e){await fail(1,'error',safeErrorMessage(e?.message));}
}else if(!route||!GATEWAY_ROUTES.includes(route)||flags.length!==1||flags[0]!=='--json-in'||args.length!==2){
  await fail(64,'bad_request','Usage: gateway <route> --json-in (JSON request on stdin) | gateway --limits. Routes: '+GATEWAY_ROUTES.join(', '));
}else{
  // If the process that started this one disappears (for example the caller kills Hub.cmd, which does not kill its node child),
  // stop within a couple of seconds instead of finishing a request nobody will read. Only the direct parent is watched.
  const parent=process.ppid;
  if(parent>1){const timer=setInterval(()=>{try{process.kill(parent,0);}catch(e){if(e.code==='ESRCH')process.exit(1);}},2000);timer.unref();}
  const ignored=OVERRIDES.filter(name=>process.env[name]);
  if(ignored.length)process.stderr.write(`gateway: ${ignored.join(', ')} ignored (the gateway command never loads a module named by the environment)\n`);
  try{
    let body;
    try{body=parseJsonText(await readRequest(process.stdin));}
    catch(e){if(e.bad)throw e;throw Object.assign(new Error(e instanceof SyntaxError?'stdin is not valid JSON.':'Could not read stdin.'),{bad:true});}
    if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('The request must be one JSON object.'),{bad:true});
    const result=await callGateway(route,body,{config:readConfig({env:process.env}),env:process.env});
    await finish(0,result);
  }catch(e){
    if(e?.bad)await fail(64,'bad_request',e.message);
    else if(e?.notConfigured)await fail(2,'not_configured',safeErrorMessage(e.message),{provider:e.notConfigured.provider,missing:e.notConfigured.missing,register:e.notConfigured.register,terms:e.notConfigured.terms});
    else if(e?.code==='local_state')await fail(1,'local_state',e.message);
    else if(e?.code==='local_limit'||e?.code==='local_busy')await fail(75,e.code,e.message,{retry_after_seconds:e.retryAfterSeconds,...(e.limit?{limit:e.limit}:{})});
    else await fail(1,'error',safeErrorMessage(e?.message));
  }
}
