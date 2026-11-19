import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {analyzeCpc} from '../src/analysis.mjs';
import {exportReport,probeChartRenderer,pythonChildEnv} from '../src/reports.mjs';
import {exportExaminerReport,queryExaminerReport} from '../src/examiner.mjs';

// Reports must not depend on Python: without a chart renderer they are still written, with a warning.
const home=fs.mkdtempSync(path.join(os.tmpdir(),'patent-chart-'));
const exportsRoot=path.join(home,'exports');
process.env.PATENT_RESEARCH_EXPORTS_DIR=exportsRoot;
process.env.PATENT_RESEARCH_DATA_DIR=path.join(home,'data');
process.on('exit',()=>{try{fs.rmSync(home,{recursive:true,force:true});}catch{}});
const dataset={source:'SYNTHETIC UNIT TEST',snapshotDate:'2026-09-06',coverage:'Test fixture; not patent statistics',records:[{publicationId:'A',publicationDate:'2024-02-01',cpc:['G06N3/08']},{publicationId:'B',publicationDate:'2025-02-01',cpc:['G06N3/02']}]};
const analysis=analyzeCpc(dataset,{cpc:'G06N',from:2023,to:2025});
const listExports=()=>fs.existsSync(exportsRoot)?fs.readdirSync(exportsRoot):[];
const withPython=async(python,fn)=>{const before=process.env.RESEARCH_PLOT_PYTHON;process.env.RESEARCH_PLOT_PYTHON=python;try{return await fn();}finally{if(before===undefined)delete process.env.RESEARCH_PLOT_PYTHON;else process.env.RESEARCH_PLOT_PYTHON=before;}};
const missingPython=path.join(home,'no-such-python.exe');

test('probe reports an unavailable renderer instead of throwing',async()=>{
  await withPython(missingPython,()=>{const r=probeChartRenderer();assert.equal(r.available,false);assert.match(r.warning,/No chart was produced/);});
  // An interpreter that starts but has no matplotlib (Node is used as the stand-in executable).
  await withPython(process.execPath,()=>{const r=probeChartRenderer();assert.equal(r.available,false);assert.match(r.reason,/matplotlib/);});
});

test('a report with an analysis is still exported, without a chart and with a warning, when Python is unavailable',async()=>{
  const files=await withPython(missingPython,()=>exportReport({title:'No chart fixture',analysis,dataset}));
  assert.equal(files.chart,undefined);assert.equal(files.png,undefined);
  assert.equal(files.warnings.length,1);assert.match(files.warnings[0],/No chart was produced/);
  assert.ok(fs.existsSync(files.html)&&fs.existsSync(files.markdown)&&fs.existsSync(files.json)&&fs.existsSync(files.csv)&&fs.existsSync(files.dataset));
  assert.ok(!fs.existsSync(path.join(files.directory,'chart.svg')));
  assert.match(fs.readFileSync(files.html,'utf8'),/No chart was produced/);
  const md=fs.readFileSync(files.markdown,'utf8');assert.doesNotMatch(md,/!\[Computed counts\]/);assert.match(md,/No chart was produced/);assert.match(md,/Computed dataset trend/);
  assert.match(fs.readFileSync(files.csv,'utf8'),/^year,count,yoy_percent/);
});

test('a report without an analysis needs no renderer and carries no warning',async()=>{
  const files=await withPython(missingPython,()=>exportReport({title:'Text only'}));
  assert.deepEqual(files.warnings,[]);assert.equal(files.csv,undefined);
});

test('a failed export leaves no orphan folder behind',async()=>{
  const before=listExports();
  await withPython(missingPython,async()=>{await assert.rejects(exportReport({title:'Broken',analysis:{title:'no series'}}),TypeError);});
  assert.deepEqual(listExports(),before);
});

test('examiner and BigQuery report queries probe the renderer before any provider call and still report without a chart',async()=>{
  const events=[];
  const input={scope:'examiner',examiner:'Example, Alex',from:2012,to:2014};
  const store={reserveBigQuery(){},completeBigQuery(){},getQueryCache:()=>{events.push('query-started');return null;}};
  await assert.rejects(queryExaminerReport(input,{probeRenderer:()=>{events.push('probe');return {available:false,python:null,reason:'fixture',warning:'No chart was produced (fixture).'};},config:{googleBigQueryExecutionEnabled:false},store}),/googleBigQueryExecutionEnabled/);
  assert.deepEqual(events,['probe','query-started']);
  // Export from a finished trend: the warning is the first key of the result, and the files are complete.
  const trend={table:'fixture.table',tableLastModifiedAt:'2017-10-09T00:00:00.000Z',coverage:'fixture',parameters:{scope:'examiner',value:'EXAMPLE, ALEX',from:2012,to:2014},
    dataBounds:{maxFilingDate:'2017-10-12',maxDisposalDate:'2017-10-10',dataCutoff:'2017-10-12'},dataQuality:{invalidFilingDates:'0',invalidIssueDates:'0',invalidAbandonDates:'0'},
    series:[{year:2012,issued:10,abandoned:2,disposed:12,issueSharePercent:83.33},{year:2013,issued:8,abandoned:4,disposed:12,issueSharePercent:66.67}],
    jobReference:{jobId:'fixture'},totalBytesProcessed:'1',totalBytesBilled:'1',cacheHit:false,maximumBytesBilled:'10',preflight:{totalBytesProcessed:'1'},
    budget:{trackedMonth:'2026-09',trackedBytesAfter:'1',monthlyLimitBytes:'100'},warnings:[],delivery:{mode:'hosted-query',servedAt:'2026-09-07T00:00:00.000Z'}};
  const result=await exportExaminerReport(trend,{},{renderer:{available:false,python:null,reason:'fixture',warning:'No chart was produced (fixture).'}});
  assert.equal(Object.keys(result)[0],'warnings');assert.deepEqual(result.warnings,['No chart was produced (fixture).']);
  assert.equal(result.files.chart,undefined);assert.ok(fs.existsSync(result.files.html)&&fs.existsSync(result.files.csv));
});

test('the Python child process gets no provider keys',()=>{
  const env=pythonChildEnv({PATH:'p',SystemRoot:'C:\\Windows',TEMP:'t',USPTO_API_KEY:'k1',GOOGLE_APPLICATION_CREDENTIALS:'k2',COURTLISTENER_TOKEN:'k3',EPO_OPS_CONSUMER_SECRET:'k4',OPENAI_API_KEY:'k5'});
  assert.equal(env.PATH,'p');assert.equal(env.PYTHONIOENCODING,'utf-8');
  for(const name of ['USPTO_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','COURTLISTENER_TOKEN','EPO_OPS_CONSUMER_SECRET','OPENAI_API_KEY'])assert.equal(env[name],undefined,name);
});

// Runs only where Python with matplotlib is installed (Setup's optional chart packages); otherwise the chart path is not exercised.
const renderer=probeChartRenderer();
test('with a renderer the chart is drawn',{skip:renderer.available?false:'Python with matplotlib is not installed here (optional chart packages)'},async()=>{
  const files=await exportReport({title:'Chart fixture',analysis,dataset});
  assert.deepEqual(files.warnings,[]);assert.ok(fs.existsSync(files.chart)&&fs.existsSync(files.png));assert.match(fs.readFileSync(files.html,'utf8'),/<svg/);
});
