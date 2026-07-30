param()

$ErrorActionPreference = 'Stop'
chcp.com 65001 > $null
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

function Enable-ProjectPdal {
    $LocalEnv = Join-Path $Root '.pdal-env'
    $LocalPdal = Join-Path $LocalEnv 'Library\bin\pdal.exe'
    if (Test-Path $LocalPdal) {
        $Env:PATH = @(
            (Join-Path $LocalEnv 'Library\bin'),
            (Join-Path $LocalEnv 'Scripts'),
            (Join-Path $LocalEnv 'Library\usr\bin'),
            $Env:PATH
        ) -join [System.IO.Path]::PathSeparator
        $Env:SIMULATEUR_PDAL_EXE = $LocalPdal
        return Get-Command pdal -ErrorAction SilentlyContinue
    }

    $Command = Get-Command pdal -ErrorAction SilentlyContinue
    if ($Command) {
        $Env:SIMULATEUR_PDAL_EXE = $Command.Source
    }
    return $Command
}

$Pdal = Enable-ProjectPdal
if ($Pdal) {
    Write-Host "PDAL détecté : $($Pdal.Source)"
    & pdal --version
} else {
    Write-Warning 'PDAL est introuvable. Exécutez scripts\windows\install-pdal.ps1 une fois, puis relancez run.ps1 pour activer le crop/nettoyage LiDAR.'
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

function Wait-ForPdalGateway {
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/lidar/pdal/status' -TimeoutSec 2
            if ($response.available -eq $true) {
                Write-Host "Passerelle PDAL prête : $($response.executable)"
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    throw 'La passerelle PDAL répond, mais PDAL n’est pas visible par le serveur. Relancez scripts\windows\install-pdal.ps1 puis run.ps1.'
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

$EscapedPath = $Env:PATH.Replace("'", "''")
$EscapedPdalExe = ($Env:SIMULATEUR_PDAL_EXE ?? '').Replace("'", "''")
$ApiCommand = "chcp.com 65001 > `$null; Set-Location '$Root'; `$Env:PATH = '$EscapedPath'; `$Env:SIMULATEUR_PDAL_EXE = '$EscapedPdalExe'; & '$VenvPython' -m uvicorn server.main:app --reload --port 8000"
$WebCommand = "chcp.com 65001 > `$null; Set-Location '$Root'; npm run dev --prefix web"

Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $ApiCommand)
Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-Command', $WebCommand)

Wait-ForUrl -Url 'http://127.0.0.1:8000/health' -Name 'API LiDAR'
Wait-ForUrl -Url 'http://127.0.0.1:8000/local-lidar/files' -Name 'Accès aux dalles locales'
Wait-ForPdalGateway
Wait-ForUrl -Url 'http://127.0.0.1:5173/laz-perf/laz-perf.wasm' -Name 'Décodeur LiDAR local'
Wait-ForUrl -Url 'http://127.0.0.1:5173/lidar.html' -Name 'Vue COPC iTowns dédiée'
Wait-ForUrl -Url 'http://127.0.0.1:5173' -Name 'Interface cartographique'

Start-Process 'http://127.0.0.1:5173'
