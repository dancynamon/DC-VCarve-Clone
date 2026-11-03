#!/usr/bin/env bash
# Vendor the PDF/.ai importer and clipper.js from aquamentor-vector-studio, which holds the canonical
# copies, and re-pin their sha256 in cam-engine/VENDORED. cam-engine/vendortest.js (part of npm test)
# fails when a vendored file no longer matches its pin, so a fix made here instead of upstream is
# caught instead of silently forking the two parsers again.
#
#   tools/sync-pdfparse.sh [path/to/aquamentor-vector-studio]
#       default source: $VECTOR_STUDIO, else ../aquamentor-vector-studio next to this repo
#   tools/sync-pdfparse.sh --check
#       verify the pins only (what vendortest.js does), change nothing
#
# If cadcam-studio.html no longer carries the vendored source, the bundle is rebuilt (npm run build).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pins="$root/cam-engine/VENDORED"

# canonical path in vector-studio -> vendored path here
FILES=(
  "engine/pdfparse.js:cam-engine/pdfparse.js"
  "engine/pdfparse.test.js:cam-engine/pdfparse.test.js"
  "engine/pdfparse.golden.json:cam-engine/pdfparse.golden.json"
  "engine/package/clipper.js:cam-engine/package/clipper.js"
)

sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

if [ "${1:-}" = "--check" ]; then
  exec node "$root/cam-engine/vendortest.js"
fi

src="${1:-${VECTOR_STUDIO:-$root/../aquamentor-vector-studio}}"
[ -f "$src/engine/pdfparse.js" ] || { echo "sync-pdfparse: no engine/pdfparse.js under $src (pass the vector-studio checkout path)" >&2; exit 1; }
src="$(cd "$src" && pwd)"

rev="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
dirty=""
for pair in "${FILES[@]}"; do
  if [ -n "$(git -C "$src" status --porcelain -- "${pair%%:*}" 2>/dev/null)" ]; then dirty=" (+uncommitted ${pair%%:*})$dirty"; fi
done
[ -z "$dirty" ] || echo "sync-pdfparse: WARNING vendoring uncommitted changes:$dirty" >&2

{
  echo "# Vendored from aquamentor-vector-studio, which holds the canonical copies. Do not edit these files"
  echo "# here: change them in vector-studio, then run tools/sync-pdfparse.sh. Checked by cam-engine/vendortest.js."
  echo "# source: aquamentor-vector-studio@$rev$dirty"
  echo "# sha256  vendored-path  canonical-path"
} > "$pins.tmp"

for pair in "${FILES[@]}"; do
  from="${pair%%:*}" to="${pair#*:}"
  cp "$src/$from" "$root/$to"
  echo "$(sha "$root/$to")  $to  $from" >> "$pins.tmp"
  echo "  $from -> $to"
done
mv "$pins.tmp" "$pins"

cd "$root"
node cam-engine/vendortest.js >/dev/null || node cam-engine/build.js >/dev/null
node cam-engine/vendortest.js && node cam-engine/pdfparse.test.js
echo "sync-pdfparse: vendored aquamentor-vector-studio@$rev$dirty — review git diff, then commit"
