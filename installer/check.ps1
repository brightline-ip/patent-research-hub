# Shows which Patent Research Hub sources are ready with this installation's settings and keys file.
# Makes no network call and prints names of settings only, never key values.
param([switch]$NoPause)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$code = 0
try {
    $config = Read-PrhConfig $root
    $paths = Get-PrhPaths $root ([string]$config.data_root)
    $node = [string]$config.node
    if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $found = Find-PrhNode
        if (-not $found) { throw 'Node.js was not found. Install it, then run the "Patent Research Hub - Repair" shortcut.' }
        $node = $found.Exe
    }
    Write-Host 'Patent Research Hub - Check' -ForegroundColor White
    Write-Info 'No network call is made; only the names of missing settings are shown.'
    Write-Host ''
    Write-PrhDoctorSummary (Invoke-PrhDoctor $node $paths)
    Write-Host ''
    Write-Info "Keys file: $($paths.Keys)"
    Write-Info "Settings:  $($paths.HubConfig)"
    Write-Info 'Add a key by pasting it after its = sign in the keys file, save, and run this check again.'
} catch {
    Write-Bad $_.Exception.Message
    $code = 1
}
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
exit $code
