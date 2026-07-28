param()
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python 3.11+ est requis.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ est requis.' }

if (-not (Test-Path '.venv')) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r server\requirements.txt
npm install --prefix web

if (-not (Test-Path 'web\.env.local')) { Copy-Item 'web\.env.example' 'web\.env.local' }
Write-Host 'Installation terminée. Configurez web\.env.local puis lancez scripts\windows\run.ps1.'
