#!/usr/bin/env bash
set -u; uname -a; grep PRETTY_NAME /etc/os-release; command -v gz || true; command -v make || true; test -d "${PX4_DIR:-$HOME/PX4-Autopilot}" && echo PX4_OK || echo PX4_MISSING
