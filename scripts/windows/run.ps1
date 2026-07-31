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
$ApiLog = Join-Path $LogDir 'api-console.log'
$WebLog = Join-Path $LogDir 'web-console.log'
$StatusJson = Join-Path $LogDir 'last-pdal-status.json'
$InstanceToken = [Guid]::NewGuid().ToString('N')

function Write-Log([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $LauncherLog -Encoding UTF8 -Value $line
    Write-Host $Message
}

function Invoke-Native([string]$Name, [scriptblock]$Command) {
    Write-Log "Commande native : $Name"
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 0
        & $Command 2>&1 | ForEach-Object {
            $text = $_.ToString()
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value $text
            Write-Host $text
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    if ($null -eq $code) { $code = 0 }
    Write-Log "Code retour $Name : $code"
    if ($code -ne 0) { throw "$Name a echoue avec le code $code. Consultez $LauncherLog." }
}

function Escape-SingleQuoted([AllowNull()][string]$Value) {
    if ($null -eq $Value) { return '' }
    return $Value.Replace("'", "''")
}

function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-ProjectProcess([AllowNull()][object]$Process, [int]$Port = 0) {
    if ($null -eq $Process) { return $false }
    $line = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($line)) { return $false }
    $lower = $line.ToLowerInvariant()
    $rootNeedle = $Root.ToLowerInvariant()
    $runtimeNeedle = $RuntimeDir.ToLowerInvariant()

    if ($lower.Contains('start-api.ps1') -or $lower.Contains('start-web.ps1')) { return $true }
    if ($lower.Contains('uvicorn') -and ($lower.Contains('server.app:app') -or $lower.Contains('server.main:app'))) { return $true }
    if ($Port -eq 8000 -and $lower.Contains('multiprocessing.spawn')) { return $true }
    if (($lower.Contains('vite') -or $lower.Contains('npm run dev')) -and ($lower.Contains($rootNeedle) -or $lower.Contains($runtimeNeedle))) { return $true }
    return $false
}

function Get-ProjectRootPid([int]$ProcessId) {
    $candidate = $ProcessId
    $current = Get-ProcessInfo $ProcessId
    for ($depth = 0; $depth -lt 10 -and $current; $depth++) {
        $parentId = [int]$current.ParentProcessId
        if ($parentId -le 0 -or $parentId -eq $PID) { break }
        $parent = Get-ProcessInfo $parentId
        if (-not (Test-ProjectProcess $parent)) { break }
        $candidate = $parentId
        $current = $parent
    }
    return $candidate
}

function Stop-Tree([int]$ProcessId) {
    if ($ProcessId -le 0 -or $ProcessId -eq $PID) { return }
    $rootPid = Get-ProjectRootPid $ProcessId
    $info = Get-ProcessInfo $rootPid
    $description = if ($info) { "$($info.Name) $($info.CommandLine)" } else { 'processus inconnu ou termine' }
    Write-Log "Arret arbre PID=$rootPid ($description)"
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & taskkill.exe /PID $rootPid /T /F 2>&1 | ForEach-Object {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value $_.ToString()
        }
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
}

function Stop-OldRuntimes {
    $handled = @{}
    foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ([int]$process.ProcessId -eq $PID -or -not (Test-ProjectProcess $process)) { continue }
        $rootPid = Get-ProjectRootPid ([int]$process.ProcessId)
        if ($handled.ContainsKey($rootPid)) { continue }
        $handled[$rootPid] = $true
        Write-Log "Ancienne instance : PID=$($process.ProcessId) Command=$($process.CommandLine)"
        Stop-Tree ([int]$process.ProcessId)
    }
}

function Get-PortOwners([int]$Port) {
    $owners = @()
    foreach ($connection in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        $pidValue = [int]$connection.OwningProcess
        $owners += [pscustomobject]@{ Pid = $pidValue; Info = Get-ProcessInfo $pidValue }
    }
    return $owners
}

