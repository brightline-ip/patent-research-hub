<#
.SYNOPSIS
  Installs Patent Research Hub for the current Windows user. Started by Setup.cmd.

.DESCRIPTION
  Copies the Hub into a per-user program folder, installs its Node.js packages from package-lock.json, creates a
  separate data folder (database, exports, settings and a keys file readable only by your account), writes MCP
  setup snippets for AI assistants and adds Start Menu shortcuts. It installs no service, scheduled task or
  background process, asks for no key and edits no AI assistant configuration.
  Missing programs are explained and offered through winget; nothing is installed without your "yes".
  Re-running Setup (or the Repair shortcut) repairs or updates the installation and keeps your data, settings and keys.
  No administrator rights are needed.

.PARAMETER InstallRoot
  Program folder. Default: %LOCALAPPDATA%\Brightline\PatentResearchHub
.PARAMETER DataRoot
  Data folder (database, exports, config.json, keys.env). Default: %LOCALAPPDATA%\Brightline\PatentResearchHub-Data
.PARAMETER ShortcutFolder
  Where shortcuts go. Default: Start Menu, folder "Patent Research Hub".
.PARAMETER DryRun
  Check this computer and show what Setup would do, without installing, writing or starting anything.
.PARAMETER SimulateMissing
  With -DryRun only: pretend these programs are missing (Node, Python).
.PARAMETER NoOptional
  Do not offer Python or the optional chart packages. Never approves installing software.
.PARAMETER NoOpen
  Do not open the getting-started guide in Notepad at the end.
