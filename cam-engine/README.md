# Aquamentor CAD/CAM — engine & architecture

## ★ NEW: full CAD editor — `../cadcam-studio-260614.html`
Editor-first, VCarve-style. Draw + edit vectors, then cut. Single self-contained file.
- **Draw:** select, node-edit, line, polyline, **bezier curve (pen tool)**, rectangle, circle, ellipse, arc, polygon, star, single-stroke text, measure.
- **Curve (bezier) tool:** click anchors, drag to pull symmetric handles; Enter finishes, click the start node to close. Stored as `prim:{kind:'bezier',nodes}`, flattened to `pts` so CAM/preview/export just work. Node-edit shows draggable anchors + handles (green = smooth, tan = corner; dbl-click toggles). Core: `mkBezier`/`flattenBezier`/`reflowBezier`/`mirrorSmoothHandle`.
- **Edit:** move / **scale (8 handles — a single unrotated rect/round/circle/ellipse stays parametric: dims update in the prim, and non-uniform-scaling a circle becomes an ellipse)** / **rotate about center from any of 4 corner grips (Shift = 15° snap; a single rect/round/circle/ellipse/polygon/star stays parametric — the grip accumulates its prim rotation so it remains editable in the dialog)**, offset, **weld (union) / subtract / intersect** (Clipper booleans), join, mirror H/V, rotate 90°, duplicate, array (rows×cols), align (6-way), node add/delete/drag.
- **Snapping:** grid snap + object snap (endpoints, midpoints, centers) + **job/material corners, edge midpoints & center** (corner = diamond marker); ortho with Shift.
- **Selection:** click an edge **or click inside** a closed contour to pick it (VCarve-style); marquee box-select; shift to add.
- **Right-click menu:** right-click a shape for Edit dimensions…, Duplicate, Delete, Mirror H/V, Rotate 90°, Offset…, Array…, Bring to front / Send to back (and Weld/Subtract/Intersect when 2+ are selected).
- **Numeric edit (VCarve-style dialog):** double-click a shape (or right-click → Edit dimensions…, or Properties → **Edit…**) for a modal with exact fields per type — rect/round (X/Y/W/H + corner radius + rotation°; a radius >0 promotes a rect to rounded), circle (center/radius + rotation°), ellipse/polygon/star (center, radii, sides/points, rotation°), line (endpoints + rotation°), arc (center/radius/angles), text (string/pos/height). Rotation° on rect/round/circle/ellipse/polygon/star is stored and round-trips (re-opens showing the angle); on line and generic vectors it's applied as a delta about the center. Non-parametric vectors get a generic X/Y/W/H (move+scale). **Live preview** — the shape updates on the canvas as you type; the dialog is draggable (so it never hides the shape) and the backdrop is lightly dimmed. Apply commits as a single undo step; Cancel/Esc reverts.
- **Job/material:** set W×H×thickness + origin; drawn as a clear bordered/shadowed stock panel with corner brackets, a size caption (`W" × H" · T" thick`), and edge dimension labels; updates live as you type.
- **Layers, undo/redo (Ctrl+Z/Y), pan/zoom, fit (F)**, hotkeys (V/N/L/P/R/C/E/A/G/T/M).
- **2D Design / Preview tabs** — a VCarve-style tab strip over the canvas. "2D Design" is the vector editor; "Preview" shows the machining result, read-only (grid + editing handles hidden). The active tab persists in the `.aqcam` project (`meta.view`).
- **3D material-removal simulation** — in Preview, a "3D cut" toggle renders a z-buffer heightfield sim: flat stock (job W×H×thickness) is carved by sweeping each toolpath's tool profile (flat / ball / V-bit by op) along its moves, lowering cells to `min(current, tool-surface)`; deeper passes win, overcuts clamp to the stock floor. Shaded top-down as a wood-tone depth map with directional hillshade for a carved 3D look. Resolution selectable (0.08–0.02"). Pure core: `camcore.simulateStock({x0,y0,w,h,thickness,res,cuts})` → heightfield + `stockHeightAt`. This is the substrate for the future Aspire 3D relief work.
- **Project save/load** — "Save job…" writes a versioned `.aqcam` JSON project (shapes + prims/text, layers, job/material, and the queued toolpath ops); "Open / Import" and drag-drop reopen it. Autosaves to localStorage (debounced on change + every 30s) and offers "Restore last session?" on load. Own format, not Vectric `.crv`. Core: `projectToJSON`/`projectFromJSON` (versioned, validates + rejects unknown versions).
- **Import** DXF + SVG + **vector PDF** as **editable** geometry; **export** DXF / SVG. PDF import extracts path geometry from content streams (paths, Bézier curves, rectangles, q/Q/cm transforms) scaled to real inches — for cutting shapes out of logos/artwork. Resolves **Form XObjects** (the `Do` operator with per-form `/Matrix`, recursive + cycle-guarded) since Illustrator/Corel wrap art in them. Ships a pure DEFLATE/zlib inflater so FlateDecode streams decode offline with no dependency; works with both classic-xref and xref-stream PDFs. **Live text is detected and warned** (the importer flags `hasLiveText` so the UI tells you to outline the fonts and re-export) rather than silently dropped. Not supported (yet): raster/scanned PDFs, cutting live text directly, clip regions.
- **CAM built in (Op selector):**
  - **Profile** — outside/inside/on, climb/conv, multipass, holding tabs.
  - **Pocket** — concentric offset-stepover clearing (stepover %), respects islands/holes, multipass.
  - **Lead-in/out** (Profile + Pocket) — tangential **arc** or **line** entry/exit of a chosen length, on the non-gouging side (outside for outside-profile, inside for inside/pocket), kept at cut depth so the plunge lands off the finished edge; auto-skipped (with a warning) on contours too small to fit it. Optional **Z ramp-in** (Ramp" length) descends clearZ→cutZ over the first part of the lead-in instead of plunging straight (0 = straight plunge). A ramped **arc** lead emits a **helical G2/G3 + Z** move on posts that support it (`helical:true`, default for ShopSabre/Generic) — split into a descending sub-arc (clearZ→cutZ over exactly Ramp") + a flat sub-arc to the contour start when Ramp" is shorter than the lead-in arc, or one descending helix when Ramp" ≥ the arc length; line leads and helical-off posts fall back to G1 ramp segments.
  - **Drill** — one hole at each closed contour's centroid, optional peck depth; green hole markers on the backplot.
  - **V-Carve** — true medial-axis (grassfire/distance-transform skeleton) groove, depth = inscribed-radius ÷ tan(½·bit-angle), capped by Cut depth (0 = full sharp V); pairs with TTF outline text. **Flat-depth area clearance:** set a Flat" depth + a clearance endmill Ø and the op emits TWO toolpaths — a flat endmill pocket that roughs the deep interior (where the groove would exceed the flat depth) down to flat depth FIRST, then the V-bit finishing the tapered walls capped at flat depth (bevelled prism with a flat machined floor). Each op carries a `toolProfile` so the 3D sim renders the right tool.
  - All → **G2/G3 arcs** → ShopSabre/Generic post → live **depth-shaded backplot** (cut moves tinted shallow→deep by Z, with a depth legend; rapids dashed grey) → **Export .tap**.
  - **Machining time estimate:** each toolpath row shows its estimated cut time (feed for cutting moves, plunge for Z-down, rapid for G0 — `camcore.estimateTime`), with the job total in the Preview status. Useful for quoting.
  - **Check vectors:** the Edit panel's "Check vectors" flags and selects open contours, duplicate vectors, and self-intersecting closed shapes (`cadcore.validateShapes`) before you cut.
  - **Editable TOOLPATHS list (VCarve-style):** "+ Toolpath" captures the current op + selection as a named toolpath. Each row has a show/hide checkbox (toggles it in the backplot), click-to-rename, an ✎ Edit action that loads its params + selection back into the CAM panel (button flips to "✓ Update" to write changes back in place), ↑/↓ reorder, and delete. "Recalc all" recomputes the combined depth-shaded backplot for every visible toolpath. "Post job" concatenates all toolpaths into one program (HEADER tool block for the first, TOOLCHANGE blocks for the rest) → one `job.tap`, applying nearest-neighbor pass ordering (`orderPasses`) to cut rapid travel; auto-assigns tool numbers from the saved Tool library by diameter and refuses to post if one tool number is used with two diameters. Toolpaths (name + visible + params + selection) persist in the `.aqcam` project.
