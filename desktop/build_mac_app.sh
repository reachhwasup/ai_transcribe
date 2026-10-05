#!/bin/bash
# Build "Dubbing Studio.app" into dist/.
#
# The app is a small shell around this project folder: it starts the server from here, with this
# project's Python environment, and shows it in its own window. It therefore runs on this Mac,
# from this folder — move or rename the folder and the app must be built again. Videos, the
# database and settings stay where they are, in uploads/ and data/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PY="$ROOT/backend/venv/bin/python"
APP="$ROOT/dist/Dubbing Studio.app"
VERSION="$(date +%Y.%m.%d)"

[ -x "$PY" ] || { echo "backend/venv is missing — create it and install backend/requirements.txt first"; exit 1; }
"$PY" -c "import webview" 2>/dev/null || { echo "Installing the window library…"; "$PY" -m pip install --quiet -r desktop/requirements.txt; }

echo "Building the app's pages…"
(cd frontend && npm run build)

echo "Putting the app together…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
"$PY" desktop/make_icon.py "$ICONSET/icon_512x512@2x.png"
for size in 16 32 128 256 512; do
    sips -z $size $size "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    [ $size -lt 512 ] && sips -z $double $double "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
cp "$ICONSET/icon_512x512@2x.png" "$APP/Contents/Resources/icon.png"

cat > "$APP/Contents/MacOS/Dubbing Studio" <<LAUNCH
#!/bin/bash
# Made by desktop/build_mac_app.sh — the project folder is fixed here.
ROOT="$ROOT"
if [ ! -x "\$ROOT/backend/venv/bin/python" ]; then
    osascript -e 'display alert "Dubbing Studio" message "The project folder has moved or its Python environment is missing. Build the app again with desktop/build_mac_app.sh."'
    exit 1
fi
cd "\$ROOT"
export DUBBING_STUDIO_ICON="\$(dirname "\$0")/../Resources/icon.png"
exec "\$ROOT/backend/venv/bin/python" "\$ROOT/desktop/app.py"
LAUNCH
chmod +x "$APP/Contents/MacOS/Dubbing Studio"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Dubbing Studio</string>
    <key>CFBundleDisplayName</key><string>Dubbing Studio</string>
    <key>CFBundleIdentifier</key><string>local.dubbingstudio.app</string>
    <key>CFBundleExecutable</key><string>Dubbing Studio</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "Checking that it starts…"
"$PY" desktop/app.py --check
echo
echo "Built: $APP"
echo "Open it from there, or drag it into Applications."
