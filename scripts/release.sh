#!/bin/sh
# Refresh mods/herdr-draw: the built mod as people install it (herdr.dev: "add the mod
# github.com/ryanthedev/herdr-draw" copies this folder). Run before committing a change people
# should get; test/release.test.js fails while it's stale.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
"$here/scripts/build.sh" >/dev/null
mkdir -p "$here/mods"
rm -rf "$here/mods/herdr-draw"
cp -R "$here/build/herdr-draw" "$here/mods/herdr-draw"
echo "$here/mods/herdr-draw"
