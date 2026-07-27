#!/usr/bin/env bash
set -euo pipefail
. /etc/os-release
case "$VERSION_ID" in 22.04|24.04) ;; *) echo "Ubuntu $VERSION_ID non pris en charge par ce script"; exit 2;; esac
sudo apt-get update; sudo apt-get install -y git python3-jinja2 python3-pip ninja-build exiftool
DIR=${PX4_DIR:-$HOME/PX4-Autopilot}
if [ ! -d "$DIR/.git" ]; then git clone --recursive https://github.com/PX4/PX4-Autopilot.git "$DIR"; else git -C "$DIR" pull --ff-only; git -C "$DIR" submodule update --init --recursive; fi
bash "$DIR/Tools/setup/ubuntu.sh" --no-nuttx
printf 'Test après réouverture du terminal: cd %q && make px4_sitl gz_x500
' "$DIR"
