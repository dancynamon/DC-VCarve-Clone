#!/bin/bash
# Installs "Aquamentor CADCAM.app" and makes it the Mac's default for .tap, .dxf, .crv3d and .crv.
# It only needs running once: after that the app updates itself from each build published from main. Run it again
# only if this script or the launcher changes (or to try a local build, which stays until the next published one).
#   tools/mac/install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SUP="$HOME/Library/Application Support/Aquamentor CADCAM"; APP="$HOME/Applications/Aquamentor CADCAM.app"; ID=com.aquamentor.cadcam
command -v duti >/dev/null || { echo "duti is needed: brew install duti"; exit 1; }
mkdir -p "$SUP" "$HOME/Applications"
cp "$REPO/cadcam-studio.html" "$SUP/cadcam-studio.html"
cp "$HERE/cadcam_launcher.py" "$SUP/cadcam_launcher.py"

osacompile -o "$APP" <<'EOF'
property launcher : "Library/Application Support/Aquamentor CADCAM/cadcam_launcher.py"
on launcherPath()
	return quoted form of (POSIX path of (path to home folder) & launcher)
end launcherPath
on open theFiles
	repeat with f in theFiles
		set p to POSIX path of f
		try
			do shell script "/usr/bin/python3 " & launcherPath() & " open " & quoted form of p
		on error msg
			display alert "Aquamentor CAD/CAM could not open " & p message msg as critical
		end try
	end repeat
end open
on run
	try
		do shell script "/usr/bin/python3 " & launcherPath() & " app"
	on error msg
		display alert "Aquamentor CAD/CAM could not start" message msg as critical
	end try
end run
EOF

/usr/bin/python3 - "$APP/Contents/Info.plist" "$ID" <<'EOF'
import plistlib, sys
path, bundle = sys.argv[1:3]
kinds = [("tap", "CNC toolpath (.tap)", "com.aquamentor.tap"), ("dxf", "DXF drawing", "com.aquamentor.dxf"),
         ("crv3d", "Aspire job (.crv3d)", "com.aquamentor.crv3d"), ("crv", "VCarve job (.crv)", "com.aquamentor.crv")]
with open(path, "rb") as f: p = plistlib.load(f)
p["CFBundleIdentifier"] = bundle; p["CFBundleName"] = "Aquamentor CADCAM"
p["CFBundleDocumentTypes"] = [{"CFBundleTypeName": n, "CFBundleTypeExtensions": [e], "CFBundleTypeRole": "Editor", "LSHandlerRank": "Owner", "LSItemContentTypes": [u]} for e, n, u in kinds]
p["UTImportedTypeDeclarations"] = [{"UTTypeIdentifier": u, "UTTypeDescription": n, "UTTypeConformsTo": ["public.data"], "UTTypeTagSpecification": {"public.filename-extension": [e]}} for e, n, u in kinds]
with open(path, "wb") as f: plistlib.dump(p, f)
EOF
codesign --force --deep -s - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
for ext in tap dxf crv3d crv; do
  duti -s "$ID" "com.aquamentor.$ext" all   # by the type declared above: duti cannot set a default by extension on this macOS
  printf '%s -> %s\n' ".$ext" "$(duti -x "$ext" | head -1)"
done

# Keep the app's server (and its update check) running, so the installed app can start from the Dock at any time.
AGENT="$HOME/Library/LaunchAgents/com.aquamentor.cadcam-server.plist"
launchctl bootout "gui/$(id -u)/com.aquamentor.cadcam-server" 2>/dev/null || true
pkill -f "cadcam_launcher.py serve" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$AGENT" <<EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aquamentor.cadcam-server</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$SUP/cadcam_launcher.py</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Aquamentor CADCAM.log</string>
</dict></plist>
EOF2
sleep 1
launchctl bootstrap "gui/$(id -u)" "$AGENT"
echo "Server running; the app now updates itself from main."
