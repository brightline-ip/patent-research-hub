// Packaging of the ODP search provider response in the live workflow patent-research-uspto-core. Embedded verbatim
// (Function.prototype.toString) by scripts/build-live-uspto-core.mjs, so it must stay self-contained.
//
// The provider HTTP node runs with neverError (no fullResponse: in this n8n version fullResponse hands Code nodes an
// unread stream), so this function receives the parsed JSON body for success AND error. ODP error bodies carry their
// own status, e.g. {code:404, message:'Not Found', detailedMessage:'No matching records found, ...'} (live 2026-10-17).
// Before this change the node threw on any non-2xx status, so "no matching records" reached callers as an empty n8n
// response, indistinguishable from a failure. Now:
//   success body (has count)                    -> serialized exactly as before (JSON.stringify of the body), status 200
//   error body code 404 + "no matching records" -> {count:0, patentFileWrapperDataBag:[], provider_status:404}, status 200
//   other error body (code >= 400)              -> that status (callers already reject non-2xx), bounded message
//   anything else                               -> 502 (never a fake success)
export function packageSearchResponse(j){
 const body=j&&typeof j==='object'&&!Array.isArray(j)?j:{};
 if(Object.prototype.hasOwnProperty.call(body,'count')&&!(Number(body.code)>=400))return {text:JSON.stringify(j),status:200,contentType:'application/json'};
 const code=Number(body.code);
 const message=['message','detailedMessage','errorDetails','error'].map(k=>body[k]).filter(v=>typeof v==='string').join(' | ').replace(/[\u0000-\u001f]/g,' ').slice(0,300);
 if(code===404&&/no\s+matching\s+records?/i.test(message))
  return {text:JSON.stringify({count:0,patentFileWrapperDataBag:[],provider_status:404,provider_message:message.slice(0,200)}),status:200,contentType:'application/json'};
 if(Number.isInteger(code)&&code>=400&&code<600)return {text:JSON.stringify({provider_status:code,provider_message:message}),status:code,contentType:'application/json'};
 return {text:JSON.stringify({provider_status:null,provider_message:'unrecognized provider response'}),status:502,contentType:'application/json'};
}
