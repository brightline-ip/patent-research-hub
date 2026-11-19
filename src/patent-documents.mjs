import {createHash} from 'node:crypto';
import {callGateway,readConfig} from './gateway.mjs';
import {stageOriginal} from './originals.mjs';
import {intakeDir} from './config.mjs';
import {originalRequest,verifyOriginal} from './application-original.mjs';
export const MAX_PATENT_DOCUMENT_BYTES=40*1024*1024;  // raised from 10 MB 2026-11-04: reexam requests and affidavits exceed 10 MB

const inventoryUrl=applicationNumber=>'https://api.uspto.gov/api/v1/patent/applications/'+applicationNumber+'/documents';
const originalUrl=(applicationNumber,documentIdentifier)=>'https://api.uspto.gov/api/v1/download/applications/'+applicationNumber+'/'+documentIdentifier+'.pdf';

// Callers supply an identity, never a URL or key. The live original route embeds src/application-original.mjs.
export function validatePatentDocumentRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['applicationNumber','maxDocuments'].includes(k)))throw new Error('Supply a public application number and optional document cap only');
  const applicationNumber=input.applicationNumber,maxDocuments=input.maxDocuments??2000;
  if(typeof applicationNumber!=='string'||!/^\d{8}$/.test(applicationNumber))throw new Error('Use an eight-digit US application number');
  if(!Number.isSafeInteger(maxDocuments)||maxDocuments<1||maxDocuments>20000)throw new Error('Document cap must be 1 to 20000');
  return {applicationNumber,maxDocuments,url:inventoryUrl(applicationNumber)};
}

// The provider response is untrusted. Retain only bounded public metadata and
// exact unsigned identity-matched PDF links; never persist signed URLs or headers.
export function parsePatentDocumentInventory(input,identity){
  const request=validatePatentDocumentRequest({applicationNumber:identity.applicationNumber,maxDocuments:identity.maxDocuments});
  const rows=Array.isArray(input)?input:input?.documentBag;
  if(!Array.isArray(rows)||rows.length>20000)throw new Error('USPTO document inventory schema or size is unsupported');
  const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v)?v:null;
  const documents=[],issues=[],seen=new Set();
  let duplicateRows=0;
  for(let index=0;index<rows.length;index++){
    const row=rows[index];
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid USPTO inventory entry');
    const id=text(row.documentIdentifier,100);
    if(!id||!/^[A-Za-z0-9_-]+$/.test(id)||row.applicationNumberText!==request.applicationNumber){
      issues.push({row:index,status:'UNRESOLVED_IDENTITY'});continue;
    }
    if(seen.has(id)){duplicateRows++;issues.push({row:index,status:'DUPLICATE_DOCUMENT_ID'});continue;}
    seen.add(id);
    const url=originalUrl(request.applicationNumber,id);
    const options=row.downloadOptionBag;
    if(options!==undefined&&(!Array.isArray(options)||options.length>30))throw new Error('Invalid download-option inventory');
    const pdf=(options||[]).filter(o=>o&&['PDF','application/pdf'].includes(o.mimeTypeIdentifier));
    const matching=pdf.filter(o=>o.downloadUrl===url);
    // Newer e-filed documents publish their PDF as .../<app>/<doc>/files/<fileId>.pdf (live-verified 2026-10-16).
    const filePrefix=url.slice(0,-'.pdf'.length)+'/files/';
    const fileForm=pdf.filter(o=>typeof o.downloadUrl==='string'&&o.downloadUrl.startsWith(filePrefix)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.pdf$/.test(o.downloadUrl.slice(filePrefix.length)));
    const unknown=pdf.filter(o=>o.downloadUrl!==url&&!fileForm.includes(o));
    const xmlAvailable=(options||[]).some(o=>o&&o.mimeTypeIdentifier==='XML'&&o.downloadUrl===url.slice(0,-'.pdf'.length)+'/xmlarchive');
    // Native Word original (e.g. APP.TEXT): retrievable with {fileId: docx_file_id, format:'docx'}.
    const docx=(options||[]).filter(o=>o&&o.mimeTypeIdentifier==='MS_WORD'&&typeof o.downloadUrl==='string'&&o.downloadUrl.startsWith(filePrefix)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.docx$/.test(o.downloadUrl.slice(filePrefix.length)));
    const docxFileId=docx.length===1?docx[0].downloadUrl.slice(filePrefix.length,-'.docx'.length):null;
    let status='NO_SUPPORTED_PDF',chosen=null,fileId=null;
    if(unknown.length)status='UNRECOGNIZED_DOWNLOAD_DESTINATION';
    else if(matching.length===1){status='AUTHENTICATED_DOWNLOAD_REQUIRED';chosen=matching[0];} // the document form wins when both exist
    else if(matching.length>1||fileForm.length>1)status='AMBIGUOUS_PDF_OPTIONS';
    else if(fileForm.length===1){status='AUTHENTICATED_FILE_DOWNLOAD_REQUIRED';chosen=fileForm[0];fileId=chosen.downloadUrl.slice(filePrefix.length,-'.pdf'.length);}
    const pages=chosen?.pageTotalQuantity;
    documents.push({application_number:request.applicationNumber,document_id:id,
      document_code:text(row.documentCode,80),description:text(row.documentCodeDescriptionText,500),
      official_date:text(row.officialDate,80),direction:text(row.directionCategory??row.documentDirectionCategory,40),
      page_count:Number.isSafeInteger(pages)&&pages>=0?pages:null,
      url:chosen?chosen.downloadUrl:null,file_id:fileId,xml_available:xmlAvailable,docx_file_id:docxFileId,status,
      original_acquired:false,normalization_status:'NOT_SUBMITTED'});
  }
  const retained=documents.slice(0,request.maxDocuments);
  const limited=documents.length>retained.length;
  return {version:1,application_number:request.applicationNumber,source_url:request.url,
    status:limited?'PAUSED_DOCUMENT_LIMIT':issues.length||documents.some(d=>!['AUTHENTICATED_DOWNLOAD_REQUIRED','AUTHENTICATED_FILE_DOWNLOAD_REQUIRED'].includes(d.status))?'REVIEW_INVENTORY':'INVENTORY_READY',
    provider_rows:rows.length,unique_documents:documents.length,duplicate_rows:duplicateRows,
    returned_documents:retained.length,omitted_by_cap:documents.length-retained.length,documents:retained,issues,
    next_document_offset:limited?retained.length:null,provider_population_complete:false,
    ownership_verified:false,all_files_obtained:false,
    warnings:['Public file-wrapper inventory only; no originals have been downloaded or normalized.',
      'Do not send authenticated or signed USPTO links to anonymous Get Files.',
      'Associated publication/grant ZIP metadata is not an individual publication PDF.',
      'No family expansion, unpublished/restricted record access, or ownership determination is implied.']};
}

