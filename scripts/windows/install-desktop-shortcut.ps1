[CmdletBinding()]
param(
    [string]$Name = 'Simulateur LiDAR France',
    [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Launcher = Join-Path $PSScriptRoot 'launch.ps1'

if (-not (Test-Path -LiteralPath $Launcher)) {
    throw "Lanceur introuvable : $Launcher"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$targets = @((Join-Path $desktop "$Name.lnk"))
if ($StartMenu) {
    $programs = [Environment]::GetFolderPath('Programs')
    $targets += Join-Path $programs "$Name.lnk"
}

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $targets) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.Description = 'Démarrer le prototype Simulateur LiDAR France'
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,18"
    $shortcut.Save()
    Write-Host "Raccourci créé : $shortcutPath" -ForegroundColor Green
}
