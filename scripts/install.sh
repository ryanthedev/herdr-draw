#!/bin/sh
# Install the committed build into the person's own Herdr (~/.config/herdr-app), whatever
# HERDR_APP_HOME a shell has (a Claude shell may point it at the test home ~/.cache/hdt).
# Builds from HEAD, not the working tree, so half-done edits never reach the person's window.
# Also run by .git/hooks/post-commit (scripts/install-hook.sh), so every commit updates it.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
home_dir="$HOME/.config/herdr-app"
dest="$home_dir/mods/herdr-draw"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/herdr-draw-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

git -C "$here" archive HEAD | tar -x -C "$tmp"
"$tmp/scripts/build.sh" >/dev/null
mkdir -p "$dest"
rsync -a --delete "$tmp/build/herdr-draw/" "$dest/"
mkdir -p "$home_dir/herdr-draw" "$HOME/.local/bin"
ln -sf "$dest/drawh" "$HOME/.local/bin/drawh"
env -u HERDR_APP_HOME herdr-app check "$dest"
echo "herdr-draw $(git -C "$here" rev-parse --short HEAD) installed. Reopen an open board pane to load it."
