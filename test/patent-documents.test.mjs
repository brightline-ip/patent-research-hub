import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {intakeDir} from '../src/config.mjs';
import {buildPatentDocumentWorkflows} from '../extras/n8n/scripts/build-patent-document-workflows.mjs';
import {acquirePatentDocumentOriginal,decodePatentDocumentOriginal,parsePatentDocumentInventory,patentDocumentInventory,validatePatentDocumentDownload,validatePatentDocumentOriginal,validatePatentDocumentRequest} from '../src/patent-documents.mjs';

const identity={applicationNumber:'18123456',documentIdentifier:'ABC_123-x'};
const url='https://api.uspto.gov/api/v1/download/applications/18123456/ABC_123-x.pdf';

test('application inventory identity is fixed, bounded and independent of caller URLs',()=>{
  assert.equal(validatePatentDocumentRequest({applicationNumber:'18123456'}).url,'https://api.uspto.gov/api/v1/patent/applications/18123456/documents');
  assert.equal(validatePatentDocumentOriginal(identity).url,url);
  for(const bad of [{...identity,url:'https://evil.example/a.pdf'},{...identity,documentIdentifier:'../secret'},{...identity,applicationNumber:'18/123456'}])assert.throws(()=>validatePatentDocumentOriginal(bad));
  assert.throws(()=>validatePatentDocumentRequest({applicationNumber:'18123456',apiKey:'secret'}));
});

test('inventory retains only exact identity-matched unsigned PDF choices and visible issues',()=>{
  const result=parsePatentDocumentInventory({documentBag:[
    {applicationNumberText:'18123456',documentIdentifier:'A',documentCode:'DOC',directionCategory:'OUTGOING',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:'https://api.uspto.gov/api/v1/download/applications/18123456/A.pdf',pageTotalQuantity:2}]},
    {applicationNumberText:'18123456',documentIdentifier:'A',downloadOptionBag:[]},
    {applicationNumberText:'99999999',documentIdentifier:'B',downloadOptionBag:[]},
    {applicationNumberText:'18123456',documentIdentifier:'C',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:'https://evil.example/C.pdf'}]}
  ]},{applicationNumber:'18123456',maxDocuments:10});
  assert.equal(result.documents[0].status,'AUTHENTICATED_DOWNLOAD_REQUIRED');
  assert.equal(result.documents[0].page_count,2);
  assert.equal(result.documents[1].url,null);
  assert.equal(result.documents[1].status,'UNRECOGNIZED_DOWNLOAD_DESTINATION');
  assert.deepEqual(result.issues.map(x=>x.status),['DUPLICATE_DOCUMENT_ID','UNRESOLVED_IDENTITY']);
  assert.equal(result.all_files_obtained,false);
});

test('application-document redirect support accepts only the live-reviewed USPTO destination contract',()=>{
  assert.deepEqual(validatePatentDocumentDownload({statusCode:200},identity),{downloadUrl:url,authenticated:true});
  const signed='https://data-documents.uspto.gov/redirect/download/applications/18123456/ABC_123-x.pdf?token=fixture_123-~';
  assert.equal(validatePatentDocumentDownload({statusCode:302,headers:{location:signed}},identity).downloadUrl,signed);
  for(const bad of [signed.replace('data-documents.uspto.gov','data-documents.uspto.gov.evil.example'),signed.replace('ABC_123-x','OTHER'),signed+'#fragment',signed.replace('https:','http:')])assert.throws(()=>validatePatentDocumentDownload({statusCode:302,headers:{location:bad}},identity));
});

test('application PDF decoder binds exact identity, MIME, length, base64 and signature',()=>{
  const bytes=Buffer.from('%PDF-1.4\nFIXTURE\n%%EOF');
  const good={status:200,application_number:identity.applicationNumber,document_identifier:identity.documentIdentifier,extension:'pdf',url,contentType:'application/pdf',bytes:bytes.length,base64:bytes.toString('base64')};
  assert.equal(decodePatentDocumentOriginal(good,identity).bytes.toString(),bytes.toString());
  for(const bad of [{...good,document_identifier:'OTHER'},{...good,url:'https://evil.example/'},{...good,extension:'docx'},{...good,contentType:'text/html'},{...good,base64:'SGVsbG8='},{...good,bytes:999}])assert.throws(()=>decodePatentDocumentOriginal(bad,identity));
});

