<#
.SYNOPSIS
  Removes this Patent Research Hub installation: what Setup created, nothing else.
.DESCRIPTION
  Stops this installation's running Hub processes (matched by this program folder's path), removes its shortcuts
  and deletes the program folder. Your data folder (database, exports, config.json, keys.env) is KEPT unless you
  choose to delete it. Node.js and Python stay installed. MCP client entries you added are not edited.
.PARAMETER RemoveData
  Also permanently delete the data folder, including your keys file.
.PARAMETER KeepData
  Keep the data folder without asking.
.PARAMETER Yes
  Do not ask for confirmation (requires -RemoveData or -KeepData).
#>
[CmdletBinding()]
param([switch]$RemoveData, [switch]$KeepData, [switch]$Yes)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')

function Remove-Links([string]$Path) {
    # Walked by hand: Windows PowerShell's -Recurse can follow a junction into its target.
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { return }
    foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ($child.PSIsContainer) { [IO.Directory]::Delete($child.FullName, $false) } else { [IO.File]::Delete($child.FullName) }
        } elseif ($child.PSIsContainer) { Remove-Links $child.FullName }
    }
}

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
            # Long paths (deep node_modules folders): empty the folder with robocopy, then remove it.
            $empty = Join-Path ([IO.Path]::GetTempPath()) ('prh-empty-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $empty | Out-Null
            $null = & robocopy.exe $empty $Path /MIR /XJ /NFL /NDL /NJH /NJS /NP
            Remove-Item -LiteralPath $empty -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
        }
    } else { Remove-Item -LiteralPath $Path -Force }
    if (Test-Path -LiteralPath $Path) { throw "Could not remove $Path. Close any program using files there and try again." }
}

function Test-SafeTarget([string]$Path) {
    $p = $Path.TrimEnd('\')
    if ($p -eq ([IO.Path]::GetPathRoot($p)).TrimEnd('\')) { return $false }
    foreach ($f in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('Desktop'))) {
        if ($f -and $p -ieq $f.TrimEnd('\')) { return $false }
    }
    return $true
}

$exit = 0
try {
    if ($RemoveData -and $KeepData) { throw 'Use either -RemoveData or -KeepData, not both.' }
    if ($Yes -and -not ($RemoveData -or $KeepData)) { throw '-Yes needs -RemoveData or -KeepData, so your data is never deleted without an explicit choice.' }
    if (-not (Test-Path -LiteralPath (Join-Path $root $script:PrhMarker) -PathType Leaf)) { throw "No Patent Research Hub installation was found in $root (the marker file is missing). Nothing was changed." }
    if (-not (Test-SafeTarget $root)) { throw "Refusing to remove $root." }
    $config = $null
    try { $config = Read-PrhConfig $root } catch { Write-Warn2 'The installation settings are missing; removing program files only. Your data folder is not touched.' }
    $dataRoot = if ($config -and $config.data_root) { [IO.Path]::GetFullPath([string]$config.data_root).TrimEnd('\') } else { $null }
    $dataOwned = $dataRoot -and (Test-Path -LiteralPath (Join-Path $dataRoot $script:PrhDataMarker) -PathType Leaf) -and (Test-SafeTarget $dataRoot)

    Write-Host 'Uninstall Patent Research Hub' -ForegroundColor White
    Write-Info "Program folder: $root"
    if ($dataRoot) { Write-Info "Data folder:    $dataRoot" }
    Write-Info 'Node.js and Python stay installed. AI assistant settings you changed are not edited.'
    if ($RemoveData -and -not $dataOwned) { Write-Warn2 'The data folder was not created by Setup (or is missing), so it will not be deleted.'; $RemoveData = $false; $KeepData = $true }
    if (-not ($RemoveData -or $KeepData)) {
        if ($dataOwned) {
            Write-Host ''
            Write-Info 'Your data folder holds your saved research records, exported reports, settings and your keys file.'
            Write-Info 'It is KEPT unless you answer yes here.'
            if (Read-YesNo 'Permanently DELETE the data folder as well?' $false) { $RemoveData = $true } else { $KeepData = $true }
        } else { $KeepData = $true }
    }
    if (-not $Yes -and -not (Read-YesNo 'Remove Patent Research Hub now?' $false)) { Write-Info 'Nothing was changed.'; if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }; exit 0 }

    Set-Location -LiteralPath ([IO.Path]::GetTempPath())
    $n = Stop-PrhProcesses $root
    if ($n) { Write-Good "Stopped $n Hub process(es) from this installation"; Start-Sleep -Seconds 1 }

    if ($config) {
        foreach ($lnk in @($config.shortcuts)) {
            if ($lnk -and [string]$lnk -like '*.lnk' -and (Test-Path -LiteralPath $lnk)) { Remove-Item -LiteralPath $lnk -Force }
        }
        $folder = [string]$config.shortcut_folder
        if ($folder -and (Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $folder -Force }
        Write-Good 'Shortcuts removed'
    }

    Remove-Tree $root
    Write-Good 'Program files removed'
    if ($RemoveData) {
        Remove-Tree $dataRoot
        Write-Good 'Data folder removed'
    } elseif ($dataRoot) {
        Write-Good "Your data was kept in $dataRoot"
    }
    if ($config -and $config.created_parent) {
        $parent = Split-Path -Parent $root
        if ($parent -and (Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $parent -Force }
    }
    Write-Info 'Remove any MCP client entry named patent_research yourself.'
} catch {
    Write-Bad $_.Exception.Message
    $exit = 1
}
if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }
exit $exit
