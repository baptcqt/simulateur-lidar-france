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
$WorkParent = Join-Path $Root '.runtime'
$WorkDir = Join-Path $WorkParent "diagnostic-$Stamp"

New-Item -ItemType Directory -Force -Path $ExportDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkParent | Out-Null
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Copy-FileIfExists {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (Test-Path $Path -PathType Leaf) {
        New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
        Copy-Item -Path $Path -Destination $Destination -Force
    }
}

function Copy-FlatFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$DestinationDir,
        [Parameter(Mandatory = $true)][string[]]$Extensions
    )
    if (-not (Test-Path $SourceDir -PathType Container)) { return }
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    Get-ChildItem -Path $SourceDir -File | Where-Object {
        $Extensions -contains $_.Extension.ToLowerInvariant() -and $_.Name -notlike 'simulateur-diagnostic-*.zip'
    } | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination (Join-Path $DestinationDir $_.Name) -Force
    }
}

# Nettoyage des anciens exports récursifs créés par les versions précédentes.
if (Test-Path $LogDir -PathType Container) {
    Get-ChildItem -Path $LogDir -Directory -Force | Where-Object { $_.Name -like '.diagnostic-*' } | ForEach-Object {
        Remove-Item -Path $_.FullName -Recurse -Force
    }
}

Copy-FlatFiles -SourceDir $LogDir -DestinationDir (Join-Path $WorkDir 'logs') -Extensions @('.log', '.json', '.txt')
Copy-FlatFiles -SourceDir $RuntimeDir -DestinationDir (Join-Path $WorkDir 'runtime') -Extensions @('.ps1', '.json', '.txt')

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
    note = 'Export plat : les sous-dossiers logs/.diagnostic-* et les ZIP existants sont exclus pour éviter toute récursion.'
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $WorkDir 'diagnostics-summary.json') -Encoding UTF8

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $WorkDir '*') -DestinationPath $ZipPath -Force
Remove-Item -Recurse -Force $WorkDir

Write-Host "Diagnostic exporté : $ZipPath"
