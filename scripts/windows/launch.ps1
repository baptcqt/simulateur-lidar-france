[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$RebuildDemo
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$StateDir = Join-Path $env:LOCALAPPDATA 'SimMap'
$ApiUrl = 'http://127.0.0.1:8000'
$WebUrl = 'http://127.0.0.1:5173'

function Get-CondaCommand {
    foreach ($name in @('mamba', 'conda')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    foreach ($candidate in @(
        (Join-Path $env:USERPROFILE 'miniforge3\Scripts\conda.exe'),
        (Join-Path $env:USERPROFILE 'Miniforge3\Scripts\conda.exe'),
        (Join-Path $env:LOCALAPPDATA 'miniforge3\Scripts\conda.exe'),
        (Join-Path $env:ProgramData 'miniforge3\Scripts\conda.exe')
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Test-Endpoint([string]$Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch { return $false }
}

function Wait-Endpoint([string]$Url, [int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Endpoint $Url) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Show-LauncherError([string]$Message) {
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($Message, 'Simulateur LiDAR France', 'OK', 'Error') | Out-Null
    }
    catch { Write-Error $Message }
}

try {
    Set-Location $RepoRoot
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

    $conda = Get-CondaCommand
    if (-not $conda) {
        throw "Miniforge/Conda est introuvable. Lancez d'abord scripts\windows\bootstrap.ps1."
    }

    $envListJson = & $conda env list --json
    if ($LASTEXITCODE -ne 0 -or -not ($envListJson | Select-String -SimpleMatch 'simmap')) {
        throw "L'environnement Conda 'simmap' est absent. Lancez d'abord le bootstrap."
    }

    $demoGlb = Join-Path $RepoRoot 'data\projects\demo\chunks\chunk_0.glb'
    if ($RebuildDemo -or -not (Test-Path -LiteralPath $demoGlb)) {
        & $conda run -n simmap simmap demo build --output data/projects/demo --profile surface --fidelity 45
        if ($LASTEXITCODE -ne 0) { throw 'La construction de la démonstration a échoué.' }
    }

    $apiProcess = $null
    if (-not (Test-Endpoint "$ApiUrl/health")) {
        $apiProcess = Start-Process -FilePath $conda -ArgumentList @(
            'run', '-n', 'simmap', 'python', '-m', 'uvicorn',
            'apps.api.main:app', '--host', '127.0.0.1', '--port', '8000'
        ) -WorkingDirectory $RepoRoot -WindowStyle Minimized -PassThru
    }

    $webProcess = $null
    if (-not (Test-Endpoint $WebUrl)) {
        $webProcess = Start-Process -FilePath $conda -ArgumentList @(
            'run', '-n', 'simmap', 'npm', '--workspace', 'apps/web',
            'run', 'dev', '--', '--host', '127.0.0.1'
        ) -WorkingDirectory $RepoRoot -WindowStyle Minimized -PassThru
    }

    if (-not (Wait-Endpoint "$ApiUrl/health" 45)) {
        throw "L'API ne répond pas sur $ApiUrl. Exécutez scripts\windows\doctor.ps1."
    }
    if (-not (Wait-Endpoint $WebUrl 45)) {
        throw "L'interface ne répond pas sur $WebUrl. Vérifiez Node.js et relancez le bootstrap."
    }

    @{
        started_at = (Get-Date).ToString('o')
        api_pid = if ($apiProcess) { $apiProcess.Id } else { $null }
        web_pid = if ($webProcess) { $webProcess.Id } else { $null }
        repository = $RepoRoot
        web_url = $WebUrl
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDir 'launcher-state.json') -Encoding UTF8

    if (-not $NoBrowser) { Start-Process $WebUrl }
    Write-Host "Simulateur LiDAR France démarré : $WebUrl" -ForegroundColor Green
}
catch {
    Show-LauncherError $_.Exception.Message
    exit 1
}
