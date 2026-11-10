#!/bin/bash
# Installs "Aquamentor CADCAM.app" and makes it the Mac's default for .tap, .dxf, .crv3d and .crv.
# Run it again after building a new version: it copies the current cadcam-studio.html into place.
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
