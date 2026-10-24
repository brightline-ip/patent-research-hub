// Stable provider gateway. Public contract (also used by other tools, for example Patent Genius via
// FRAME_GATEWAY_MODULE; see docs/INTEGRATION.md):
//   readConfig()                          -> merged configuration (config.json optional)
//   callGateway(route, body, {config})    -> provider envelope, e.g. {text, status, contentType} for source routes
//   gatewaySource(source, url, options, config) -> {text, status, contentType}; throws on a non-2xx status
// config.transport selects 'direct' (default: the Hub calls providers with credentials from environment variables)
// or 'n8n' (optional: a loopback n8n instance holds the credentials; workflows in extras/n8n).
import fs from 'node:fs';
import {request} from './net.mjs';
import {safeErrorMessage} from './security.mjs';
import {readConfig} from './config.mjs';
import {directGateway,directSource,routeForSource} from './direct.mjs';
export {readConfig};

export function gatewayAuth(config=readConfig()){
  if(!config.gatewayAuthFile)throw new Error('n8n transport: set gatewayAuthFile or RESEARCH_GATEWAY_AUTH_FILE');
  const content=fs.readFileSync(config.gatewayAuthFile,'utf8');
  const token=content.split(/\r?\n/).find(x=>x.startsWith('RESEARCH_GATEWAY_AUTH_HEADER_VALUE='))?.split('=').slice(1).join('=').trim();
  if(!/^Bearer [A-Za-z0-9_-]{43,}$/.test(token||''))throw new Error('Existing n8n gateway authentication is unavailable');
  return token;
}
export async function callN8nGateway(route,body,{config=readConfig(),fetchImpl=fetch,maxBytes=8e6}={}){
  const base=new URL(config.n8nBaseUrl);
  if(!['127.0.0.1','localhost'].includes(base.hostname)||base.protocol!=='http:'||base.username||base.password)throw new Error('n8n must be local; configure TLS before remote use');
  if(!/^[a-z-]+$/.test(route))throw new Error('Invalid gateway route');
  const response=await request(new URL('/webhook/patent-research-'+route,base),{method:'POST',body,headers:{Authorization:gatewayAuth(config),'Content-Type':'application/json'},timeout:240000,maxBytes,fetchImpl});
  let result;try{result=JSON.parse(response.text);}catch{throw new Error(response.text.trim()?'n8n returned an invalid response; check the source workflow':'n8n returned an empty response: the source workflow may have failed. Check its provider response; this is not evidence of zero matches.');}
  if(result.error)throw new Error(typeof result.error==='string'?safeErrorMessage(result.error,'n8n source/model failed; sensitive details were suppressed'):'n8n source/model failed; check credential configuration');
  return result;
}
export async function callGateway(route,body,options={}){
  const config=options.config||readConfig();
  if(config.transport==='n8n')return callN8nGateway(route,body,{...options,config});
  if(!/^[a-z-]+$/.test(route))throw new Error('Invalid gateway route');
  return directGateway(route,body,{...options,config});
}
export async function gatewaySource(source,url,options={},config=readConfig(),context={}){
  if(config.transport!=='n8n')return directSource(source,url,options,{...context,config});
  const r=await callN8nGateway(routeForSource(source),{source,url:String(url),method:options.method||'GET',body:options.body},{config,...(context.fetchImpl?{fetchImpl:context.fetchImpl}:{})});
  if(typeof r.text!=='string'||typeof r.contentType!=='string')throw new Error('n8n source response schema changed');
  if(r.status<200||r.status>=300)throw new Error('Provider HTTP '+r.status+'; check source credentials in n8n');
  return r;
}
