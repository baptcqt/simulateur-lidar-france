#!/usr/bin/env bash
set -euo pipefail; src=${1:?world.sdf requis}; dst=${2:-$HOME/.simulation-gazebo/worlds/simmap.sdf}; mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; echo "$dst"
