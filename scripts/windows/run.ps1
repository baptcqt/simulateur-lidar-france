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

function Write-LauncherOutput {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return }
    $text = $Value.ToString()
    Add-Content -Path $LauncherLog -Encoding UTF8 -Value $text
    Write-Host $text
}

function Invoke-LoggedNative {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )

    Write-LauncherLog "Commande native : $Name"
    $previousErrorActionPreference = $ErrorActionPreference
    $hasNativePreference = $false
    $previousNativePreference = $null
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
        $hasNativePreference = $true
        $previousNativePreference = $global:PSNativeCommandUseErrorActionPreference
        $global:PSNativeCommandUseErrorActionPreference = $false
    }

    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $Command 2>&1 | ForEach-Object { Write-LauncherOutput $_ }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hasNativePreference) {
            $global:PSNativeCommandUseErrorActionPreference = $previousNativePreference
        }
    }

    if ($null -eq $exitCode) { $exitCode = 0 }
    Write-LauncherLog "Code retour $Name : $exitCode"
    if ($exitCode -ne 0) {
        throw "$Name a échoué avec le code $exitCode. Consultez $LauncherLog."
    }
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
    Invoke-LoggedNative 'pdal --version' { & pdal --version }
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
        [int]$Attempts = 60
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                Write-LauncherLog "$Name prêt."
                return
            }
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Name attente $attempt : HTTP $($response.StatusCode)"
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Name attente $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 500
    }

    throw "$Name n’a pas démarré correctement. Logs : $LogDir"
}

function Wait-ForPdalGateway {
    $lastResponse = $null
    for ($attempt = 1; $attempt -le 80; $attempt++) {
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
        }
        Start-Sleep -Milliseconds 500
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
$Env:npm_config_loglevel = 'error'
Invoke-LoggedNative 'npm install web' { & npm install --prefix web --no-audit --no-fund --loglevel=error }
Invoke-LoggedNative 'copy laz-perf' { & node (Join-Path $Root 'web\scripts\copy-laz-perf.mjs') }
Invoke-LoggedNative 'npm verify iTowns' { & npm run verify:itowns --prefix web --loglevel=error }

Stop-ProjectListener -Port 8000
Stop-ProjectListener -Port 5173
Start-Sleep -Milliseconds 1000

$ApiScript = Join-Path $RuntimeDir 'start-api.ps1'
$WebScript = Join-Path $RuntimeDir 'start-web.ps1'

$EscapedRoot = Escape-ForSingleQuotedPowerShellString $Root
$EscapedPath = Escape-ForSingleQuotedPowerShellString $Env:PATH
$EscapedPython = Escape-ForSingleQuotedPowerShellString $VenvPython
$EscapedPdalExe = Escape-ForSingleQuotedPowerShellString $Env:SIMULATEUR_PDAL_EXE
$EscapedApiLog = Escape-ForSingleQuotedPowerShellString $ApiLog
$EscapedWebLog = Escape-ForSingleQuotedPowerShellString $WebLog

$ApiScriptContent = @"
`$ErrorActionPreference = 'Continue'
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
& '$EscapedPython' -m uvicorn server.main:app --port 8000
Stop-Transcript | Out-Null
"@

$WebScriptContent = @"
`$ErrorActionPreference = 'Continue'
chcp.com 65001 > `$null
`$Env:npm_config_loglevel = 'error'
Start-Transcript -Path '$EscapedWebLog' -Append | Out-Null
Set-Location '$EscapedRoot'
npm run dev --prefix web --loglevel=error
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
