// Self-contained: also runs in n8n's restricted JS runner, which has no URL global.
export function validateWorkflowSource(j,route){
  function isEpoCpc(s){return /^\/classification\/cpc\/[A-HY](?:[0-9]{2}(?:[A-Z](?:[0-9]{1,4}\/[0-9]{2,6})?)?)?$/.test(s);}
  function isGovinfoPdf(u){const m=/^https:\/\/api\.govinfo\.gov\/packages\/(USCOURTS-[a-z0-9]{2,8}-[A-Za-z0-9_.-]{1,80})\/granules\/(USCOURTS-[a-z0-9]{2,8}-[A-Za-z0-9_.-]{1,80}-\d{1,3})\/pdf$/.exec(u);return !!m&&m[2].startsWith(m[1]+'-')&&/^\d{1,3}$/.test(m[2].slice(m[1].length+1))&&!/\.\./.test(u);}
  const b=j.source?j:j.body||{};
  const urls=JSON.parse(j.sourceUrls),base=urls[b.source];
  if(typeof base!=='string')throw new Error('Source not configured');
  let url=b.url||base;
  const allowed=/^https:\/\/(?:www\.cafc\.uscourts\.gov|www\.uspto\.gov|api\.uspto\.gov|api\.govinfo\.gov|www\.courtlistener\.com|ops\.epo\.org)\//;
  if(typeof url!=='string'||!allowed.test(base)||!allowed.test(url)||/[\s\\#\u0000-\u001f\u007f]/.test(url))throw new Error('Unapproved source URL');
  const requestPath=url.split('?')[0];
  if(route==='epo'){
    const suffix=requestPath.slice(base.length);
    if(!requestPath.startsWith(base))throw new Error('EPO lookup does not match the configured source');
    if(isEpoCpc(suffix)){
      // CPC scheme for one class, subclass or group (OPS classification service); only ?depth=<all|0-9> is allowed.
      const q=url.slice(requestPath.length);
      if(q!==''&&!/^\?depth=(?:all|[0-9])$/.test(q))throw new Error('EPO CPC lookup allows only a depth parameter');
    }else{
      if(url!==requestPath)throw new Error('EPO lookup must not contain query parameters');
      if(!/^\/published-data\/publication\/epodoc\/[A-Z]{2}[0-9]{1,14}(?:\.?[A-Z][0-9]?)?\/biblio$/.test(suffix))throw new Error('Invalid EPO publication path');
    }
  }else if(route==='govinfo'&&isGovinfoPdf(url)){
    // One USCOURTS opinion PDF (granule) by id; the granule must belong to its package; no query string.
  }else if(route==='courtlistener'&&/^https:\/\/www\.courtlistener\.com\/api\/rest\/v4\/opinions\/[1-9][0-9]{0,9}\/$/.test(requestPath)){
    // One opinion's text by numeric id (bounded field list); validated below.
  }else if(requestPath!==base)throw new Error('Unapproved source path');
  if(route==='courtlistener'&&!j.internalUseAgreementConfirmed)throw new Error('Confirm internal-tool use agreement in Connection Settings');
  const method=(route==='govinfo'&&!isGovinfoPdf(url))||b.source==='odp'?'POST':'GET';
  if((b.method||'GET')!==method)throw new Error('Method not allowed');
  if(JSON.stringify(b).length>16000)throw new Error('Request too large');
  if(b.source==='odp'){
    const {q,pagination}=b.body||{};
    if(typeof q!=='string'||!q.trim()||q.length>2000||!Number.isSafeInteger(pagination?.offset)||pagination.offset<0||!Number.isSafeInteger(pagination?.limit)||pagination.limit<1||pagination.limit>100)throw new Error('Invalid USPTO query or pagination');
  }
  if(route==='govinfo'&&isGovinfoPdf(url)){
    if(b.body!==undefined&&!(b.body&&typeof b.body==='object'&&!Array.isArray(b.body)&&!Object.keys(b.body).length))throw new Error('GovInfo PDF request takes no body');
  }else if(route==='govinfo'){
    const body=b.body;
    if(!body||Array.isArray(body)||typeof body!=='object')throw new Error('Invalid GovInfo request body');
    const keys=Object.keys(body).sort().join(',');
    if(keys!=='offsetMark,pageSize,query,sorts')throw new Error('Unexpected GovInfo request fields');
    if(typeof body.query!=='string'||!body.query.startsWith('collection:USCOURTS ')||!body.query.slice(20).trim()||body.query.length>2020)throw new Error('GovInfo query must target USCOURTS');
    if(typeof body.pageSize!=='string'||!/^\d{1,3}$/.test(body.pageSize)||Number(body.pageSize)<1||Number(body.pageSize)>100)throw new Error('Invalid GovInfo page size');
    if(typeof body.offsetMark!=='string'||!body.offsetMark||body.offsetMark.length>2000||/[\u0000-\u001f\u007f]/.test(body.offsetMark))throw new Error('Invalid GovInfo offset mark');
    if(!Array.isArray(body.sorts)||body.sorts.length!==1||Object.keys(body.sorts[0]||{}).sort().join(',')!=='field,sortOrder'||body.sorts[0].field!=='score'||body.sorts[0].sortOrder!=='DESC')throw new Error('Invalid GovInfo sort');
  }
  if(route==='courtlistener'&&requestPath!==base){
    // Opinion fetch: only an optional fields= list from a fixed set; no other parameters.
    const FIELDS=['id','cluster','type','plain_text','html_with_citations','download_url','absolute_url','author_str','joined_by_str','per_curiam'];
    const q=url.slice(requestPath.length);
    if(q){
      const m=/^\?fields=([a-z_,]{1,200})$/.exec(q);
      if(!m||!m[1].split(',').every(x=>FIELDS.includes(x)))throw new Error('Invalid CourtListener opinion fields');
    }
    url=requestPath+q;
  }else if(route==='courtlistener'){
    const query=url.slice(base.length+1);
    if(!url.startsWith(base+'?')||!query)throw new Error('Invalid CourtListener query');
    const values={};
    for(const part of query.split('&')){
      const pair=part.split('=');
      if(pair.length!==2)throw new Error('Invalid CourtListener query');
      let key,value;try{key=decodeURIComponent(pair[0].replace(/\+/g,' '));value=decodeURIComponent(pair[1].replace(/\+/g,' '));}catch{throw new Error('Invalid CourtListener query encoding');}
      if(!['q','type','cursor'].includes(key)||Object.prototype.hasOwnProperty.call(values,key))throw new Error('Unexpected CourtListener query field');
      values[key]=value;
    }
    if(typeof values.q!=='string'||!values.q.trim()||values.q.length>2000||values.type!=='o'||(values.cursor!==undefined&&(!values.cursor||values.cursor.length>2000)))throw new Error('Invalid CourtListener search parameters');
    url=base+'?q='+encodeURIComponent(values.q)+'&type=o'+(values.cursor===undefined?'':'&cursor='+encodeURIComponent(values.cursor));
  }
  return {url,method,body:b.body||{}};
}
