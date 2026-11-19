// CPC scheme lookups through the existing EPO OPS connector (route 'epo', OPS classification service): one class,
// subclass or group with its descendants, parsed into a flat list in scheme order. No provider logic here: the request
// goes through the configured transport (gatewaySource): the direct transport with your own EPO OPS key (the default),
// or the optional n8n workflows, which hold the credential. Intended for expanding CPC seed symbols into exact symbol
// sets without downloading the bulk scheme files. This is a module function only: no CLI command or MCP tool calls it.
import {gatewaySource,readConfig} from './gateway.mjs';

export const EPO_BASE='https://ops.epo.org/3.2/rest-services';
const SYMBOL=/^[A-HY](?:[0-9]{2}(?:[A-Z](?:[0-9]{1,4}\/[0-9]{2,6})?)?)?$/;

export function cpcSchemeUrl(symbol,depth='all'){
  if(!SYMBOL.test(symbol||''))throw new Error('Invalid CPC symbol: '+symbol);
  if(!(depth==='all'||/^[0-9]$/.test(String(depth))))throw new Error('Invalid depth');
  return `${EPO_BASE}/classification/cpc/${symbol}?depth=${depth}`;
}

const unescape=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/g,'&');

// -> [{symbol, level, title}] in document (scheme) order. Rejects DTDs and entity declarations.
export function parseCpcScheme(xml){
  if(typeof xml!=='string'||!xml.trim())throw new Error('Empty CPC scheme response');
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('CPC scheme response contains a DTD or entity declaration');
  if(!/classification-item\b/.test(xml))throw new Error('Unexpected CPC scheme response (no classification items)');
  const items=[],re=/<(?:[\w-]+:)?classification-item\b([^>]*)>/g;let m;
  while((m=re.exec(xml))){
    const level=Number((/\blevel="(\d+)"/.exec(m[1])||[])[1]);
    const rest=xml.slice(re.lastIndex);
    const next=rest.search(/<(?:[\w-]+:)?classification-item\b/);
    const own=next<0?rest:rest.slice(0,next);  // this item's own content, before any child item
    const sym=/<(?:[\w-]+:)?classification-symbol>([^<]+)</.exec(own);
    if(!sym)continue;
    const titleBlock=/<(?:[\w-]+:)?class-title>([\s\S]*?)<\/(?:[\w-]+:)?class-title>/.exec(own);
    const title=titleBlock?[...titleBlock[1].matchAll(/<(?:[\w-]+:)?text\b[^>]*>([^<]*)</g)].map(t=>unescape(t[1]).trim()).filter(Boolean).join('; '):'';
    items.push({symbol:sym[1].trim(),level:Number.isFinite(level)?level:null,title});
  }
  if(!items.length)throw new Error('CPC scheme response had no symbols');
  return items;
}

export async function fetchCpcScheme(symbol,{config=readConfig(),depth='all',source=gatewaySource}={}){
  const url=cpcSchemeUrl(symbol,depth);
  const r=await source('epo',url,{method:'GET'},config);
  if(!/xml/i.test(r.contentType))throw new Error('CPC scheme response is not XML ('+r.contentType+')');
  const items=parseCpcScheme(r.text);
  if(!items.some(i=>i.symbol===symbol))throw new Error('CPC scheme response does not contain the requested symbol '+symbol);
  return {symbol,depth,url,items};
}
