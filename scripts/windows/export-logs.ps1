param()

$ErrorActionPreference = 'Stop'
chcp.com 65001 > $null
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LogDir = Join-Path $Root 'logs'
$RuntimeDir = Join-Path $Root '.runtime'
$DataDir = Join-Path $Root 'data'
$ExportDir = Join-Path $Root 'logs'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ZipPath = Join-Path $ExportDir "simulateur-diagnostic-$Stamp.zip"
$WorkDir = Join-Path $ExportDir ".diagnostic-$Stamp"

New-Item -ItemType Directory -Force -Path $ExportDir | Out-Null
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Copy-IfExists {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path $Path) {
        New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
        Copy-Item -Path $Path -Destination $Destination -Recurse -Force
    }
}

Copy-IfExists -Path $LogDir -Destination (Join-Path $WorkDir 'logs')
Copy-IfExists -Path $RuntimeDir -Destination (Join-Path $WorkDir 'runtime')

$summary = [ordered]@{
    createdAt = (Get-Date).ToString('o')
    root = $Root
    powershell = $PSVersionTable.PSVersion.ToString()
    logDirExists = Test-Path $LogDir
    runtimeDirExists = Test-Path $RuntimeDir
    dataDirExists = Test-Path $DataDir
    pdalEnvExists = Test-Path (Join-Path $Root '.pdal-env')
    localPdalExists = Test-Path (Join-Path $Root '.pdal-env\Library\bin\pdal.exe')
    simulatorPdalExe = $Env:SIMULATEUR_PDAL_EXE
    path = $Env:PATH
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $WorkDir 'diagnostics-summary.json') -Encoding UTF8

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $WorkDir '*') -DestinationPath $ZipPath -Force
Remove-Item -Recurse -Force $WorkDir

Write-Host "Diagnostic exporté : $ZipPath"
