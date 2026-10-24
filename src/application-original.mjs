// Application file-wrapper original retrieval rules. These three functions are embedded verbatim
// (Function.prototype.toString) into the live n8n workflow patent-research-application-pdf-core by
// scripts/build-live-application-pdf-core.mjs, so they must stay self-contained (no imports, no closures).
//
// Supported identities (observed provider behaviour, 2026-10-16):
//   {application_number, document_identifier}                         -> .../<app>/<doc>.pdf               (unchanged)
//   {..., native_filename:'<name>.docx'}                               -> .../<app>/<doc>/files/<name>      (unchanged)
//   {..., file_id, format:'pdf'|'docx'}                                -> .../<app>/<doc>/files/<fileId>.<format>
//   {..., format:'xmlarchive'}                                         -> .../<app>/<doc>/xmlarchive        (uncompressed TAR of ST.96 XML)
// The API answers with one redirect to the same path under https://data-documents.uspto.gov/redirect/download/ plus a signed query.

export function originalRequest(b){
 if(!/^\d{8}$/.test(b.application_number||'')||!/^[A-Za-z0-9_-]{1,100}$/.test(b.document_identifier||''))throw Error('Invalid public application/document identity');
 const prefix='https://api.uspto.gov/api/v1/download/applications/'+b.application_number+'/'+b.document_identifier;
 const given=k=>b[k]!==undefined&&b[k]!==null&&b[k]!=='';
 let url=prefix+'.pdf',extension='pdf',file_id=null;
 if(b.native_filename!==undefined){
  if(given('file_id')||given('format'))throw Error('Use native_filename or file_id/format, not both');
  if(typeof b.native_filename!=='string'||b.native_filename.length>250||!b.native_filename.endsWith('.docx')||/[\\/\u0000-\u001f]/.test(b.native_filename)||b.native_filename.includes('..'))throw Error('Invalid native document filename');
  url=prefix+'/files/'+encodeURIComponent(b.native_filename);extension='docx';
 }else if(given('format')||given('file_id')){
  if(b.format==='xmlarchive'){
   if(given('file_id'))throw Error('xmlarchive takes no file identifier');
   url=prefix+'/xmlarchive';extension='tar';
  }else if(b.format==='pdf'||b.format==='docx'){
   if(typeof b.file_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(b.file_id))throw Error('Invalid document file identifier');
   file_id=b.file_id;url=prefix+'/files/'+b.file_id+'.'+b.format;extension=b.format;
  }else throw Error('Unsupported document format');
 }
 return {application_number:b.application_number,document_identifier:b.document_identifier,file_id,url,extension};
}

export function signedDownload(r,i){
 if(![302,303,307,308].includes(r.statusCode))throw Error('USPTO authorization HTTP '+Number(r.statusCode||0));
 const u=r.headers?.location||r.headers?.Location;
 const expected=i.url.replace('https://api.uspto.gov/api/v1/download/','https://data-documents.uspto.gov/redirect/download/');
 if(typeof u!=='string'||!u.startsWith(expected+'?')||/[\s\\#]/.test(u)||u.length>4096||!/^[A-Za-z0-9_~.%=&+\-]+$/.test(u.slice(expected.length+1)))throw Error('Unexpected USPTO download destination or signing format');
 return {downloadUrl:u};
}

// Size and signature check of the downloaded bytes; returns the content type to report. A TAR is checked by its
// first header block checksum and 512-byte framing only: it is never extracted here (callers extract with bounds).
export function verifyOriginal(b,i){
 if(!b||typeof b.length!=='number'||b.length<5||b.length>10485760)throw Error('Original size or signature mismatch');
 if(i.extension==='pdf'){if(b.subarray(0,5).toString('ascii')!=='%PDF-')throw Error('Original size or signature mismatch');return 'application/pdf';}
 if(i.extension==='docx'){if(b.subarray(0,2).toString('ascii')!=='PK')throw Error('Original size or signature mismatch');return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';}
 if(i.extension==='tar'){
  if(b.length<1024||b.length%512!==0)throw Error('Original size or signature mismatch');
  const field=b.subarray(148,156).toString('ascii').replace(/[\u0000 ]+$/,'').trim();
  if(!/^[0-7]{1,8}$/.test(field))throw Error('Original size or signature mismatch');
  let sum=0;for(let k=0;k<512;k++)sum+=(k>=148&&k<156)?32:b[k];
  if(sum!==parseInt(field,8))throw Error('Original size or signature mismatch');
  return 'application/x-tar';
 }
 throw Error('Unsupported original extension');
}