// Application documents use a provider route distinct from PTAB. Callers
// provide an exact public identity, never a provider or signed URL.
// Optional fileId+format ('pdf'|'docx') selects a file-form original (inventory status
// AUTHENTICATED_FILE_DOWNLOAD_REQUIRED); format 'xmlarchive' selects the XML TAR. Rules: src/application-original.mjs.
export function validatePatentDocumentOriginal(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['applicationNumber','documentIdentifier','fileId','format'].includes(k)))throw new Error('Supply an application and document identity only');
  const {applicationNumber,documentIdentifier,fileId,format}=input;
  if(typeof applicationNumber!=='string'||!/^\d{8}$/.test(applicationNumber))throw new Error('Use an eight-digit US application number');
  if(typeof documentIdentifier!=='string'||documentIdentifier.length>100||!/^[A-Za-z0-9_-]+$/.test(documentIdentifier))throw new Error('Invalid application document identifier');
  const r=originalRequest({application_number:applicationNumber,document_identifier:documentIdentifier,file_id:fileId,format});
  return {applicationNumber,documentIdentifier,fileId:r.file_id,format:format??null,extension:r.extension,url:r.url};
}

export function validatePatentDocumentDownload(response,identity){
  const expected=validatePatentDocumentOriginal(identity);
  if(response?.statusCode===200)return {downloadUrl:expected.url,authenticated:true};
  if(![302,303,307,308].includes(response?.statusCode))throw new Error('USPTO did not authorize the application document (HTTP '+Number(response?.statusCode||0)+')');
  const location=response.headers?.location||response.headers?.Location;
  const expectedPath=new URL(expected.url).pathname.replace('/api/v1/download/','/redirect/download/');
  let parsed;try{parsed=new URL(location);}catch{throw new Error('Invalid USPTO application-document redirect');}
  const query=parsed.search.slice(1);
  if(parsed.protocol!=='https:'||parsed.hostname!=='data-documents.uspto.gov'||parsed.port||parsed.username||parsed.password||parsed.hash||parsed.pathname!==expectedPath||!query||query.length>4096||!/^[A-Za-z0-9_~.%=&+\-]+$/.test(query))throw new Error('Unexpected USPTO application-document destination or signing format');
  return {downloadUrl:location,authenticated:false};
}

