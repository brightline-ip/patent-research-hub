// GovInfo USCOURTS opinion PDFs on demand: one granule (opinion) PDF by package + granule id, through the existing
// 'govinfo' gateway route (PDF branch of patent-research-govinfo-core). Verified like PTAB originals: exact URL, PDF
// content type, size cap, canonical base64, %PDF- signature, SHA-256. Stage with originals.mjs stageOriginal().
import {createHash} from 'node:crypto';
import {callGateway as defaultCallGateway} from './gateway.mjs';
export const MAX_GOVINFO_PDF_BYTES=10*1024*1024;
const ID=/^USCOURTS-[a-z0-9]{2,8}-[A-Za-z0-9_.-]{1,80}$/;

export function govinfoPdfUrl(packageId,granuleId){
  if(!ID.test(packageId||'')||/\.\./.test(packageId))throw new Error('Invalid GovInfo USCOURTS package id');
  if(!new RegExp('^'+packageId.replace(/[.]/g,'\\.')+'-\\d{1,3}$').test(granuleId||''))throw new Error('Granule id must be <package id>-<n>');
  return 'https://api.govinfo.gov/packages/'+packageId+'/granules/'+granuleId+'/pdf';
}

export function decodeGovinfoPdf(envelope,expectedUrl){
  if(envelope?.status!==200)throw new Error(envelope?.error||'GovInfo PDF retrieval failed (HTTP '+Number(envelope?.status||0)+')');
  if(envelope.url!==expectedUrl||String(envelope.contentType).split(';')[0].trim().toLowerCase()!=='application/pdf')throw new Error('Unexpected GovInfo PDF response');
  const text=envelope.base64;
  if(typeof text!=='string'||!text.length||text.length>4*Math.ceil(MAX_GOVINFO_PDF_BYTES/3)||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw new Error('Invalid or oversized GovInfo PDF encoding');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length>MAX_GOVINFO_PDF_BYTES||bytes.length!==envelope.bytes||bytes.toString('base64')!==text||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('GovInfo PDF size or signature verification failed');
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function fetchGovinfoOpinionPdf(packageId,granuleId,{callGateway=defaultCallGateway,config}={}){
  const url=govinfoPdfUrl(packageId,granuleId);
  const envelope=await callGateway('govinfo',{source:'govinfo',url,method:'GET'},{...(config?{config}:{}),maxBytes:4*Math.ceil(MAX_GOVINFO_PDF_BYTES/3)+4096});
  return {url,packageId,granuleId,...decodeGovinfoPdf(envelope,url)};
}
