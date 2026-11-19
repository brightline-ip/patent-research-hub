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

# Runs icacls.exe without letting $ErrorActionPreference = 'Stop' turn its stderr text into a raw terminating error: the
# exit code decides, and a failure gets a plain-language message.
function Invoke-PrhIcacls([string]$Path, [string[]]$IcaclsArgs, [string]$Problem) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $null = & icacls.exe $Path @IcaclsArgs 2>&1; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $old }
    if ($code -ne 0) { throw "$Problem Make sure the folder is on an NTFS drive and belongs to your account, then run Setup again. (icacls code $code, path $Path)" }
}

# Folder or file accessible only by the current user: no SYSTEM or Administrators entry is added. Raises if icacls fails.
function Set-PrhUserOnly([string]$Path, [switch]$Folder) {
    $grant = if ($Folder) { (Get-PrhUserSid) + ':(OI)(CI)F' } else { (Get-PrhUserSid) + ':F' }
    # /reset first: /grant:r alone leaves any extra explicit entry (for example one added by hand) in place.
    Invoke-PrhIcacls $Path @('/reset') 'Could not reset the access list of the file or folder.'
    Invoke-PrhIcacls $Path @('/inheritance:r', '/grant:r', $grant) 'Could not restrict the file or folder to your account.'
    $null = Assert-PrhUserOnly $Path
}

# Same result as Set-PrhUserOnly (inheritance off, one Allow entry: the current user, full control), written with ONE
# write of the access list. For an existing file that already holds keys there is no moment when the old and new lists are
# mixed or when inheritance is re-applied. Only the access section is loaded and written: Set-Acl with a whole descriptor
# can demand the SeSecurityPrivilege that ordinary accounts do not hold. The list is read back before returning.
function Set-PrhUserOnlyAcl([string]$Path, [switch]$Folder) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $access = [Security.AccessControl.AccessControlSections]::Access
    $legacy = [bool][IO.File].GetMethod('GetAccessControl', [Type[]]@([string], [Security.AccessControl.AccessControlSections]))
    try {
        $acl = if (-not $legacy) { Get-Acl -LiteralPath $Path } elseif ($Folder) { [IO.Directory]::GetAccessControl($Path, $access) } else { [IO.File]::GetAccessControl($Path, $access) }
        foreach ($existing in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $null = $acl.RemoveAccessRuleSpecific($existing) }
        $acl.SetAccessRuleProtection($true, $false)
        $rule = if ($Folder) {
            New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        } else {
            New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
        }
        $acl.AddAccessRule($rule)
        if (-not $legacy) { Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop }
        elseif ($Folder) { [IO.Directory]::SetAccessControl($Path, $acl) }
        else { [IO.File]::SetAccessControl($Path, $acl) }
    } catch { throw "Could not restrict the file or folder to your account. Make sure it is on an NTFS drive and belongs to your account, then run Setup again. ($($_.Exception.Message))" }
    $null = Assert-PrhUserOnly $Path
}
# Reads the access list back. Throws unless inheritance is off and the only principals that are allowed access are the
# current user (what Setup sets) or, if someone added them, SYSTEM and Administrators (who can read the file anyway).
# Deny rules are ignored: they can only narrow access. Returns the list of principals found, for the log.
function Assert-PrhUserOnly([string]$Path) {
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($userSid, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $Path
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
    $extra = @($rules | Where-Object { $_.IdentityReference.Value -notin $allowed } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if (-not $acl.AreAccessRulesProtected) { throw "The access list of $Path still inherits permissions from its parent folder; it is not private to your account." }
    if ($extra.Count) { throw "$Path can still be accessed by other accounts ($($extra -join ', ')). Setup stopped so no key is stored in it." }
    if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $userSid }).Count) { throw "Your own account has no access to $Path after the permissions change." }
    return @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
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
    if (-not $ids.Count) { return 0 }
    # taskkill writes to stderr for a process that already exited; under $ErrorActionPreference = 'Stop' that is a raw
    # terminating error. Run it with 'Continue' and judge the result by listing the processes again.
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { foreach ($id in $ids) { $null = & taskkill.exe /PID $id /T /F 2>&1 } }
    finally { $ErrorActionPreference = $old }
    $left = @()
    for ($try = 0; $try -lt 10; $try++) {
        $left = @(Get-PrhProcesses $Root | Where-Object { $_ -in $ids })
        if (-not $left.Count) { break }
        Start-Sleep -Milliseconds 300
    }
    if ($left.Count) { throw "Could not stop $($left.Count) Hub process(es) from this installation (process IDs: $($left -join ', ')). Quit your AI assistant, then try again." }
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

# --- Deleting folders -------------------------------------------------------------------------------------------------

