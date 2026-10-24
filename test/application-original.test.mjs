import test from 'node:test';
import assert from 'node:assert/strict';
import {originalRequest,signedDownload,verifyOriginal} from '../src/application-original.mjs';
import {buildLiveCore,CODE,IDENTITY_NODE} from '../extras/n8n/scripts/build-live-application-pdf-core.mjs';

const app='17000002',doc='4b072a25-efb9-4826-b6b4-de87347ccb29',file='13ec9510-5e9a-4119-8bf5-212a191c876e';
const base='https://api.uspto.gov/api/v1/download/applications/'+app+'/';
const signed=url=>({statusCode:302,headers:{location:url.replace('https://api.uspto.gov/api/v1/download/','https://data-documents.uspto.gov/redirect/download/')+'?X-Amz-Expires=300&X-Amz-Signature=abc123'}});

function tar(){ // one POSIX header block with a valid checksum, one data block, two end blocks
  const b=Buffer.alloc(2048);b.write('17000002/MRWFHHQS64X4X89/x.REM.XML',0,'ascii');b.write('0000644\0',100,'ascii');
  b.write('00000000005\0',124,'ascii');b.write('ustar\u000000',257,'ascii');b.write('        ',148,'ascii');
  let sum=0;for(let k=0;k<512;k++)sum+=b[k];b.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');b.write('<?xml',512,'ascii');return b;
}

test('old-form and native docx identities are unchanged', ()=>{
  assert.deepEqual(originalRequest({application_number:app,document_identifier:'MRWFHHQS64X4X89'}),{application_number:app,document_identifier:'MRWFHHQS64X4X89',file_id:null,url:base+'MRWFHHQS64X4X89.pdf',extension:'pdf'});
  const d=originalRequest({application_number:app,document_identifier:doc,native_filename:'a b.docx'});
  assert.equal(d.url,base+doc+'/files/a%20b.docx');assert.equal(d.extension,'docx');
  assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,native_filename:''}));
});

test('file-form pdf/docx and xmlarchive identities', ()=>{
  const p=originalRequest({application_number:app,document_identifier:doc,file_id:file,format:'pdf'});
  assert.equal(p.url,base+doc+'/files/'+file+'.pdf');assert.equal(p.extension,'pdf');assert.equal(p.file_id,file);
  assert.equal(originalRequest({application_number:app,document_identifier:doc,file_id:'2024_05_15_17_26_41_0864_ba24028e-00e8',format:'docx'}).extension,'docx');
  const x=originalRequest({application_number:app,document_identifier:'MPE21CH66X95X53',format:'xmlarchive'});
  assert.equal(x.url,base+'MPE21CH66X95X53/xmlarchive');assert.equal(x.extension,'tar');
});

test('file identifiers and formats are strictly bounded', ()=>{
  for(const file_id of ['../x','a/b','a.pdf','%2e','-lead','',' x','a'.repeat(121),'a\\b'])
    assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,file_id,format:'pdf'}),String(file_id));
  assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,file_id:file,format:'exe'}));
  assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,file_id:file}));
  assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,file_id:file,format:'xmlarchive'}));
  assert.throws(()=>originalRequest({application_number:app,document_identifier:doc,file_id:file,format:'pdf',native_filename:'a.docx'}));
  assert.throws(()=>originalRequest({application_number:'1866528',document_identifier:doc,format:'xmlarchive'}));
});

test('signed redirect must match the exact path of the requested form', ()=>{
  for(const i of [originalRequest({application_number:app,document_identifier:doc,file_id:file,format:'pdf'}),originalRequest({application_number:app,document_identifier:'MPE21CH66X95X53',format:'xmlarchive'})]){
    assert.ok(signedDownload(signed(i.url),i).downloadUrl.startsWith('https://data-documents.uspto.gov/redirect/download/'));
    const wrong=[i.url.replace(i.document_identifier,'OTHERDOC000001'),i.url.replace(app,'17000003'),i.url+'x'];
    if(i.file_id)wrong.push(i.url.replace(file,'00000000-0000-0000-0000-000000000000'));
    for(const u of wrong)assert.throws(()=>signedDownload(signed(u),i));
    const ok=signed(i.url).headers.location;
    for(const loc of [ok.replace('https://data-documents.uspto.gov','https://data-documents.uspto.gov.evil.example'),ok.replace('https:','http:'),ok+'#x',ok.replace('?','/../?'),ok+' ',ok.replace('?','%2F?')])
      assert.throws(()=>signedDownload({statusCode:302,headers:{location:loc}},i),loc);
    assert.throws(()=>signedDownload({statusCode:200,headers:{}},i));
  }
});

