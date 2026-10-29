#!/bin/bash
# Builds Duo.app: a real Mac app that starts Duo and shows it in its own window.
#   bash scripts/make-mac-app.sh            -> ~/Applications/Duo.app
#   bash scripts/make-mac-app.sh /Applications/Duo.app
set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "This builds a macOS app, so it only runs on a Mac."; exit 1; }
for tool in osacompile sips iconutil plutil; do
  command -v "$tool" >/dev/null || { echo "Missing $tool (it ships with macOS)."; exit 1; }
done

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$HOME/Applications/Duo.app}"
case "$DIR" in *\"*|*\\*) echo "The Duo folder path contains a quote or backslash. Move it somewhere simpler."; exit 1;; esac

command -v node >/dev/null || echo "Note: node was not found in this shell. Install it with: brew install node"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Compile the launcher with this folder's path baked in.
tpl="$(cat "$DIR/scripts/Duo.applescript")"
printf '%s\n' "${tpl//__DUO_DIR__/$DIR}" > "$WORK/Duo.applescript"
mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
osacompile -s -o "$APP" "$WORK/Duo.applescript"

# 2. Icon: resize the 1024px artwork into a full .icns set.
ICONSET="$WORK/Duo.iconset"
mkdir -p "$ICONSET"
SRC="$DIR/assets/duo-icon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"

# 3. Name it Duo and make sure the Dock shows it as a normal app.
PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Duo" "$PLIST"
plutil -replace CFBundleDisplayName -string "Duo" "$PLIST" 2>/dev/null || plutil -insert CFBundleDisplayName -string "Duo" "$PLIST"
plutil -replace CFBundleIdentifier -string "local.duo.app" "$PLIST"
touch "$APP"

echo
echo "Built $APP"
echo "Open it from Spotlight (Cmd+Space, type Duo), or drag it into your Dock."
echo "Quit it with Cmd+Q to stop Duo. Logs: ~/Library/Logs/Duo.log"
