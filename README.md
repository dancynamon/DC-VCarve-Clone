# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 369 checks: CAM (163) + arc-fit (9) + CAD (169) + smoke (10) + import (25) + PDF (30)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```

## What it does
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure, tooltips, layers, undo/redo.
- **Dimension annotations (D):** aligned / horizontal / vertical / radius / diameter / angle dimensions with
  extension lines, solid arrowheads and an auto-formatted label (in / mm / plain, decimals, manual override).
  Snap to nodes, midpoints, centres and job corners; edit numerically like any shape. Annotations are never machined.
- **Import/Export:** DXF + SVG (editable) in; DXF/SVG out.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs), Pocket, Drill, V-Carve, **Inlay**
  (matched female cavity + male plug, straight or V-carve fit, with a per-side gap and a mirrored plug)
  → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap (next)
C6 toolpath templates · D1 bitmap import + trace · D2 clipart / shape library.
Status table and full feature notes in `cam-engine/README.md`.
# DC-VCarve-Clone
