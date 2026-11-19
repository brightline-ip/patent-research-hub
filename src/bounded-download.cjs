'use strict';
const https=require('node:https');
const dns=require('node:dns');
const crypto=require('node:crypto');
// PTAB decisions: 10 MiB, 60 s. Application file-wrapper originals (reexamination requests, affidavits): 40 MiB, 180 s.
const MAX_BYTES=10*1024*1024,MAX_APPLICATION_BYTES=40*1024*1024,PTAB_TIMEOUT_MS=60000,APPLICATION_TIMEOUT_MS=180000,MAX_ACTIVE=2;
let active=0;
function identity(input){
  const {application_number,document_identifier,native_filename}=input;
  if(typeof application_number!=='string'||!/^\d{8}$/.test(application_number)||typeof document_identifier!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(document_identifier))throw Error('Invalid public document identity');
  let extension='pdf',suffix='.pdf';
  if(native_filename!==undefined&&native_filename!==''){
    if(typeof native_filename!=='string'||native_filename.length>250||!native_filename.endsWith('.docx')||/[\\/\x00-\x1f\x7f]/.test(native_filename)||native_filename.includes('..'))throw Error('Invalid native filename');
    extension='docx';suffix='/files/'+encodeURIComponent(native_filename);
  }
  return {operation:'application',application_number,document_identifier,extension,url:'https://api.uspto.gov/api/v1/download/applications/'+application_number+'/'+document_identifier+suffix};
}
function ptabIdentity(input){
  const {trial_number,appeal_number,document_identifier}=input||{};
  const appeal=/^(20\d{2})(\d{6})$/.exec(appeal_number||'');
  if(appeal){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(document_identifier||''))throw Error('Invalid PTAB appeal document identity');return {operation:'ptab',appealNumber:appeal_number,documentIdentifier:document_identifier,extension:'pdf',url:'https://api.uspto.gov/api/v1/patent/ptab-files/APP/'+appeal[1]+'/'+appeal[2]+'/'+document_identifier+'.pdf'};}
  const trial=/^(IPR|PGR|CBM|DER)(20\d{2})-(\d{5})$/.exec(trial_number||'');
  if(!trial||!/^\d{1,20}$/.test(document_identifier||''))throw Error('Invalid PTAB trial document identity');
  return {operation:'ptab',trialNumber:trial_number,documentIdentifier:document_identifier,extension:'pdf',url:'https://api.uspto.gov/api/v1/patent/ptab-files/'+trial[1]+'/'+trial[2]+'/'+trial[3]+'/'+document_identifier+'.pdf'};
}
function signedDestination(location,expected){
  const prefix=expected.url.replace('https://api.uspto.gov/api/v1/download/','https://data-documents.uspto.gov/redirect/download/');
  if(typeof location!=='string'||location.length>4096||!location.startsWith(prefix+'?')||/[\s\\#]/.test(location)||!/^[A-Za-z0-9_~.%=&+\-]+$/.test(location.slice(prefix.length+1)))throw Error('Unrecognized signed download destination');
  const u=new URL(location);if(u.origin!=='https://data-documents.uspto.gov'||u.pathname!==new URL(prefix).pathname||u.username||u.password)throw Error('Unrecognized signed download destination');return u;
}
function ptabSignedDestination(location,expected){
  const unsigned=expected.url.replace('https://api.uspto.gov/api/v1/patent/','https://data.uspto.gov/');
  if(typeof location!=='string'||location.length>4096||!location.startsWith(unsigned+'?')||/[\s\\#]/.test(location))throw Error('Unrecognized PTAB signed download destination');
  const u=new URL(location);if(u.origin!=='https://data.uspto.gov'||u.pathname!==new URL(unsigned).pathname||u.username||u.password)throw Error('Unrecognized PTAB signed download destination');
  const seen=new Set();for(const part of u.search.slice(1).split('&')){const match=/^(Expires|Signature|Key-Pair-Id)=([A-Za-z0-9_~.%-]+)$/.exec(part);if(!match||seen.has(match[1])||match[1]==='Expires'&&!/^\d+$/.test(match[2]))throw Error('Invalid PTAB signed download parameters');seen.add(match[1]);}
  if(seen.size!==3)throw Error('Incomplete PTAB signed download parameters');return u;
}
function publicIPv4(value){
  if(typeof value!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(value))return false;
  const [a,b,c,d]=value.split('.').map(Number);if([a,b,c,d].some(n=>n>255))return false;
  return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
function pinnedLookup(lookupImpl=dns.lookup){return (hostname,options,callback)=>{
  if(!['api.uspto.gov','data-documents.uspto.gov','data.uspto.gov'].includes(hostname))return callback(Error('Unapproved provider host'));
  lookupImpl(hostname,{all:true,family:4},(error,addresses)=>{
    if(error||!addresses?.length||addresses.some(x=>x.family!==4||!publicIPv4(x.address)))return callback(Error('Provider DNS is not public IPv4'));
    const first=addresses[0];options?.all?callback(null,[first]):callback(null,first.address,4);
  });
};}
function receive(url,{headers,expected,maxBytes,signal,requestImpl,lookupImpl,allowRedirect}){
  return new Promise((resolve,reject)=>{
    let req,res,settled=false;const chunks=[];let bytes=0;
    const finish=(error,value)=>{if(settled)return;settled=true;res?.destroy();req?.destroy();error?reject(error):resolve(value);};
    try{
      req=requestImpl(url,{method:'GET',agent:false,headers,signal,lookup:pinnedLookup(lookupImpl),servername:url.hostname,maxHeaderSize:16384},response=>{
        res=response;res.on('error',()=>finish(Error('Provider body interrupted')));res.on('aborted',()=>finish(Error('Provider body interrupted')));
        if(allowRedirect&&[302,303,307,308].includes(res.statusCode)){
          try{return finish(null,{redirect:expected.operation==='ptab'?ptabSignedDestination(res.headers.location,expected):signedDestination(res.headers.location,expected)});}catch(error){return finish(error);}
        }
        if(res.statusCode!==200)return finish(Error('Provider original HTTP '+Number(res.statusCode||0)));
        const type=typeof res.headers['content-type']==='string'?res.headers['content-type'].split(';')[0].trim().toLowerCase():'';
        const wanted=expected.extension==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const accepted=type===wanted||expected.extension==='pdf'&&type==='binary/octet-stream';
        if(!accepted){const visible=/^[a-z0-9!#$&^_.+\/-]{1,100}$/.test(type)?type:'missing-or-invalid';return finish(Error(`Unexpected original MIME type (${visible}; HTTP ${Number(res.statusCode||0)})`));}
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')return finish(Error('Encoded original body is unsupported'));
        const length=res.headers['content-length'];
        if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes))return finish(Error('Original exceeds byte limit'));
        res.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>maxBytes)return finish(Error('Original exceeds byte limit'));chunks.push(Buffer.from(chunk));});
        res.on('end',()=>{
          if(settled)return;if(length!==undefined&&Number(length)!==bytes)return finish(Error('Original body length mismatch'));
          const data=Buffer.concat(chunks,bytes);const valid=expected.extension==='pdf'?data.subarray(0,5).toString('ascii')==='%PDF-':data.subarray(0,2).toString('ascii')==='PK';
          if(!valid)return finish(Error('Original signature mismatch'));finish(null,{data,contentType:wanted});
        });
      });
      req.on('error',()=>finish(Error('Provider request failed or timed out')));req.end();
    }catch{finish(Error('Provider request failed'));}
  });
}
async function boundedDownload(expected,{apiKey,maxBytes,timeoutMs,requestImpl=https.request,lookupImpl=dns.lookup}={}){
  const ptab=expected.operation==='ptab',byteLimit=ptab?MAX_BYTES:MAX_APPLICATION_BYTES,timeLimit=ptab?PTAB_TIMEOUT_MS:APPLICATION_TIMEOUT_MS;
  if(maxBytes===undefined)maxBytes=byteLimit;if(timeoutMs===undefined)timeoutMs=PTAB_TIMEOUT_MS;
  if(typeof apiKey!=='string'||!apiKey||apiKey.length>4096||/[\r\n]/.test(apiKey))throw Error('USPTO credential is unavailable');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<5||maxBytes>byteLimit||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>timeLimit)throw Error('Invalid download bounds');
  if(active>=MAX_ACTIVE)throw Error('Original downloader busy; resume later');
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const options={expected,maxBytes,signal:controller.signal,requestImpl,lookupImpl};
    let result=await receive(new URL(expected.url),{...options,headers:{'x-api-key':apiKey,Accept:expected.extension==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Accept-Encoding':'identity'},allowRedirect:true});
    if(result.redirect)result=await receive(result.redirect,{...options,headers:{Accept:expected.extension==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Accept-Encoding':'identity'},allowRedirect:false});
    const data=result.data;
    return {...expected,status:200,retrieved_at:new Date().toISOString(),contentType:result.contentType,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),base64:data.toString('base64')};
  }finally{clearTimeout(timer);active--;}
}
async function downloadOriginal(input,options={}){return boundedDownload(identity(input),options);}
async function downloadPtabOriginal(input,options={}){return boundedDownload(ptabIdentity(input),options);}
module.exports={downloadOriginal,downloadPtabOriginal,identity,ptabIdentity,signedDestination,ptabSignedDestination,pinnedLookup,publicIPv4,MAX_BYTES,MAX_APPLICATION_BYTES,APPLICATION_TIMEOUT_MS};
