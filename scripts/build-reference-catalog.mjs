// Seed only links observed in the preserved official MPEP index.
import fs from 'node:fs';
import {parse} from 'parse5';
const indexUrl='https://www.uspto.gov/web/offices/pac/mpep/index.html';
// Usage: node scripts/build-reference-catalog.mjs <saved copy of the official MPEP index HTML>
const indexFile=process.argv[2];if(!indexFile)throw new Error('usage: node scripts/build-reference-catalog.mjs <saved MPEP index.html>');
const html=fs.readFileSync(indexFile,'utf8');
const urls=new Set();function walk(n){const href=n.attrs?.find(a=>a.name==='href')?.value;if(href&&/\.pdf$/i.test(href)){const u=new URL(href,indexUrl);if(u.hostname==='www.uspto.gov')urls.add(u.href);}for(const c of n.childNodes||[])walk(c);}walk(parse(html));
const references=[];
for(const url of urls){
 const name=url.split('/').pop(),chapter=/^mpep-(\d{2})00\.pdf$/.exec(name);
 if(name.includes('searchable_mpep'))continue;
 const family=name==='consolidated_laws.pdf'?'usc35':name==='consolidated_rules.pdf'?'cfr37':/^mpep-\d/.test(name)?'mpep':'guidance';
 const id=(chapter?'mpep-'+Number(chapter[1])*100:family==='usc35'?'usc35':family==='cfr37'?'cfr37':name.replace(/\.pdf$/,'').toLowerCase().replace(/[^a-z0-9-]/g,'-'));
 references.push({id,family,title:chapter?'MPEP Chapter '+Number(chapter[1])*100:family==='usc35'?'USPTO Consolidated Patent Laws — Title 35':family==='cfr37'?'USPTO Consolidated Patent Rules — 37 CFR patent practice':name.replace(/\.pdf$/,'').replace(/[-_]/g,' '),url,authority:family==='usc35'?'official-statutory-compilation':family==='cfr37'?'official-regulatory-compilation':'official-guidance',edition:family==='mpep'?'Ninth edition, Rev. 01.2024; individual sections may retain older revision dates':family==='usc35'?'Current as of July 18, 2025 per publisher':family==='cfr37'?'Current as of July 20, 2026 per publisher':'See dated source document',discoveryUrl:indexUrl});
}
references.push({id:'frcp',family:'frcp',title:'Federal Rules of Civil Procedure — December 1, 2025',url:'https://www.uscourts.gov/sites/default/files/document/federal-rules-of-civil-procedure.pdf',authority:'official-court-rules',edition:'Amended to December 1, 2025',discoveryUrl:'https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure'});
const monitors=[{id:'mpep-index',url:indexUrl,title:'Current MPEP and updates'},{id:'frcp-index',url:'https://www.uscourts.gov/forms-rules/current-rules-practice-procedure/federal-rules-civil-procedure',title:'Current FRCP index'},{id:'patent-guidance',url:'https://www.uspto.gov/patents/laws/patent-legal-administration',title:'Patent legal administration and guidance'}];
fs.mkdirSync('config',{recursive:true});fs.writeFileSync('config/references.json',JSON.stringify({schemaVersion:1,checkedAt:'2026-09-06',defaultPolling:'weekly',policy:'Immutable source snapshots. A hash proves byte identity, not legal applicability or currency. Subsequent updates are candidates; existing pins are not overwritten.',references,monitors},null,2));
console.log(JSON.stringify({references:references.length,chapters:references.filter(r=>/^mpep-\d+$/.test(r.id)).length}));
