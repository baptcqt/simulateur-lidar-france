param()

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    throw 'Exécutez d’abord scripts\windows\install.ps1.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js et npm sont requis.'
}

function Stop-ProjectListener {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if (-not $process) { continue }

        if ($process.ProcessName -notin @('node', 'python', 'python3', 'pythonw')) {
            throw "Le port $Port est occupé par $($process.ProcessName) (PID $($process.Id)). Fermez cette application avant de lancer le simulateur."
        }

        Write-Host "Arrêt de l’ancienne instance $($process.ProcessName) sur le port $Port..."
        Stop-Process -Id $process.Id -Force
    }
}

function Wait-ForUrl {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Name,
        [int]$Attempts = 40
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Write-Host "$Name prêt."
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    throw "$Name n’a pas démarré correctement. Consultez la fenêtre PowerShell correspondante."
}

Stop-ProjectListener -Port 8000
Stop-ProjectListener -Port 5173
Start-Sleep -Milliseconds 700

$ApiCommand = "Set-Location '$Root'; & '$VenvPython' -m uvicorn server.app:app --reload --port 8000"
$WebCommand = "Set-Location '$Root'; npm run dev --prefix web"

Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $ApiCommand)
Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $WebCommand)

Wait-ForUrl -Url 'http://127.0.0.1:8000/health' -Name 'API LiDAR'
Wait-ForUrl -Url 'http://127.0.0.1:5173' -Name 'Interface iTowns'

Start-Process 'http://127.0.0.1:5173'
