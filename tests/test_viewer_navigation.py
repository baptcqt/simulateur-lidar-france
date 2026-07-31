from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NAVIGATION = ROOT / "web" / "src" / "reliable-navigation.ts"
INDEX = ROOT / "web" / "index.html"
LIDAR_BOOTSTRAP = ROOT / "web" / "src" / "lidar-bootstrap.ts"
SELECTION_GUARD = ROOT / "web" / "src" / "selection-no-recenter.ts"


def test_reliable_zoom_is_loaded_in_both_itowns_views():
    navigation = NAVIGATION.read_text(encoding="utf-8")
    index = INDEX.read_text(encoding="utf-8")
    bootstrap = LIDAR_BOOTSTRAP.read_text(encoding="utf-8")

    assert "/src/reliable-navigation.ts" in index
    assert "await import('./reliable-navigation')" in bootstrap
    assert "addEventListener('wheel'" in navigation
    assert "passive: false" in navigation
    assert "event.stopImmediatePropagation()" in navigation
    assert "controls.lookAtCoordinate" in navigation
    assert "controller.zoomBy" in navigation
    assert "touch-action: none" in navigation
    assert "overscroll-behavior-x: none" in navigation


def test_zoom_controls_are_reenabled_after_rectangle_selection():
    navigation = NAVIGATION.read_text(encoding="utf-8")
    selection_guard = SELECTION_GUARD.read_text(encoding="utf-8")

    assert "view.controls.enabled = !document.body.classList.contains('selection-active')" in navigation
    assert "new MutationObserver(sync)" in navigation
    assert "originalLookAtCoordinate(options, ...args)" in selection_guard


def test_standalone_viewer_blocks_accidental_history_navigation():
    navigation = NAVIGATION.read_text(encoding="utf-8")

    assert "history.pushState" in navigation
    assert "window.addEventListener('popstate'" in navigation
    assert "history.forward()" in navigation
    assert "event.stopImmediatePropagation()" in navigation
    assert "window.location.replace('/')" in navigation
