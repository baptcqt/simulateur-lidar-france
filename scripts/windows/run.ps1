param()

$ErrorActionPreference = 'Stop'
chcp.com 65001 > $null
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$LogDir = Join-Path $Root 'logs'
$RuntimeDir = Join-Path $Root '.runtime'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$LauncherLog = Join-Path $LogDir 'launcher.log'
$ApiLog = Join-Path $LogDir 'api-console.log'
$WebLog = Join-Path $LogDir 'web-console.log'
$StatusJson = Join-Path $LogDir 'last-pdal-status.json'

function Write-LauncherLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $LauncherLog -Encoding UTF8 -Value $line
    Write-Host $Message
}

Write-LauncherLog '--- Démarrage simulateur ---'
Write-LauncherLog "Root=$Root"
Write-LauncherLog "PowerShell=$($PSVersionTable.PSVersion)"
Write-LauncherLog "LogDir=$LogDir"

$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $VenvPython)) {
    Write-LauncherLog 'Python virtuel introuvable.'
    throw 'Exécutez d’abord scripts\windows\install.ps1.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-LauncherLog 'npm introuvable.'
    throw 'Node.js et npm sont requis.'
}

function Enable-ProjectPdal {
    $LocalEnv = Join-Path $Root '.pdal-env'
    $LocalPdal = Join-Path $LocalEnv 'Library\bin\pdal.exe'
    Write-LauncherLog "Recherche PDAL local : $LocalPdal"
    if (Test-Path $LocalPdal) {
        $Env:PATH = @(
            (Join-Path $LocalEnv 'Library\bin'),
            (Join-Path $LocalEnv 'Scripts'),
            (Join-Path $LocalEnv 'Library\usr\bin'),
            $Env:PATH
        ) -join [System.IO.Path]::PathSeparator
        $Env:SIMULATEUR_PDAL_EXE = $LocalPdal
        Write-LauncherLog "SIMULATEUR_PDAL_EXE=$($Env:SIMULATEUR_PDAL_EXE)"
        return Get-Command pdal -ErrorAction SilentlyContinue
    }

    $Command = Get-Command pdal -ErrorAction SilentlyContinue
    if ($Command) {
        $Env:SIMULATEUR_PDAL_EXE = $Command.Source
        Write-LauncherLog "PDAL système=$($Command.Source)"
    }
    return $Command
}

$Pdal = Enable-ProjectPdal
if ($Pdal) {
    Write-LauncherLog "PDAL détecté : $($Pdal.Source)"
    & pdal --version 2>&1 | Tee-Object -FilePath $LauncherLog -Append
} else {
    Write-LauncherLog 'AVERTISSEMENT : PDAL introuvable côté lanceur.'
}

function Stop-ProjectListener {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if (-not $process) { continue }

        if ($process.ProcessName -notin @('node', 'python', 'python3', 'pythonw')) {
            Write-LauncherLog "Port $Port occupé par $($process.ProcessName) PID=$($process.Id)"
            throw "Le port $Port est occupé par $($process.ProcessName) (PID $($process.Id)). Fermez cette application avant de lancer le simulateur."
        }

        Write-LauncherLog "Arrêt de l’ancienne instance $($process.ProcessName) sur le port $Port PID=$($process.Id)"
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
                Write-LauncherLog "$Name prêt."
                return
            }
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Name attente $attempt : $($_.Exception.Message)"
            Start-Sleep -Milliseconds 500
        }
    }

    throw "$Name n’a pas démarré correctement. Logs : $LogDir"
}

function Wait-ForPdalGateway {
    $lastResponse = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/lidar/pdal/status' -TimeoutSec 2
            $lastResponse = $response | ConvertTo-Json -Depth 12
            Set-Content -Path $StatusJson -Encoding UTF8 -Value $lastResponse
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) PDAL status tentative $attempt : $lastResponse"
            if ($response.available -eq $true) {
                Write-LauncherLog "Passerelle PDAL prête : $($response.executable)"
                return
            }
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) PDAL status erreur $attempt : $($_.Exception.Message)"
            Start-Sleep -Milliseconds 500
        }
    }

    Write-LauncherLog "PDAL invisible par le serveur. Statut écrit dans $StatusJson"
    Write-LauncherLog 'Ouvrez http://127.0.0.1:8000/diagnostics/logs.zip et envoyez le ZIP.'
    throw "La passerelle PDAL répond, mais PDAL n’est pas visible par le serveur. Logs : $LogDir"
}

