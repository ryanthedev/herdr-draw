#!/bin/sh
# Make every commit on main reinstall the mod into the person's Herdr (scripts/install.sh).
# Undo: rm .git/hooks/post-commit
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
hook="$here/.git/hooks/post-commit"
cat > "$hook" <<'EOF'
#!/bin/sh
# herdr-draw: reinstall the mod after each commit on main (see scripts/install-hook.sh).
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || exit 0
root=$(git rev-parse --show-toplevel)
mkdir -p "$root/build"
sh "$root/scripts/install.sh" >"$root/build/install.log" 2>&1 \
  && echo "herdr-draw: installed $(git rev-parse --short HEAD)" \
  || echo "herdr-draw: install failed, see build/install.log"
EOF
chmod +x "$hook"
echo "post-commit hook installed: $hook"
