# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 725 checks: CAM (236) + CAD (180) + import (88) + clipart (47) + trace (45) + 3D (44) + PDF (30) + arc-fit (15) + air-cut (30) + smoke (10)
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html
```
Or run the current build in the browser with no install:
https://claude.ai/code/artifact/0166593e-5811-4dd2-a714-4a16f6342f5e

## Layout (matched to Vectric Aspire)
Rebuilt from screenshots of Dan's own Aspire install (`docs/vcarve-reference/`):
- **Menu bar:** File · Edit · Toolpaths · View · Help, with working drop-downs.
- **Left dock "Drawing"** — File Operations, 2D View Control, Create Vectors, Transform Objects,
  Edit Objects, Align Objects, Offset and Layout; a **Job Dimensions** readout at the bottom, and
  **Drawing / Clipart / Layers** tabs along the bottom edge.
- **Right dock "Toolpaths"** — Material Setup (Set…, Z0/thickness, XY datum), a Toolpath Operations
  icon grid, and a **Toolpath List** that stays visible underneath whatever form is open.
- **Form-in-panel, per dock:** a drawing tool's options replace the left dock body; a toolpath
  operation's options replace the right dock's upper area. The two never clobber each other.
- **Type or drag:** shape forms take exact Width / Height / Diameter / Sides + an X-Y position given by a **9-box anchor**
  (lower / center / upper × left / middle / right — VCarve-style) + **Create** (or Enter). The edit dialog (double-click)
  uses the same anchor, and switching it re-expresses X/Y without moving the shape.
- Canvas tabs **2D View / 3D View** sit top-left over the view, as in Aspire.
- **Icons:** a hand-drawn 24×24 inline-SVG set, 28px in the tool squares, **two-tone** — a primary
  colour per group (create = blue, transform = purple, edit = teal, destructive = red, layout = rust)
  plus a per-icon accent hue on `--a` for the secondary parts. Each glyph shows what the tool does — profile is an offset
  path around a shape, pocket is concentric clearing rings, v-carve is a V groove in section.
- **True 3D view:** the machined stock is rendered as a real solid in WebGL, with the **toolpath
  moves drawn over it** (amber cuts, optional grey rapids — both toggleable in the 3D footer).
  **Left-drag to pan, Option/Alt-drag (or middle / right button) to orbit, wheel to zoom, double-click to reframe;**
  Top / Iso / Front presets over the view. Toolpaths added, edited or toggled while the 3D view is open re-simulate at once. Panning
  moves the orbit target, so you are never locked to the centre of the job. Falls back to the flat
  top-down shading if the browser has no WebGL.
- **Canvas theme:** 2D View is a near-white ground with dark ink; 3D View uses the lavender gradient
  (`#babbf4 → #e0e0f8`) sampled straight out of the reference screenshots. All canvas colours come
  from one `THEMES` table in `studio_app.js`, so retuning is a single edit.

## What it does
- **Rotate…** (Edit menu, Transform Objects, right-click): exact angle, CW / CCW, live preview, and a 9-box **pivot** — any
  corner, edge middle or the center of the selection. The corner rotate grips use the same pivot; Shift snaps to the
  "Rot °" increment (default 5°). Moving a selection snaps its anchor point to the grid / object snaps (Ctrl = free).
- **Cut / Copy / Paste** (Edit menu, right-click, ⌘/Ctrl+X · C · V): pastes in place, repeated pastes step 0.5"; the copy is
  also written to the system clipboard so it survives a reload and pastes into another tab of the app.
- **Rulers** (View menu): X along the top, Y down the left, in inches, with a marker that follows the cursor.
- **Dark mode** (View menu or the ☾/☀ button in the status bar): whole UI plus both canvases; remembered between sessions.
- **Help search** (Help menu or Ctrl+K): type what you want and it lists matching menu items, tools, forms and buttons;
  Enter / click takes you there (opens the menu with the item highlighted, or the form) without running anything.
- **Save / Save As…** (Ctrl+S / Ctrl+Shift+S, Ctrl+O to open): in Chrome/Edge a real save dialog, and Save writes back to
  the opened file; elsewhere Save As asks for a name and downloads. Build version shown lower-right and under Help.
- **Layers tab:** add / rename (double-click) / colour / delete, and → moves the selection to a layer.
- **Default job: 48.5" × 97" × 1.5" thick** — the standard sheet, so it is right on open.
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
- **CAM:** Profile (outside/inside/on, **left/right of an open vector**, climb/conv, multipass, tabs),
  Pocket (concentric rings **linked into one inside-out spiral**, or raster), Drill, V-Carve, **Inlay**
  (matched female cavity + male plug, straight or V-carve fit, with a per-side gap and a mirrored plug)
  → G2/G3 arcs → ShopSabre post → backplot → Export .tap.
- **Toolpath templates:** save a machining recipe (settings only, no geometry) and apply it to any job's
  vectors; five starter recipes built in, import/export as `.aqtpl`.

## Re-posting a job from its DXF
`cam-engine/repost.js` runs the same engine as the studio with no browser, so a job whose only
surviving source is its `.dxf` can be regenerated after an engine fix.

**One op over every vector** — enough for a simple nest:
```
node cam-engine/repost.js CAD/XRT-50.dxf CAD/XRT-50-aq.tap --dia 0.25 --depth 1.5 --pass 1.5 \
  --feed 100 --plunge 30 --rpm 24000 --clear 0.8 --side outside --dir conventional \
  --lead line --leadlen 0.25
```

**A job spec** — several tools over hand-picked vectors, which is what a real job looks like:
```
node cam-engine/repost.js --job "CAD/jobs/LGC 50 Job 1 Board 3.aqjob.json"
```
With `--job`, the paths come from the spec or from `--dxf`/`--out`; a positional argument is refused.

A spec is readable JSON: each op names its tool, feeds, depths and tabs, and `select`s vectors by
`[layer, index]` (the vector's position within that layer in DXF order). A third element overrides
that one vector — Vectric lets each vector in a toolpath sit on its own side of the line, so
`["TOP_STEP_4", 0, {"side":"right","reverse":true}]` is normal, not an edge case.

Every `.tap` in `CAD/` has been re-posted this way to `*-aq.tap`; the Vectric originals are left
untouched beside them. Cut geometry matches the originals to 0.0001" on the straight-cut boards,
0.0015" on the foam jig and 0.010" on the two pocket roughs (whose finished wall matches to 0.0004").
Retract and plunge counts now match the Vectric originals exactly, board for board.

## Dry-running a job
`node cam-engine/aircut.js in.tap out.tap [--clearance 0.25] [--band 0.30]` rewrites a posted program
so it cannot touch the material: every cutting Z is remapped into a thin band *above* the surface,
while rapid and park heights stay exactly as posted, so the Z travel envelope is unchanged. The remap
is order-preserving — the deepest pass is still the lowest air pass — so the staging reads as it runs.
XY motion, feeds, tool changes and dwells are untouched. Every job in `CAD/` has a `*-AIRCUT.tap` beside it. A program posted with a low retract plane (the
foam jig retracts to 0.2") has no room for a 0.25" air pass underneath, so `--retract N` lifts any
retract move below N up to it; the park height and the travel envelope are unchanged.

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `pdfparse.js`, `bitmaptrace.js`, `clipart.js`, `repost.js`, `build.js`, `package/clipper.js`, tests, ShopSabre `.pp`, roadmap README.

## Roadmap
The 2D VCarve-parity build is complete — status table and full feature notes in `cam-engine/README.md`.
Next: 3D / Aspire-style relief work, on top of the existing `simulateStock` heightfield.
# DC-VCarve-Clone
