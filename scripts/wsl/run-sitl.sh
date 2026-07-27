#!/usr/bin/env bash
set -euo pipefail; cd "${PX4_DIR:-$HOME/PX4-Autopilot}"; ${HEADLESS:+HEADLESS=1} make px4_sitl gz_x500
