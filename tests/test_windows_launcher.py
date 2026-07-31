from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUN_SCRIPT = ROOT / "scripts" / "windows" / "run.ps1"


def test_windows_launcher_uses_one_dynamic_server():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "function Get-FreePort" in script
    assert "TcpListener" in script
    assert "LocalEndpoint.Port" in script
    assert "$Env:VITE_API_URL = '/'" in script
    assert "npm run build --prefix web" in script
    assert "server.main:app" in script
    assert "SIMULATEUR_INSTANCE_TOKEN" in script
    assert "Wait-Identity" in script


def test_windows_launcher_does_not_manage_fixed_ports_or_vite_runtime():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "Get-NetTCPConnection" not in script
    assert "taskkill.exe" not in script
    assert "Clear-ProjectPort" not in script
    assert "npm run dev" not in script
    assert "--reload" not in script
    assert "127.0.0.1:8000" not in script
    assert "127.0.0.1:5173" not in script


def test_windows_launcher_only_stops_the_previous_tracked_api():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "function Stop-PreviousInstance" in script
    assert "launcher-instance.json" in script
    assert "apiPid = $ApiProcess.Id" in script
    assert "PID=$oldPid reutilise par un autre processus" in script
