# 20-piece male print jig — foam

**Status:** ready to build an `ours` side. Do this one *after* `xrt-50`.

## Files
- `reference.tap` — posted from VCarve with the ShopSabre ATC post.
- `source.dxf` — 1.4 MB, 21 `POLYLINE` entities, **15,524 vertices**. Heavy
  organic geometry (the jig pockets), not parametric shapes.

## Parameters derived from the pair

| Parameter | Value | How it was derived |
|---|---|---|
| Tool diameter | **0.250"** | DXF extents `0.25,0.25 → 37.264,30.061` vs TAP envelope `0.125,0.125 → 37.389,30.186` — 0.125" proud all round |
| Side | **outside** | Toolpath lies outside the part outline |
| Cut depth | **-0.7500** | Single Z level |
| Pass depth | same (one pass) | 21 polylines → 21 passes |
| Feed | **80.0** ipm | Modal `F` on contour moves |
| Plunge | **30.0** ipm | `F` on the `G1 Z` plunge |
| Tabs | **none** | Zero mid-cut Z lifts |
| Tool changes | **1** | Single tool |

## Why this one second
Same op shape as `xrt-50` (single-tool outside profile) but with ~140x the vertex
count and freeform curves instead of arcs. It isolates a different failure mode:
not "is the offset logic right" but "does arc-fitting and contour assembly hold up
on dense real geometry". Running it before `xrt-50` is green would confuse the two.

Expect the arc-fit tolerance (`arcTol`, default 0.0015") to matter here — if our
`cut length` check drifts slightly, that is the first knob to look at, not a bug.
