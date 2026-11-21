const hosts=new Set(['www.cafc.uscourts.gov','www.uspto.gov','data.uspto.gov','api.uspto.gov','patentsgazette.uspto.gov','api.govinfo.gov','www.govinfo.gov','www.courtlistener.com','ops.epo.org','www.uscourts.gov','uscode.house.gov','www.ecfr.gov']);
export function validateSourceUrl(input){
  const u=new URL(input);
  if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.username||u.password||u.port)throw new Error('Source URL is outside the approved HTTPS providers');
  return u;
}
export function retryDelay(value,{now=Date.now()}={}){
  if(value===null||value===undefined||String(value).trim()==='')return 1000;
  const text=String(value).trim();let ms;
  if(/^\d+(?:\.\d+)?$/.test(text))ms=Number(text)*1000;
  else{const at=Date.parse(text);if(Number.isNaN(at))throw new Error('Provider supplied an invalid Retry-After value');ms=Math.max(0,at-now);}
  if(!Number.isFinite(ms)||ms>5000)throw new Error('Provider requested a retry delay beyond the configured limit');
  return Math.max(1000,Math.ceil(ms));
}
// Retries (with Retry-After or exponential backoff, at most 5 s) apply only to idempotent GET/HEAD requests and only to HTTP 5xx.
// HTTP 429 is never retried here: the caller gets the status and Retry-After, and the limiter (limiter.mjs) holds the key back for at
// least 5 s (the provider's published minimum) before any later request.
// allowHttpError returns non-2xx responses instead of throwing; binary also returns the raw bytes.
export async function request(url,{method='GET',body,headers={},timeout=25000,maxBytes=6e6,fetchImpl=fetch,allowHttpError=false,binary=false}={}){
  const retryable=['GET','HEAD'].includes(String(method).toUpperCase());
  for(let attempt=0;attempt<(retryable?3:1);attempt++){
    let r;
    try{r=await fetchImpl(url,{method,headers:{'User-Agent':'PatentResearchHub/0.2 (public legal research)','Accept':'application/json, application/xml, text/html',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(timeout),redirect:'error'});}
    catch{throw new Error('Provider connection failed, timed out, or redirected; no credentials or response body were logged');}
    if(retryable&&r.status>=500&&attempt<2){await r.body?.cancel();let delay;try{delay=Math.min(5000,Math.max(retryDelay(r.headers.get('retry-after')),1000*2**attempt));}catch{if(allowHttpError)return {text:'',contentType:r.headers.get('content-type')||'',status:r.status};throw new Error(`Provider HTTP ${r.status}; retry later`);}await new Promise(resolve=>setTimeout(resolve,delay));continue;}
    if(!r.ok&&!allowHttpError){await r.body?.cancel();throw new Error(`Provider HTTP ${r.status}; check access and retry later`);}
    let size=0;const blocks=[];
    for await(const b of r.body??[]){size+=b.length;if(size>maxBytes){await r.body.cancel().catch(()=>{});throw new Error('Provider response exceeded the size limit');}blocks.push(b);}
    const buffer=Buffer.concat(blocks);return {text:binary?'':buffer.toString('utf8'),contentType:r.headers.get('content-type')||'',status:r.status,retryAfter:r.headers.get('retry-after'),...(binary?{buffer}:{})};
  }
}
export async function jsonRequest(url,options={}){const r=await request(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});try{return JSON.parse(r.text);}catch{throw new Error('Provider returned invalid JSON; no records imported');}}
export async function sourceRequest(url,options){validateSourceUrl(url);return request(url,options);}
