param()

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {
    # L'installation peut continuer si la console ne permet pas ce réglage.
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "La commande '$Command $($Arguments -join ' ')' a échoué avec le code $LASTEXITCODE."
    }
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3.11 ou une version ultérieure est requis.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20 ou une version ultérieure est requis.'
}

if (-not (Test-Path '.venv')) {
    Invoke-NativeCommand python '-m' 'venv' '.venv'
}

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
Invoke-NativeCommand $VenvPython '-m' 'pip' 'install' '--upgrade' 'pip'
Invoke-NativeCommand $VenvPython '-m' 'pip' 'install' '-r' 'server\requirements.txt'

# Supprime une résolution partielle laissée par une installation npm interrompue.
if (Test-Path 'web\node_modules') {
    Remove-Item 'web\node_modules' -Recurse -Force
}
if (Test-Path 'web\package-lock.json') {
    Remove-Item 'web\package-lock.json' -Force
}

Push-Location 'web'
try {
    Invoke-NativeCommand npm 'install'
    Invoke-NativeCommand npm 'run' 'build'
} finally {
    Pop-Location
}

if (-not (Test-Path 'web\.env.local')) {
    Copy-Item 'web\.env.example' 'web\.env.local'
}

Write-Host 'Installation terminée avec succès. Configurez web\.env.local puis lancez scripts\windows\run.ps1.'
