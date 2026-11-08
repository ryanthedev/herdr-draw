#!/bin/sh
# Build, then copy into the running Herdr app (Herdr doesn't hot-reload a symlinked mod).
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
"$here/scripts/build.sh" >/dev/null
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/herdr-draw"
mkdir -p "$dest"
rsync -a --delete "$here/build/herdr-draw/" "$dest/"
herdr-app check "$dest"
