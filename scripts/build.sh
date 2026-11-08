#!/bin/sh
# Assemble the Herdr mod folder from the adapter + the shared core: build/herdr-draw.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/build/herdr-draw"
rm -rf "$out"; mkdir -p "$out/core"
cp "$here"/adapters/herdr/*.js "$here"/adapters/herdr/*.json "$here"/adapters/herdr/*.d.ts "$out/"
cp "$here"/core/*.js "$out/core/"
rm -f "$out/core/"*.old.js
cp "$here/adapters/svg/svg.js" "$out/svg.js"
cp "$here/cli/drawh" "$out/drawh"
echo "$out"
