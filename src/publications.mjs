// Publication identity comes from the credential-owning ODP connector. PDFs
// use the explicitly authorized Google mirror through shared Get Files.
export function publicationIdentity(value, kind) {
  if(typeof value!=='string')throw Error('Publication identifier required');
  if(kind==='application'&&/^US(?:19|20)\d{9}A[129]$/.test(value))return value;
  if(kind==='grant'&&/^(?:\d{7,8}|D\d{6,7}|PP\d{5,6}|RE\d{5,6})$/.test(value))return 'US'+value;
  throw Error('Unsupported publication identifier; review without guessing a kind code');
}
export function parsePublicationInventory(applicationNumber,result){
  if(!/^\d{8}$/.test(applicationNumber)||!Array.isArray(result?.records)||result.records.length>1
    ||result.nextCursor!=null||result.providerTotal!==result.records.length||!/^[a-f0-9]{64}$/.test(result.snapshotId??''))throw Error('Incomplete exact application lookup');
  const documents=[],issues=[];
  if(!result.records.length)issues.push({row:0,status:'PUBLIC_RECORD_NOT_FOUND'});
  else{
    const data=result.records[0].metadata;
    if(data?.applicationNumberText!==applicationNumber||!data.applicationMetaData)throw Error('Publication application identity mismatch');
    const meta=data.applicationMetaData;
    for(const [field,kind] of [['earliestPublicationNumber','application'],['patentNumber','grant']]){
      if(meta[field]===undefined||meta[field]===null||meta[field]==='')continue;
      let id;try{id=publicationIdentity(meta[field],kind);}catch{issues.push({row:documents.length,status:'PUBLICATION_ID_UNSUPPORTED'});continue;}
      documents.push({application_number:applicationNumber,document_id:id,publication_kind:kind,category:'publication',
        description:id+' — Google Patents PDF mirror',status:'PUBLIC_DOWNLOAD_REQUIRED',source_url:'https://patents.google.com/patent/'+id+'/en'});
    }
    if(!documents.length&&!issues.length)issues.push({row:0,status:'NO_PUBLICATION_IDENTIFIERS_RETURNED'});
  }
  return {snapshot_id:result.snapshotId,documents,issues,scope:'ODP earliest US publication and recorded grant; not every republication or correction',mirror:'google-patents'};
}
export async function publicationInventory(applicationNumber,{client}={}){
  if(!/^\d{8}$/.test(applicationNumber)||typeof client?.query!=='function')throw Error('Shared exact-application query required');
  return parsePublicationInventory(applicationNumber,await client.query('odp','applicationNumberText:"'+applicationNumber+'"',{limit:2}));
}
export function validateMirrorDestination(url,requested,kind){
  let u;try{u=new URL(url);}catch{throw Error('Publication download destination missing');}
  if(u.origin!=='https://patentimages.storage.googleapis.com'||u.username||u.password||u.search||u.hash
    ||!/^\/(?:[a-f0-9]+\/){4}US[A-Z0-9]+\.pdf$/.test(u.pathname))throw Error('Unrecognized public PDF mirror destination');
  const actual=u.pathname.split('/').at(-1).slice(0,-4);
  const suffix=kind==='grant'?(requested.startsWith('USD')?'S[1]':requested.startsWith('USPP')?'P[23]':'[BE][12]'):'';
  // Some real grant PDFs use a bare US number; do not invent the omitted
  // kind code. The exact ODP grant number remains the identity boundary.
  if(kind==='application'?actual!==requested:actual!==requested&&!new RegExp('^'+requested+suffix+'$').test(actual))throw Error('Mirror PDF publication identity mismatch');
  return actual;
}
