param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
chcp.com 65001 > $null
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$EnvDir = Join-Path $Root '.pdal-env'
$PdalExe = Join-Path $EnvDir 'Library\bin\pdal.exe'

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "La commande '$Command $($Arguments -join ' ')' a échoué avec le code $LASTEXITCODE."
    }
}

function Get-CondaTool {
    foreach ($name in @('mamba', 'conda', 'micromamba')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }

    $candidates = @(
        "$Env:USERPROFILE\miniforge3\Scripts\mamba.exe",
        "$Env:USERPROFILE\Miniforge3\Scripts\mamba.exe",
        "$Env:LOCALAPPDATA\miniforge3\Scripts\mamba.exe",
        "$Env:LOCALAPPDATA\Programs\miniforge3\Scripts\mamba.exe",
        "$Env:LOCALAPPDATA\Programs\Miniforge3\Scripts\mamba.exe",
        "$Env:LOCALAPPDATA\micromamba\micromamba.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }

    return $null
}

function Ensure-CondaTool {
    $tool = Get-CondaTool
    if ($tool) { return $tool }

    $Winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $Winget) {
        throw 'PDAL nécessite Conda Forge sous Windows. Installez Miniforge ou winget, puis relancez scripts\windows\install-pdal.ps1.'
    }

    Write-Host 'Miniforge introuvable. Installation de Miniforge3 via winget...'
    Invoke-NativeCommand $Winget.Source 'install' '-e' '--id' 'CondaForge.Miniforge3' '--scope' 'user' '--accept-package-agreements' '--accept-source-agreements'

    $tool = Get-CondaTool
    if ($tool) { return $tool }

    throw 'Miniforge a été installé, mais mamba/conda reste introuvable. Ouvrez une nouvelle fenêtre PowerShell puis relancez scripts\windows\install-pdal.ps1.'
}

if ((Test-Path $PdalExe) -and -not $Force) {
    Write-Host "PDAL local déjà installé : $PdalExe"
    & $PdalExe --version
    exit 0
}

if ((Test-Path $EnvDir) -and $Force) {
    Write-Host 'Suppression de l’ancien environnement PDAL local...'
    Remove-Item $EnvDir -Recurse -Force
}

$CondaTool = Ensure-CondaTool
Write-Host "Gestionnaire Conda détecté : $CondaTool"
Write-Host "Création de l’environnement PDAL local : $EnvDir"

Invoke-NativeCommand $CondaTool 'create' '-y' '-p' $EnvDir '-c' 'conda-forge' 'pdal'

if (-not (Test-Path $PdalExe)) {
    throw "Installation PDAL terminée mais pdal.exe est introuvable dans $PdalExe."
}

Write-Host 'PDAL installé pour le projet.'
& $PdalExe --version