test('verifyOriginal checks size and real signatures', ()=>{
  const pdf={extension:'pdf'},docx={extension:'docx'},t={extension:'tar'};
  assert.equal(verifyOriginal(Buffer.from('%PDF-1.7 x'),pdf),'application/pdf');
  assert.throws(()=>verifyOriginal(Buffer.from('<html>x'),pdf));
  assert.equal(verifyOriginal(Buffer.from('PK\u0003\u0004xx'),docx),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(verifyOriginal(tar(),t),'application/x-tar');
  const bad=tar();bad[0]^=1;assert.throws(()=>verifyOriginal(bad,t));
  assert.throws(()=>verifyOriginal(tar().subarray(0,1500),t));
  assert.throws(()=>verifyOriginal(Buffer.from('%PDF-1.7 x'),t));
  assert.throws(()=>verifyOriginal(Buffer.alloc(10485761),pdf));
  assert.throws(()=>verifyOriginal(Buffer.from('%PDF-'),{extension:'exe'}));
});

test('live workflow build replaces only the three Code nodes and the embedded code runs', async ()=>{
  const live={id:'patent-research-application-pdf-core',name:'x',settings:{executionTimeout:270},connections:{a:1},nodes:[
    {name:'When Called by Another Workflow',type:'n8n-nodes-base.executeWorkflowTrigger',parameters:{}},
    {name:IDENTITY_NODE,type:'n8n-nodes-base.code',parameters:{jsCode:'old'}},
    {name:'Authorize',type:'n8n-nodes-base.httpRequest',parameters:{url:'={{ $json.url }}'},credentials:{httpHeaderAuth:{id:'c'}}},
    {name:'Validate USPTO signed download',type:'n8n-nodes-base.code',parameters:{jsCode:'old'}},
    {name:'Download',type:'n8n-nodes-base.httpRequest',parameters:{}},
    {name:'Package Verified Original',type:'n8n-nodes-base.code',parameters:{jsCode:'old'}}]};
  const out=buildLiveCore([live]);
  assert.deepEqual(out.nodes[2],live.nodes[2]);assert.deepEqual(out.connections,live.connections);
  // Run the generated Code-node bodies with minimal n8n stand-ins.
  const run=(code,ctx)=>new (Object.getPrototypeOf(async function(){}).constructor)('$input','$','helpers',code.replace('this.helpers','helpers'))(ctx.$input,ctx.$,ctx.helpers);
  const body={application_number:app,document_identifier:doc,file_id:file,format:'pdf'};
  const [{json:i}]=await run(out.nodes[1].parameters.jsCode,{$input:{first:()=>({json:{body}})}});
  assert.equal(i.url,base+doc+'/files/'+file+'.pdf');
  const [{json:d}]=await run(out.nodes[3].parameters.jsCode,{$input:{first:()=>({json:signed(i.url)})},$:()=>({first:()=>({json:i})})});
  assert.match(d.downloadUrl,/^https:\/\/data-documents\.uspto\.gov\/redirect\/download\//);
  const [{json:pkg}]=await run(out.nodes[5].parameters.jsCode,{$input:{first:()=>({json:{statusCode:200}})},$:()=>({first:()=>({json:i})}),helpers:{getBinaryDataBuffer:async()=>Buffer.from('%PDF-1.7 body')}});
  assert.equal(pkg.contentType,'application/pdf');assert.equal(pkg.file_id,file);assert.equal(pkg.bytes,13);
  assert.throws(()=>buildLiveCore([{...live,nodes:live.nodes.slice(0,2)}]));
  assert.ok(CODE[IDENTITY_NODE].includes('function originalRequest'));
});
