# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test      # 372 checks: CAM 140 · arc-fit 9 · CAD 132 · smoke 8 · import 25 · PDF 30 · parity 28
npm run parity # G-code parity vs real VCarve output (see below)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```

## What it does
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure, tooltips, layers, undo/redo.
- **Import/Export:** DXF + SVG (editable) in; DXF/SVG out.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs) → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Parity harness — "is it really a clone?"
Every other suite grades this codebase against its own intentions. The parity
harness grades it against **Vectric**: post a real job out of VCarve, build the
same job here, and compare what the spindle actually does — pass count, XY
envelope, cut depths, cut order, G2/G3 directions, cut length, feeds, tool
changes, tab lifts — while ignoring dialect (modal vs explicit words, comments,
line numbers, inch vs mm, CRLF).

It self-verifies with no fixtures present: four format variants of our own output
must read as PARITY (proving the differ isn't dialect-sensitive), and five
semantic mutations — flipped arc, wrong depth, dropped pass, shifted X, wrong
feed — must each be CAUGHT by the matching check (proving it isn't blind).

To grade a real job, drop it in `cam-engine/fixtures/parity/<job>/` —
see that folder's `README.md`.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.
- `cam-engine/gcodeparse.js` + `parity.js` + `paritytest.js` + `fixtures/parity/` — the parity harness (Node-only test tooling; not embedded in the built HTML).

## Roadmap (next)
TTF-outline text · Pocket / V-carve toolpaths · snap-to-job-corners · tool & material library · DXF BLOCK/INSERT expansion.
See `cam-engine/README.md`.
# DC-VCarve-Clone