function Clear-ProjectPort([int]$Port, [int]$Attempts = 40, [int]$StableChecks = 4) {
    $stable = 0
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $owners = @(Get-PortOwners $Port)
        if ($owners.Count -eq 0) {
            $stable++
            if ($stable -ge $StableChecks) {
                Write-Log "Port $Port libre et stable."
                return
            }
        } else {
            $stable = 0
            foreach ($owner in $owners) {
                if ($owner.Info -and -not (Test-ProjectProcess $owner.Info $Port)) {
                    throw "Le port $Port est occupe par $($owner.Info.Name) (PID $($owner.Pid)). Fermez cette application."
                }
                Write-Log "Nettoyage port $Port PID=$($owner.Pid)"
                Stop-Tree $owner.Pid
            }
        }
        Start-Sleep -Milliseconds 350
    }
    $remaining = @(Get-PortOwners $Port | ForEach-Object { "PID=$($_.Pid)" }) -join ', '
    throw "Le port $Port ne reste pas libre ($remaining). Consultez $LauncherLog."
}

function Assert-Running([AllowNull()][System.Diagnostics.Process]$Process, [string]$Name) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if ($Process.HasExited) { throw "$Name s'est arrete avec le code $($Process.ExitCode). Consultez $LogDir." }
}

function Wait-Identity([System.Diagnostics.Process]$Process, [string]$ExpectedToken, [int]$Attempts = 60) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Assert-Running $Process 'API LiDAR'
        try {
            $identity = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/runtime/identity' -TimeoutSec 2
            if ([string]$identity.instanceToken -eq $ExpectedToken) {
                Write-Log "API attendue prete : PID=$($identity.processId) Token=$ExpectedToken"
                return
            }
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) Ancienne API detectee : token='$($identity.instanceToken)'"
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) Attente API $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "La nouvelle API n'a pas pris le port 8000. Consultez $LogDir."
}

function Wait-Url([string]$Url, [string]$Name, [AllowNull()][System.Diagnostics.Process]$Process = $null, [int]$Attempts = 60) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        Assert-Running $Process $Name
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
                Write-Log "$Name pret."
                return
            }
        } catch {
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) $Name attente $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name n'a pas demarre. Consultez $LogDir."
}

function Wait-Pdal([System.Diagnostics.Process]$Process) {
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        Assert-Running $Process 'API LiDAR'
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/lidar/pdal/status' -TimeoutSec 2
            $json = $status | ConvertTo-Json -Depth 12
            Set-Content -Path $StatusJson -Encoding UTF8 -Value $json
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) PDAL status : $json"
            if ($status.available -eq $true) {
                Write-Log "Passerelle PDAL prete : $($status.executable)"
                return
            }
            throw "L'API fonctionne, mais PDAL est introuvable. Statut : $StatusJson"
        } catch {
            if ($_.Exception.Message -like "L'API fonctionne, mais PDAL*") { throw }
            Add-Content -Path $LauncherLog -Encoding UTF8 -Value "$(Get-Date -Format o) PDAL attente $attempt : $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "PDAL n'est pas disponible. Logs : $LogDir"
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

Write-Log '--- Demarrage simulateur ---'
Write-Log "Root=$Root"
Write-Log "InstanceToken=$InstanceToken"
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw 'Executez scripts\windows\install.ps1.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js et npm sont requis.' }
$PdalExe = Find-Pdal
if (-not $PdalExe) { throw 'PDAL est introuvable. Executez scripts\windows\install-pdal.ps1.' }
$Env:SIMULATEUR_PDAL_EXE = $PdalExe
Invoke-Native 'pdal --version' { & $PdalExe --version }

$Env:npm_config_loglevel = 'error'
Invoke-Native 'npm install web' { & npm install --prefix web --no-audit --no-fund --loglevel=error }
Invoke-Native 'copy laz-perf' { & node (Join-Path $Root 'web\scripts\copy-laz-perf.mjs') }
Invoke-Native 'npm verify iTowns' { & npm run verify:itowns --prefix web --loglevel=error }

