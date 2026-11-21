import './setup.mjs';  // temporary data and limiter folders, also when this file is run on its own
// The one-time settings update when 0.1.x is updated to 0.2.0 (installer\common.ps1 Update-PrhLimitDefaults), run under Windows
// PowerShell 5.1 against scratch folders. Nothing here touches an installation, %LOCALAPPDATA% or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readConfig,effectiveLimits} from '../src/config.mjs';

const skip=process.platform==='win32'?false:'the installer is Windows-only';
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const repo=path.resolve(import.meta.dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'prh-mig-'));
process.on('exit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The settings file a default 0.1.0 install holds (cap 120 for every provider), with comments of the user's own formatting kept.
const oldConfig=(caps={uspto:120,epo:120,govinfo:120,courtlistener:120,bigquery:120},bom=false)=>(bom?'\uFEFF':'')+`{
  "transport": "direct",
  "requestTimeoutMs": 25000,
  "directMinIntervalMs": { "uspto": 1000, "epo": 1000 },
  "maxRequestsPerHour": {
${Object.entries(caps).map(([k,v])=>`    "${k}": ${v}`).join(',\n')}
  },
  "courtlistenerEnabled": false,
  "dataDir": "D:\\\\hubdata"
}
`;
function migrate(text,previous){
  const dir=fs.mkdtempSync(path.join(scratch,'case-')),config=path.join(dir,'config.json');
  fs.writeFileSync(config,text);
  const run=()=>{
    const r=spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',`. '${path.join(repo,'installer','common.ps1')}'; $r = Update-PrhLimitDefaults '${config}' '${previous}'; $acl = if ($r.Backup) { try { $null = Assert-PrhUserOnly $r.Backup; 'user-only' } catch { 'NOT user-only: ' + $_.Exception.Message } } else { '' }; [ordered]@{ changed = @($r.Changed); backup = [string]$r.Backup; skipped = [string]$r.Skipped; acl = $acl } | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(r.status,0,r.stdout+r.stderr);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  };
  return {dir,config,backup:config+'.before-0.2.0',run};
}

test('a 0.1.0 settings file with 120 everywhere becomes 1800, with a user-only backup of the old file beside it',{skip},()=>{
  const original=oldConfig(),m=migrate(original,'0.1.0'),r=m.run();
  assert.deepEqual(r.changed,['uspto','epo','govinfo','courtlistener','bigquery']);assert.equal(r.backup,m.backup);assert.equal(r.acl,'user-only');
  assert.equal(fs.readFileSync(m.backup,'utf8'),original,'the backup must be the previous file, byte for byte');
  const now=fs.readFileSync(m.config,'utf8');
  assert.equal(now,original.replace(/"(uspto|epo|govinfo|courtlistener|bigquery)": 120/g,'"$1": 1800'),'only the five numbers may change');
  const cfg=readConfig({env:{PATENT_RESEARCH_CONFIG:m.config}});
  assert.deepEqual(Object.values(effectiveLimits(cfg).providers).map(p=>p.maxRequestsPerHour),[1800,1800,1800,1800,1800]);
  assert.equal(cfg.directMinIntervalMs.uspto,1000);
});

test('a byte order mark in the old file is tolerated; no previous version recorded counts as an old installation',{skip},()=>{
  const m=migrate(oldConfig(undefined,true),''),r=m.run();
  assert.equal(r.changed.length,5);assert.equal(JSON.parse(fs.readFileSync(m.config,'utf8')).maxRequestsPerHour.uspto,1800);
});

test('a value the user chose (for example 77) is kept; only providers still at exactly 120 are raised',{skip},()=>{
  const m=migrate(oldConfig({uspto:77,epo:120,govinfo:1800,courtlistener:0,bigquery:120.5}),'0.1.0'),r=m.run();
  assert.deepEqual(r.changed,['epo']);
  const caps=JSON.parse(fs.readFileSync(m.config,'utf8')).maxRequestsPerHour;
  assert.deepEqual(caps,{uspto:77,epo:1800,govinfo:1800,courtlistener:0,bigquery:120.5});
  // all custom: nothing changes and no backup is made
  const none=migrate(oldConfig({uspto:77,epo:500,govinfo:1000,courtlistener:5,bigquery:1}),'0.1.0'),before=sha(none.config),r2=none.run();
  assert.deepEqual(r2.changed,[]);assert.equal(sha(none.config),before);assert.ok(!fs.existsSync(none.backup));
});

test('running it a second time changes nothing, and an installation already at 0.2.0 is skipped',{skip},()=>{
  const m=migrate(oldConfig(),'0.1.0');m.run();
  const configHash=sha(m.config),backupHash=sha(m.backup),again=m.run();
  assert.deepEqual(again.changed,[]);assert.equal(sha(m.config),configHash);assert.equal(sha(m.backup),backupHash,'the backup must not be overwritten');
  // someone sets 120 on purpose after the update: a Repair of the 0.2.0 install leaves it alone
  fs.writeFileSync(m.config,oldConfig({uspto:120,epo:120,govinfo:120,courtlistener:120,bigquery:120}));
  const kept=sha(m.config),skipped=migrate(fs.readFileSync(m.config,'utf8'),'0.2.0').run();
  assert.deepEqual(skipped.changed,[]);assert.match(skipped.skipped,/0\.2\.0 or newer/);assert.equal(sha(m.config),kept);
});

test('a settings file that is not valid JSON, or has no cap block, is left alone',{skip},()=>{
  for(const text of ['{ not json','{"transport":"direct"}']){
    const m=migrate(text,'0.1.0'),r=m.run();assert.deepEqual(r.changed,[]);assert.equal(fs.readFileSync(m.config,'utf8'),text);assert.ok(!fs.existsSync(m.backup));
  }
});

test('Setup calls the migration when it keeps an existing settings file, and says what it did',{skip},()=>{
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  assert.match(setup,/Update-PrhLimitDefaults \$paths\.HubConfig \$previous/);
  assert.match(setup,/Hourly request limit raised from the 0\.1\.0 default of 120 to 1800/);assert.match(setup,/To lower it, edit maxRequestsPerHour in config\.json/);
});
