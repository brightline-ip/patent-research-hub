import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isReservedDeviceName} from '../src/names.mjs';
import {sessionKey,checkpoint,resume} from '../src/checkpoints.mjs';
import {Store} from '../src/store.mjs';
import {queryExaminerReport} from '../src/examiner.mjs';
import {queryBigQueryTrendReport} from '../src/bigquery.mjs';
import {exportCpcReport} from '../src/reports.mjs';
import {stageOriginal,sweepStagingTemporaries} from '../src/originals.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'prh-r2-'));
const exportsRoot=path.join(home,'exports'),dataRoot=path.join(home,'data');
process.env.PATENT_RESEARCH_EXPORTS_DIR=exportsRoot;
process.env.PATENT_RESEARCH_DATA_DIR=dataRoot;
process.on('exit',()=>{try{fs.rmSync(home,{recursive:true,force:true});}catch{}});
const noChart=()=>({available:false,python:null,reason:'fixture',warning:'No chart was produced (fixture).'});

// ---- reserved Windows device names -------------------------------------------------------------------------------
test('reserved device names are recognised with any case, extension, trailing dots or spaces',()=>{
  for(const name of ['CON','con','Nul','PRN','aux','COM1','com9','LPT1','lpt9','CON.txt','nul.manifest.json','aux.','CON . ','con.tar.gz','COM3.json'])assert.equal(isReservedDeviceName(name),true,name);
  for(const name of ['CONSOLE','console1','COM0','COM10','LPT0','my-con','x.CON','session-1','nulls','prn2','auxiliary'])assert.equal(isReservedDeviceName(name),false,name);
  assert.equal(isReservedDeviceName(undefined),false);
});

test('a session named CON (or any reserved name) is refused and no folder is created',async()=>{
  for(const name of ['CON','con','NUL','Prn','AUX','COM1','lpt9'])assert.throws(()=>sessionKey(name),/reserved Windows device name/,name);
  assert.equal(sessionKey('console'),'console');
  await assert.rejects(checkpoint({session:'CON',objective:'o',scope:'s'}),/reserved Windows device name/);
  await assert.rejects(resume('NUL'),/reserved Windows device name/);
  assert.ok(!fs.existsSync(path.join(dataRoot,'checkpoints')),'nothing may be created for a refused name');
  const saved=await checkpoint({session:'real-session',objective:'o',scope:'s'});assert.ok(fs.existsSync(saved.path));
});

test('a backup manifest with a reserved device name is refused before any file access',()=>{
  const store=new Store(path.join(home,'store'));
  try{
    for(const name of ['CON.manifest.json','nul.manifest.json','COM1.manifest.json'])assert.throws(()=>store.stageRestore(name),/reserved Windows device name/,name);
    assert.throws(()=>store.stageRestore('missing.manifest.json'),/cannot be staged/);
  }finally{store.db.close();}
});

// ---- a billed query must not lose its result ---------------------------------------------------------------------
const examinerTrend={table:'fixture.table',tableLastModifiedAt:'2017-10-09T00:00:00.000Z',coverage:'fixture',parameters:{scope:'examiner',value:'EXAMPLE, ALEX',from:2012,to:2013},
  dataBounds:{maxFilingDate:'2017-10-12',maxDisposalDate:'2017-10-10',dataCutoff:'2017-10-12'},dataQuality:{invalidFilingDates:'0',invalidIssueDates:'0',invalidAbandonDates:'0'},
  series:[{year:2012,issued:10,abandoned:2,disposed:12,issueSharePercent:83.33},{year:2013,issued:8,abandoned:4,disposed:12,issueSharePercent:66.67}],
  jobReference:{jobId:'fixture'},totalBytesProcessed:'1',totalBytesBilled:'1',cacheHit:false,maximumBytesBilled:'10',preflight:{totalBytesProcessed:'1'},
  budget:{trackedMonth:'2026-09',trackedBytesAfter:'1',monthlyLimitBytes:'100'},warnings:['fixture warning'],delivery:{mode:'hosted-query',servedAt:'2026-09-07T00:00:00.000Z'}};
const bigQueryTrend={table:'fixture.publications',tableLastModifiedAt:'2025-01-01T00:00:00.000Z',coverage:'fixture',cpcMatch:'subclass',parameters:{cpc:'G06N',from:2023,to:2024},
  series:[{year:2023,count:5,yoyPercent:null},{year:2024,count:7,yoyPercent:40}],jobReference:{jobId:'fixture'},totalBytesProcessed:'1',totalBytesBilled:'1',cacheHit:false,maximumBytesBilled:'10',
  preflight:{totalBytesProcessed:'1'},budget:{trackedMonth:'2026-09',trackedBytesAfter:'1',monthlyLimitBytes:'100'},warnings:['fixture warning'],delivery:{mode:'hosted-query',servedAt:'2026-09-07T00:00:00.000Z'}};
