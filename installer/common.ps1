# Shared helpers for the Patent Research Hub Windows installer. Windows PowerShell 5.1 compatible.
# Dot-source this file; it defines functions only.

# Started from a PowerShell 7 window, Windows PowerShell inherits a module path it cannot use.
if ($PSVersionTable.PSEdition -ne 'Core') {
    $env:PSModulePath = @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\Modules'),
        (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
    ) -join ';'
}

$script:PrhMarker = '.patent-research-hub-install'
$script:PrhDataMarker = '.patent-research-hub-data'
$script:PrhVersion = '0.1.0'
$script:PrhMinNode = [version]'24.13.0'

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('== ' + $Text) -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host ('   ' + $Text) }
function Write-Good([string]$Text) { Write-Host ('   OK  ' + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host ('   !   ' + $Text) -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host ('   X   ' + $Text) -ForegroundColor Red }

function Read-YesNo([string]$Question, [bool]$Default = $false) {
    $suffix = if ($Default) { ' [Y/n] ' } else { ' [y/N] ' }
    while ($true) {
        $answer = Read-Host -Prompt ('   ' + $Question + $suffix)
        if ($null -eq $answer) { return $Default }
        $answer = $answer.Trim().ToLowerInvariant()
        if ($answer -eq '') { return $Default }
        if ($answer -in @('y', 'yes')) { return $true }
        if ($answer -in @('n', 'no')) { return $false }
        Write-Info 'Please type Y for yes or N for no.'
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Get-PrhPaths([string]$Root, [string]$DataRoot) {
    return @{
        Root       = $Root
        Marker     = Join-Path $Root $script:PrhMarker
        Config     = Join-Path $Root 'installer.json'
        Logs       = Join-Path $Root 'logs'
        Venv       = Join-Path $Root '.venv\Scripts\python.exe'
        NpmCache   = Join-Path $Root '.npm-cache'
        Cli        = Join-Path $Root 'src\cli.mjs'
        Mcp        = Join-Path $Root 'src\mcp.mjs'
        HubCmd     = Join-Path $Root 'Hub.cmd'
        Guide      = Join-Path $Root 'GETTING-STARTED.txt'
        McpJson    = Join-Path $Root 'MCP-setup.json'
        McpToml    = Join-Path $Root 'MCP-setup.codex.toml'
        DataRoot   = $DataRoot
        DataMarker = Join-Path $DataRoot $script:PrhDataMarker
        Data       = Join-Path $DataRoot 'data'
        Exports    = Join-Path $DataRoot 'exports'
        HubConfig  = Join-Path $DataRoot 'config.json'
        Keys       = Join-Path $DataRoot 'keys.env'
    }
}

function Read-PrhConfig([string]$Root) {
    return (Get-Content -LiteralPath (Join-Path $Root 'installer.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# The current user's SID, for access lists (names can fail for some Microsoft or work accounts).
function Get-PrhUserSid { return ('*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) }

# Folder or file readable only by the current user. Raises if icacls fails.
function Set-PrhUserOnly([string]$Path, [switch]$Folder) {
    $grant = if ($Folder) { (Get-PrhUserSid) + ':(OI)(CI)F' } else { (Get-PrhUserSid) + ':F' }
    $null = & icacls.exe $Path /inheritance:r /grant:r $grant 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict $Path to your account (icacls code $LASTEXITCODE)." }
}

# Returns @{ Exe; Version } for Node.js at or above the version the Hub needs (node:sqlite).
function Find-PrhNode {
    $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    $exe = if ($node) { $node.Source } elseif (Test-Path -LiteralPath "$env:ProgramFiles\nodejs\node.exe") { "$env:ProgramFiles\nodejs\node.exe" } else { $null }
    if (-not $exe) { return $null }
    try {
        $v = & $exe -p 'process.versions.node' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return $null }
        $version = [version](([string]$v).Trim())
        $npm = Join-Path (Split-Path -Parent $exe) 'npm.cmd'
        return @{ Exe = $exe; Version = $version; Npm = $(if (Test-Path -LiteralPath $npm) { $npm } else { $null }); NewEnough = ($version -ge $script:PrhMinNode) }
    } catch { return $null }
}

# Returns @{ Exe; Version } for Python 3.12+ (optional: charts and PatentsView preparation).
function Find-PrhPython {
    # No quote characters: Windows PowerShell 5.1 drops embedded double quotes when calling native programs.
    $probe = 'import sys;print(sys.executable);print(sys.version_info[0],sys.version_info[1],sys.version_info[2],sep=chr(46))'
    $candidates = New-Object Collections.Generic.List[object]
    foreach ($v in @('3.12', '3.13', '3.14')) { $candidates.Add(@('py', "-$v")) }
    $candidates.Add(@('python'))
    foreach ($v in @('312', '313', '314')) {
        foreach ($base in @("$env:LOCALAPPDATA\Programs\Python\Python$v", "$env:ProgramFiles\Python$v")) {
            $candidates.Add(@((Join-Path $base 'python.exe')))
        }
    }
    foreach ($c in $candidates) {
        $exe = $c[0]; $extra = @($c | Select-Object -Skip 1)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $out = & $exe @extra -c $probe 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
            $lines = @($out)
            if ($lines.Count -lt 2) { continue }
            $ver = [version]$lines[1]
            if ($ver.Major -eq 3 -and $ver.Minor -ge 12 -and $lines[0] -notmatch '\\WindowsApps\\') {
                return @{ Exe = $lines[0].Trim(); Version = $ver }
            }
        } catch { continue }
    }
    return $null
}

# Processes that belong to this installation: node.exe running a script from this install's src\ or scripts\
# folder (an MCP server your AI assistant started, a CLI run, a PatentsView worker), and python.exe from this
# install's .venv. Matched by this install's own paths, never by name or port alone.
function Get-PrhProcesses([string]$Root) {
    $prefix = $Root.TrimEnd('\') + '\'
    $owned = @{}
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue)) {
        $cmd = [string]$p.CommandLine
        $exe = [string]$p.ExecutablePath
        $mine = $false
        if ($p.Name -ieq 'node.exe') {
            foreach ($dir in @('src\', 'scripts\')) {
                if ($cmd.IndexOf($prefix + $dir, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $mine = $true }
            }
        } elseif ($exe -and $exe.StartsWith($prefix + '.venv\', [StringComparison]::OrdinalIgnoreCase)) { $mine = $true }
        if ($mine) { $owned[[int]$p.ProcessId] = $true }
    }
    return @($owned.Keys)
}

function Stop-PrhProcesses([string]$Root) {
    $ids = @(Get-PrhProcesses $Root)
    foreach ($id in $ids) { $null = & taskkill.exe /PID $id /T /F 2>&1 }
    return $ids.Count
}

# Runs `doctor` with this installation's settings and keys file. Returns the parsed report, or throws.
function Invoke-PrhDoctor([string]$NodeExe, $Paths) {
    $env:PATENT_RESEARCH_CONFIG = $Paths.HubConfig
    $env:PATENT_RESEARCH_DATA_DIR = $Paths.Data
    $env:PATENT_RESEARCH_EXPORTS_DIR = $Paths.Exports
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $out = & $NodeExe ('--env-file-if-exists=' + $Paths.Keys) $Paths.Cli doctor 2>$null
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    if ($code -ne 0 -or -not $out) { throw "The Hub's check (doctor) failed with code $code." }
    return ((@($out) -join "`n") | ConvertFrom-Json)
}

# Plain-language summary of a doctor report. Names of settings only; doctor never returns values.
function Write-PrhDoctorSummary($Report) {
    Write-Good ('Keyless sources ready: ' + (@($Report.keylessSources.sources) -join ', '))
    foreach ($p in @($Report.providers)) {
        if ($p.configured) { Write-Good "$($p.name): configured" }
        else {
            Write-Info "--  $($p.name): not configured"
            Write-Info ('      missing: ' + (@($p.missing) -join ', '))
            Write-Info ('      register: ' + $p.register)
        }
    }
    Write-Info ('BigQuery mode: ' + $Report.bigQuery.mode)
    $py = if ($Report.integrations.python.found) { 'found' } else { 'not found (charts and PatentsView preparation unavailable)' }
    Write-Info ('Python: ' + $py)
    Write-Info ('Data folder: ' + $Report.dataDir)
}

# A TOML basic string with backslashes and quotes escaped.
function ConvertTo-TomlString([string]$Text) {
    return '"' + $Text.Replace('\', '\\').Replace('"', '\"') + '"'
}
