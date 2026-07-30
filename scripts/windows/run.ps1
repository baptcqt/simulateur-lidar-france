param()

$ErrorActionPreference = 'Stop'
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    throw 'Exécutez d’abord scripts\windows\install.ps1.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js et npm sont requis.'
}

$Pdal = Get-Command pdal -ErrorAction SilentlyContinue
if ($Pdal) {
    Write-Host "PDAL détecté : $($Pdal.Source)"
    & pdal --version
} else {
    Write-Warning 'PDAL est introuvable. La carte démarrera, mais le crop/nettoyage LiDAR échouera tant que PDAL n’est pas installé et accessible dans le PATH.'
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
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                Write-Host "$Name prêt."
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    throw "$Name n’a pas démarré correctement. Consultez la fenêtre PowerShell correspondante."
}

Write-Host 'Synchronisation des dépendances iTowns et du décodeur LiDAR...'
& npm install --prefix web --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'L’installation des dépendances web a échoué.' }

& node (Join-Path $Root 'web\scripts\copy-laz-perf.mjs')
if ($LASTEXITCODE -ne 0) { throw 'La préparation du décodeur LiDAR a échoué.' }

& npm run verify:itowns --prefix web
if ($LASTEXITCODE -ne 0) { throw 'La chaîne COPC iTowns est incomplète ou incohérente.' }

Stop-ProjectListener -Port 8000
Stop-ProjectListener -Port 5173
Start-Sleep -Milliseconds 700

$ApiCommand = "Set-Location '$Root'; & '$VenvPython' -m uvicorn server.main:app --reload --port 8000"
$WebCommand = "Set-Location '$Root'; npm run dev --prefix web"

Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $ApiCommand)
Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $WebCommand)

Wait-ForUrl -Url 'http://127.0.0.1:8000/health' -Name 'API LiDAR'
Wait-ForUrl -Url 'http://127.0.0.1:8000/local-lidar/files' -Name 'Accès aux dalles locales'
Wait-ForUrl -Url 'http://127.0.0.1:8000/lidar/pdal/status' -Name 'Passerelle PDAL'
Wait-ForUrl -Url 'http://127.0.0.1:5173/laz-perf/laz-perf.wasm' -Name 'Décodeur LiDAR local'
Wait-ForUrl -Url 'http://127.0.0.1:5173/lidar.html' -Name 'Vue COPC iTowns dédiée'
Wait-ForUrl -Url 'http://127.0.0.1:5173' -Name 'Interface cartographique'

Start-Process 'http://127.0.0.1:5173'