- **Tool library:** saved presets (dia/feed/plunge/RPM/op/angle) in a dropdown; Save/Del; persisted to localStorage.
- **Self-test** (top bar): builds a sample design (rect + circle + single-stroke "AQ") and runs every CAM op (Profile w/ arc lead+ramp, Pocket, Drill, V-Carve) through `camBuild`, reporting "N/4 ops OK" in the status bar — a one-click smoke test of the pure core.
- `pdftest.js` guards the vector-PDF importer (30 checks = pure inflate vs zlib, path/curve/rect ops, cm/q/Q transforms, FlateDecode end-to-end, Form XObject `Do`/`/Matrix`/nesting/cycle-guard, live-text `hasLiveText` flag (Tj/TJ), PDF→CAM). 
- Engine: `cadcore.js` (pure, 100 unit tests) + `camcore.js` (CAM, 107 tests = profile/pocket/drill/v-carve/leads/ramp/helical/tooldb/arc/raster/ordering/medial-axis). The camcore suite also covers the material-removal sim (flat-cut depth, V cross-section, deeper-pass-wins, floor clamp, rapid no-op). `smoketest.js` runs the studio Self-test's 4-op sequence headless on both posts (8 checks). `importtest.js` guards DXF (6 checks), BLOCK/INSERT explosion (6 checks + 1 non-uniform-scale), SVG (6 checks), ELLIPSE-in-block (2 checks), and DXF+SVG round-trip export (4 checks) = 25 import checks. `npm test` runs all six suites.
- **Text:** single-stroke engraving font (built in) **or real TTF/OTF outline text** — toggle "Outline (TTF)" in Shape params, **Load font…** (or drag-drop a `.ttf/.otf`), and placement traces the actual glyph contours (with counters/holes) as closed, cuttable vectors → Profile/Pocket/V-carve. Outline height = the "H" field. Parser: opentype.js (MIT), embedded in `package/opentype.js`.

