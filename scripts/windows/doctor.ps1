$ErrorActionPreference='Continue'; Set-Location (Resolve-Path "$PSScriptRoot\..\..")
python -m simmap.cli.app doctor
