param([switch]$NoWeb)
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$api=Start-Process python -ArgumentList '-m','uvicorn','apps.api.main:app','--host','127.0.0.1','--port','8000' -PassThru
if(-not $NoWeb){ npm --workspace apps/web run dev }
Write-Host "API PID $($api.Id)"
