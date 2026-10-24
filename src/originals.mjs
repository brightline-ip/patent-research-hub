import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const MAX_PTAB_PDF_BYTES=10*1024*1024;

// Also embedded in n8n: keep this independent of imports and browser globals.
export function validatePtabOriginal(input){
  const {trialNumber,appealNumber,documentIdentifier}=input||{};
  const appeal=/^(20\d{2})(\d{6})$/.exec(appealNumber||'');
  if(appeal){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(documentIdentifier||''))throw new Error('Invalid PTAB appeal document identifier');
    const url='https://api.uspto.gov/api/v1/patent/ptab-files/APP/'+appeal[1]+'/'+appeal[2]+'/'+documentIdentifier+'.pdf';
    return {appealNumber,documentIdentifier,url};
  }
  const trial=/^(IPR|PGR|CBM|DER)(20\d{2})-(\d{5})$/.exec(trialNumber||'');
  if(!trial||!/^\d{1,20}$/.test(documentIdentifier||''))throw new Error('Invalid PTAB trial or document identifier');
  const url='https://api.uspto.gov/api/v1/patent/ptab-files/'+trial[1]+'/'+trial[2]+'/'+trial[3]+'/'+documentIdentifier+'.pdf';
  return {trialNumber,documentIdentifier,url};
}

// Shared by the n8n Code node. Never return the signed URL outside the core workflow.
export function validatePtabDownload(response,identity){
  if(![302,303,307,308].includes(response?.statusCode))throw new Error('USPTO did not authorize a PTAB download (HTTP '+Number(response?.statusCode||0)+')');
  const location=response.headers?.location||response.headers?.Location;
  const expected=identity.url.replace('https://api.uspto.gov/api/v1/patent/','https://data.uspto.gov/');
  if(typeof location!=='string'||location.length>4096||!location.startsWith(expected+'?'))throw new Error('Unexpected USPTO download destination');
  const query=location.slice(expected.length+1),seen=new Set();
  for(const part of query.split('&')){
    const match=/^(Expires|Signature|Key-Pair-Id)=([A-Za-z0-9_~.%-]+)$/.exec(part);
    if(!match||seen.has(match[1]))throw new Error('Invalid USPTO signed download parameters');
    if(match[1]==='Expires'&&!/^\d+$/.test(match[2]))throw new Error('Invalid USPTO download expiry');
    seen.add(match[1]);
  }
  if(seen.size!==3)throw new Error('Incomplete USPTO signed download parameters');
  return {downloadUrl:location};
}

export function ptabOriginalRequest(record){
  if(!['ptab-trials','ptab-appeals'].includes(record.source))throw new Error('Record is not a PTAB decision');
  const request=validatePtabOriginal(record.source==='ptab-appeals'?{appealNumber:record.metadata?.appealNumber,documentIdentifier:record.metadata?.documentData?.documentIdentifier}:{trialNumber:record.metadata?.trialNumber,documentIdentifier:record.metadata?.documentData?.documentIdentifier});
  if(record.url!==request.url)throw new Error('PTAB original URL does not match its recorded proceeding/document identity');
  return request;
}

export function decodePtabOriginal(envelope,expectedUrl){
  if(envelope?.status!==200)throw new Error('PTAB original retrieval failed; check the source credential and document access');
  if(envelope.url!==expectedUrl||envelope.contentType?.split(';')[0].trim().toLowerCase()!=='application/pdf')throw new Error('Unexpected PTAB original response');
  const text=envelope.base64;
  if(typeof text!=='string'||text.length>4*Math.ceil(MAX_PTAB_PDF_BYTES/3)||!text.length||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw new Error('Invalid or oversized PTAB PDF encoding');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length>MAX_PTAB_PDF_BYTES||bytes.length!==envelope.bytes||bytes.toString('base64')!==text||bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('PTAB PDF size or signature verification failed');
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function stageOriginal(bytes,sha256,intakeRoot,extension='pdf'){
  if(!['pdf','docx','tar'].includes(extension))throw new Error('Unsupported original extension');
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Original integrity mismatch');
  const root=path.resolve(intakeRoot),directory=path.join(root,'patent-research');
  await fs.mkdir(root,{recursive:true});
  if(path.resolve(await fs.realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error('Corpus intake must not resolve through a junction');
  await fs.mkdir(directory,{recursive:true});
  if(path.resolve(await fs.realpath(directory)).toLowerCase()!==directory.toLowerCase())throw new Error('Research intake must not resolve through a junction');
  const target=path.join(directory,sha256+'.'+extension);
  try{await fs.writeFile(target,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(path.resolve(await fs.realpath(target)).toLowerCase()!==target.toLowerCase()||createHash('sha256').update(await fs.readFile(target)).digest('hex')!==sha256)throw new Error('Staged original conflicts with the verified PDF');
  return target;
}
