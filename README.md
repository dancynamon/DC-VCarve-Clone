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
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure,
  dimension annotations (linear/radial/angular), tooltips, layers, undo/redo.
- **Import/Export:** DXF + SVG (editable) in; DXF/SVG out.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs), Pocket, Drill, V-Carve, **Inlay** (female cavity + undersized male plug) → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap (next)
TTF-outline text · Pocket / V-carve toolpaths · snap-to-job-corners · tool & material library · DXF BLOCK/INSERT expansion.
See `cam-engine/README.md`.
# DC-VCarve-Clone