The older `gcode-cadcam-260614.html` remains as the import-a-file → CAM/backplot viewer.

---


Goal: grow the G-code/DXF **viewer** into a robust 2D CNC CAD/CAM that replaces
VCarve for our job-shop work, runs anywhere (single self-contained HTML, no
install, works offline), and posts G-code that matches our ShopSabre/WinCNC.

## Files
- `../gcode-cadcam-260614.html` — the app. Single file, double-click to open in any browser.
- `camcore.js` — pure CAM engine (no DOM). Runs in Node (tests) **and** embedded in the HTML.
- `package/clipper.js` — Angus Johnson Clipper 6.4.2 (Boost license). Polygon offsetting. Embedded in the HTML too.
- `package/opentype.js` — opentype.js 1.3.4 (MIT). TTF/OTF glyph-outline parsing for outline text. Embedded in the HTML too.
- `test.js` — Node test harness (23 assertions). Run: `node test.js` from this folder.

## Architecture (single-file, modular inside)
The HTML embeds three scripts: **Clipper** → **camcore** → **app**.
- **Viewer engine** (reused, unchanged): DXF parser, geometry flattening (lines/arcs/circles/ellipses/splines/bulges), world↔screen transform, pan/zoom/fit, tool library, layers, and the **G-code backplot simulator**.
- **camcore (new):** `assembleContours` (chain loose segments into closed loops) → `offsetLoop` (Clipper) → `profileOp` (toolpaths) → `postProcess` (G-code). Pure functions, fully unit-tested.
- **Integration trick:** CAM emits **G-code text**, which is fed through the existing `loadGcodeText()` → the toolpath display + simulator come for free. CAM output is just another G-code "file."

## What works now (v260614)
- Load DXF → it shows as art with layers.
- **CAM · Profile** panel: tool #, diameter, side (outside/inside/on-line), direction (climb/conventional), cut depth, pass depth (multi-pass), feed, plunge, RPM, top-Z, **holding tabs** (count/length/height), post selector.
- Selection model = **visible layers** (toggle layers in the left panel to choose what to cut).
- **Generate G-code** → backplots over the art (combined mode). **Export .tap** → downloads.
- Posts: **ShopSabre/WinCNC** — now matched **byte-for-byte** to the real Vectric post `ShopSabre_DC_ATC_speed_arc_inch.pp` (header `G90→M5/M51→T#→Z2→S→M3→g4 x 4→M50→F`, ATC `T#` no M6, mid-file TOOLCHANGE omits Z2, footer `G0 Z2`/park `X0 Y115`/`M5`/`m51`, no M30/G20, CRLF) and **Generic ISO**.
- **Arc output (G2/G3):** toolpaths are arc-fitted before posting — circles/fillets/round corners emit true `I/J` arcs (CW=G2, CCW=G3), straight edges stay `G1`. Arcs split at ≤270° for controller-unambiguous moves. Toggle in the panel ("Arcs G2/G3"); off = polyline `G1` only.

## Verified
- 23/23 camcore unit tests (offset bounds, climb/conventional orientation, multipass, tabs, oversize-tool warning, post round-trip re-parses to exact bounds).
- Real DXF (GO_12x12 sign) through the full pipeline.
- Browser-DOM (jsdom) end-to-end: DXF→CAM→backplot, inside-profile exact bounds, **his real .tap still loads as viewer** (regression OK), zero console errors.

## Known limitations / next steps (importance order)
1. ~~ShopSabre post~~ ✅ matched to the real `.pp`. ~~Arc output~~ ✅ G2/G3 done.
2. ~~DXF import: BLOCK/INSERT not exploded~~ ✅ BLOCKS parsed; INSERTs exploded with position/scale/rotation, recursive + cycle-guarded (`importtest.js` guards it via `sample-block.dxf`). SVG import already supported. Remaining: ARC/ELLIPSE/SPLINE coverage in blocks is approximate under non-uniform INSERT scale.
3. ~~filled TTF-outline text~~ ✅. ~~Pocket~~ ✅ ~~Drill~~ ✅ ~~V-carve/engrave~~ ✅ ~~click-select of contours~~ ✅ ~~tool database~~ ✅. **CAM ops still to add:** raster/horizontal pocket clearing (vs offset), ramped/arc lead-in-out, true medial-axis V-carve (vs offset approximation), pocket sub-region grouping to cut rapids.
4. **CAD tools:** draw/edit primitives (line/arc/rect/circle/text), offset, trim, node edit, so geometry can be made from scratch, not only imported.
5. **Units** in/mm toggle + measure tool; tool-change ordering for multi-op jobs.

## How to extend safely
Edit `camcore.js`, run `node test.js` (keep it green), then re-embed into the HTML
(the HTML's embedded copy must be regenerated — the build concatenates Clipper +
opentype + camcore + cadcore + dxfparse + the app). Ask Claude to "rebuild the
CAD/CAM HTML from cam-engine."
