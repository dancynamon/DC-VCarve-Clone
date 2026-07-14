# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 408 checks: CAM (161) + arc-fit (9) + CAD (175) + smoke (8) + import (25) + pdf (30)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```

## What it does
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure,
  dimension annotations (linear/radial/angular), clipart shape library, tooltips, layers, undo/redo.
- **Import/Export:** DXF + SVG + vector PDF (editable) in; **bitmap trace** (PNG/JPG → cuttable vectors); DXF/SVG out.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs), Pocket, Drill, V-Carve, **Inlay** (female cavity + undersized male plug) → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap (next)
2D VCarve-parity build complete (dimensions · inlay · toolpath templates · bitmap trace · clipart library).
Next: 3D relief / Aspire-style modelling on the material-removal sim substrate.
See `cam-engine/README.md`.
# DC-VCarve-Clone
