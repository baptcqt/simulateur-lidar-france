[CmdletBinding()]
param(
    [ValidateSet('Surface', 'Standard', 'Quality', 'Custom')]
    [string]$Profile = 'Surface',
    [switch]$CoreOnly,
    [switch]$WithGodot,
    [switch]$WithSimulation,
    [switch]$WithAI,
    [switch]$WithDevTools,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-CondaCommand {
    foreach ($name in @('mamba', 'conda')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }

    $candidates = @(
        (Join-Path $env:USERPROFILE 'miniforge3\Scripts\conda.exe'),
        (Join-Path $env:USERPROFILE 'Miniforge3\Scripts\conda.exe'),
        (Join-Path $env:LOCALAPPDATA 'miniforge3\Scripts\conda.exe'),
        (Join-Path $env:ProgramData 'miniforge3\Scripts\conda.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "La commande a échoué avec le code $LASTEXITCODE : $FilePath $($Arguments -join ' ')"
    }
}

Write-Host "Bootstrap SimMap ($Profile). Les installations système éventuelles sont affichées explicitement."

Write-Step 'Vérification de Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'Git est absent et winget est indisponible. Installez Git, puis relancez ce script.'
    }

    Invoke-Checked $winget.Source 'install' '--id' 'Git.Git' '-e' '--accept-source-agreements' '--accept-package-agreements'
}

Write-Step 'Vérification de Conda ou Mamba'
$conda = Get-CondaCommand
if (-not $conda) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'Conda/Mamba est absent et winget est indisponible. Installez Miniforge, puis relancez ce script.'
    }

    Write-Host 'Miniforge est requis pour PDAL, GDAL et PROJ.' -ForegroundColor Yellow
    Write-Host 'Commande exécutée : winget install --id CondaForge.Miniforge3 -e' -ForegroundColor Yellow
    Invoke-Checked $winget.Source 'install' '--id' 'CondaForge.Miniforge3' '-e' '--accept-source-agreements' '--accept-package-agreements'

    $conda = Get-CondaCommand
    if (-not $conda) {
        throw @'
Miniforge a été installé, mais Conda n'est pas encore accessible dans ce terminal.
Fermez complètement PowerShell, ouvrez une nouvelle fenêtre, puis relancez :
  .\scripts\windows\bootstrap.ps1 -Profile Surface -WithGodot
'@
    }
}
Write-Host "Conda détecté : $conda"

Write-Step 'Création ou mise à jour de l’environnement Conda simmap'
$environmentExists = $false
$envListJson = & $conda 'env' 'list' '--json'
if ($LASTEXITCODE -eq 0) {
    try {
        $envList = $envListJson | ConvertFrom-Json
        $environmentExists = @($envList.envs | ForEach-Object { Split-Path $_ -Leaf }) -contains 'simmap'
    }
    catch {
        Write-Warning "Impossible d'analyser la liste des environnements Conda. Une mise à jour sera tentée."
    }
}

if ($environmentExists) {
    Invoke-Checked $conda 'env' 'update' '-n' 'simmap' '-f' 'environment.yml' '--prune'
}
else {
    Invoke-Checked $conda 'env' 'create' '-n' 'simmap' '-f' 'environment.yml'
}

Write-Step 'Installation du paquet Python dans l’environnement simmap'
# environment.yml installe déjà le projet. Cette commande garantit une installation éditable à jour.
Invoke-Checked $conda 'run' '-n' 'simmap' 'python' '-m' 'pip' 'install' '-e' '.[geo,dev]'

if (-not $CoreOnly) {
    Write-Step 'Installation des dépendances frontend'
    $nodeVersion = & $conda 'run' '-n' 'simmap' 'node' '--version'
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js n'est pas disponible dans l'environnement simmap."
    }
    Write-Host "Node.js détecté : $nodeVersion"
    Invoke-Checked $conda 'run' '-n' 'simmap' 'npm' 'install'
}

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Fichier .env créé depuis .env.example.'
}
else {
    Write-Host 'Fichier .env existant conservé.'
}

Write-Step 'Initialisation de la base SQLite'
Invoke-Checked $conda 'run' '-n' 'simmap' 'python' '-c' "from pathlib import Path; from simmap.jobs.store import migrate; migrate(Path.home()/'.simmap'/'simmap.sqlite')"

Write-Step 'Tests de fumée'
Invoke-Checked $conda 'run' '-n' 'simmap' 'python' '-m' 'pytest' '-q'

if ($WithGodot) {
    Write-Step 'Vérification de Godot'
    if (-not (Get-Command godot -ErrorAction SilentlyContinue)) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host 'Godot est absent. Installation avec winget.' -ForegroundColor Yellow
            Invoke-Checked $winget.Source 'install' '--id' 'GodotEngine.GodotEngine' '-e' '--accept-source-agreements' '--accept-package-agreements'
        }
        else {
            Write-Warning 'Godot est absent et winget est indisponible. Installez Godot manuellement.'
        }
    }
}

if ($WithSimulation) {
    Write-Host 'Simulation optionnelle : exécutez scripts/windows/enable-wsl.ps1 puis scripts/wsl/install-px4-gazebo.sh.' -ForegroundColor Yellow
}

if ($WithAI) {
    Write-Host 'Les adaptateurs IA restent désactivés par défaut. Aucun poids volumineux n’est téléchargé automatiquement.' -ForegroundColor Yellow
}

if ($WithDevTools) {
    Write-Host 'Les outils de développement optionnels sont documentés dans docs/ et ne sont pas installés silencieusement.' -ForegroundColor Yellow
}

Write-Step 'Diagnostic final'
& (Join-Path $PSScriptRoot 'doctor.ps1')

Write-Host "`nInstallation terminée." -ForegroundColor Green
Write-Host 'Pour démarrer :' -ForegroundColor Green
Write-Host "  & '$conda' run -n simmap powershell -ExecutionPolicy Bypass -File .\scripts\windows\run.ps1"