test('portable n8n application workflows match the active independently callable routes',()=>{
  const [core,gateway,originalCore,originalGateway]=buildPatentDocumentWorkflows();
  assert.equal(core.active,false);assert.equal(gateway.active,false);
  const request=core.nodes.find(n=>n.type.endsWith('.httpRequest'));
  assert.ok(request.credentials.httpHeaderAuth);assert.equal(request.parameters.options.redirect.redirect.followRedirects,false);
  const code=core.nodes.find(n=>n.name==='Validate Application').parameters.jsCode;
  assert.throws(()=>vm.runInNewContext('(function(){'+code+'})()',{$input:{first:()=>({json:{body:{application_number:'../secret'}}})}}));
  const result=vm.runInNewContext('(function(){'+code+'})()',{$input:{first:()=>({json:{body:{application_number:'18123456',url:'https://evil.example'}}})}});
  assert.deepEqual(JSON.parse(JSON.stringify(result[0].json)),{application_number:'18123456',url:'https://api.uspto.gov/api/v1/patent/applications/18123456/documents'});
  assert.equal(gateway.nodes.find(n=>n.type.endsWith('.executeWorkflow')).parameters.workflowId.value,core.id);
  assert.equal(originalCore.active,false);assert.equal(originalGateway.active,false);
  const originalRequest=originalCore.nodes.find(n=>n.type==='n8n-nodes-patent-research.usptoOriginal');assert.ok(originalRequest.credentials.httpHeaderAuth);assert.equal(originalRequest.parameters.maxBytes,41943040);assert.equal(originalRequest.parameters.timeoutMs,180000);
  assert.equal(originalCore.nodes.some(n=>n.type.endsWith('.httpRequest')),false);
  assert.equal(originalGateway.nodes.find(n=>n.type.endsWith('.executeWorkflow')).parameters.workflowId.value,originalCore.id);
});
test('application inventory calls the live gateway contract and persists only normalized public metadata',async()=>{
 let called,saved;const provider=[{applicationNumberText:'18123456',documentIdentifier:'A',documentCode:'DOC',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:'https://api.uspto.gov/api/v1/download/applications/18123456/A.pdf',pageTotalQuantity:2}]}];
 const result=await patentDocumentInventory({applicationNumber:'18123456',maxDocuments:5},{config:{transport:'n8n',patentDocumentsEnabled:true},store:{saveQueryCache:(kind,key,value)=>saved={kind,key,value}},gateway:async(route,body)=>{called={route,body};return {application_number:'18123456',source_url:'https://api.uspto.gov/api/v1/patent/applications/18123456/documents',retrieved_at:'2026-09-07T14:00:00.000Z',status:200,body:provider};}});
 assert.deepEqual(called,{route:'application-documents',body:{application_number:'18123456'}});assert.equal(result.documents[0].status,'AUTHENTICATED_DOWNLOAD_REQUIRED');assert.equal(result.retrieved_at,'2026-09-07T14:00:00.000Z');assert.equal(saved.kind,'patent-document-inventory');assert.equal(saved.value.documents[0].url,'https://api.uspto.gov/api/v1/download/applications/18123456/A.pdf');
});
test('original acquisition is gated and stages only an identity-bound verified PDF',async()=>{
  const bytes=Buffer.from('%PDF-1.4\nACQUIRE FIXTURE\n%%EOF'),envelope={status:200,application_number:identity.applicationNumber,document_identifier:identity.documentIdentifier,extension:'pdf',url,contentType:'application/pdf',bytes:bytes.length,base64:bytes.toString('base64')};let staged;
  await assert.rejects(acquirePatentDocumentOriginal(identity,{config:{transport:'n8n',patentDocumentOriginalsEnabled:false}}),/not enabled/);
  const result=await acquirePatentDocumentOriginal(identity,{config:{transport:'n8n',patentDocumentOriginalsEnabled:true,corpusIntakeRoot:'fixture'},gateway:async(route,body)=>{assert.equal(route,'application-pdf');assert.deepEqual(body,{application_number:'18123456',document_identifier:'ABC_123-x'});return envelope;},stage:async(b,sha,root)=>(staged={b,sha,root},'C:/fixture/'+sha+'.pdf')});
  assert.equal(result.status,'ORIGINAL_VERIFIED');assert.equal(result.normalization_status,'NOT_SUBMITTED');assert.deepEqual(staged.b,bytes);assert.equal(staged.root,intakeDir({corpusIntakeRoot:'fixture'}));assert.ok(path.isAbsolute(staged.root),'staging folder must not resolve against the working directory');
});
test('inventory classifies file-form, mixed, xml and unknown options deterministically',()=>{
  const A='https://api.uspto.gov/api/v1/download/applications/18123456/';
  const r=parsePatentDocumentInventory({documentBag:[
    {applicationNumberText:'18123456',documentIdentifier:'F1',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:A+'F1/files/abc-123_X.pdf'}]},
    {applicationNumberText:'18123456',documentIdentifier:'M1',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:A+'M1.pdf',pageTotalQuantity:3},{mimeTypeIdentifier:'PDF',downloadUrl:A+'M1/files/zz.pdf'},{mimeTypeIdentifier:'XML',downloadUrl:A+'M1/xmlarchive'}]},
    {applicationNumberText:'18123456',documentIdentifier:'U1',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:A+'U1/files/ok.pdf'},{mimeTypeIdentifier:'PDF',downloadUrl:'https://evil.example/U1.pdf'}]},
    {applicationNumberText:'18123456',documentIdentifier:'D1',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:A+'D1/files/a.pdf'},{mimeTypeIdentifier:'PDF',downloadUrl:A+'D1/files/b.pdf'}]},
    {applicationNumberText:'18123456',documentIdentifier:'B1',downloadOptionBag:[{mimeTypeIdentifier:'PDF',downloadUrl:A+'B1/files/../x.pdf'}]},
    {applicationNumberText:'18123456',documentIdentifier:'X1',downloadOptionBag:[{mimeTypeIdentifier:'XML',downloadUrl:A+'X1/xmlarchive'},{mimeTypeIdentifier:'XML',downloadUrl:A+'OTHER/xmlarchive'}]}
  ]},{applicationNumber:'18123456',maxDocuments:10});
  const by=Object.fromEntries(r.documents.map(d=>[d.document_id,d]));
  assert.deepEqual([by.F1.status,by.F1.file_id,by.F1.url],['AUTHENTICATED_FILE_DOWNLOAD_REQUIRED','abc-123_X',A+'F1/files/abc-123_X.pdf']);
  assert.deepEqual([by.M1.status,by.M1.file_id,by.M1.url,by.M1.page_count,by.M1.xml_available],['AUTHENTICATED_DOWNLOAD_REQUIRED',null,A+'M1.pdf',3,true]);
  assert.deepEqual([by.U1.status,by.U1.url],['UNRECOGNIZED_DOWNLOAD_DESTINATION',null]);
  assert.equal(by.D1.status,'AMBIGUOUS_PDF_OPTIONS');assert.equal(by.B1.status,'UNRECOGNIZED_DOWNLOAD_DESTINATION');
  assert.equal(by.X1.status,'NO_SUPPORTED_PDF');assert.equal(by.X1.xml_available,true);assert.equal(by.F1.xml_available,false);
});
test('file-form and xmlarchive acquisition send selected keys and stage by extension',async()=>{
  const A='https://api.uspto.gov/api/v1/download/applications/18123456/';
  const pdf=Buffer.from('%PDF-1.7 FILE FORM'),cfg={transport:'n8n',patentDocumentOriginalsEnabled:true,corpusIntakeRoot:'fixture'};let body,ext;
  const env={status:200,application_number:'18123456',document_identifier:'F1',file_id:'abc-123_X',extension:'pdf',url:A+'F1/files/abc-123_X.pdf',contentType:'application/pdf',bytes:pdf.length,base64:pdf.toString('base64')};
  const r=await acquirePatentDocumentOriginal({applicationNumber:'18123456',documentIdentifier:'F1',fileId:'abc-123_X',format:'pdf'},{config:cfg,gateway:async(route,b)=>(body=b,env),stage:async(b,sha,root,e)=>(ext=e,'C:/f/'+sha+'.'+e)});
  assert.deepEqual(body,{application_number:'18123456',document_identifier:'F1',file_id:'abc-123_X',format:'pdf'});assert.equal(ext,'pdf');assert.equal(r.file_id,'abc-123_X');
  await assert.rejects(acquirePatentDocumentOriginal({applicationNumber:'18123456',documentIdentifier:'F1',fileId:'abc-123_X',format:'pdf'},{config:cfg,gateway:async()=>({...env,file_id:'other'}),stage:async()=>'x'}));
  const t=Buffer.alloc(1024);t.write('a/b/c.xml',0);t.write('        ',148);let s=0;for(let k=0;k<512;k++)s+=t[k];t.write(s.toString(8).padStart(6,'0')+'\0 ',148);
  const tenv={status:200,application_number:'18123456',document_identifier:'X1',file_id:null,extension:'tar',url:A+'X1/xmlarchive',contentType:'application/x-tar',bytes:t.length,base64:t.toString('base64')};
  await acquirePatentDocumentOriginal({applicationNumber:'18123456',documentIdentifier:'X1',format:'xmlarchive'},{config:cfg,gateway:async(route,b)=>(body=b,tenv),stage:async(b,sha,root,e)=>(ext=e,'x')});
  assert.deepEqual(body,{application_number:'18123456',document_identifier:'X1',format:'xmlarchive'});assert.equal(ext,'tar');
  assert.throws(()=>decodePatentDocumentOriginal({...tenv,contentType:'application/pdf'},{applicationNumber:'18123456',documentIdentifier:'X1',format:'xmlarchive'}));
  assert.throws(()=>validatePatentDocumentOriginal({applicationNumber:'18123456',documentIdentifier:'F1',fileId:'../x',format:'pdf'}));
});
test('inventory records a single native Word original as docx_file_id',()=>{
  const A='https://api.uspto.gov/api/v1/download/applications/18123456/';
  const r=parsePatentDocumentInventory({documentBag:[
    {applicationNumberText:'18123456',documentIdentifier:'T1',downloadOptionBag:[{mimeTypeIdentifier:'MS_WORD',downloadUrl:A+'T1/files/2024_05_15_17_26_41_0864_ba24028e-00e8.docx'},{mimeTypeIdentifier:'PDF',downloadUrl:A+'T1/files/c1c8.pdf'}]},
    {applicationNumberText:'18123456',documentIdentifier:'T2',downloadOptionBag:[{mimeTypeIdentifier:'MS_WORD',downloadUrl:'https://evil.example/T2.docx'}]},
    {applicationNumberText:'18123456',documentIdentifier:'T3',downloadOptionBag:[{mimeTypeIdentifier:'MS_WORD',downloadUrl:A+'T3/files/a.b.docx'}]}
  ]},{applicationNumber:'18123456',maxDocuments:10});
  const by=Object.fromEntries(r.documents.map(d=>[d.document_id,d]));
  assert.equal(by.T1.docx_file_id,'2024_05_15_17_26_41_0864_ba24028e-00e8');assert.equal(by.T1.status,'AUTHENTICATED_FILE_DOWNLOAD_REQUIRED');
  assert.equal(by.T2.docx_file_id,null);assert.equal(by.T3.docx_file_id,null);
});
