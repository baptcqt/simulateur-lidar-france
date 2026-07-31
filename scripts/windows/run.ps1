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
New-Item -ItemType Directory -Force -Path $LogDir, $RuntimeDir | Out-Null

$LauncherLog = Join-Path $LogDir 'launcher.log'
$ApiStdout = Join-Path $LogDir 'api-stdout.log'
$ApiStderr = Join-Path $LogDir 'api-stderr.log'
$StatusJson = Join-Path $LogDir 'last-pdal-status.json'
$StateFile = Join-Path $RuntimeDir 'launcher-instance.json'

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $LauncherLog -Encoding UTF8 -Value $line
    Write-Host $Message
}

function Invoke-Native([string]$Name, [scriptblock]$Command) {
    Write-Log "Commande native : $Name"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $Command 2>&1 | ForEach-Object {
            $text = $_.ToString()
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value $text
            Write-Host $text
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($null -eq $exitCode) { $exitCode = 0 }
    Write-Log "Code retour $Name : $exitCode"
    if ($exitCode -ne 0) {
        throw "$Name a echoue avec le code $exitCode. Consultez $LauncherLog."
    }
}

function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Stop-PreviousInstance {
    if (-not (Test-Path -LiteralPath $StateFile)) { return }

    try {
        $state = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $oldPid = [int]$state.apiPid
    } catch {
        Write-Log 'Ancien fichier de lancement illisible ; il est supprime.'
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
        return
    }

    if ($oldPid -gt 0) {
        $process = Get-ProcessInfo $oldPid
        if ($process) {
            $commandLine = ([string]$process.CommandLine).ToLowerInvariant()
            $rootNeedle = $Root.ToLowerInvariant()
            $isOurApi = $commandLine.Contains($rootNeedle) -and
                $commandLine.Contains('uvicorn') -and
                $commandLine.Contains('server.main:app')

            if ($isOurApi) {
                Write-Log "Arret de l'ancienne API suivie par le lanceur : PID=$oldPid"
                Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            } else {
                Write-Log "PID=$oldPid reutilise par un autre processus ; aucun arret effectue."
            }
        }
    }

    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return [int]$listener.LocalEndpoint.Port
    } finally {
        $listener.Stop()
    }
}

function Assert-Running([System.Diagnostics.Process]$Process, [string]$Name) {
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "$Name s'est arrete avec le code $($Process.ExitCode). Consultez $ApiStderr."
    }
}

function Wait-Identity(
    [System.Diagnostics.Process]$Process,
    [string]$BaseUrl,
    [string]$ExpectedToken,
    [int]$Attempts = 80
) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Assert-Running $Process 'API LiDAR'
        try {
            $identity = Invoke-RestMethod -Uri "$BaseUrl/runtime/identity" -TimeoutSec 2
            if ([string]$identity.instanceToken -eq $ExpectedToken) {
                Write-Log "API prete : PID=$($identity.processId), URL=$BaseUrl"
                return
            }
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) Attente API $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 400
    }
    throw "L'API n'a pas demarre correctement. Consultez $ApiStderr."
}

function Wait-Url(
    [System.Diagnostics.Process]$Process,
    [string]$Url,
    [string]$Name,
    [int]$Attempts = 60
) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Assert-Running $Process $Name
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                Write-Log "$Name pret."
                return
            }
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Name attente $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 400
    }
    throw "$Name n'est pas disponible. Consultez $LogDir."
}

function Find-Pdal {
    $localEnv = Join-Path $Root '.pdal-env'
    $localExe = Join-Path $localEnv 'Library\bin\pdal.exe'
    if (Test-Path -LiteralPath $localExe) {
        $Env:PATH = @(
            (Join-Path $localEnv 'Library\bin'),
            (Join-Path $localEnv 'Scripts'),
            (Join-Path $localEnv 'Library\usr\bin'),
            $Env:PATH
        ) -join [System.IO.Path]::PathSeparator
        return (Resolve-Path -LiteralPath $localExe).Path
    }

    $command = Get-Command pdal -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

Write-Log '--- Demarrage simulateur, mode serveur unique ---'
Write-Log "Root=$Root"

$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) {
    throw 'Executez scripts\windows\install.ps1.'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js et npm sont requis.'
}