const cases=[
  {name:'examiner',run:queryExaminerReport,input:{scope:'examiner',examiner:'Example, Alex',from:2012,to:2013},trend:examinerTrend},
  {name:'BigQuery',run:queryBigQueryTrendReport,input:{cpc:'G06N',from:2023,to:2024},trend:bigQueryTrend}
];
const breakExports=()=>{fs.rmSync(exportsRoot,{recursive:true,force:true});fs.writeFileSync(exportsRoot,'a file where the export folder should be');};
const restoreExports=()=>{fs.rmSync(exportsRoot,{recursive:true,force:true});};

for(const c of cases){
  test(`${c.name} report: an unwritable export folder or a bad title is found before the query runs`,async()=>{
    let queried=0;const query=async()=>{queried++;return c.trend;};
    breakExports();
    try{await assert.rejects(c.run(c.input,{query,probeRenderer:noChart}),/not writable.*Nothing was queried/s);}finally{restoreExports();}
    assert.equal(queried,0);
    await assert.rejects(c.run({...c.input,title:'x'.repeat(201)},{query,probeRenderer:noChart}),/title must be 1 to 200 characters/);
    await assert.rejects(c.run({...c.input,title:'   '},{query,probeRenderer:noChart}),/title must be 1 to 200 characters/);
    assert.equal(queried,0);
    // The same inputs with a writable folder do run the query, and the preflight leaves no test file behind.
    const ok=await c.run(c.input,{query,probeRenderer:noChart});
    assert.equal(queried,1);assert.equal(ok.exportError,undefined);assert.equal(Object.keys(ok)[0],'warnings');
    assert.ok(!fs.readdirSync(exportsRoot).some(n=>n.startsWith('.write-test-')));
  });
  test(`${c.name} report: an export error after the query returns the paid result with exportError`,async()=>{
    const query=async()=>{breakExports();return c.trend;};// the folder becomes unusable while the query runs
    let result;try{result=await c.run(c.input,{query,probeRenderer:noChart});}finally{restoreExports();}
    assert.equal(Object.keys(result)[0],'warnings');
    assert.match(result.exportError,/\S/);assert.equal(result.files,null);
    assert.deepEqual(result.trend.series,c.trend.series);
    assert.match(result.warnings[0],/query completed, but the report files could not be written/);assert.ok(result.warnings.includes('fixture warning'));
  });
}

test('the CPC report returns warnings first',async()=>{
  const dataset={source:'SYNTHETIC UNIT TEST',snapshotDate:'2026-09-06',coverage:'fixture',records:[{publicationId:'A',publicationDate:'2024-02-01',cpc:['G06N3/08']}]};
  const before=process.env.RESEARCH_PLOT_PYTHON;process.env.RESEARCH_PLOT_PYTHON=path.join(home,'no-such-python.exe');
  try{const r=await exportCpcReport({dataset,cpc:'G06N',dateBasis:'publication',unit:'publication',from:2023,to:2025});assert.equal(Object.keys(r)[0],'warnings');assert.match(r.warnings[0],/No chart was produced/);assert.ok(r.analysis&&r.files.csv);}
  finally{if(before===undefined)delete process.env.RESEARCH_PLOT_PYTHON;else process.env.RESEARCH_PLOT_PYTHON=before;}
});

// ---- staged originals --------------------------------------------------------------------------------------------
const pdf=Buffer.from('%PDF-1.4\nROUND TWO FIXTURE\n%%EOF'),sha=createHash('sha256').update(pdf).digest('hex');

test('staging sweeps old orphan temporary files and keeps recent ones',async()=>{
  const intake=path.join(home,'intake-sweep'),dir=path.join(intake,'patent-research');fs.mkdirSync(dir,{recursive:true});
  const hex=c=>c.repeat(64),uuid='11111111-2222-3333-4444-555555555555';
  const old=path.join(dir,'.'+hex('a')+'.'+uuid+'.tmp'),recent=path.join(dir,'.'+hex('b')+'.'+uuid+'.tmp'),other=path.join(dir,'keep.pdf'),oldNotTmp=path.join(dir,'.hidden.txt'),oldForeign=path.join(dir,'.user-notes.tmp');
  for(const f of [old,recent,other,oldNotTmp,oldForeign])fs.writeFileSync(f,'x');
  const past=new Date(Date.now()-11*60*1000);for(const f of [old,other,oldNotTmp,oldForeign])fs.utimesSync(f,past,past);
  const target=await stageOriginal(pdf,sha,intake);
  assert.ok(fs.existsSync(target));assert.ok(!fs.existsSync(old),'old orphan removed');assert.ok(fs.existsSync(recent),'recent temporary kept');assert.ok(fs.existsSync(other));assert.ok(fs.existsSync(oldNotTmp));assert.ok(fs.existsSync(oldForeign),'only files with the exact name pattern of the writer are swept');
  assert.equal(await sweepStagingTemporaries(path.join(home,'does-not-exist')),0);
});

