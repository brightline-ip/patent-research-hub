import {parse,parseFragment} from 'parse5';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {createHash} from 'node:crypto';
export const hash=s=>createHash('sha256').update(s).digest('hex');
export const arr=x=>x===undefined||x===null?[]:Array.isArray(x)?x:[x];
const attr=(n,key)=>n.attrs?.find(a=>a.name===key)?.value;
function walk(n,fn){fn(n);for(const c of n.childNodes||[])walk(c,fn);}
export function plain(n){if(typeof n==='string')return plain(parseFragment(n));if(['script','style','nav','footer','header'].includes(n.tagName))return '';if(n.nodeName==='#text')return n.value;return (n.childNodes||[]).map(plain).join(' ').replace(/\s+/g,' ').trim();}
export function links(html,base){const root=parse(html);let main;walk(root,n=>{if(!main&&(n.tagName==='main'||attr(n,'id')==='main-content'))main=n;});const out=[];walk(main||root,n=>{if(n.tagName!=='a')return;const href=attr(n,'href');if(!href)return;try{const u=new URL(href,base);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return;u.hash='';const label=plain(n);if(!label)return;out.push({url:u.href,title:label,context:plain(n.parentNode).slice(0,2400)});}catch{}});return [...new Map(out.map(x=>[x.url,x])).values()];}
export function record(source,item){return {id:hash(source+'\n'+item.url).slice(0,24),source,title:item.title||item.url,url:item.url,date:item.date||null,dateBasis:item.dateBasis||null,type:item.type||'source-link',precedentialStatus:item.precedentialStatus||'not-verified',excerpt:item.excerpt||'',metadata:item.metadata||{},retrievedAt:new Date().toISOString(),fullText:false};}
export function parseCafc(xml){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Invalid or unsupported feed XML');
  const data=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml);
  if(!data.rss?.channel)throw new Error('Court feed schema changed');
  return arr(data.rss.channel.item).map(item=>{const title=plain(String(item.title||''));const html=String(item['content:encoded']||item.description||'');const pdf=links(html,'https://www.cafc.uscourts.gov').find(x=>new URL(x.url).pathname.endsWith('.pdf'));const d=new Date(item.pubDate);return record('cafc',{url:pdf?.url||String(item.link),title,date:Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10),dateBasis:'feed-posted',type:/\[OPINION\]/i.test(title)?'opinion':/\[ORDER\]/i.test(title)?'order':'court-disposition',precedentialStatus:/\bNonprecedential\b/i.test(title)?'nonprecedential':/\bPrecedential\b/i.test(title)?'precedential':'not-verified',excerpt:plain(html),metadata:{landingUrl:String(item.link),appealNumber:title.match(/^([\d-]+):/)?.[1]||null,origin:plain(html).match(/Origin:\s*(\w+)/)?.[1]||null}});});
}

export function normalizeEpodocPublication(value){
  if(typeof value!=='string')throw new Error('EPO publication identifier must be a string');
  const compact=value.trim().toUpperCase(),match=compact.match(/^([A-Z]{2})([0-9]{1,14})(?:\.?([A-Z][0-9]?))?$/);
  if(!match)throw new Error('Supply one epodoc publication identifier, for example EP1000000 or EP1000000.A1');
  const [,country,docNumber,kind='']=match;
  return {country,docNumber,kind,normalized:country+docNumber+kind,path:country+docNumber+(kind?'.'+kind:'')};
}

const localKey=(object,name)=>Object.keys(object||{}).find(key=>!key.startsWith('@_')&&key.split(':').at(-1)===name);
const child=(object,name)=>object?.[localKey(object,name)];
function xmlText(value){
  if(value===undefined||value===null)return '';
  if(['string','number','boolean'].includes(typeof value))return String(value).replace(/\s+/g,' ').trim();
  if(Array.isArray(value))return value.map(xmlText).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  if(typeof value==='object')return Object.entries(value).filter(([key])=>!key.startsWith('@_')).map(([,item])=>xmlText(item)).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  return '';
}
function collectLocal(value,name,out=[]){
  if(Array.isArray(value)){for(const item of value)collectLocal(item,name,out);return out;}
  if(!value||typeof value!=='object')return out;
  for(const [key,item] of Object.entries(value)){
    if(key.startsWith('@_'))continue;
    if(key.split(':').at(-1)===name)out.push(...arr(item));
    else collectLocal(item,name,out);
  }
  return out;
}
const cleanUnique=values=>[...new Set(values.map(xmlText).filter(Boolean))];
const ymd=value=>/^\d{8}$/.test(value||'')?`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`:null;

