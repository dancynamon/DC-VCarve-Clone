# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test     # 863 checks: CAM (274) + CAD (229) + import (95) + clipart (47) + trace (45) + 3D mesh (44) + playback (44) + PDF (30) + arc-fit (15) + air-cut (30) + smoke (10)
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
- **3D view on the 3D Product Viewer's engine:** three.js r160 + OrbitControls + RoomEnvironment, the same
  bundle as `~/code/3D-Product-Viewer` (`cam-engine/package/aq3d-three.min.js`). The stock is a heightfield
  texture shaded per pixel, so V-carve flanks keep full simulation detail. **The program plays:** Play / Pause,
  scrub, step to the previous / next contour or tool change, speed (Auto ≈ 30 s for the whole job, or 1×–1000×
  machine time). The block is carved live as the cutter (flat / ball / V model, sized from the tool) moves, forwards
  or backwards. A readout shows the running move, G-code line, tool, S, F and XYZ, and a G-code pane follows the
  running line. Also: per-tool path colours, rapids, ghost stock. **Left-drag pans, Option/Alt-drag (or middle /
  right button) orbits, the wheel zooms to the cursor, double-click reframes;** Top / Iso / Front presets. Falls back
  to the flat top-down shading without WebGL2.
- **Open a .tap / .nc / .gcode** (File → Open, or drag it in): it plays in the 3D view and backplots in 2D. Set
  each T number's cutter shape and size in the Tools box (remembered per T number); the stock grows to fit a
  program that cuts outside the job.
- **Canvas theme:** 2D View is a near-white ground with dark ink; 3D View uses the lavender gradient
  (`#babbf4 → #e0e0f8`) sampled straight out of the reference screenshots. All canvas colours come
  from one `THEMES` table in `studio_app.js`, so retuning is a single edit.

## What it does
- **Pan with ⌘-drag** (Mac Command key; Alt-drag or middle button also) in the 2D view, whatever tool is active. Starts in the Select tool.
- **Arithmetic in every number field:** type `35.5/2`, `12+3*0.25`, `(48.5-2)/3` — resolves in place on Enter / Tab / leaving the
  field (bad input turns the field red and is left alone). ↑/↓ step by the field's step.
- **Cursor precision:** positions are free to 0.0001" (readout always 4 decimals); object points (corners, centers,
  midpoints) still attract within 7px. **Hold S to snap to the grid** for rough placement (tick Grid-snap to always snap);
  hold Ctrl for no object snap either. Arrow keys nudge the selection 0.001" · Shift 0.1" · Alt/Option 0.0001".
- **Zoom-adaptive grid:** drawn on the job sheet only (not the pasteboard around it), a darker line every inch, and it
  subdivides as you zoom — 0.5 → 0.25 → 0.1 → … → 0.0001". Zoom goes to 40000 px/in.
- **Position panel (Properties):** a 9-box anchor picks which point of the selection's bounding box X / Y report — any corner, edge
  middle or center — and typing X / Y / W / H (arithmetic allowed) moves or resizes the selection about that point. Shares the anchor
  with the draw forms and the edit dialog.
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
- **Group / Ungroup** (⌘/Ctrl+G, ⌘/Ctrl+Shift+G, Edit menu, right-click): grouped vectors pick, move, scale, rotate
  and copy as one.
- **Inches or millimetres** per job (Job Setup, or the in/mm button in the status bar). The drawing is always stored in
  inches; length fields, readouts, rulers and the grid switch to mm, and any length field takes a unit suffix
  (`25mm`, `1.5in`). The metric posts (ShopSabre / Generic mm) write G21 programs.
- **Two-sided jobs** (Job Setup → Sides: Two, flip left↔right or top↕bottom): Top / Bottom switch, per-side vectors and
  toolpaths. The far side shows mirrored and dashed. Save Toolpaths writes `job-top.tap` + `job-bottom.tap`, and the 3D
  view shows where the two sides' cuts meet and go through.
- **Rotary (wrapped) jobs** (Job Setup → Type: Rotary, diameter × length): you draw on the unwrapped surface (Y runs round
  the circumference). Y posts as the A axis in degrees, with Z0 on the surface, and the 3D view shows the part as a
  cylinder.
- **Default job: 48.5" × 97" × 1.5" thick** — the standard sheet, so it is right on open.
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure, tooltips, layers, undo/redo.
- **Fillet / Dog-bone / T-bone** (Fillet tool): round a corner, or cut a relief notch sized to the tool so a square part
  seats in an inside corner. Click one corner, or apply it to every sharp convex (holes, slots) or concave (part)
  corner of the selection.
- **Fit Curves to Vectors** (Edit Objects): rebuild jagged traced or scanned vectors from straight lines and true arcs
  within a tolerance, keeping real corners. They then post as clean G2/G3 moves.
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
- **More toolpaths:** **Chamfer** (V-bit bevel along an edge, depth from the width and bit angle), **Quick Engrave**
  (V-bit along vectors; sharp corners get a tail that rises out of the corner so they stay crisp), **Fluting**
  (grooves that ramp in and out, linear or smooth, with a ball / V / flat tool), **Prism** (raised bevelled shapes: a
  ridge at the surface, flanks at the bit angle) and **Moulding** (a cross-section profile swept along rails with a
  ball nose, compensated so the ball does not gouge).
- **Merge toolpaths:** Shift/Cmd-click toolpaths in the list, then Merge. They become one toolpath per tool, cut
  together with a single tool block, and each part keeps its own feeds. Unmerge splits them again.
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
VCarve Pro parity, without the Aspire 3D tier, is complete. The status table and full feature notes are in
`cam-engine/README.md`. Next, when wanted: the 3D / Aspire tier (STL import, 3D roughing / finishing, reliefs, textures).
# DC-VCarve-Clone
