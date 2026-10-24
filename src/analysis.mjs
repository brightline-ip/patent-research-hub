import {hash} from './parsers.mjs';
export const normalizeCpc=x=>{if(typeof x!=='string')throw new Error('CPC must be text');const s=x.toUpperCase().replace(/\s/g,'');if(!/^[A-HY]\d{2}[A-Z](?:\d{1,4}\/\d{2,})?$/.test(s))throw new Error('Supply a CPC subclass or full symbol');return s;};
export function analyzeCpc(input,options){
  if(!Array.isArray(input.records)||!input.source||!input.snapshotDate||!input.coverage)throw new Error('Dataset requires records, source, snapshotDate and coverage');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.snapshotDate)||Number.isNaN(Date.parse(input.snapshotDate))||new Date(input.snapshotDate).toISOString().slice(0,10)!==input.snapshotDate)throw new Error('snapshotDate must be a real YYYY-MM-DD date');
  const {cpc,dateBasis='publication',from,to,unit='publication'}=options;const symbol=normalizeCpc(cpc);
  if(!['publication','filing','grant'].includes(dateBasis)||!['publication','application','grant','family'].includes(unit))throw new Error('Unsupported date basis or counting unit');
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<1800||to<from||to-from>100||to>new Date().getUTCFullYear())throw new Error('Invalid year interval');
  const idKey=unit+'Id',dateKey=dateBasis+'Date';const seen=new Map(),buckets=new Map();for(let y=from;y<=to;y++)buckets.set(y,new Set());
  let excludedMissing=0,duplicates=0;const warnings=['Counts describe only the supplied dataset and its declared coverage. No population completeness has been verified.'];
  for(const r of input.records){if(!Array.isArray(r.cpc))throw new Error('Every record needs a cpc array');const match=r.cpc.map(normalizeCpc).some(x=>symbol.length===4?x.slice(0,4)===symbol:x===symbol);if(!match)continue;const id=r[idKey],date=r[dateKey];if(!id||!date){excludedMissing++;continue;}if(typeof id!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Invalid identifier/date in matching record');
    if(seen.has(id)){if(seen.get(id)!==date)throw new Error(`Conflicting ${dateBasis} dates for a counting unit; resolve before analysis`);duplicates++;continue;}seen.set(id,date);const year=Number(date.slice(0,4));buckets.get(year)?.add(id);
  }
  if(dateBasis==='filing')warnings.push('Public filing cohorts omit unpublished applications; recent years are especially incomplete. These are not all applications filed.');
  if(to===new Date().getUTCFullYear())warnings.push('Current calendar year is partial; do not compare it directly with full years.');
  if(excludedMissing)warnings.push(`${excludedMissing} matching rows lacked a counting identifier or selected date.`);
  let prior=null;const series=[...buckets].map(([year,ids])=>{const count=ids.size,result={year,count,yoyPercent:prior===null||prior===0?null:Math.round((count-prior)/prior*10000)/100};prior=count;return result;});
  return {title:`${symbol}: ${unit} counts by ${dateBasis} year`,source:input.source,snapshotDate:input.snapshotDate,coverage:input.coverage,datasetSha256:hash(JSON.stringify(input)),definition:{cpc:symbol,classificationScope:symbol.length===4?'subclass membership':'exact symbol (no inferred subgroup descendants)',dateBasis,unit,from,to},series,duplicatesRemoved:duplicates,excludedMissing,warnings,methodVersion:1};
}
