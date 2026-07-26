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

## Why this one first
One tool, one op, one depth, no tabs, 16 repeats of identical geometry. If our
profile offset, arc fitting, lead-in geometry and pass ordering are right, this
goes green; if any of them is wrong, the diff points straight at which.

## Open question for the parity run
Climb vs conventional is not stated anywhere — it has to be inferred from travel
direction against the offset side. Build the `ours` side both ways and keep
whichever matches the reference arc-direction sequence; record the answer here.
