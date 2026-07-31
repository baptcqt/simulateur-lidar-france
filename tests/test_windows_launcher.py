from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUN_SCRIPT = ROOT / "scripts" / "windows" / "run.ps1"


def test_windows_launcher_uses_instance_identity_and_no_reloader():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "SIMULATEUR_INSTANCE_TOKEN" in script
    assert "Wait-Identity" in script
    assert "/runtime/identity" in script
    assert "--reload" not in script


def test_windows_launcher_requires_a_stably_free_api_port():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "StableChecks = 4" in script
    assert "Get-ProjectRootPid" in script
    assert "taskkill.exe /PID $rootPid /T /F" in script
    assert "Premier demarrage API echoue" in script


def test_windows_launcher_ignores_ghost_tcp_rows_only_after_bind_probe():
    script = RUN_SCRIPT.read_text(encoding="utf-8-sig")

    assert "function Test-PortBindable" in script
    assert "[System.Net.Sockets.TcpListener]::new" in script
    assert "if (Test-PortBindable $Port)" in script
    assert "if (-not $owner.Info)" in script
    assert "Entree TCP obsolete ignoree" in script
    assert "PID=$rootPid absent : aucun arbre de processus a arreter." in script