function Escape-ForSingleQuotedPowerShellString {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) { return '' }
    return $Value.Replace("'", "''")
}

Write-LauncherLog 'Synchronisation des dépendances iTowns et du décodeur LiDAR...'
& npm install --prefix web --no-audit --no-fund 2>&1 | Tee-Object -FilePath $LauncherLog -Append
if ($LASTEXITCODE -ne 0) { throw 'L’installation des dépendances web a échoué.' }

& node (Join-Path $Root 'web\scripts\copy-laz-perf.mjs') 2>&1 | Tee-Object -FilePath $LauncherLog -Append
if ($LASTEXITCODE -ne 0) { throw 'La préparation du décodeur LiDAR a échoué.' }

& npm run verify:itowns --prefix web 2>&1 | Tee-Object -FilePath $LauncherLog -Append
if ($LASTEXITCODE -ne 0) { throw 'La chaîne COPC iTowns est incomplète ou incohérente.' }

Stop-ProjectListener -Port 8000
Stop-ProjectListener -Port 5173
Start-Sleep -Milliseconds 700

$ApiScript = Join-Path $RuntimeDir 'start-api.ps1'
$WebScript = Join-Path $RuntimeDir 'start-web.ps1'

$EscapedRoot = Escape-ForSingleQuotedPowerShellString $Root
$EscapedPath = Escape-ForSingleQuotedPowerShellString $Env:PATH
$EscapedPython = Escape-ForSingleQuotedPowerShellString $VenvPython
$EscapedPdalExe = Escape-ForSingleQuotedPowerShellString $Env:SIMULATEUR_PDAL_EXE
$EscapedApiLog = Escape-ForSingleQuotedPowerShellString $ApiLog
$EscapedWebLog = Escape-ForSingleQuotedPowerShellString $WebLog

$ApiScriptContent = @"
`$ErrorActionPreference = 'Stop'
chcp.com 65001 > `$null
`$Utf8 = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = `$Utf8
[Console]::OutputEncoding = `$Utf8
`$OutputEncoding = `$Utf8
Start-Transcript -Path '$EscapedApiLog' -Append | Out-Null
Set-Location '$EscapedRoot'
`$Env:PATH = '$EscapedPath'
`$Env:PYTHONPATH = '$EscapedRoot'
`$Env:SIMULATEUR_PDAL_EXE = '$EscapedPdalExe'
Write-Host "API cwd=`$(Get-Location)"
Write-Host "API python='$EscapedPython'"
Write-Host "API SIMULATEUR_PDAL_EXE=`$Env:SIMULATEUR_PDAL_EXE"
Write-Host "API Test-Path PDAL=`$(Test-Path `$Env:SIMULATEUR_PDAL_EXE)"
& '$EscapedPython' -m uvicorn server.main:app --reload --port 8000
Stop-Transcript | Out-Null
"@

$WebScriptContent = @"
`$ErrorActionPreference = 'Stop'
chcp.com 65001 > `$null
Start-Transcript -Path '$EscapedWebLog' -Append | Out-Null
Set-Location '$EscapedRoot'
npm run dev --prefix web
Stop-Transcript | Out-Null
"@

Set-Content -Path $ApiScript -Value $ApiScriptContent -Encoding UTF8
Set-Content -Path $WebScript -Value $WebScriptContent -Encoding UTF8
Write-LauncherLog "Script API écrit : $ApiScript"
Write-LauncherLog "Script Web écrit : $WebScript"

Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ApiScript`"")
Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$WebScript`"")

Wait-ForUrl -Url 'http://127.0.0.1:8000/health' -Name 'API LiDAR'
Wait-ForUrl -Url 'http://127.0.0.1:8000/local-lidar/files' -Name 'Accès aux dalles locales'
Wait-ForPdalGateway
Wait-ForUrl -Url 'http://127.0.0.1:8000/diagnostics/status' -Name 'Diagnostics serveur'
Wait-ForUrl -Url 'http://127.0.0.1:5173/laz-perf/laz-perf.wasm' -Name 'Décodeur LiDAR local'
Wait-ForUrl -Url 'http://127.0.0.1:5173/lidar.html' -Name 'Vue COPC iTowns dédiée'
Wait-ForUrl -Url 'http://127.0.0.1:5173' -Name 'Interface cartographique'

Write-LauncherLog 'Démarrage terminé.'
Start-Process 'http://127.0.0.1:5173'