export function parseEpoBiblio(xml,requestedPublication){
  const requested=normalizeEpodocPublication(requestedPublication);
  if(typeof xml!=='string'||!xml.trim()||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Invalid or unsupported EPO XML');
  const data=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false,processEntities:false,trimValues:true}).parse(xml);
  const root=child(data,'world-patent-data');
  if(!root)throw new Error('EPO response schema changed: world-patent-data is missing');
  const exchangeDocuments=collectLocal(root,'exchange-document');
  if(!exchangeDocuments.length)throw new Error('EPO response contains no bibliographic documents');
  const documents=exchangeDocuments.map(document=>{
    const bibliographic=child(document,'bibliographic-data');
    if(!bibliographic)return null;
    const reference=child(bibliographic,'publication-reference');
    const ids=arr(child(reference,'document-id'));
    const docdb=ids.find(item=>item?.['@_document-id-type']==='docdb')||{};
    const country=xmlText(child(docdb,'country'))||String(document['@_country']||'');
    const docNumber=xmlText(child(docdb,'doc-number'))||String(document['@_doc-number']||'');
    const kind=xmlText(child(docdb,'kind'))||String(document['@_kind']||'');
    const date=ymd(xmlText(child(docdb,'date'))||xmlText(child(ids.find(item=>item?.['@_document-id-type']==='epodoc')||{},'date')));
    if(!/^[A-Z]{2}$/.test(country)||!docNumber||!kind)return null;
    const titles=arr(child(bibliographic,'invention-title'));
    const preferredTitle=titles.find(item=>item?.['@_lang']==='en')||titles[0];
    const parties=child(bibliographic,'parties')||{};
    const applicants=arr(child(child(parties,'applicants')||{},'applicant'));
    const inventors=arr(child(child(parties,'inventors')||{},'inventor'));
    const names=items=>cleanUnique(items.map(item=>child(child(item,'applicant-name')||child(item,'inventor-name')||{},'name')));
    const abstracts=arr(child(document,'abstract'));
    const preferredAbstract=abstracts.find(item=>item?.['@_lang']==='en')||abstracts[0];
    return {publication:country+docNumber+kind,country,docNumber,kind,date,familyId:String(document['@_family-id']||'')||null,title:xmlText(preferredTitle)||null,applicants:names(applicants),inventors:names(inventors),abstract:xmlText(preferredAbstract)||null};
  }).filter(Boolean);
  const matches=documents.filter(document=>document.country===requested.country&&document.docNumber===requested.docNumber&&(!requested.kind||document.kind===requested.kind));
  if(!matches.length)throw new Error('EPO response identity does not match the requested publication');
  return {requested:requested.normalized,documents:matches};
}
export function parseSourceLinks(source,html){
  const found=links(html,source.url).filter(l=>{
    const u=new URL(l.url);if(source.id==='gazette')return u.hostname==='patentsgazette.uspto.gov'&&/week|OG|eOG/i.test(u.pathname);
    if(source.kind==='directory')return /\.pdf$|\.xlsx?$|decision|director|gazette|download|patentsview|guidance|exam|PTAB|OED|TTAB/i.test(l.url+' '+l.title)&&l.url!==source.url;
    return /\.pdf$|\.xlsx?$|RetrievePdf|download-documents/i.test(u.pathname+u.search);
  });
  if(!found.length)throw new Error('No recognized source links; the page may have changed or requires interactive access');
  return found.map(l=>record(source.id,{...l,excerpt:l.context,type:source.id==='gazette'?'gazette-issue':source.id==='ptab-statistics'?'statistical-publication':'source-link',metadata:{indexUrl:source.url,designationNote:source.id==='ptab-precedent'?'Designation must be checked in context on official index; not inferred from page membership.':null}}));
}
