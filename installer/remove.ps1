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
    Write-Info 'Any Hub processes running from this program folder (for example one your AI assistant started) will be stopped first.'
    if ($RemoveData -and -not $dataOwned) { Write-Warn2 'The data folder was not created by Setup (or is missing), so it will not be deleted.'; $RemoveData = $false; $KeepData = $true }
    if (-not ($RemoveData -or $KeepData)) {
        if ($dataOwned) {
            Write-Host ''
            Write-Info 'Your data folder holds your saved research records, exported reports, settings and your keys file.'
            Write-Info 'It is KEPT unless you answer yes here.'
            if (Read-YesNo 'Permanently DELETE the data folder as well?' $false) { $RemoveData = $true } else { $KeepData = $true }
        } else { $KeepData = $true }
    }
    if (-not $Yes -and -not (Read-YesNo 'Remove Patent Research Hub now? Running Hub processes from this installation will be stopped.' $false)) { Write-Info 'Nothing was changed.'; if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }; exit 0 }

    # The shortcut may have started this process inside the program folder. Windows will not delete a folder that is
    # a process's current directory, and Set-Location only changes PowerShell's own location, not the process's.
    $safeDir = [IO.Path]::GetTempPath()
    Set-Location -LiteralPath $safeDir
    [Environment]::CurrentDirectory = $safeDir
    $n = Stop-PrhProcesses $root
    if ($n) { Write-Good "Stopped $n Hub process(es) from this installation"; Start-Sleep -Seconds 1 }

    # The two deletions are independent: a program folder that cannot be removed never silently skips the data
    # deletion you asked for, and each outcome is reported on its own.
    $programGone = $false; $programError = $null
    # Everything but the uninstaller scripts, installer.json and the marker file goes first; those go last, so a partial failure can be run again.
    $programLink = $false; $dataLink = $false
    try { $programLink = [bool](Remove-OwnedTree $root @('installer', 'installer.json', $script:PrhMarker)); $programGone = $true } catch { $programError = $_.Exception.Message }
    $dataGone = $false; $dataError = $null
    if ($RemoveData) {
        try { $dataLink = [bool](Remove-OwnedTree $dataRoot @($script:PrhDataMarker)); $dataGone = $true } catch { $dataError = $_.Exception.Message }
    }
    # Shortcuts go only once the program folder is gone: while it is partly there, the Uninstall shortcut is still a way to run the removal again.
    if ($programGone -and $config) {
        foreach ($lnk in @($config.shortcuts)) {
            if ($lnk -and [string]$lnk -like '*.lnk' -and (Test-Path -LiteralPath $lnk)) { Remove-Item -LiteralPath $lnk -Force }
        }
        $folder = [string]$config.shortcut_folder
        if ($folder -and (Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $folder -Force }
        Write-Good 'Shortcuts removed'
    }
    Write-Host ''
    if ($programGone -and $programLink) { Write-Good "Program folder was a link; the link was removed, its target was left as is: $root" }
    elseif ($programGone) { Write-Good "Program folder DELETED: $root" } else { Write-Bad "Program folder NOT deleted (still present): $root"; Write-Info "    $programError" }
    if ($RemoveData) {
        if ($dataGone -and $dataLink) { Write-Good "Data folder was a link; the link was removed, its target was left as is: $dataRoot" }
        elseif ($dataGone) { Write-Good "Data folder DELETED: $dataRoot" } else { Write-Bad "Data folder NOT deleted (still present): $dataRoot"; Write-Info "    $dataError" }
    } elseif ($dataRoot -and -not (Test-Path -LiteralPath $dataRoot)) {
        Write-Info "Data folder not present (nothing to keep or delete): $dataRoot"
    } elseif ($dataRoot) {
        Write-Good "Data folder KEPT (not deleted): $dataRoot"
    }
    if (-not $programGone -or ($RemoveData -and -not $dataGone)) {
        Write-Info 'To finish: close any program using files in the folder(s) named above as NOT deleted, then delete'
        Write-Info 'that folder in File Explorer. If the program folder is still there, you can also run the removal again:'
        Write-Info ('the Uninstall shortcut is kept until the program folder is gone, and ' + (Join-Path $root 'installer\remove.ps1') + ' (right-click, Run with PowerShell)')
        Write-Info 'works while that file exists; the marker file and installer folder are removed last, so a partial removal can be repeated.'
        $exit = 1
    }
    if ($programGone -and $config -and $config.created_parent) {
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
