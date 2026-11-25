#!/usr/bin/env bash
# check-extension-sync.sh — report, per Chrome profile, whether the loaded
# extension has already picked up the current dev-version sentinel.
#
#   bash ~/Downloads/projects/arena-transcript-export/scripts/check-extension-sync.sh
#
# The extension records the sentinel value it last applied in
# chrome.storage.local under `arexDevVersion`; that lands in the profile's
# LevelDB, so a plain grep is enough to tell "applied" from "still pending".
# A false "pending" is possible if LevelDB has compressed the value — in that
# case open chrome://extensions in that profile and look at the reload state.
set -uo pipefail

REPO="${AREX_REPO:-$HOME/Downloads/projects/arena-transcript-export}"
CHROME_DIR="${CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
EXT_ID="nikmpkecgfbpejnifokdgdklcjmdkbdk"
# Profiles where the extension is actually loaded (the user's decision: these five).
PROFILES=("Default" "Profile 1" "Profile 10" "Profile 12" "Profile 16")

want="$(cat "$REPO/extension/dev-version.txt" 2>/dev/null || echo '')"
if [ -z "$want" ]; then
  echo "no sentinel at $REPO/extension/dev-version.txt — run sync-extension.sh first"
  exit 1
fi

echo "sentinel: $want"
echo
printf '%-12s %-9s %s\n' PROFILE STATE DETAIL
for profile in "${PROFILES[@]}"; do
  data="$CHROME_DIR/$profile/Local Extension Settings/$EXT_ID"
  prefs="$CHROME_DIR/$profile/Secure Preferences"
  if [ ! -f "$prefs" ] || ! grep -q "$EXT_ID" "$prefs" 2>/dev/null; then
    printf '%-12s %-9s %s\n' "$profile" "absent" "extension not installed in this profile"
    continue
  fi
  if [ ! -d "$data" ]; then
    printf '%-12s %-9s %s\n' "$profile" "pending" "no storage dir yet (old code still loaded?)"
    continue
  fi
  if grep -aq -- "$want" "$data"/* 2>/dev/null; then
    printf '%-12s %-9s %s\n' "$profile" "applied" "storage records $want"
  else
    printf '%-12s %-9s %s\n' "$profile" "pending" "storage dir: $(basename "$data")"
  fi
done
