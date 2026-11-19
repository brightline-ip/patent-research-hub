// USPTO ODP Office Action Rejections (DSAPI v2) route: request validation and response packaging. Both functions are
// embedded verbatim into the n8n workflow patent-research-oa-rejections-core by scripts/build-oa-rejections-workflows.mjs,
// so they must stay self-contained. Callers send only application numbers and paging (or ask for the field list);
// the endpoint is fixed and the Lucene criteria are built here, never taken from the caller.
//   {action:'records', application_numbers:['17000001', ...1..100], field?:'patentApplicationNumber', start?:0, rows?:100}
//   {action:'fields'}
export function rejectionsRequest(b){
 const base='https://api.uspto.gov/api/v1/patent/oa/oa_rejections/v2/';
 const action=b?.action??'records';
 if(action==='fields')return {url:base+'fields',method:'GET',body:'',contentType:''};
 if(action!=='records')throw Error('Unsupported action');
 const apps=b?.application_numbers;
 if(!Array.isArray(apps)||apps.length<1||apps.length>100||apps.some(a=>typeof a!=='string'||!/^\d{8}$/.test(a)))throw Error('Supply 1-100 eight-digit application numbers');
 const field=b.field??'patentApplicationNumber';
 if(!['patentApplicationNumber','applicationNumberText'].includes(field))throw Error('Unsupported application-number field');
 const start=b.start??0,rows=b.rows??100;
 if(!Number.isSafeInteger(start)||start<0||start>1000000||!Number.isSafeInteger(rows)||rows<1||rows>100)throw Error('Invalid paging');
 const criteria=field+':('+[...new Set(apps)].join(' OR ')+')';
 const body='criteria='+encodeURIComponent(criteria)+'&start='+start+'&rows='+rows;
 return {url:base+'records',method:'POST',body,contentType:'application/x-www-form-urlencoded'};
}

// Input: the parsed provider body (HTTP node runs with neverError, no fullResponse). Success bodies pass through as
// JSON text with status 200; provider error bodies keep their own status; anything unrecognized is 502.
export function packageRejectionsResponse(j){
 const body=j&&typeof j==='object'&&!Array.isArray(j)?j:null;
 if(!body)return {text:JSON.stringify({provider_status:null,provider_message:'unrecognized provider response'}),status:502,contentType:'application/json'};
 const code=Number(body.code??body.status);
 // Success needs a documented shape: records {response:{...}} or the field list {fields:[...]}. Anything else (provider error objects, or a non-JSON page that
 // n8n wraps as {data:'<html>...'}) is an error, never a 200.
 const looksError=(Number.isInteger(code)&&code>=400)||!((body.response&&typeof body.response==='object'&&!Array.isArray(body.response))||Array.isArray(body.fields));
 if(!looksError)return {text:JSON.stringify(body),status:200,contentType:'application/json'};
 const message=['message','detailedMessage','errorDetails','error','data'].map(k=>body[k]).filter(v=>typeof v==='string').join(' | ').replace(/[\u0000-\u001f]/g,' ').slice(0,300);
 return {text:JSON.stringify({provider_status:Number.isInteger(code)?code:null,provider_message:message}),status:Number.isInteger(code)&&code>=400&&code<600?code:502,contentType:'application/json'};
}
