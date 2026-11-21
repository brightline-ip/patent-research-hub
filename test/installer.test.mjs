import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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
  return {base,app,data,shortcuts,lnk};
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
    // The marker, installer.json and the installer folder go last, so the removal can be run again; the advice names File Explorer.
    assert.ok(fs.existsSync(path.join(f.app,'.patent-research-hub-install')),'marker file must survive a partial failure');assert.ok(fs.existsSync(path.join(f.app,'installer','remove.ps1')));assert.ok(fs.existsSync(path.join(f.app,'installer.json')));
    assert.ok(!fs.existsSync(path.join(f.app,'node_modules')),'ordinary content is removed first');
    assert.match(r.stdout,/delete\s+that folder in File Explorer/);assert.match(r.stdout,/installer\\remove\.ps1/);
    assert.ok(fs.existsSync(f.lnk),'the Uninstall shortcut is kept while the program folder is still there');
  }finally{holder.kill();await new Promise(r=>holder.once('exit',r));}
});

// The installer limits the program folder path to 100 characters, so a repository checked out in a long path must not matter:
// the scripts are staged into a short scratch folder, which plays the part of the extracted download.
function stageDownload(name){
  const bundle=path.join(scratch,name,'dl');
  fs.cpSync(path.join(repo,'installer'),path.join(bundle,'installer'),{recursive:true});
  fs.mkdirSync(path.join(bundle,'src'),{recursive:true});fs.writeFileSync(path.join(bundle,'src','mcp.mjs'),'// placeholder');fs.writeFileSync(path.join(bundle,'package-lock.json'),'{}');
  return bundle;
}
test('Setup refuses a program folder that contains the download folder (checked before anything is copied)',{skip},()=>{
  const bundle=stageDownload('dl'),dataRoot=path.join(scratch,'nest-data');
  assert.ok(bundle.length<60,'the staged download must be at a short path: '+bundle);
  for(const installRoot of [path.join(bundle,'nested-install'),path.dirname(bundle)]){// the second contains the download folder
    const r=run(['-File',path.join(bundle,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',installRoot,'-DataRoot',dataRoot,'-ShortcutFolder',path.join(scratch,'nest-sc')]);
    assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/download folder .* and the program folder .* must be separate/s);
  }
  assert.ok(!fs.existsSync(path.join(bundle,'nested-install')));
});

test('Setup dry run accepts folders with non-ASCII names',{skip},()=>{
  const r=run(['-File',path.join(repo,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',path.join(scratch,'programme-é-日本'),'-DataRoot',path.join(scratch,'données-ü'),'-ShortcutFolder',path.join(scratch,'raccourcis-é')]);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/Dry run finished/);
});

test('shortcuts never start in the program folder, and Hub.cmd is UTF-8 under code page 65001',{skip},()=>{
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  assert.match(setup,/Save-PrhShortcut \$ShortcutFolder \$Name \$Target \$args2 \$env:SystemRoot/);assert.doesNotMatch(setup,/WorkingDirectory = \$InstallRoot/);
  const common=fs.readFileSync(path.join(repo,'installer','common.ps1'),'utf8');
  assert.match(common,/'chcp 65001 >nul'/);assert.match(setup,/Write-Utf8NoBom \$paths\.HubCmd/);assert.doesNotMatch(setup,/Encoding\]::ASCII/);
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

// ---- second review round --------------------------------------------------------------------------------------------------
const extended=p=>'\\\\?\\'+path.resolve(p);// \\?\ form: Node can create entries Windows' ordinary path rules refuse
function makeReserved(root){
  // A folder named like the legacy device CON (what research_checkpoint used to create), more reserved names, and one with a trailing dot.
  for(const name of ['CON','nul','aux.txt','trailing.'])fs.mkdirSync(extended(path.join(root,name)),{recursive:true});
  fs.writeFileSync(extended(path.join(root,'CON','a.json')),'{}');fs.writeFileSync(extended(path.join(root,'PRN')),'file');fs.writeFileSync(extended(path.join(root,'nul','deep.txt')),'x');
}

test('Uninstall deletes both folders even when they hold reserved device names (CON, PRN, NUL, a trailing dot)',{skip},()=>{
  const f=fakeInstall('reserved folder');// a space in the path as well
  makeReserved(path.join(f.data,'data','checkpoints'));makeReserved(path.join(f.app,'sub'));
  const r=run(['-File',path.join(f.app,'installer','remove.ps1'),'-RemoveData','-Yes'],{cwd:os.tmpdir()});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(!fs.existsSync(f.app),'program folder should be gone');assert.ok(!fs.existsSync(f.data),'data folder should be gone');
  assert.match(r.stdout,/Program folder DELETED/);assert.match(r.stdout,/Data folder DELETED/);
});

test('Remove-Tree falls back to \\\\?\\ paths, never follows a junction, and fails loudly instead of leaving a folder',{skip},()=>{
  const base=path.join(scratch,'tree'),outside=path.join(scratch,'tree-outside');
  fs.mkdirSync(path.join(base,'inner'),{recursive:true});fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(outside,'keep.txt'),'keep');
  makeReserved(path.join(base,'inner'));fs.symlinkSync(outside,path.join(base,'inner','link'),'junction');
  const script=`. '${path.join(repo,'installer','common.ps1')}'
$ErrorActionPreference = 'Stop'
Remove-Tree '${base}'
'REMOVED=' + (-not (Test-Path -LiteralPath '${base}'))`;
  const r=run(['-Command',script]);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/REMOVED=True/);
  assert.ok(fs.existsSync(path.join(outside,'keep.txt')),'the junction target must survive');
});

test('Remove-OwnedTree keeps the marker, installer.json and installer folder when something else cannot be removed',{skip},async()=>{
  const f=fakeInstall('partial');
  const holder=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{cwd:path.join(f.app,'sub','deeper'),stdio:'ignore',windowsHide:true});
  try{
    await new Promise(r=>setTimeout(r,500));
    const script=`. '${path.join(repo,'installer','common.ps1')}'
try { Remove-OwnedTree '${f.app}' @('installer', 'installer.json', '.patent-research-hub-install'); 'NO-THROW' } catch { 'THROWS' }`;
    const r=run(['-Command',script]);
    assert.match(r.stdout,/THROWS/);
    for(const keep of ['.patent-research-hub-install','installer.json'])assert.ok(fs.existsSync(path.join(f.app,keep)),keep);
    assert.ok(fs.existsSync(path.join(f.app,'installer','common.ps1')));
  }finally{holder.kill();await new Promise(r=>holder.once('exit',r));}
  // Once nothing holds it, the same call finishes the job.
  const again=run(['-Command',`. '${path.join(repo,'installer','common.ps1')}'\nRemove-OwnedTree '${f.app}' @('installer', 'installer.json', '.patent-research-hub-install'); 'DONE'`]);
  assert.match(again.stdout,/DONE/);assert.ok(!fs.existsSync(f.app));
});

test('Stop-PrhProcesses survives an already-exited process under ErrorActionPreference Stop, and really stops a running one',{skip},async()=>{
  const common=path.join(repo,'installer','common.ps1');
  // 1. The list names a process that has already exited: taskkill writes to stderr and exits non-zero.
  const exited=run(['-Command',`$ErrorActionPreference = 'Stop'
. '${common}'
function Get-PrhProcesses([string]$Root) { if (-not $script:seen) { $script:seen = $true; return @(2147483000) } return @() }
try { $n = Stop-PrhProcesses 'C:\\nowhere'; 'RESULT=' + $n } catch { 'THREW ' + $_.Exception.Message }`]);
  assert.equal(exited.status,0,exited.stdout+exited.stderr);assert.match(exited.stdout,/RESULT=1/);assert.doesNotMatch(exited.stdout,/THREW/);
  // 2. A real Hub-like process (node running a script from this install's src folder) is stopped.
  const f=fakeInstall('stopreal');fs.mkdirSync(path.join(f.app,'src'),{recursive:true});fs.writeFileSync(path.join(f.app,'src','hold.mjs'),'setTimeout(()=>{},60000)');
  const holder=spawn(process.execPath,[path.join(f.app,'src','hold.mjs')],{stdio:'ignore',windowsHide:true});
  try{
    await new Promise(r=>setTimeout(r,800));
    const stopped=run(['-Command',`$ErrorActionPreference = 'Stop'\n. '${common}'\ntry { 'RESULT=' + (Stop-PrhProcesses '${f.app}') } catch { 'THREW ' + $_.Exception.Message }`]);
    assert.match(stopped.stdout,/RESULT=1/,stopped.stdout+stopped.stderr);
    await new Promise(r=>setTimeout(r,500));assert.notEqual(holder.exitCode===null&&holder.signalCode===null,true,'the process should be gone');
  }finally{holder.kill();}
});

test('icacls failures give a plain message instead of a raw error, even under ErrorActionPreference Stop',{skip},()=>{
  const missing=path.join(scratch,'no-such-folder','keys.env');
  const r=run(['-Command',`$ErrorActionPreference = 'Stop'\n. '${path.join(repo,'installer','common.ps1')}'\ntry { Set-PrhUserOnly '${missing}'; 'NO-THROW' } catch { 'MESSAGE=' + $_.Exception.Message }`]);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/MESSAGE=Could not reset the access list of the file or folder\. Make sure the folder is on an NTFS drive/);assert.doesNotMatch(r.stdout,/NativeCommandError|NO-THROW/);
});

test('an existing keys.env gets a protected, user-only access list in one step (also when already protected), and the read-back agrees',{skip},()=>{
  const file=path.join(scratch,'acl-existing.env'),folder=path.join(scratch,'acl-existing-folder');fs.writeFileSync(file,'KEY=');fs.mkdirSync(folder,{recursive:true});
  const common=path.join(repo,'installer','common.ps1');
  const script=`. '${common}'
$null = & icacls.exe '${file}' /grant '*S-1-5-32-545:R'
$null = & icacls.exe '${folder}' /grant '*S-1-5-32-545:(OI)(CI)R'
Set-PrhUserOnlyAcl '${file}'
Set-PrhUserOnlyAcl '${folder}' -Folder
# Again, now that both are already protected (the Repair case): a whole-descriptor Set-Acl fails here with a SeSecurityPrivilege error.
$null = & icacls.exe '${file}' /grant '*S-1-5-32-545:R'
$null = & icacls.exe '${folder}' /grant '*S-1-5-32-545:(OI)(CI)R'
Set-PrhUserOnlyAcl '${file}'
Set-PrhUserOnlyAcl '${folder}' -Folder
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($p in @('${file}', '${folder}')) {
  $acl = Get-Acl -LiteralPath $p
  $sids = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
  'ACL ' + (Split-Path $p -Leaf) + ' protected=' + $acl.AreAccessRulesProtected + ' entries=' + ($sids -join ',') + ' me=' + $me
}
'CONTENT=' + [IO.File]::ReadAllText('${file}')`;
  const r=run(['-Command',script]);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const me=/me=(S-[\d-]+)/.exec(r.stdout)[1];
  for(const leaf of ['acl-existing.env','acl-existing-folder'])assert.ok(r.stdout.includes(`ACL ${leaf} protected=True entries=${me} me=${me}`),r.stdout);
  assert.match(r.stdout,/CONTENT=KEY=/);
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  assert.match(setup,/Set-PrhUserOnlyAcl \$paths\.Keys/);assert.doesNotMatch(setup,/no account other than yours, SYSTEM and Administrators/);
});

test('Hub.cmd reads the caller\'s code page from the last word of chcp output, digits only (a trailing period or other wording must not break the restore)',{skip},()=>{
  const dir=path.join(scratch,'hubcmd');fs.mkdirSync(path.join(dir,'src'),{recursive:true});fs.mkdirSync(path.join(dir,'bin'),{recursive:true});
  fs.writeFileSync(path.join(dir,'src','cli.mjs'),'process.exit(7)');
  const common=path.join(repo,'installer','common.ps1');
  const gen=run(['-Command',`. '${common}'\n$p = Get-PrhPaths '${dir}' '${path.join(dir,'d')}'\n[IO.File]::WriteAllText('${path.join(dir,'Hub.cmd')}', (Get-PrhHubCmdText '${process.execPath}' $p))`]);
  assert.equal(gen.status,0,gen.stdout+gen.stderr);
  const hub=fs.readFileSync(path.join(dir,'Hub.cmd'),'utf8');
  assert.match(hub,/^if defined PRH_CP chcp %PRH_CP% >nul$/m);assert.doesNotMatch(hub,/tokens=2 delims=:/);
  // The lines that detect the code page, run against stand-in chcp programs that print like various Windows languages.
  const lines=hub.split(/\r?\n/),end=lines.indexOf('chcp 65001 >nul');assert.ok(end>3);
  const probe=path.join(dir,'probe.cmd');fs.writeFileSync(probe,[...lines.slice(0,end),'echo CP=[%PRH_CP%]',''].join('\r\n'));
  const bin=path.join(dir,'bin'),env={...process.env,PATH:bin+';'+process.env.PATH};
  const cases=[['Active code page: 850','850'],['Aktive Codepage: 850.','850'],['Page de codes active : 437','437'],['Текущая кодовая страница: 866','866'],['Aktif kod sayfası: 1254.','1254'],['something unexpected','']];
  for(const [printed,expected] of cases){
    fs.writeFileSync(path.join(bin,'chcp.cmd'),`@echo off\r\necho ${printed.replace(/[&<>|^]/g,'^$&')}\r\n`);
    const r=spawnSync('cmd.exe',['/d','/c',probe],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:60000});
    assert.match(r.stdout,new RegExp(`CP=\\[${expected}\\]`),`${printed} -> ${r.stdout}${r.stderr}`);
  }
  // The whole wrapper, with the real chcp, still passes the Hub's exit code on.
  const full=spawnSync('cmd.exe',['/d','/c',path.join(dir,'Hub.cmd'),'doctor'],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(full.status,7,full.stdout+full.stderr);
});

test('Hub.cmd gateway: keys.env is loaded for the child, a JSON request on stdin returns the envelope, and a test-module override is ignored',{skip},()=>{
  const dir=path.join(scratch,'hub gateway'),data=path.join(dir,'d');   // a space in the path: callers must quote it
  fs.mkdirSync(data,{recursive:true});fs.cpSync(path.join(repo,'src'),path.join(dir,'src'),{recursive:true});
  const common=path.join(repo,'installer','common.ps1');
  const gen=run(['-Command',`. '${common}'\n$p = Get-PrhPaths '${dir}' '${data}'\n[IO.File]::WriteAllText('${path.join(dir,'Hub.cmd')}', (Get-PrhHubCmdText '${process.execPath}' $p))`]);
  assert.equal(gen.status,0,gen.stdout+gen.stderr);
  const log=path.join(dir,'requests.jsonl'),marker=path.join(dir,'override-loaded.txt'),override=path.join(dir,'override.mjs');
  fs.writeFileSync(override,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'x');export const callGateway=async()=>({});`);
  const preload=pathToFileURL(path.join(repo,'test','fixtures','mock-provider-preload.mjs')).href;
  const env={...process.env,NODE_OPTIONS:`--import=${preload}`,PRH_MOCK_LOG:log,PATENT_RESEARCH_LIMITER_DIR:path.join(dir,'lim'),FRAME_GATEWAY_MODULE:override,PRH_MOCK_RULES:JSON.stringify([{match:'/applications/search',status:200,body:{count:0,patentFileWrapperDataBag:[]}}])};
  delete env.PATENT_RESEARCH_DATA_DIR;delete env.USPTO_API_KEY;
  const input=JSON.stringify({source:'odp',url:'https://api.uspto.gov/api/v1/patent/applications/search',method:'POST',body:{q:'x',pagination:{offset:0,limit:5}}});
  // The documented way to start a .cmd file: through cmd.exe /d /s /c with the whole command line in one quoted string.
  const call=()=>spawnSync('cmd.exe',['/d','/s','/c','""'+path.join(dir,'Hub.cmd')+'" gateway uspto --json-in"'],{cwd:dir,env,input,encoding:'utf8',windowsHide:true,timeout:60000,windowsVerbatimArguments:true});
  // No key anywhere: the child reports not_configured and sends nothing.
  fs.writeFileSync(path.join(data,'keys.env'),'USPTO_API_KEY=\n');
  const missing=call();assert.equal(missing.status,2,missing.stdout+missing.stderr);assert.equal(JSON.parse(missing.stdout).error.code,'not_configured');assert.ok(!fs.existsSync(log));
  // The key from keys.env reaches the child (and only the provider request).
  fs.writeFileSync(path.join(data,'keys.env'),'USPTO_API_KEY=fixture-key-from-keys-env\n');
  const ok=call();assert.equal(ok.status,0,ok.stdout+ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status,200);assert.ok(!ok.stdout.includes('fixture-key-from-keys-env')&&!ok.stderr.includes('fixture-key-from-keys-env'));
  assert.equal(JSON.parse(fs.readFileSync(log,'utf8').trim()).key,'fixture-key-from-keys-env');
  assert.ok(!fs.existsSync(marker),'FRAME_GATEWAY_MODULE must not be loaded');assert.ok(fs.existsSync(path.join(dir,'lim')),'limiter state lives in the limiter folder (PATENT_RESEARCH_LIMITER_DIR here; one per-user folder by default)');
});

test('winget "already installed" is not recorded as something Setup installed, and Uninstall asks with the stop notice',{skip},()=>{
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  assert.match(setup,/if \(\$code -eq -1978335189\) \{ return 'installed' \}\r?\n\s+if \(\$code -eq 0\) \{ \$script:WingetInstalled \+= \$Name; return 'installed' \}/);
  const remove=fs.readFileSync(path.join(repo,'installer','remove.ps1'),'utf8');
  assert.match(remove,/Read-YesNo 'Remove Patent Research Hub now\? Running Hub processes from this installation will be stopped\.'/);
  assert.match(setup,/Reinstalls the Node\.js packages, re-applies key file protection, refreshes the optional chart packages if installed, and rewrites Hub\.cmd/);
});
// ---- third review round ---------------------------------------------------------------------------------------------------
test('paths with , ; = & ^ in a space-free path: a locked file never makes the removal touch a sibling folder (no command shell is used)',{skip},async()=>{
  const common=path.join(repo,'installer','common.ps1');
  for(const odd of ['a,b','R&D','x;y','k=v','h^t']){
    const base=path.join(scratch,'odd-'+odd.replace(/\W/g,'_')),sibling=path.join(base,odd.split(/[,&;=^]/)[0]),target=path.join(base,odd,'x');
    fs.mkdirSync(sibling,{recursive:true});fs.writeFileSync(path.join(sibling,'precious.txt'),'keep');fs.mkdirSync(path.join(target,'deeper'),{recursive:true});
    makeReserved(target);fs.writeFileSync(path.join(target,'file.txt'),'x');
    const holder=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{cwd:path.join(target,'deeper'),stdio:'ignore',windowsHide:true});
    try{
      await new Promise(r=>setTimeout(r,400));
      const r=run(['-Command',`. '${common}'\n$ErrorActionPreference = 'Stop'\ntry { Remove-Tree '${target}'; 'REMOVED' } catch { 'FAILED' }`]);
      assert.match(r.stdout,/FAILED/,odd+' '+r.stdout+r.stderr);// the folder is held open, so the removal fails...
      assert.ok(fs.existsSync(path.join(sibling,'precious.txt')),`${odd}: the sibling folder must survive`);// ...and deletes nothing outside the target
    }finally{holder.kill();await new Promise(r=>holder.once('exit',r));}
    const ok=run(['-Command',`. '${common}'\nRemove-Tree '${target}'; 'REMOVED=' + (-not (Test-Path -LiteralPath '${target}'))`]);
    assert.match(ok.stdout,/REMOVED=True/,odd+' '+ok.stdout+ok.stderr);assert.ok(fs.existsSync(path.join(sibling,'precious.txt')));
  }
  assert.doesNotMatch(fs.readFileSync(common,'utf8'),/cmd\.exe/i);
});

test('Setup refuses , ; = & ^ (as well as " % !) in the program, data and shortcut folders',{skip},()=>{
  const bundle=stageDownload('dl-chars');
  for(const bad of ['a,b','R&D','x;y','k=v','h^t']){
    const odd=path.join(scratch,'chars-'+bad);
    for(const args of [['-InstallRoot',odd,'-DataRoot',path.join(scratch,'cd1')],['-InstallRoot',path.join(scratch,'ci1'),'-DataRoot',odd],['-InstallRoot',path.join(scratch,'ci2'),'-DataRoot',path.join(scratch,'cd2'),'-ShortcutFolder',odd]]){
      const r=run(['-File',path.join(bundle,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen',...args]);
      assert.equal(r.status,1,bad+' '+r.stdout+r.stderr);assert.match(r.stdout,/cannot contain/);
    }
  }
  assert.ok(!fs.existsSync(path.join(scratch,'ci1')));
});

test('a program or data folder that is itself a junction is unlinked and its target is left exactly as it is',{skip},()=>{
  const f=fakeInstall('linkroot'),real=path.join(f.base,'real-app'),realData=path.join(f.base,'real-data'),linkApp=path.join(f.base,'link-app'),linkData=path.join(f.base,'link-data');
  fs.renameSync(f.app,real);fs.renameSync(f.data,realData);
  fs.symlinkSync(real,linkApp,'junction');fs.symlinkSync(realData,linkData,'junction');
  fs.writeFileSync(path.join(real,'installer.json'),JSON.stringify({version:'0.1.0',data_root:linkData,shortcut_folder:f.shortcuts,shortcuts:[f.lnk],node:process.execPath,created_parent:false}));
  const r=run(['-File',path.join(linkApp,'installer','remove.ps1'),'-RemoveData','-Yes'],{cwd:os.tmpdir()});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(!fs.existsSync(linkApp)&&!fs.existsSync(linkData),'both links removed');
  assert.ok(fs.existsSync(path.join(real,'.patent-research-hub-install'))&&fs.existsSync(path.join(real,'node_modules','x','a.js'))&&fs.existsSync(path.join(real,'installer','remove.ps1')),'program target untouched');
  assert.ok(fs.existsSync(path.join(realData,'keys.env'))&&fs.existsSync(path.join(realData,'.patent-research-hub-data')),'data target untouched');
  assert.match(r.stdout,/Program folder was a link; the link was removed, its target was left as is/);assert.match(r.stdout,/Data folder was a link; the link was removed, its target was left as is/);
  assert.doesNotMatch(r.stdout,/Program folder DELETED|Data folder DELETED/);
});

test('Set-PrhUserOnlyAcl also works under PowerShell 7 on an already protected file',{skip:skip||(spawnSync('pwsh.exe',['-NoProfile','-Command','1'],{encoding:'utf8'}).status===0?false:'PowerShell 7 (pwsh) is not installed here')},()=>{
  const file=path.join(scratch,'acl-core.env'),folder=path.join(scratch,'acl-core-dir');fs.writeFileSync(file,'KEY=x');fs.mkdirSync(folder,{recursive:true});
  const script=`. '${path.join(repo,'installer','common.ps1')}'
foreach ($i in 1..2) {
  $null = & icacls.exe '${file}' /grant '*S-1-5-32-545:R'; $null = & icacls.exe '${folder}' /grant '*S-1-5-32-545:(OI)(CI)R'
  Set-PrhUserOnlyAcl '${file}'; Set-PrhUserOnlyAcl '${folder}' -Folder
}
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($p in @('${file}', '${folder}')) { $acl = Get-Acl -LiteralPath $p; 'ACL protected=' + $acl.AreAccessRulesProtected + ' entries=' + (@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) -join ',') + ' me=' + $me }
'PSEDITION=' + $PSVersionTable.PSEdition`;
  const r=spawnSync('pwsh.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PSEDITION=Core/);
  const me=/me=(S-[\d-]+)/.exec(r.stdout)[1];assert.equal((r.stdout.match(new RegExp(`protected=True entries=${me} me=${me}`,'g'))||[]).length,2,r.stdout);
});

test('no tracked text file contains control characters other than tab, CR and LF (a PowerShell backtick escape that slipped in)',()=>{
  const bad=[];
  const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(['node_modules','.git','_dist','.venv'].includes(e.name))continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory()){walk(p);continue;}
    if(/\.(zip|png|ico|jpg|pdf|sqlite|gz|tar)$/i.test(e.name))continue;
    const b=fs.readFileSync(p);if(b.includes(0))continue;
    for(let i=0;i<b.length;i++){const c=b[i];if(c<32&&c!==9&&c!==10&&c!==13){bad.push(`${path.relative(repo,p)} offset ${i} byte 0x${c.toString(16)}`);break;}}
  }};
  walk(repo);assert.deepEqual(bad,[]);
});
// ---- fourth round: shortcut folders outside the ANSI code page -------------------------------------------------------------
test('shortcuts can be saved into a folder whose path has characters outside the ANSI code page (saved in a plain path, then moved)',{skip},()=>{
  const parent=path.join(scratch,'C-é-日本','sc-日本');fs.mkdirSync(parent,{recursive:true});
  const common=path.join(repo,'installer','common.ps1'),dataDir=path.join(scratch,'dat-日本');fs.mkdirSync(dataDir,{recursive:true});
  const script=`[Console]::OutputEncoding = [Text.Encoding]::UTF8
. '${common}'
$folder = '${parent}'
'PREFLIGHT=[' + (Test-PrhShortcutFolder $folder @([IO.Path]::GetTempPath())) + ']'
'PREFLIGHT-NEW=[' + (Test-PrhShortcutFolder (Join-Path $folder 'not-yet\\child') @([IO.Path]::GetTempPath())) + ']'
$safe = Get-PrhAnsiSafePath '${dataDir}'
'SAFE=' + [bool]$safe + ' ANSIOK=' + ($safe -cmatch '^[\\x20-\\x7e\\u00a0-\\u00ff]+$')
$lnk = Save-PrhShortcut $folder 'Patent Research Hub - Check' (Join-Path $env:SystemRoot 'explorer.exe') ('"' + $safe + '"') $env:SystemRoot 'test' $null @([IO.Path]::GetTempPath())
'EXISTS=' + [IO.File]::Exists($lnk)
'LEFTOVER=' + @([IO.Directory]::GetFiles($folder, 'prh-test-*')).Count
$copy = Join-Path ([IO.Path]::GetTempPath()) ('prh-copy-' + [Guid]::NewGuid().ToString('N') + '.lnk'); [IO.File]::Copy($lnk, $copy)
'ARGS=' + (New-Object -ComObject WScript.Shell).CreateShortcut($copy).Arguments
Remove-Item -LiteralPath $copy -Force`;
  const r=run(['-Command',script]);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/PREFLIGHT=\[\]/);assert.match(r.stdout,/PREFLIGHT-NEW=\[\]/);assert.match(r.stdout,/SAFE=True ANSIOK=True/);
  assert.match(r.stdout,/EXISTS=True/);assert.match(r.stdout,/LEFTOVER=0/);
  assert.match(r.stdout,/ARGS="[^"?]+"/,'the stored argument must not contain "?" placeholders');
  assert.ok(fs.existsSync(path.join(parent,'Patent Research Hub - Check.lnk')));
});

test('Setup stops before creating anything when shortcuts cannot be created in the shortcut folder; a CJK shortcut folder passes the preflight',{skip},()=>{
  const bundle=stageDownload('dl-lnk');
  const base=['-File',path.join(bundle,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',path.join(scratch,'lnk-app'),'-DataRoot',path.join(scratch,'lnk-dat')];
  const ok=run([...base,'-ShortcutFolder',path.join(scratch,'C-é-日本','sc-日本')]);
  assert.equal(ok.status,0,ok.stdout+ok.stderr);assert.match(ok.stdout,/Dry run finished/);
  const drive=['Q','R','S','T','U','V','W'].find(l=>!fs.existsSync(l+':\\'));
  if(drive){
    const bad=run([...base,'-ShortcutFolder',drive+':\\no\\sc']);
    assert.equal(bad.status,1,bad.stdout+bad.stderr);assert.match(bad.stdout,/Shortcuts cannot be created in .*Nothing was installed.*-ShortcutFolder.*basic Latin/s);
  }
  assert.ok(!fs.existsSync(path.join(scratch,'lnk-app'))&&!fs.existsSync(path.join(scratch,'lnk-dat')));
});

test('Setup writes installer.json (and has the marker) before it creates shortcuts, so installer\\remove.ps1 works after any later failure',{skip},()=>{
  const setup=fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8');
  const config=setup.indexOf('Write-Utf8NoBom $paths.Config'),firstShortcut=setup.indexOf("(New-PrhShortcut 'Patent Research Hub - Check'"),marker=setup.indexOf('Write-Utf8NoBom $paths.Marker');
  assert.ok(marker>0&&config>marker&&firstShortcut>config,`marker ${marker}, config ${config}, shortcuts ${firstShortcut}`);
  assert.match(setup,/\$config\.shortcuts = @\(\$shortcuts\)/);
});

test('Uninstall says the data folder is not present, rather than kept, when it no longer exists',{skip},()=>{
  const f=fakeInstall('nodata');fs.rmSync(f.data,{recursive:true,force:true});
  const r=run(['-File',path.join(f.app,'installer','remove.ps1'),'-KeepData','-Yes'],{cwd:os.tmpdir()});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/Data folder not present/);assert.doesNotMatch(r.stdout,/Data folder KEPT/);
});
test('a file anywhere on the shortcut folder path stops Setup before anything is created',{skip},()=>{
  const bundle=stageDownload('dl-file');const blocker=path.join(scratch,'afile.txt');fs.writeFileSync(blocker,'x');
  const r=run(['-File',path.join(bundle,'installer','setup.ps1'),'-DryRun','-NoOptional','-NoOpen','-InstallRoot',path.join(scratch,'fapp'),'-DataRoot',path.join(scratch,'fdat'),'-ShortcutFolder',path.join(blocker,'sc')]);
  assert.equal(r.status,1,r.stdout+r.stderr);assert.match(r.stdout,/afile\.txt is a file, not a folder.*Nothing was installed/s);
  assert.ok(!fs.existsSync(path.join(scratch,'fapp'))&&!fs.existsSync(path.join(scratch,'fdat')));
  const direct=run(['-Command',`. '${path.join(repo,'installer','common.ps1')}'\n'R=[' + (Test-PrhShortcutFolder '${path.join(blocker,'a','b')}' @([IO.Path]::GetTempPath())) + ']'`]);
  assert.match(direct.stdout,/R=\[.*is a file, not a folder/);
});

test('installer.json and Hub settings written with a byte order mark are read; the Repair shortcut does not open the guide',{skip},()=>{
  const f=fakeInstall('bominstall');const json=fs.readFileSync(path.join(f.app,'installer.json'));
  fs.writeFileSync(path.join(f.app,'installer.json'),Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),json]));
  const r=run(['-Command',`. '${path.join(repo,'installer','common.ps1')}'\n$c = Read-PrhConfig '${f.app}'\n'DATA=' + $c.data_root`]);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.ok(r.stdout.includes('DATA='+f.data),r.stdout);
  const rm=run(['-File',path.join(f.app,'installer','remove.ps1'),'-RemoveData','-Yes'],{cwd:os.tmpdir()});
  assert.equal(rm.status,0,rm.stdout+rm.stderr);assert.ok(!fs.existsSync(f.data),'the BOM installer.json still names the data folder');
  assert.match(fs.readFileSync(path.join(repo,'installer','setup.ps1'),'utf8'),/Get-PsArgs 'setup\.ps1' '-Repair -NoOpen'/);
});