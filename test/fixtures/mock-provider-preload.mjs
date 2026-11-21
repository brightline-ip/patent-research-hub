// Test-only preload for child processes (node --import): replaces global fetch with a scripted fake, so no network is used.
// PRH_MOCK_RULES: JSON array of {match: substring of the URL, status, body (object or string), headers, delayMs, times}.
// PRH_MOCK_LOG: file that receives one JSON line per request {pid,t0,t1,url,method,key}. The first rule that matches (and
// has uses left) answers; with no match the response is HTTP 599 so a wrong URL is visible.
import fs from 'node:fs';
const rules=JSON.parse(process.env.PRH_MOCK_RULES||'[]'),log=process.env.PRH_MOCK_LOG;
globalThis.fetch=async(url,options={})=>{
  const t0=Date.now(),u=String(url),rule=rules.find(r=>u.includes(r.match)&&(r.times===undefined||r.times>0));
  if(rule&&rule.times!==undefined)rule.times--;
  if(rule?.delayMs)await new Promise(r=>setTimeout(r,rule.delayMs));
  if(log)fs.appendFileSync(log,JSON.stringify({pid:process.pid,t0,t1:Date.now(),url:u,method:options.method||'GET',key:options.headers?.['X-API-KEY']||null})+'\n');
  const body=typeof rule?.body==='string'?rule.body:JSON.stringify(rule?.body??{});
  return new Response(body,{status:rule?.status??599,headers:{'content-type':'application/json',...(rule?.headers||{})}});
};
