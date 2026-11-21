// Adapter between the Hub's `oa-rejections` route and the USPTO service that answers it. Only the route code in
// direct.mjs talks to this module, so moving to another USPTO service later changes one entry here.
//
// Today: the legacy "Office Action Rejection API v2" on the Open Data Portal (fixed endpoint, 8-digit application
// numbers only; request validation lives in oa-rejections.mjs because the optional n8n workflow embeds it verbatim).
// The portal marks this API "Legacy". Its successor, the "Office Action Search API", is NOT implemented: its endpoint
// and field list could not be read without signing in (see CHANGELOG and docs/INTEGRATION.md), so adding it needs a
// documented request/response contract and a test against that contract.
//
// Contract of an adapter:
//   buildRequest(body)            -> {url, method, body, contentType}   (throws on anything outside the bounded contract)
//   packageResponse(action, httpStatus, text, {start}) -> {text, status, contentType}   (start = the requested offset)
// packageResponse takes the status from the HTTP response, never from the body, and fails closed: a body that does not
// have the documented shape is an error (502), never a successful result with zero records.
import {rejectionsRequest} from './oa-rejections.mjs';

const clean=value=>String(value??'').replace(/[\u0000-\u001f]/g,' ').slice(0,300);
const errorEnvelope=(status,providerStatus,message)=>({text:JSON.stringify({provider_status:providerStatus,provider_message:clean(message)}),status,contentType:'application/json'});

function legacyPackage(action,httpStatus,text,requested={}){
  const status=Number(httpStatus);
  let body=null;
  try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed;}catch{}
  const message=body?['message','detailedMessage','errorDetails','error'].map(k=>body[k]).filter(v=>typeof v==='string').join(' | '):'';
  if(!Number.isInteger(status)||status<200)return errorEnvelope(502,null,'unrecognized provider response');
  if(status>=400&&status<600)return errorEnvelope(status,status,message);                         // the provider's own status
  if(status>=300)return errorEnvelope(502,status,'unexpected redirect or status from the provider');
  if(!body)return errorEnvelope(502,null,'provider response was not a JSON object');
  const bodyCode=Number(body.code??body.status);
  if(Number.isInteger(bodyCode)&&bodyCode>=400)return errorEnvelope(502,bodyCode,message||'provider error inside a 2xx response');
  if(action==='fields'){
    if(!Array.isArray(body.fields))return errorEnvelope(502,null,'field list missing from the provider response');
    return {text:JSON.stringify(body),status:200,contentType:'application/json'};
  }
  const r=body.response;
  // numFound and docs must both be present and agree in kind; an object without them is never read as "no records".
  if(!r||typeof r!=='object'||Array.isArray(r)||!Number.isSafeInteger(r.numFound)||r.numFound<0||!Array.isArray(r.docs)||(r.numFound>0&&r.docs.length===0&&!(Number(requested.start)>=r.numFound)))
    return errorEnvelope(502,null,'unexpected response shape (no response.numFound and response.docs)');
  return {text:JSON.stringify(body),status:200,contentType:'application/json'};
}

export const oaAdapters=Object.freeze({
  'legacy-rejections-v2':Object.freeze({id:'legacy-rejections-v2',buildRequest:rejectionsRequest,packageResponse:legacyPackage}),
});
export function selectOaAdapter(config={}){
  const id=config.oaRejectionsAdapter||'legacy-rejections-v2';
  const adapter=Object.hasOwn(oaAdapters,id)?oaAdapters[id]:null;
  if(!adapter)throw new Error(`Unknown oaRejectionsAdapter "${String(id).slice(0,60)}"; this release supports: ${Object.keys(oaAdapters).join(', ')}`);
  return adapter;
}