$PdalExe = Find-Pdal
if (-not $PdalExe) {
    throw 'PDAL est introuvable. Executez scripts\windows\install-pdal.ps1.'
}
$Env:SIMULATEUR_PDAL_EXE = $PdalExe
Invoke-Native 'pdal --version' { & $PdalExe --version }

Stop-PreviousInstance

$Env:npm_config_loglevel = 'error'
Invoke-Native 'npm install web' { & npm install --prefix web --no-audit --no-fund --loglevel=error }
Invoke-Native 'npm verify iTowns' { & npm run verify:itowns --prefix web --loglevel=error }

$ApiPort = Get-FreePort
$ApiBase = "http://127.0.0.1:$ApiPort"
$InstanceToken = [Guid]::NewGuid().ToString('N')
$Env:VITE_API_URL = $ApiBase
Write-Log "Port dynamique choisi par Windows : $ApiPort"
Invoke-Native 'npm build web' { & npm run build --prefix web --loglevel=error }

$WebDist = Join-Path $Root 'web\dist'
if (-not (Test-Path -LiteralPath (Join-Path $WebDist 'index.html'))) {
    throw 'Le build Web est incomplet : web\dist\index.html est absent.'
}
if (-not (Test-Path -LiteralPath (Join-Path $WebDist 'lidar.html'))) {
    throw 'Le build Web est incomplet : web\dist\lidar.html est absent.'
}

Remove-Item -LiteralPath $ApiStdout, $ApiStderr -Force -ErrorAction SilentlyContinue
$Env:PYTHONPATH = $Root
$Env:PYTHONUNBUFFERED = '1'
$Env:SIMULATEUR_INSTANCE_TOKEN = $InstanceToken

$ApiProcess = Start-Process \
    -FilePath $Python \
    -ArgumentList @('-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', "$ApiPort") \
    -WorkingDirectory $Root \
    -RedirectStandardOutput $ApiStdout \
    -RedirectStandardError $ApiStderr \
    -WindowStyle Hidden \
    -PassThru

@{
    apiPid = $ApiProcess.Id
    apiPort = $ApiPort
    apiUrl = $ApiBase
    instanceToken = $InstanceToken
    pdalExecutable = $PdalExe
    startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8

try {
    Wait-Identity $ApiProcess $ApiBase $InstanceToken
    Wait-Url $ApiProcess "$ApiBase/health" 'API LiDAR'
    Wait-Url $ApiProcess "$ApiBase/local-lidar/files" 'Acces aux dalles locales'

    $pdalStatus = Invoke-RestMethod -Uri "$ApiBase/lidar/pdal/status" -TimeoutSec 4
    $pdalStatus | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $StatusJson -Encoding UTF8
    if ($pdalStatus.available -ne $true) {
        throw "L'API fonctionne, mais PDAL est introuvable. Statut : $StatusJson"
    }
    Write-Log "Passerelle PDAL prete : $($pdalStatus.executable)"

    Wait-Url $ApiProcess "$ApiBase/diagnostics/status" 'Diagnostics serveur'
    Wait-Url $ApiProcess "$ApiBase/laz-perf/laz-perf.wasm" 'Decodeur LiDAR local'
    Wait-Url $ApiProcess "$ApiBase/lidar.html" 'Vue COPC iTowns'
    Wait-Url $ApiProcess "$ApiBase/" 'Interface cartographique'
} catch {
    Stop-Process -Id $ApiProcess.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    throw
}

Write-Log "Demarrage termine : $ApiBase/"
Start-Process "$ApiBase/"
