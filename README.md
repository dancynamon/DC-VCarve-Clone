# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 63 unit tests: CAM (27) + arc-fit (9) + CAD (27)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```

## What it does
- **CAD editor:** job/material setup (Edit → Job Size and Position…), draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  **create by numbers** (Enter with a shape tool: exact size + 9-box anchor position — lower/center/upper × left/middle/right),
  select/move/scale/rotate (Rotate… dialog: angle, CW/CCW, pivot; corner grips with hover cursor, Shift = snap to "Rot °" increment),
  node edit, offset, weld/subtract/intersect, mirror, array, align, grid/object snapping (moved selection snaps by its anchor point; Ctrl = free),
  measure, tooltips, layers (add/rename/color/delete/move-to), undo/redo. Menu bar: File / Edit / View / Help. Version shown lower-right.
- **Import/Export:** DXF + SVG (editable) in; DXF/SVG out. File → Open / Save / Save As… (Chrome/Edge: real save dialog, Save writes back to the file; Ctrl+O / Ctrl+S / Ctrl+Shift+S).
- **3D cut preview:** WebGL heightfield with stock walls and depth-tinted toolpaths at real Z; left-drag = pan, **Option/Alt-drag = orbit**, wheel = zoom; Top / Iso / Front buttons.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs) → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap (next)
TTF-outline text · Pocket / V-carve toolpaths · snap-to-job-corners · tool & material library · DXF BLOCK/INSERT expansion.
See `cam-engine/README.md`.
# DC-VCarve-Clone
