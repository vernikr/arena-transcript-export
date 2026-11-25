#!/usr/bin/env bash
# sync-extension.sh — run ON THE MAC (through the Arena Bridge) after the agent
# pushes to GitHub. It refreshes the shared checkout and pokes every Chrome
# profile at once by rewriting the dev-version sentinel.
#
#   bash ~/Downloads/projects/arena-transcript-export/scripts/sync-extension.sh
#
# Exit codes: 0 = synced, 1 = pull failed (dirty tree, diverged branch, network).
set -euo pipefail

REPO="${AREX_REPO:-$HOME/Downloads/projects/arena-transcript-export}"
EXT_DIR="$REPO/extension"
SENTINEL="$EXT_DIR/dev-version.txt"

cd "$REPO"

echo "=== before ==="
git rev-parse --short --abbrev-ref HEAD 2>/dev/null || true
git log --oneline -1
sed -n 's/.*"version": "\([^"]*\)".*/manifest version: \1/p' "$EXT_DIR/manifest.json" | head -1

echo
echo "=== fetch + pull ==="
git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "already up to date at $(git rev-parse --short HEAD)"
else
  git pull --ff-only origin main
fi

echo
echo "=== update sentinel ==="
SHA="$(git rev-parse --short HEAD)"
printf '%s\n' "$SHA" > "$SENTINEL"
echo "$SENTINEL -> $SHA"

echo
echo "=== after ==="
git log --oneline -1
echo "Every profile with the extension loaded reloads itself within ~60 s"
echo "(chrome.alarms poll of $SENTINEL; see extension/dev-reload.js)."