.PARAMETER Repair
  Started from the Repair shortcut: read the folders from this installation's settings and wait for Enter at the end.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Brightline\PatentResearchHub'),
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'Brightline\PatentResearchHub-Data'),
    [string]$ShortcutFolder = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Patent Research Hub'),
    [switch]$DryRun,
    [string[]]$SimulateMissing = @(),
    [switch]$NoOptional,
    [switch]$NoOpen,
    [switch]$Repair
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$bundle = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Accept "-SimulateMissing Node,Python" from both -File (one string) and -Command (an array).
$SimulateMissing = @($SimulateMissing | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($item in $SimulateMissing) { if ($item -notin @('Node', 'Python')) { throw "-SimulateMissing accepts Node and Python (got '$item')." } }
if ($SimulateMissing.Count -and -not $DryRun) { throw '-SimulateMissing can only be used together with -DryRun.' }

$script:WingetInstalled = @()

function Get-WingetArgs([string]$Id) {
    return @('install', '--id', $Id, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements')
}

# Explain a missing program and, after an explicit yes, install it with winget.
# Returns 'installed', 'declined', 'failed' or 'dryrun'.
function Request-Program([string]$Name, [string]$Id, [string[]]$Why, [string]$ManualUrl) {
    foreach ($line in $Why) { Write-Info $line }
    Write-Info 'Setup can install it with Windows Package Manager (free; no account needed):'
    Write-Info ('    winget ' + ((Get-WingetArgs $Id) -join ' '))
    Write-Info "Or install it yourself from $ManualUrl and run Setup again."
    if ($DryRun) { Write-Info "[dry run] Setup would ask: Install $Name now?"; return 'dryrun' }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Bad 'Windows Package Manager (winget) is not available. Install "App Installer" from the Microsoft Store, or use the link above.'
        return 'failed'
    }
    if (-not (Read-YesNo "Install $Name now?" $false)) { return 'declined' }
    Write-Info "Installing $Name. Windows may ask for permission; choose Yes."
    & $winget.Source @(Get-WingetArgs $Id)
    $code = $LASTEXITCODE
    Update-SessionPath
    # -1978335189 (0x8A15002B): already installed, no applicable upgrade. Nothing was installed then, so it is not recorded as something Setup installed.
    if ($code -eq -1978335189) { return 'installed' }
    if ($code -eq 0) { $script:WingetInstalled += $Name; return 'installed' }
    Write-Bad "winget reported an error ($code) while installing $Name."
    return 'failed'
}

function Test-PrhFolder([string]$Path, [string]$Label, [int]$MaxLength) {
    if ($Path.IndexOfAny([char[]]'"%!&,;=^') -ge 0) { throw "The $Label path cannot contain any of these characters: "" % ! & , ; = ^ . Choose another folder." }
    if ($Path.Length -gt $MaxLength) { throw "The $Label path is too long (at most $MaxLength characters, so the files inside stay under the Windows path limit). Choose a shorter folder." }
    $drive = [IO.Path]::GetPathRoot($Path)
    if (-not $drive -or $drive.StartsWith('\\')) { throw "The $Label must be on a local drive, not a network path." }
    if ($Path.TrimEnd('\') -ieq $drive.TrimEnd('\')) { throw "The $Label cannot be the root of a drive." }
    $info = New-Object IO.DriveInfo($drive)
    # Your keys file and research data rely on NTFS permissions.
    if ($info.DriveFormat -notin @('NTFS', 'ReFS')) { throw "The $Label is on a $($info.DriveFormat) drive, which cannot restrict access to your files. Choose an NTFS drive." }
    return $info
}

function New-PrhShortcut([string]$Name, [string]$Target, [string]$Arguments, [string]$Description, [string]$Icon) {
    New-Item -ItemType Directory -Force -Path $ShortcutFolder | Out-Null
    $lnk = Join-Path $ShortcutFolder ($Name + '.lnk')
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $s.TargetPath = $Target
    $s.Arguments = $Arguments
    # Never the program folder: a process whose current directory is inside it blocks Uninstall and Repair from deleting it.
    $s.WorkingDirectory = $env:SystemRoot
    $s.Description = $Description
    $s.IconLocation = "$env:SystemRoot\System32\$Icon"
    $s.Save()
    return $lnk
}

function Get-PsArgs([string]$Script, [string]$Extra = '') {
    $a = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot "installer\$Script") + '"'
    if ($Extra) { $a += ' ' + $Extra }
    return $a
}

$exit = 0
try {
    if ($Repair) {
        # The Repair shortcut runs this script inside the installation: use its recorded folders.
        if (-not (Test-Path -LiteralPath (Join-Path $bundle $script:PrhMarker) -PathType Leaf)) { throw 'The Repair shortcut must run from an installed copy.' }
        $recorded = Read-PrhConfig $bundle
        $InstallRoot = $bundle
        $DataRoot = [string]$recorded.data_root
        $ShortcutFolder = [string]$recorded.shortcut_folder
    }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
    $ShortcutFolder = [IO.Path]::GetFullPath($ShortcutFolder).TrimEnd('\')
    $paths = Get-PrhPaths $InstallRoot $DataRoot

    Write-Host ''
    Write-Host "Patent Research Hub - Setup (public preview $script:PrhVersion)" -ForegroundColor White
    Write-Info 'Retrieves public US patent and legal sources for an AI assistant or the command line, and keeps a local record.'
    Write-Info "Program folder: $InstallRoot"
    Write-Info "Data folder:    $DataRoot"

    # ---- 1. This computer --------------------------------------------------------------------
    Write-Step 'Step 1 of 5: Checking this computer and the folders'
    if (-not [Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) { throw 'Patent Research Hub needs 64-bit Windows 10 or 11.' }
    if (-not (Test-Path -LiteralPath (Join-Path $bundle 'src\mcp.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $bundle 'package-lock.json'))) {
        throw 'The download is incomplete. Extract the whole zip file (right-click, Extract All) and run Setup.cmd from the extracted folder.'
    }
    # node_modules paths under the program folder reach about 120 characters; the Windows limit is 260.
    $info = Test-PrhFolder $InstallRoot 'program folder' 100
    $null = Test-PrhFolder $DataRoot 'data folder' 120
    if ($ShortcutFolder.IndexOfAny([char[]]'"%!&,;=^') -ge 0) { throw 'The shortcut folder path cannot contain any of these characters: " % ! & , ; = ^' }
    $a = $InstallRoot + '\'; $b = $DataRoot + '\'
    if ($a.StartsWith($b, [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The program folder and the data folder must be separate (neither inside the other), so uninstalling never touches your data.'
    }
    foreach ($forbidden in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('Desktop'))) {
        if ($forbidden -and ($InstallRoot -ieq $forbidden.TrimEnd('\') -or $DataRoot -ieq $forbidden.TrimEnd('\'))) { throw "Choose a dedicated folder, not $forbidden itself." }
    }
    $hadInstall = Test-Path -LiteralPath $paths.Marker -PathType Leaf
    if ($bundle -ieq $InstallRoot -and -not $hadInstall) { throw 'Run Setup.cmd from the extracted download, not from inside the program folder.' }
    # The program folder is mirrored from the download folder (files only in the program folder are deleted), so the
    # two must not contain one another.
    $dl = $bundle + '\'; $pf = $InstallRoot + '\'
    if ($bundle -ine $InstallRoot -and ($dl.StartsWith($pf, [StringComparison]::OrdinalIgnoreCase) -or $pf.StartsWith($dl, [StringComparison]::OrdinalIgnoreCase))) {
        throw "The download folder ($bundle) and the program folder ($InstallRoot) must be separate (neither inside the other), because Setup replaces the program folder's contents with the download. Move the extracted download elsewhere or choose another -InstallRoot."
    }
    if (-not $hadInstall -and (Test-Path -LiteralPath $InstallRoot) -and (Get-ChildItem -LiteralPath $InstallRoot -Force | Select-Object -First 1)) {
        throw "$InstallRoot already has files that Setup did not put there. Choose an empty folder with -InstallRoot."
    }
    $hadData = Test-Path -LiteralPath $paths.DataMarker -PathType Leaf
    if (-not $hadData -and (Test-Path -LiteralPath $DataRoot) -and (Get-ChildItem -LiteralPath $DataRoot -Force | Select-Object -First 1)) {
        throw "$DataRoot already has files that Setup did not put there. Choose an empty folder with -DataRoot."
    }
    if ($info.AvailableFreeSpace -lt 1GB) { Write-Warn2 ("Only {0:N1} GB free. Allow at least 1 GB plus room for your research data." -f ($info.AvailableFreeSpace / 1GB)) }
    Write-Good ('Windows ' + [Environment]::OSVersion.Version.ToString() + ', 64-bit; folders are on ' + $info.DriveFormat)
    if ($hadInstall) { Write-Info 'An earlier installation was found: Setup will repair or update it and keep your data, settings and keys.' }
    if ($hadData) { Write-Info 'Your existing data folder will be kept as it is.' }

    # ---- 2. Programs --------------------------------------------------------------------------
    Write-Step 'Step 2 of 5: Checking programs'
    $node = if ('Node' -in $SimulateMissing) { $null } else { Find-PrhNode }
    if (-not $node -or -not $node.NewEnough -or -not $node.Npm) {
        if ($node -and -not $node.NewEnough) { Write-Warn2 "Node.js $($node.Version) is installed, but the Hub needs $script:PrhMinNode or newer." }
        elseif ($node) { Write-Warn2 'Node.js was found without npm.' }
        else { Write-Warn2 'Node.js was not found (required).' }
        $r = Request-Program 'Node.js LTS' 'OpenJS.NodeJS.LTS' @('The Hub is written for Node.js: it runs its MCP server and command line, and keeps its database with Node''s built-in SQLite.', 'Node.js is free, open-source software.') 'https://nodejs.org/'
        if ($r -eq 'installed') { $node = Find-PrhNode }
        if ($r -ne 'dryrun' -and (-not $node -or -not $node.NewEnough -or -not $node.Npm)) {
            throw "Node.js $script:PrhMinNode or newer (with npm) is required. Install it and run Setup again. If you just installed it, close this window and run Setup again."
        }
    }
    if ($node -and $node.NewEnough) { Write-Good "Node.js $($node.Version) ($($node.Exe))" }

    $python = $null; $wantCharts = $false
    $hasVenv = Test-Path -LiteralPath $paths.Venv -PathType Leaf
    if (-not $NoOptional) {
        $python = if ('Python' -in $SimulateMissing) { $null } else { Find-PrhPython }
        if (-not $python) {
            Write-Info 'Python 3.12 or newer was not found. It is OPTIONAL.'
            $r = Request-Program 'Python 3.12 (optional)' 'Python.Python.3.12' @('Python draws the charts in exported reports (reports are still produced without it, just with no chart) and prepares the PatentsView dataset (see docs\PATENTSVIEW.md).', 'Everything else works without it. Python is free, open-source software.') 'https://www.python.org/downloads/windows/'
            if ($r -eq 'installed') { $python = Find-PrhPython }
            if (-not $python -and $r -ne 'dryrun') { Write-Info 'Continuing without Python. Run Setup again later to add it.' }
        }
        if ($python) {
            Write-Good "Python $($python.Version) ($($python.Exe)) - optional"
            if ($hasVenv) { $wantCharts = $true; Write-Info 'The chart packages are already set up; Setup will refresh them.' }
            else {
                Write-Info 'Charts in reports need matplotlib. Setup can put it in a private environment inside the program folder'
                Write-Info '(about 60 MB from the Python Package Index, versions pinned in requirements.txt). Optional.'
                if ($DryRun) { Write-Info '[dry run] Setup would ask: Set up the chart packages now?' }
                else { $wantCharts = Read-YesNo 'Set up the optional chart packages now?' $false }
            }
        }
    } else { Write-Info 'Skipping the optional Python check (-NoOptional).' }

    # ---- 3. Running copies --------------------------------------------------------------------
    Write-Step 'Step 3 of 5: Checking for running copies of this installation'
    $running = if ($hadInstall) { @(Get-PrhProcesses $InstallRoot) } else { @() }
    if ($running.Count) {
        Write-Info "$($running.Count) Hub process(es) from this installation are running, probably started by an AI assistant."
        Write-Info 'They hold files that Setup must replace, so they have to stop first. Stopping them ends them immediately (a search or'
        Write-Info 'download in progress is cut off; saved records are not affected). Your AI assistant starts the Hub again when needed.'
        Write-Info 'Only processes running files from this program folder are stopped; nothing else is touched.'
        if ($DryRun) { Write-Info '[dry run] Setup would ask: Stop them now?' }
        elseif (Read-YesNo 'Stop them now?' $false) {
            $null = Stop-PrhProcesses $InstallRoot
            Start-Sleep -Seconds 1
            Write-Good 'Stopped them so the files can be updated. Restart your AI assistant if it does not reconnect by itself.'
        } else {
            throw 'Setup did not change anything because the running Hub processes were left running. Quit your AI assistant (or let any running search finish), then run Setup again.'
        }
    } else { Write-Good 'None running' }

    if ($DryRun) {
        Write-Host ''
        Write-Good 'Dry run finished. Nothing was changed.'
        Write-Info "Setup would copy the program to $InstallRoot and run: npm ci --omit=dev --ignore-scripts"
        Write-Info "It would create $DataRoot (readable only by your account) with config.json and an empty keys.env,"
        Write-Info "write MCP-setup.json and MCP-setup.codex.toml, and add shortcuts in $ShortcutFolder."
        exit 0
    }

    # ---- 4. Install ---------------------------------------------------------------------------
    Write-Step 'Step 4 of 5: Installing (downloads the npm packages; allow a minute or two)'
    $createdParent = $false
    $parent = Split-Path -Parent $InstallRoot
    if (-not $hadInstall) {
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { $createdParent = $true }
    } else {
        try { $createdParent = [bool](Read-PrhConfig $InstallRoot).created_parent } catch {}
    }
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    if (-not $hadInstall) { Write-Utf8NoBom $paths.Marker "Patent Research Hub program folder. The uninstaller removes only folders that contain this file.`r`n" }
    New-Item -ItemType Directory -Force -Path $paths.Logs | Out-Null
    if ($bundle -ine $InstallRoot) {
        $null = & robocopy.exe $bundle $InstallRoot /MIR /XJ /XD .git node_modules .venv .npm-cache logs data exports /XF installer.json MCP-setup.json MCP-setup.codex.toml Hub.cmd GETTING-STARTED.txt config.json .env keys.env $script:PrhMarker /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "Copying the program files failed (robocopy code $LASTEXITCODE)." }
    }
    # Clear the "downloaded from the Internet" mark on the copies this installation runs.
    Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Include *.ps1, *.cmd, *.mjs, *.cjs, *.js, *.py | Unblock-File -ErrorAction SilentlyContinue
    if ($bundle -ine $InstallRoot) { Write-Good 'Program files copied' } else { Write-Good 'Program files left as they are (Repair does not replace them)' }

    $log = Join-Path $paths.Logs 'install.log'
    if ($hadInstall) { Write-Warn2 'Updating: the Node.js packages are removed and downloaded again. If that download fails, the Hub stays unusable until Setup is run again (Setup.cmd, or the Repair shortcut).' }
    Push-Location -LiteralPath $InstallRoot
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        # Exact versions from package-lock.json; no install scripts run; the download cache stays in the program folder.
        & $node.Npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache $paths.NpmCache *> $log
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old; Pop-Location }
    if ($code -ne 0) {
        $after = if ($hadInstall) { ' WARNING: npm removes the old packages before installing, so the Hub is UNUSABLE until the install succeeds. When your connection works, run Setup.cmd again from the download (or the "Patent Research Hub - Repair" shortcut). Your data, settings and keys were not touched.' } else { ' Run Setup again when your connection works.' }
        throw "npm ci failed (code $code). Check your internet connection. Details: $log.$after"
    }
    Write-Good 'Node.js packages installed from package-lock.json'

    if ($wantCharts) {
        $pyLog = Join-Path $paths.Logs 'python.log'
        $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            if (-not (Test-Path -LiteralPath $paths.Venv -PathType Leaf)) { & $python.Exe -m venv (Join-Path $InstallRoot '.venv') *> $pyLog }
            if (Test-Path -LiteralPath $paths.Venv -PathType Leaf) {
                & $paths.Venv -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -r (Join-Path $InstallRoot 'requirements.txt') *>> $pyLog
                $pyCode = $LASTEXITCODE
            } else { $pyCode = 1 }
        } finally { $ErrorActionPreference = $old }
        if ($pyCode -eq 0) { Write-Good 'Chart packages installed (optional)' }
        else { Write-Warn2 "The optional chart packages could not be installed; everything else works. Details: $pyLog" }
    }

    # Data folder: created by Setup and readable only by your account, before anything is written into it.
    if (-not $hadData) {
        New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
        Set-PrhUserOnly $DataRoot -Folder
        Write-Good 'Data folder created (access list read back: inheritance off, only your account has access)'
        Write-Utf8NoBom $paths.DataMarker "Patent Research Hub data folder (database, exports, settings, keys). The uninstaller deletes it only if you ask.`r`n"
    } else {
        try { $null = Assert-PrhUserOnly $DataRoot }
        catch { Write-Warn2 "Your existing data folder is not private to your account. Setup did not change it. $($_.Exception.Message)" }
    }
    New-Item -ItemType Directory -Force -Path $paths.Data | Out-Null
    New-Item -ItemType Directory -Force -Path $paths.Exports | Out-Null

    if (-not (Test-Path -LiteralPath $paths.HubConfig -PathType Leaf)) {
        $json = [IO.File]::ReadAllText((Join-Path $InstallRoot 'config.example.json'))
        $esc = { param($p) $p.Replace('\', '\\') }
        $json = $json.Replace('"dataDir": ""', '"dataDir": "' + (& $esc $paths.Data) + '"').Replace('"exportsDir": ""', '"exportsDir": "' + (& $esc $paths.Exports) + '"')
        $check = $json | ConvertFrom-Json
        if ($check.googleBigQueryExecutionEnabled -ne $false -or $check.googleBigQueryDryRunEnabled -ne $true) { throw 'config.example.json does not keep BigQuery in dry-run mode; refusing to continue.' }
        Write-Utf8NoBom $paths.HubConfig $json
        Write-Good 'Settings file created (BigQuery stays in dry-run mode: byte estimates only, no data queries)'
    } else { Write-Good 'Existing settings file kept' }

    if (-not (Test-Path -LiteralPath $paths.Keys -PathType Leaf)) {
        # Restrict the file before anything goes into it.
        [IO.File]::Create($paths.Keys).Dispose()
        Set-PrhUserOnly $paths.Keys
        $example = [IO.File]::ReadAllText((Join-Path $InstallRoot '.env.example')) -replace "`r`n", "`n"
        $start = $example.IndexOf('# --- Provider credentials')
        $end = $example.IndexOf('# --- Locations and options')
        if ($start -lt 0 -or $end -le $start) { throw '.env.example has an unexpected layout.' }
        $header = @(
            '# Patent Research Hub keys. Every key is optional; a source without its key reports "not configured".',
            '# This file is readable only by your Windows account. Put one value after each = sign, with no quotes,',
            '# and save. If a value contains a # character, wrap the value in single quotes.',
            '# The Check shortcut and the MCP setup that Setup wrote load this file; nothing else reads it.',
            '# Never paste keys into chat or into tool arguments. Delete a value to stop using that source.',
            ''
        ) -join "`n"
        $text = ($header + "`n" + $example.Substring($start, $end - $start).TrimEnd() + "`n") -replace "`n", "`r`n"
        [IO.File]::WriteAllText($paths.Keys, $text, (New-Object Text.UTF8Encoding $false))
        Write-Good 'Keys file created, readable only by your account (empty: no keys are set)'
    } else {
        Set-PrhUserOnlyAcl $paths.Keys
        Write-Good 'Existing keys file kept (access list set in one step and read back: inheritance off, only your account has access)'
    }

    # Command-line wrapper (see Get-PrhHubCmdText in common.ps1).
    Write-Utf8NoBom $paths.HubCmd (Get-PrhHubCmdText $node.Exe $paths)

    # MCP setup snippets. Keys stay in keys.env; the snippets hold only paths.
    $envBlock = [ordered]@{ PATENT_RESEARCH_CONFIG = $paths.HubConfig; PATENT_RESEARCH_DATA_DIR = $paths.Data; PATENT_RESEARCH_EXPORTS_DIR = $paths.Exports }
    $mcpArgs = @(('--env-file-if-exists=' + $paths.Keys), $paths.Mcp)
    $mcp = [ordered]@{ mcpServers = [ordered]@{ patent_research = [ordered]@{ command = $node.Exe; args = $mcpArgs; env = $envBlock } } }
    Write-Utf8NoBom $paths.McpJson (($mcp | ConvertTo-Json -Depth 6) + "`r`n")
    $toml = @(
        '# Patent Research Hub for Codex: add these lines to %USERPROFILE%\.codex\config.toml',
        '[mcp_servers.patent_research]',
        ('command = ' + (ConvertTo-TomlString $node.Exe)),
        ('args = [' + (($mcpArgs | ForEach-Object { ConvertTo-TomlString $_ }) -join ', ') + ']'),
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 240',
        '',
        '[mcp_servers.patent_research.env]',
        ('PATENT_RESEARCH_CONFIG = ' + (ConvertTo-TomlString $paths.HubConfig)),
        ('PATENT_RESEARCH_DATA_DIR = ' + (ConvertTo-TomlString $paths.Data)),
        ('PATENT_RESEARCH_EXPORTS_DIR = ' + (ConvertTo-TomlString $paths.Exports)),
        ''
    ) -join "`r`n"
    Write-Utf8NoBom $paths.McpToml $toml

    $guide = [IO.File]::ReadAllText((Join-Path $InstallRoot 'installer\GETTING-STARTED.template.txt'))
    $guide = $guide.Replace('{{ROOT}}', $InstallRoot).Replace('{{DATA}}', $DataRoot).Replace('{{KEYS}}', $paths.Keys).Replace('{{CONFIG}}', $paths.HubConfig)
    Write-Utf8NoBom $paths.Guide $guide
    Write-Good 'MCP setup files and getting-started guide written (no AI assistant configuration was changed)'

    # ---- 5. Shortcuts and check ---------------------------------------------------------------
    Write-Step 'Step 5 of 5: Shortcuts and first check'
    $shortcuts = @(
        (New-PrhShortcut 'Patent Research Hub - Check' $PowerShellExe (Get-PsArgs 'check.ps1') 'Show which sources are ready (names only, never key values)' 'shell32.dll,23'),
        (New-PrhShortcut 'Patent Research Hub - Data folder' (Join-Path $env:SystemRoot 'explorer.exe') ('"' + $DataRoot + '"') 'Open your research data, settings and keys file' 'shell32.dll,3'),
        (New-PrhShortcut 'Patent Research Hub - Documentation' (Join-Path $env:SystemRoot 'System32\notepad.exe') ('"' + $paths.Guide + '"') 'Getting started: where keys go, MCP setup, documentation' 'shell32.dll,1'),
        (New-PrhShortcut 'Patent Research Hub - Repair' $PowerShellExe (Get-PsArgs 'setup.ps1' '-Repair') 'Reinstalls the Node.js packages, re-applies key file protection, refreshes the optional chart packages if installed, and rewrites Hub.cmd, MCP files, guide and shortcuts; program files, data and keys are not replaced' 'shell32.dll,238'),
        (New-PrhShortcut 'Patent Research Hub - Uninstall' $PowerShellExe (Get-PsArgs 'remove.ps1') 'Remove Patent Research Hub' 'shell32.dll,31')
    )
    Write-Good "Shortcuts created in $ShortcutFolder"

    $config = [ordered]@{ version = $script:PrhVersion; data_root = $DataRoot; shortcut_folder = $ShortcutFolder; shortcuts = @($shortcuts); node = $node.Exe; created_parent = $createdParent }
    Write-Utf8NoBom $paths.Config ($config | ConvertTo-Json -Depth 4)

    $report = Invoke-PrhDoctor $node.Exe $paths
    Write-PrhDoctorSummary $report

    Write-Host ''
    Write-Good 'Setup finished.'
    Write-Info 'Keys: none were asked for. All are optional. Registering for the USPTO, EPO OPS, GovInfo and CourtListener keys'
    Write-Info 'is free (each provider sets its own terms and limits). Google BigQuery can cost money on a project with billing;'
    Write-Info 'the Hub only makes free dry-run estimates unless you change config.json (see docs\BIGQUERY_SETUP.md).'
    Write-Info 'What leaves this computer: nothing until you use a source. Then your query terms, application or patent'
    Write-Info 'numbers and your key go to that provider only. Your saved records stay in the data folder.'
    Write-Info "To add keys: open $($paths.Keys) in Notepad, paste each value after its = sign, save,"
    Write-Info 'then run the "Patent Research Hub - Check" shortcut. Never paste keys into chat.'
    Write-Info "To connect an AI assistant, merge $($paths.McpJson) (Claude Desktop, Claude Code) or $($paths.McpToml) (Codex) into its configuration."
    Write-Info "Command line: `"$($paths.HubCmd)`" doctor"
    Write-Info "Your data stays in $DataRoot, also after uninstalling, unless you choose to delete it."
    Write-Info 'Read DISCLAIMER.md: output is not legal advice and must be checked against the official record.'
    if (-not $NoOpen) { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\notepad.exe') -ArgumentList ('"' + $paths.Guide + '"') }
} catch {
    Write-Host ''
    Write-Bad $_.Exception.Message
    if ($script:WingetInstalled.Count) { Write-Info ('Setup installed ' + ($script:WingetInstalled -join ' and ') + ' with winget before this error; that program stays installed.') }
    $apart = if ($script:WingetInstalled.Count) { 'Apart from that, nothing' } else { 'Nothing' }
    Write-Info "$apart outside the program folder, data folder and shortcuts was changed. You can fix the problem and run Setup again."
    $exit = 1
}
if ($Repair) { Read-Host 'Press Enter to close' | Out-Null }
exit $exit
