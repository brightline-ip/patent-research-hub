import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {exportsDir,installRoot as root,pythonExecutable,readConfig} from './config.mjs';
import {safeErrorMessage} from './security.mjs';
import {analyzeCpc} from './analysis.mjs';
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const markdownLine=s=>String(s??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().replace(/([\\`*_[\]()<>#|])/g,'\\$1');
const markdownLink=value=>{try{const u=new URL(String(value));if(u.protocol!=='https:'||u.username||u.password||u.href.length>4096)throw new Error();return '<'+u.href.replaceAll('>','%3E')+'>';}catch{return markdownLine(value);}};
const acquisitionSummary=r=>{const a=r.acquisition;if(!a)return 'Original acquisition not linked to this snapshot.';return `Acquisition: ${a.status}; original preserved: ${a.original?'yes':'not established'}; corpus document: ${a.documentId||'not yet available'}; job: ${a.jobId}. Text-read coverage and legal verification are not established by acquisition. ${a.extractionWarnings?.length?'Extraction warnings: '+a.extractionWarnings.join('; '):''}`;};
const chartEnvNames=['SystemRoot','windir','TEMP','TMP','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','LANG','LC_ALL','MPLCONFIGDIR'];
// The chart renderer needs none of the Hub's credentials: pass only what Python itself needs to start and write temp files.
export function pythonChildEnv(env=process.env){const out={};for(const name of chartEnvNames)if(env[name]!==undefined)out[name]=env[name];out.PYTHONIOENCODING='utf-8';return out;}
export const chartWarning=reason=>`No chart was produced (${reason}). The report, counts.csv and dataset.json are complete without it. For charts, install Python 3.12 or newer and the packages in requirements.txt (Setup offers this as an optional step).`;
// Is a chart renderer (Python with matplotlib) available? Cheap and offline, so callers can check before any paid provider call.
export function probeChartRenderer({config,env=process.env}={}){
  const python=env.RESEARCH_PLOT_PYTHON||pythonExecutable(config??readConfig({env}),env);
  if(!python)return {available:false,python:null,reason:'no Python interpreter was found',warning:chartWarning('no Python interpreter was found')};
  const probe=spawnSync(python,['-c','import matplotlib'],{encoding:'utf8',windowsHide:true,timeout:30000,env:pythonChildEnv(env)});
  if(probe.error||probe.status!==0){const reason=`matplotlib is not available to the Python interpreter ${python}`;return {available:false,python,reason,warning:chartWarning(reason)};}
  return {available:true,python,reason:null,warning:null};
}
// Validate the title and prove the export folder is writable BEFORE anything billable happens, so a paid query is never
// run only to find that its report cannot be written.
export async function preflightExport({title}={}){
  if(title!==undefined&&title!==null&&title!==''&&(typeof title!=='string'||!title.trim()||title.length>200))throw new Error('Report title must be 1 to 200 characters. Nothing was queried.');
  const root=exportsDir(readConfig());
  const probe=path.join(root,'.write-test-'+randomUUID());
  try{await fs.mkdir(root,{recursive:true});await fs.writeFile(probe,'ok',{flag:'wx'});}
  catch(error){throw new Error(`The export folder ${root} is not writable (${safeErrorMessage(error.message)}). Nothing was queried, so nothing was billed.`);}
  // The folder is writable; a failure to delete the probe file is not a reason to refuse (a stray .write-test file is harmless).
  await fs.rm(probe,{force:true}).catch(()=>{});
  return root;
}
// The query already ran (and may have been billed): an export failure must not discard its result.
export function exportFailure(trend,error){
  const exportError=safeErrorMessage(error?.message||String(error));
  return {warnings:[`The query completed, but the report files could not be written: ${exportError}. The result is returned here and was not saved as a report.`,...(trend.warnings||[])],exportError,trend,files:null};
}
export async function exportCpcReport(a){
  const analysis=analyzeCpc(a.dataset,a);
  const files=await exportReport({title:a.title||analysis.title,analysis,dataset:a.dataset});
  return {warnings:files.warnings,analysis,files};
}
export async function exportReport(input){
  const {title,analysis=null}=input;
  if(typeof title!=='string'||!title.trim()||title.length>200)throw new Error('Report title is required (max 200 characters)');
  // Decide about the chart before creating anything. A missing renderer is a warning, never a failure.
  const renderer=analysis?(input.renderer||probeChartRenderer()):null;
  const dir=path.join(exportsDir(readConfig()),randomUUID());await fs.mkdir(dir,{recursive:true});
  try{return await writeReport(dir,input,renderer);}
  catch(error){await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});throw error;}
}
async function writeReport(dir,{title,question='',facts=[],inferences=[],openQuestions=[],records=[],analysis=null,dataset=null},renderer){
  const report={title,question,createdAt:new Date().toISOString(),facts,inferences,openQuestions,records,analysis,notice:'Draft research evidence packet. Model interpretations require legal review; source presence does not establish good law.'};
  if(dataset)await fs.writeFile(path.join(dir,'dataset.json'),JSON.stringify(dataset,null,2));
  const sections=[['Retrieved / computed facts',facts],['Interpretations requiring review',inferences],['Open questions',openQuestions]];
  let body=`<h1>${escape(title)}</h1><p>${escape(question)}</p><p>${escape(report.notice)}</p>`;
  for(const [heading,items]of sections)body+=`<h2>${heading}</h2><ul>${items.map(x=>`<li>${escape(x)}</li>`).join('')}</ul>`;
  const warnings=[];let svg=null;
  if(analysis){
    if(renderer.available){const plotted=spawnSync(renderer.python,[path.join(root,'scripts','plot.py'),dir],{input:JSON.stringify(analysis),encoding:'utf8',windowsHide:true,timeout:60000,env:pythonChildEnv()});if(!plotted.error&&plotted.status===0)svg=await fs.readFile(path.join(dir,'chart.svg'),'utf8').catch(()=>null);if(svg===null)warnings.push(chartWarning('the chart renderer failed to run'));}
    else warnings.push(renderer.warning);
    const source=analysis.sourceUrl?`<p>Data source: <a href="${escape(analysis.sourceUrl)}">${escape(analysis.source)}</a>${analysis.sourceDocumentation?` · <a href="${escape(analysis.sourceDocumentation)}">documentation</a>`:''}</p>`:'';body+=`<h2>Computed trend</h2>${source}${svg===null?`<p><strong>${escape(warnings[0])}</strong></p>`:svg}<pre>${escape(JSON.stringify(analysis,null,2))}</pre>`;const outcomes=analysis.series.every(x=>Number.isInteger(x.issued)&&Number.isInteger(x.abandoned)&&Number.isInteger(x.disposed));const csv=outcomes?'year,issued,abandoned,disposed,issued_share_percent\n'+analysis.series.map(x=>`${x.year},${x.issued},${x.abandoned},${x.disposed},${x.issueSharePercent??''}`).join('\n'):'year,count,yoy_percent\n'+analysis.series.map(x=>`${x.year},${x.count},${x.yoyPercent??''}`).join('\n');await fs.writeFile(path.join(dir,'counts.csv'),csv);}
  body+='<h2>Source register</h2><ol>'+records.map(r=>`<li>${escape(r.title)} — ${/^https:\/\//.test(r.url)?`<a href="${escape(r.url)}">Source</a>`:escape(r.url)}<p>${escape(r.excerpt)}</p><small>Retrieved ${escape(r.retrievedAt)}; ${escape(r.type)}; designation: ${escape(r.precedentialStatus)}; snapshot: ${escape(r.snapshotId)}. ${escape(acquisitionSummary(r))}</small></li>`).join('')+'</ol>';
  await fs.writeFile(path.join(dir,'report.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>body{max-width:1000px;margin:40px auto;padding:24px;font:17px/1.6 Arial;color:#172e40}h1{font-size:32px}svg{width:100%}pre{white-space:pre-wrap;font-size:13px}small{font-size:13px}@media print{body{margin:0}h2{break-after:avoid}li,svg{break-inside:avoid}}</style>${body}</html>`);
  await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(dir,'report.md'),`# ${markdownLine(title)}\n\n${markdownLine(question)}\n\n${markdownLine(report.notice)}\n\n`+sections.map(([h,items])=>`## ${h}\n\n`+items.map(x=>'- '+markdownLine(x)).join('\n')).join('\n\n')+'\n\n## Sources\n\n'+records.map(r=>`- ${markdownLine(r.title)}: ${markdownLink(r.url)}\n  Retrieved: ${markdownLine(r.retrievedAt)}; snapshot: ${markdownLine(r.snapshotId)}. ${markdownLine(acquisitionSummary(r))}`).join('\n'));
  if(analysis){const outcomes=analysis.series.every(x=>Number.isInteger(x.issued)&&Number.isInteger(x.abandoned)&&Number.isInteger(x.disposed));const table=outcomes?'| Year | Issued | Abandoned | Disposed | Issued share % |\n| --- | --- | --- | --- | --- |\n'+analysis.series.map(x=>`| ${x.year} | ${x.issued} | ${x.abandoned} | ${x.disposed} | ${x.issueSharePercent??'N/A'} |`).join('\n'):'| Year | Count | Change % |\n| --- | --- | --- |\n'+analysis.series.map(x=>`| ${x.year} | ${x.count} | ${x.yoyPercent??'N/A'} |`).join('\n');await fs.appendFile(path.join(dir,'report.md'),'\n\n## Computed dataset trend\n\n'+(svg===null?'_'+markdownLine(warnings[0])+'_':'![Computed counts](chart.svg)')+'\n\n'+table+'\n\nSource: '+(analysis.sourceUrl?markdownLine(analysis.source)+' '+markdownLink(analysis.sourceUrl):markdownLine(analysis.source))+(analysis.sourceDocumentation?' (documentation '+markdownLink(analysis.sourceDocumentation)+')':'')+'\n\nCoverage: '+markdownLine(analysis.coverage)+'\n\nMethod: `'+markdownLine(JSON.stringify(analysis.definition))+'`\n\nDataset SHA-256: `'+markdownLine(analysis.datasetSha256)+'`\n\n'+analysis.warnings.map(w=>'- '+markdownLine(w)).join('\n')+'\n');}
  return {directory:dir,html:path.join(dir,'report.html'),markdown:path.join(dir,'report.md'),json:path.join(dir,'report.json'),...(dataset?{dataset:path.join(dir,'dataset.json')} : {}),...(analysis?{...(svg!==null?{chart:path.join(dir,'chart.svg'),png:path.join(dir,'chart.png')}:{}),csv:path.join(dir,'counts.csv')}:{}),warnings};
}