test('a rename that fails with EPERM, EBUSY or EEXIST is accepted when the target is intact, and refused when it is not',async()=>{
  for(const code of ['EPERM','EBUSY','EEXIST']){
    const intake=path.join(home,'intake-'+code),dir=path.join(intake,'patent-research'),target=path.join(dir,sha+'.pdf');
    const rename=async()=>{fs.writeFileSync(target,pdf);const e=new Error(code);e.code=code;throw e;};// another process staged it first
    assert.equal(await stageOriginal(pdf,sha,intake,'pdf',{rename}),target);
    assert.deepEqual(fs.readdirSync(dir).filter(n=>n.endsWith('.tmp')),[],'temporary file removed');
    const bad=path.join(home,'intake-bad-'+code),badDir=path.join(bad,'patent-research'),badTarget=path.join(badDir,sha+'.pdf');
    const failing=async()=>{fs.writeFileSync(badTarget,'damaged');const e=new Error(code);e.code=code;throw e;};
    await assert.rejects(stageOriginal(pdf,sha,bad,'pdf',{rename:failing}),{code});
    assert.deepEqual(fs.readdirSync(badDir).filter(n=>n.endsWith('.tmp')),[],'temporary file removed after refusal');
  }
  const other=path.join(home,'intake-other');
  await assert.rejects(stageOriginal(pdf,sha,other,'pdf',{rename:async()=>{const e=new Error('nope');e.code='ENOSPC';throw e;}}),{code:'ENOSPC'});
});

test('a rename that fails once with EPERM is retried and succeeds',async()=>{
  const intake=path.join(home,'intake-retry');let calls=0;
  const rename=async(from,to)=>{calls++;if(calls===1){const e=new Error('busy');e.code='EBUSY';throw e;}return fs.promises.rename(from,to);};
  const target=await stageOriginal(pdf,sha,intake,'pdf',{rename});
  assert.equal(calls,2);assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'),sha);
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(n=>n.endsWith('.tmp')),[]);
});

test('an empty-string title counts as absent in the preflight (the export then uses the generated title)',async()=>{
  const {preflightExport}=await import('../src/reports.mjs');
  await preflightExport({title:''});await preflightExport({});await preflightExport({title:undefined});
  await assert.rejects(preflightExport({title:'   '}),/title must be 1 to 200/);
  assert.ok(!fs.readdirSync(exportsRoot).some(n=>n.startsWith('.write-test-')));
});
test('a config.json saved with a UTF-8 byte order mark (as some Notepad versions do) is read, and doctor still runs',async()=>{
  const {readConfig}=await import('../src/config.mjs'),{parseJsonText,stripBom}=await import('../src/json-text.mjs');
  assert.equal(stripBom('\uFEFF{"a":1}'),'{"a":1}');assert.deepEqual(parseJsonText('\uFEFF{"a":1}'),{a:1});assert.deepEqual(parseJsonText('{"a":1}'),{a:1});
  const file=path.join(home,'bom-config.json');
  fs.writeFileSync(file,Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from(JSON.stringify({googleBigQueryDryRunEnabled:true,maxRequestsPerHour:{uspto:7}}))]));
  const config=readConfig({file});assert.equal(config.googleBigQueryDryRunEnabled,true);assert.equal(config.maxRequestsPerHour.uspto,7);
  fs.writeFileSync(file,'{ not json');assert.throws(()=>readConfig({file}),/not valid JSON/);
  // The command line: BOM config.json and a BOM keys.env (first line a comment, as Setup writes it) and a BOM dataset file.
  const cfg=path.join(home,'bom-cli.json'),keys=path.join(home,'bom-keys.env');
  fs.writeFileSync(cfg,'\uFEFF{"googleBigQueryDryRunEnabled":true}');fs.writeFileSync(keys,'\uFEFF# Patent Research Hub keys\nGOVINFO_API_KEY=fake-bom-value\n');
  const cli=path.join(import.meta.dirname,'..','src','cli.mjs');
  const r=spawnSync(process.execPath,['--no-warnings',`--env-file-if-exists=${keys}`,cli,'doctor'],{encoding:'utf8',env:{...process.env,PATENT_RESEARCH_CONFIG:cfg,PATENT_RESEARCH_DATA_DIR:path.join(home,'cli-data'),PATENT_RESEARCH_EXPORTS_DIR:path.join(home,'cli-exports')}});
  assert.equal(r.status,0,r.stdout+r.stderr);const report=JSON.parse(r.stdout);
  const gov=report.providers.find(p=>/GovInfo/.test(p.name));assert.equal(gov.configured,true,'a key on the first line after a BOM comment must still load');
  assert.doesNotMatch(r.stdout,/fake-bom-value/);
});