# \\?\ form of a local absolute path: Windows then skips its name rules, so entries such as CON, NUL or a name ending in a
# dot or space (which PowerShell cannot address by the ordinary path) can still be listed and deleted.
function ConvertTo-ExtendedPath([string]$Path) {
    if ($Path.StartsWith('\\?\')) { return $Path }
    return '\\?\' + [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Remove-Links([string]$Path) {
    # Walked by hand: Windows PowerShell's -Recurse can follow a junction into its target. .NET with \\?\ paths, because
    # Get-Item cannot see entries with reserved names.
    if (-not [IO.Directory]::Exists((ConvertTo-ExtendedPath $Path))) { return }
    $dir = New-Object IO.DirectoryInfo (ConvertTo-ExtendedPath $Path)
    foreach ($child in @($dir.EnumerateFileSystemInfos())) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ($child -is [IO.DirectoryInfo]) { [IO.Directory]::Delete($child.FullName, $false) } else { [IO.File]::Delete($child.FullName) }
        } elseif ($child -is [IO.DirectoryInfo]) { Remove-Links $child.FullName }
    }
}

# Removes one file or folder (never following links). Tries Remove-Item first; entries PowerShell cannot remove (reserved
# device names, trailing dots or spaces, very long paths) are retried with \\?\ paths and finally cmd.exe's rd. Pass only
# paths inside a folder whose marker file was checked.
function Remove-Tree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # The folder itself is a link: remove the link, never its target.
        if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
        return
    }
    # Unlink junctions and symbolic links first, without following them, so a linked folder's target survives.
    Remove-Links $Path
    if ($item.PSIsContainer) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop } catch {}
        if (Test-Path -LiteralPath $Path) {
            $ext = ConvertTo-ExtendedPath $Path
            try { [IO.Directory]::Delete($ext, $true) } catch {}
            if ((Test-Path -LiteralPath $Path) -and $ext -notmatch '[%"]' -and $ext.Length -gt 12) {
                $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                try { $null = & cmd.exe /d /c rd /s /q $ext 2>&1 } finally { $ErrorActionPreference = $old }
            }
        }
        if (Test-Path -LiteralPath $Path) {
            # Long paths (deep node_modules folders): empty the folder with robocopy, then remove it.
            $empty = Join-Path ([IO.Path]::GetTempPath()) ('prh-empty-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $empty | Out-Null
            $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try { $null = & robocopy.exe $empty $Path /MIR /XJ /NFL /NDL /NJH /NJS /NP } finally { $ErrorActionPreference = $old }
            Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        }
    } else {
        try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { try { [IO.File]::Delete((ConvertTo-ExtendedPath $Path)) } catch {} }
    }
    if (Test-Path -LiteralPath $Path) { throw "Could not remove $Path. Close any program using files there and try again." }
}

# Deletes a folder that Setup created and marked. Everything is removed first; the entries named in $KeepLast (the program
# folder's installer\ scripts, installer.json and the marker file) go last, in that order, and only if everything else
# succeeded. A partial failure therefore leaves the marker and the uninstaller in place so the uninstall can be run again.
function Remove-OwnedTree([string]$Path, [string[]]$KeepLast) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $failures = New-Object Collections.Generic.List[string]
    foreach ($entry in @([IO.Directory]::EnumerateFileSystemEntries((ConvertTo-ExtendedPath $Path)))) {
        $leaf = [IO.Path]::GetFileName($entry.TrimEnd('\'))
        if ($leaf -in $KeepLast) { continue }
        try { Remove-Tree $entry } catch { $failures.Add($_.Exception.Message) }
    }
    if ($failures.Count) { throw ($failures -join ' ') }
    foreach ($name in $KeepLast) { Remove-Tree (Join-Path $Path $name) }
    Remove-Tree $Path
}

# --- Hub.cmd ----------------------------------------------------------------------------------------------------------

# Command-line wrapper with this installation's folders and keys file. Written as UTF-8 (no BOM) and run under code page
# 65001, so folders with accented or non-Latin characters work. The caller's code page is restored afterwards (taken from
# the last word of chcp's output, digits only: some languages print "Active code page: 850." with a final period), and the
# Hub's exit code is passed on.
function Get-PrhHubCmdText([string]$NodeExe, $Paths) {
    return (@(
        '@echo off',
        'rem Patent Research Hub command line for this installation. Example: Hub.cmd doctor',
        'setlocal',
        'set "PRH_CP="',
        'for /f "delims=" %%a in (''chcp'') do for %%t in (%%a) do set "PRH_CP=%%t"',
        'set "PRH_CP=%PRH_CP:.=%"',
        'echo(%PRH_CP%|findstr /r /x "[0-9][0-9]*" >nul || set "PRH_CP="',
        'chcp 65001 >nul',
        ('set "PATENT_RESEARCH_CONFIG=' + $Paths.HubConfig + '"'),
        ('set "PATENT_RESEARCH_DATA_DIR=' + $Paths.Data + '"'),
        ('set "PATENT_RESEARCH_EXPORTS_DIR=' + $Paths.Exports + '"'),
        ('"' + $NodeExe + '" "--env-file-if-exists=' + $Paths.Keys + '" "%~dp0src\cli.mjs" %*'),
        'set "PRH_EXIT=%ERRORLEVEL%"',
        'if defined PRH_CP chcp %PRH_CP% >nul',
        'exit /b %PRH_EXIT%',
        ''
    ) -join "`r`n")
}