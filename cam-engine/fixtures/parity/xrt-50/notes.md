# XRT-50 — 16-up nested profile, foam

**Status:** ready to build an `ours` side. Best first fixture — simplest real job here.

## Files
- `reference.tap` — posted from VCarve with the ShopSabre ATC post.
- `source.dxf` — AC1009 (R12) DXF, 16 `POLYLINE` entities on layer `XRT-50__49_0L_`,
  112 vertices. Closed polylines with **bulge factors** (group code 42) — so the
  rounded ends are true arcs, not chords. Exercises the bulge path in `dxfparse.js`.

## Parameters derived from the pair
Nothing here was read off a dialog; all of it falls out of the DXF + TAP:

| Parameter | Value | How it was derived |
|---|---|---|
| Tool diameter | **0.250"** | DXF extents `0.25,0.50 → 49.25,96.40` vs TAP envelope `0.125,0.375 → 49.375,96.525` — exactly 0.125" proud on all four sides, so radius 0.125 |
| Side | **outside** | Toolpath lies outside the part outline |
| Cut depth | **-1.5000** | Single Z level in the program |
| Pass depth | same (one pass) | 16 polylines → 16 passes, so one pass per part |
| Clearance Z | **0.8000** | The `G0 Z` retract height |
| Feed | **100.0** ipm | Modal `F` on contour moves |
| Plunge | **30.0** ipm | `F` on the `G1 Z` plunge |
| Spindle | **24000** rpm | `S` word |
| Tool number | **T1** | `T` word, ATC style (no `M6`) |
| Tabs | **none** | Zero mid-cut Z lifts |
| Lead in/out | **arc** | `G3` arcs before and after each contour, off the finished edge |

Sheet is 4x8 (parts span 0.25→49.25 x, 0.5→96.4 y). Cut clean through 1.5" foam.

## Status: **PARITY** — `job.js` reproduces this program

Two parameters could not be read off the pair and had to be recovered empirically:

- **Conventional, not climb.** Every arc in the reference is CCW; `climb:true`
  produces CW. Not stated anywhere in either file.
- **Linear leads sit 15.00° off tangent, with a 0.25" overcut.** Measured against
  the true tangent at the entry point, the reference lead-in and lead-out are each
  exactly 15° off it, and the cut carries 0.25" past the contour start before
  departing — so the entry mark is machined away by the end of the same pass.
  Our leads were tangential with no overcut, which no amount of parameter
  fiddling could match; `leadAngle` and `overcut` were added to `profileOp`.

## What this fixture found

Five real defects, all fixed. None were visible from inside the codebase — every
one needed a real Vectric program to compare against.

1. **Contour start point was thrown away.** `offsetLoop` is Clipper, whose output
   begins at an arbitrary vertex. Nothing rotated it back, so the plunge, lead-in
   and tab phase landed somewhere unrelated to the vector drawn — here, the
   opposite corner of the part. Fixed by `rotateLoopTo`, which also *inserts* the
   exact entry point rather than snapping to the nearest existing vertex.
2. **DXF arc flattening ignored radius.** A 90° arc always got 8 segments whether
   it spanned 0.1" or 30". At r=2.875 that left the polyline 0.014" inside the true
   arc. Now sagitta-based (`arcStepCount`), holding chord error under 0.001".
3. **Straight edges posted as huge arcs.** The bottom edge came out as
   `G3 ... J794.4170` — a radius-794" arc bowing 0.3" off course — because a
   near-straight run fits an enormous circle through every sample while wandering
   between them. Two guards now: `runIsStraight` (are the *points* collinear?) and
   `arcFollowsPolyline` (bound the sagitta between consecutive samples).
4. **Offset tolerance was coarser than the arc-fit tolerance.** Clipper ran at
   0.003" while arc fitting demanded 0.0015", so corner arcs could never be
   recovered and posted as strings of G1. Offset now runs at 0.0005".
5. **`safeZ` on an op is dead.** `postProcess` reads `op.clearZ` and falls back to
   0.25"; every op builder sets `safeZ`, which nothing reads, and
   `studio_app.js:720` hardcodes `clearZ:0.25`. This job retracts to Z0.8. The
   fixture sets `clearZ` directly — **the UI still cannot set retract height, and
   that is not fixed.** See the repo TODO.

Two of these — 3 and 4 — are wrong *output*, not just mismatches: the clone was
emitting G-code that cut off course, and would have done so on any job.
