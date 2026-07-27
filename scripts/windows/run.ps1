[CmdletBinding()]
param(
    [switch]$NoWeb,
    [switch]$RebuildDemo
)

$launcher = Join-Path $PSScriptRoot 'launch.ps1'
& $launcher -NoBrowser:$NoWeb -RebuildDemo:$RebuildDemo
exit $LASTEXITCODE