export function decodePatentDocumentOriginal(envelope,identity){
  const pick=Object.fromEntries(['applicationNumber','documentIdentifier','fileId','format'].filter(k=>identity?.[k]!==undefined&&identity[k]!==null).map(k=>[k,identity[k]]));
  const expected=validatePatentDocumentOriginal(pick);
  if(envelope?.status!==200||envelope.application_number!==expected.applicationNumber||envelope.document_identifier!==expected.documentIdentifier||envelope.extension!==expected.extension||envelope.url!==expected.url||(expected.fileId&&envelope.file_id!==expected.fileId))throw new Error('Application-document retrieval failed or identity changed');
  const types={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',tar:'application/x-tar'};
  if(envelope.contentType?.split(';')[0].trim().toLowerCase()!==types[expected.extension])throw new Error('Application document has an unexpected content type');
  const text=envelope.base64;
  if(typeof text!=='string'||!text.length||text.length%4||text.length>4*Math.ceil(MAX_PATENT_DOCUMENT_BYTES/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw new Error('Invalid or oversized application-document encoding');
  const bytes=Buffer.from(text,'base64');
  if(bytes.length<5||bytes.length>MAX_PATENT_DOCUMENT_BYTES||bytes.length!==envelope.bytes||bytes.toString('base64')!==text)throw new Error('Application-document size or signature verification failed');
  try{verifyOriginal(bytes,{extension:expected.extension});}catch{throw new Error('Application-document size or signature verification failed');}
  return {bytes,sha256:createHash('sha256').update(bytes).digest('hex'),identity:expected};
}

export async function patentDocumentInventory(input,{config=readConfig(),store,gateway=callGateway}={}){
  const identity=validatePatentDocumentRequest(input);
  if(config.patentDocumentsEnabled===false)throw new Error('Patent document inventory connector is not enabled (patentDocumentsEnabled)');
  const envelope=await gateway('application-documents',{application_number:identity.applicationNumber},{config,maxBytes:8*1024*1024});
  if(envelope?.application_number!==identity.applicationNumber||envelope.source_url!==identity.url||envelope.status!==200)throw new Error('Unrecognized or failed USPTO inventory response');
  const raw=envelope.body;
  let serialized;try{serialized=JSON.stringify(raw);}catch{throw new Error('USPTO inventory response is not serializable JSON');}
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>8*1024*1024)throw new Error('USPTO inventory response is oversized');
  const result=parsePatentDocumentInventory(raw,identity);
  const response_sha256=createHash('sha256').update(serialized).digest('hex');
  const snapshot_id=createHash('sha256').update(JSON.stringify({identity,response_sha256})).digest('hex');
  const snapshot={...result,snapshot_id,response_sha256,retrieved_at:envelope.retrieved_at||new Date().toISOString()};
  if(store)store.saveQueryCache('patent-document-inventory',snapshot_id,snapshot);
  return snapshot;
}

export async function acquirePatentDocumentOriginal(input,{config=readConfig(),gateway=callGateway,stage=stageOriginal}={}){
  const identity=validatePatentDocumentOriginal(input);
  if(config.patentDocumentOriginalsEnabled===false)throw new Error('Application-document original connector is not enabled (patentDocumentOriginalsEnabled)');
  // Identity-only requests keep their exact historical body; file/format keys are sent only when selected.
  const body={application_number:identity.applicationNumber,document_identifier:identity.documentIdentifier,...(identity.fileId?{file_id:identity.fileId}:{}),...(identity.format?{format:identity.format}:{})};
  const envelope=await gateway('application-pdf',body,{config,maxBytes:Math.ceil(MAX_PATENT_DOCUMENT_BYTES*4/3)+8192});
  const decoded=decodePatentDocumentOriginal(envelope,identity);
  const file=await stage(decoded.bytes,decoded.sha256,intakeDir(config),identity.extension);
  return {version:1,status:'ORIGINAL_VERIFIED',application_number:identity.applicationNumber,document_id:identity.documentIdentifier,
    file_id:identity.fileId,format:identity.format,extension:identity.extension,
    source_url:identity.url,sha256:decoded.sha256,bytes:decoded.bytes.length,staged_path:file,
    normalization_status:'NOT_SUBMITTED',all_files_obtained:false,
    warnings:['This hash-verified public original is staged but has not been normalized or indexed.','The caller must submit it to the appropriate public corpus collection and retain its job receipt.']};
}
