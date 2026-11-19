import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';

// Windows installer scripts, run under Windows PowerShell 5.1 against scratch folders. Nothing here installs
// anything, touches %LOCALAPPDATA% or needs the network.
const skip=process.platform==='win32'?false:'the installer is Windows-only';
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const repo=path.resolve(import.meta.dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'prh-inst-'));
process.on('exit',()=>{try{fs.rmSync(scratch,{recursive:true,force:true});}catch{}});
const run=(args,options={})=>spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass',...args],{encoding:'utf8',windowsHide:true,timeout:120000,...options});

// A minimal installation the uninstaller will accept: marker file, installer.json and copies of the scripts.
function fakeInstall(name){
  const base=path.join(scratch,name),app=path.join(base,'app'),data=path.join(base,'data'),shortcuts=path.join(base,'shortcuts');
  fs.mkdirSync(path.join(app,'installer'),{recursive:true});fs.mkdirSync(path.join(app,'sub','deeper'),{recursive:true});fs.mkdirSync(path.join(app,'node_modules','x'),{recursive:true});
  fs.mkdirSync(data,{recursive:true});fs.mkdirSync(shortcuts,{recursive:true});
  for(const f of ['remove.ps1','common.ps1'])fs.copyFileSync(path.join(repo,'installer',f),path.join(app,'installer',f));
  fs.writeFileSync(path.join(app,'.patent-research-hub-install'),'marker');fs.writeFileSync(path.join(app,'node_modules','x','a.js'),'x');
  fs.writeFileSync(path.join(data,'.patent-research-hub-data'),'marker');fs.writeFileSync(path.join(data,'keys.env'),'');
  const lnk=path.join(shortcuts,'Patent Research Hub - Uninstall.lnk');fs.writeFileSync(lnk,'x');
  fs.writeFileSync(path.join(app,'installer.json'),JSON.stringify({version:'0.1.0',data_root:data,shortcut_folder:shortcuts,shortcuts:[lnk],node:process.execPath,created_parent:false}));
  return {base,app,data,shortcuts};
}

test('Uninstall started inside the program folder (as the Start Menu shortcut did) deletes both folders',{skip},()=>{
  const f=fakeInstall('inside');
  // cwd = the program folder: this is what made Remove-Tree fail before the process's own directory was moved.
  const r=run(['-File',path.join(f.app,'installer','remove.ps1'),'-RemoveData','-Yes'],{cwd:f.app});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(!fs.existsSync(f.app),'program folder should be gone');assert.ok(!fs.existsSync(f.data),'data folder should be gone');
  assert.match(r.stdout,/Program folder DELETED/);assert.match(r.stdout,/Data folder DELETED/);
});

test('Uninstall that keeps the data says so explicitly',{skip},()=>{
  const f=fakeInstall('keep');
  const r=run(['-File',path.join(f.app,'installer','remove.ps1'),'-KeepData','-Yes'],{cwd:f.app});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(!fs.existsSync(f.app));assert.ok(fs.existsSync(path.join(f.data,'keys.env')),'data must be kept');
  assert.match(r.stdout,/Program folder DELETED/);assert.match(r.stdout,/Data folder KEPT/);
});

test('A program folder that cannot be deleted does not stop the data deletion, and both outcomes are reported',{skip},async()=>{
  const f=fakeInstall('locked');
  // A process whose current directory is inside the program folder pins it, like any program holding files open.
  const holder=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{cwd:path.join(f.app,'sub','deeper'),stdio:'ignore',windowsHide:true});
  try{
    await new Promise(r=>setTimeout(r,500));
    const r=run(['-File',path.join(f.app,'installer','remove.ps1'),'-RemoveData','-Yes'],{cwd:os.tmpdir()});
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.ok(fs.existsSync(f.app),'program folder cannot be removed while a process is inside it');
    assert.ok(!fs.existsSync(f.data),'the data deletion you asked for must still happen');
    assert.match(r.stdout,/Program folder NOT deleted/);assert.match(r.stdout,/Data folder DELETED/);
  }finally{holder.kill();await new Promise(r=>holder.once('exit',r));}
});

test('Setup refuses a program folder that contains the download folder (checked before anything is copied)',{skip},()=>{
  const dataRoot=path.join(scratch,'nest-data');
  for(const installRoot of [path.join(repo,'nested-install'),path.dirname(repo)]){
    const r=run(['-File',path.join(repo,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',installRoot,'-DataRoot',dataRoot,'-ShortcutFolder',path.join(scratch,'nest-sc')]);
    assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/download folder .* and the program folder .* must be separate/s);
  }
  assert.ok(!fs.existsSync(path.join(repo,'nested-install')));
});

test('Setup dry run accepts folders with non-ASCII names',{skip},()=>{
  const r=run(['-File',path.join(repo,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',path.join(scratch,'programme-é-日本'),'-DataRoot',path.join(scratch,'données-ü'),'-ShortcutFolder',path.join(scratch,'raccourcis-é')]);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/Dry run finished/);
});

test('shortcuts never start in the program folder, and Hub.cmd is UTF-8 under code page 65001',{skip},()=>{
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  assert.match(setup,/\$s\.WorkingDirectory = \$env:SystemRoot/);assert.doesNotMatch(setup,/WorkingDirectory = \$InstallRoot/);
  assert.match(setup,/'chcp 65001 >nul'/);assert.match(setup,/Write-Utf8NoBom \$paths\.HubCmd/);assert.doesNotMatch(setup,/Encoding\]::ASCII/);
});

test('Setup stops unless the access list is read back and only the user, SYSTEM and Administrators have access',{skip},()=>{
  const file=path.join(scratch,'acl-keys.env');fs.writeFileSync(file,'');
  const common=path.join(repo,'installer','common.ps1');
  const script=`. '${common}'
$f='${file}'
$null = & icacls.exe $f /grant '*S-1-5-32-545:R'
try { $null = Assert-PrhUserOnly $f; 'NO-THROW-BROAD' } catch { 'THROWS-BROAD' }
Set-PrhUserOnly $f
try { $null = Assert-PrhUserOnly $f; 'OK-AFTER-RESTRICT' } catch { 'THROWS-AFTER ' + $_.Exception.Message }`;
  const r=run(['-Command',script]);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const lines=r.stdout.split(/\r?\n/);
  assert.ok(lines.includes('THROWS-BROAD'),r.stdout);assert.ok(lines.includes('OK-AFTER-RESTRICT'),r.stdout);
});
