param()
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

if (-not (Test-Path '.venv\Scripts\python.exe')) { throw 'Exécutez d’abord scripts\windows\install.ps1.' }

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Root'; .\.venv\Scripts\python.exe -m uvicorn server.app:app --reload --port 8000"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$Root'; npm run dev --prefix web"
Start-Sleep -Seconds 2
Start-Process 'http://localhost:5173'
