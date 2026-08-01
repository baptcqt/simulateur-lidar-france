from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VIEWER_CSS = ROOT / "web" / "src" / "lidar-viewer.css"


def test_lidar_sidebar_stays_inside_viewport_and_scrolls():
    css = VIEWER_CSS.read_text(encoding="utf-8")

    assert "#lidar-controls {" in css
    assert "max-height: calc(100dvh - 28px);" in css
    assert "display: flex;" in css
    assert "flex-direction: column;" in css
    assert "#lidar-controls-body {" in css
    assert "min-height: 0;" in css
    assert "overflow-y: auto;" in css
    assert "overscroll-behavior: contain;" in css


def test_lidar_sidebar_has_responsive_height_limits():
    css = VIEWER_CSS.read_text(encoding="utf-8")

    assert "max-height: calc(100dvh - 86px);" in css
    assert "max-height: calc(100dvh - 126px);" in css
