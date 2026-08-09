# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 530 checks: CAM (195) + CAD (169) + clipart (47) + trace (45) + PDF (30) + import (25) + smoke (10) + arc-fit (9)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```

## What it does
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure, tooltips, layers, undo/redo.
- **Dimension annotations (D):** aligned / horizontal / vertical / radius / diameter / angle dimensions with
  extension lines, solid arrowheads and an auto-formatted label (in / mm / plain, decimals, manual override).
  Snap to nodes, midpoints, centres and job corners; edit numerically like any shape. Annotations are never machined.
- **Import/Export:** DXF + SVG + vector PDF (editable) in; DXF/SVG out.
- **Bitmap trace:** drop in a PNG/JPG/GIF/BMP/WEBP, tune threshold / despeckle / smoothing with a live
  preview over the image, and trace it to cuttable contours (holes come out as holes) on a `trace` layer.
- **Clipart library:** 18 built-in shapes (basic / plaques / pool & safety) placed by dragging a box;
  save your own selections into it and share them as `.aqclip`.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs), Pocket, Drill, V-Carve, **Inlay**
  (matched female cavity + male plug, straight or V-carve fit, with a per-side gap and a mirrored plug)
  → G2/G3 arcs → ShopSabre post → backplot → Export .tap.
- **Toolpath templates:** save a machining recipe (settings only, no geometry) and apply it to any job's
  vectors; five starter recipes built in, import/export as `.aqtpl`.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `pdfparse.js`, `bitmaptrace.js`, `clipart.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap
The 2D VCarve-parity build is complete — status table and full feature notes in `cam-engine/README.md`.
Next: 3D / Aspire-style relief work, on top of the existing `simulateStock` heightfield.
# DC-VCarve-Clone