Stop-OldRuntimes
Clear-ProjectPort 8000
Clear-ProjectPort 5173

$ApiScript = Join-Path $RuntimeDir 'start-api.ps1'
$WebScript = Join-Path $RuntimeDir 'start-web.ps1'
$EscapedRoot = Escape-SingleQuoted $Root
$EscapedPath = Escape-SingleQuoted $Env:PATH
$EscapedPython = Escape-SingleQuoted $Python
$EscapedPdal = Escape-SingleQuoted $PdalExe
$EscapedToken = Escape-SingleQuoted $InstanceToken
$EscapedApiLog = Escape-SingleQuoted $ApiLog
$EscapedWebLog = Escape-SingleQuoted $WebLog

$ApiContent = @"
`$ErrorActionPreference = 'Continue'
chcp.com 65001 > `$null
Start-Transcript -Path '$EscapedApiLog' -Append | Out-Null
Set-Location '$EscapedRoot'
`$Env:PATH = '$EscapedPath'
`$Env:PYTHONPATH = '$EscapedRoot'
`$Env:PYTHONUNBUFFERED = '1'
`$Env:SIMULATEUR_PDAL_EXE = '$EscapedPdal'
`$Env:SIMULATEUR_INSTANCE_TOKEN = '$EscapedToken'
Write-Host "API PDAL=`$Env:SIMULATEUR_PDAL_EXE"
Write-Host "API Token=`$Env:SIMULATEUR_INSTANCE_TOKEN"
& '$EscapedPython' -m uvicorn server.main:app --host 127.0.0.1 --port 8000
`$code = `$LASTEXITCODE
Stop-Transcript | Out-Null
exit `$code
"@
$WebContent = @"
`$ErrorActionPreference = 'Continue'
chcp.com 65001 > `$null
Start-Transcript -Path '$EscapedWebLog' -Append | Out-Null
Set-Location '$EscapedRoot'
npm run dev --prefix web --loglevel=error
`$code = `$LASTEXITCODE
Stop-Transcript | Out-Null
exit `$code
"@
Set-Content -Path $ApiScript -Encoding UTF8 -Value $ApiContent
Set-Content -Path $WebScript -Encoding UTF8 -Value $WebContent
@{ token = $InstanceToken; launcherPid = $PID; startedAt = (Get-Date).ToString('o'); pdalExecutable = $PdalExe } |
    ConvertTo-Json | Set-Content -Path (Join-Path $RuntimeDir 'launcher-instance.json') -Encoding UTF8

function Start-Api {
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ApiScript`"") -PassThru
}

$ApiProcess = Start-Api
try {
    Wait-Identity $ApiProcess $InstanceToken
} catch {
    Write-Log "Premier demarrage API echoue : $($_.Exception.Message)"
    Stop-OldRuntimes
    Clear-ProjectPort 8000
    $ApiProcess = Start-Api
    Wait-Identity $ApiProcess $InstanceToken
}
$WebProcess = Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$WebScript`"") -PassThru

Wait-Url 'http://127.0.0.1:8000/health' 'API LiDAR' $ApiProcess
Wait-Url 'http://127.0.0.1:8000/local-lidar/files' 'Acces aux dalles locales' $ApiProcess
Wait-Pdal $ApiProcess
Wait-Url 'http://127.0.0.1:8000/diagnostics/status' 'Diagnostics serveur' $ApiProcess
Wait-Url 'http://127.0.0.1:5173/laz-perf/laz-perf.wasm' 'Decodeur LiDAR local' $WebProcess
Wait-Url 'http://127.0.0.1:5173/lidar.html' 'Vue COPC iTowns' $WebProcess
Wait-Url 'http://127.0.0.1:5173' 'Interface cartographique' $WebProcess
Write-Log 'Demarrage termine.'
Start-Process 'http://127.0.0.1:5173'
