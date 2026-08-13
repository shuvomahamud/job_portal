#!/usr/bin/env bash
# Builds JobAgent.app, a menu bar app that starts and stops the worker.
#
#   ./mac-app/build.sh            # build into mac-app/build/
#   ./mac-app/build.sh --install  # build, then copy into /Applications
#
# The repo path and node path are baked into the binary because GUI apps launched from
# Finder do not inherit the shell PATH and therefore cannot find an nvm-managed node.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$REPO_DIR/mac-app/build"
APP_DIR="$BUILD_DIR/JobAgent.app"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH. Install Node 20.9+ and retry." >&2
  exit 1
fi
# Resolve nvm shims to the real binary so the path stays valid outside the shell.
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"

echo "repo: $REPO_DIR"
echo "node: $NODE_BIN"

# Wipe the whole build directory, not just this bundle. Launch Services indexes any .app
# it finds on disk, so a bundle left behind by an earlier name would keep showing up as a
# duplicate in Spotlight and Launchpad.
rm -rf "$BUILD_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

SRC="$BUILD_DIR/JobAgent.generated.swift"
sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$REPO_DIR/mac-app/JobAgent.swift" > "$SRC"

swiftc -O \
  -framework AppKit \
  -o "$APP_DIR/Contents/MacOS/JobAgent" \
  "$SRC"

# --- app icon -----------------------------------------------------------------
# Rendered from source each build rather than committing a binary .icns.
ICON_TOOL="$BUILD_DIR/makeicon"
ICONSET="$BUILD_DIR/JobAgent.iconset"
swiftc -O -framework AppKit -o "$ICON_TOOL" "$REPO_DIR/mac-app/make-icon.swift"
"$ICON_TOOL" "$BUILD_DIR/icon-1024.png"

mkdir -p "$ICONSET"
# The names below are what iconutil expects; anything else is silently ignored.
for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" \
            "512:icon_256x256@2x" "512:icon_512x512" "1024:icon_512x512@2x"; do
  px="${spec%%:*}"
  name="${spec##*:}"
  sips -z "$px" "$px" "$BUILD_DIR/icon-1024.png" --out "$ICONSET/$name.png" >/dev/null 2>&1
done
iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/JobAgent.icns"
rm -rf "$ICONSET" "$ICON_TOOL" "$BUILD_DIR/icon-1024.png"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>JobAgent</string>
  <key>CFBundleDisplayName</key><string>JobAgent</string>
  <key>CFBundleIdentifier</key><string>com.jobagent.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>JobAgent</string>
  <key>CFBundleIconFile</key><string>JobAgent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Ad-hoc signature. Without it macOS kills the unsigned binary on launch.
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || {
  echo "warning: codesign failed; right-click > Open on first launch if macOS blocks it." >&2
}

rm -f "$SRC"
echo "built: $APP_DIR"

if [[ "${1:-}" == "--install" ]]; then
  rm -rf "/Applications/JobAgent.app"
  cp -R "$APP_DIR" /Applications/

  # Drop the staging copy. Launch Services indexes any .app on disk, so leaving it here
  # makes a second "JobAgent" show up in Spotlight and Launchpad alongside the real one.
  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$APP_DIR" >/dev/null 2>&1 || true
  rm -rf "$BUILD_DIR"

  echo "installed: /Applications/JobAgent.app"
fi
