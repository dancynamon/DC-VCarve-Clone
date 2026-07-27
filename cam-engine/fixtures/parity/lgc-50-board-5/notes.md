# LGC 50 — Job 1, Board 5

**Status: DIFF** — 8 of 9 checks pass. The single failure is the *sequence* of four
independent cross-cuts, which is not recoverable from a DXF export. See below.
No tolerance was loosened.

## Files
- `reference.tap` — VCarve-posted, ShopSabre ATC post. Two tools, one program.
- `source.dxf` — 27 shapes (23 closed, 4 open), 3,911 points.
- `source.crv3d` — original Aspire project; unreadable, kept as source of record.
- `job.js` — rebuilds the job headlessly.

## What the job is

| | Tool | What | Detail |
|---|---|---|---|
| Op 1 | **T8** | Drill 4 holes | Ø0.375 circles on the board centreline, plain plunge to -1.5, **no peck** |
| Op 2 | **T3** | 4 cross-cuts | Across the 3.5" width, **4 depth steps** of 0.375", **1 tab** each |

Feeds: drill plunge 20 (header feed 62.5); cross-cuts 60 cut / 20 plunge. S18000.
Clearance Z0.8. Only 4 of the 23 closed contours are machined — the drill circles. The
rest of the geometry sits in the DXF but is not cut in this program.

## Three defects this fixture found

**1. Open contours could not be offset at all.** `profileOp` cut every open contour *on*
the line regardless of `side`, because Clipper's offsetter only closes an open path into a
ribbon. Vectric offsets these cross-cuts by the tool radius (0.1875") to the **right of
travel**, so the kerf falls on the waste side. Added `offsetOpenPath` (mitred parallel
offset) plus an `openSide` option. Without this the cut lands half a tool-width off — a
real machining error, not a cosmetic one.

**2. Open contours got no holding tabs.** `withTabs` was gated on `c.closed`, so a
separation cut — precisely the case that most needs tabs — came out with none. `withTabs`
now takes an `open` flag and walks segments without wrapping.

**3. Tabs were applied to every depth pass.** A tab 0.1" above the floor only exists on a
pass that cuts below the tab top; shallower passes are still above it. We emitted a
spurious Z lift on all four passes of every cut — 16 lifts where the reference has 4. Now
gated on `z < topZ - cutDepth + tabHeight`. The reference confirms the rule directly: four
depth passes per cut, a Z lift on the deepest only.

Also derived and implemented: travel direction on open cuts **alternates**, each cut
starting at whichever end is nearest where the tool just left. That falls out of
`entry:'nearest'`, and it matters because the offset is always to the right of travel —
reversing a cut flips which side of the line the kerf lands on.

## The one remaining difference: cross-cut sequence

Reference cuts them y = 52.66 → 54.26 → 87.23 → 1.00. We cut 1.00 → 52.66 → 54.26 → 87.23.

Ours is a greedy nearest-neighbour tour from the origin — a defensible rule that gives a
shorter path. Vectric's order is **not** DXF order (23, 24, 25, 26), not sorted by Y, and
not nearest-neighbour from the origin, from the park position, or from where the drill op
finished. It is most likely the order the vectors were selected or created in the
`.crv3d` — internal state a DXF export does not carry.

**Not fixable from the files we have, and it does not change the part.** Four independent
cross-cuts through a board, made in a different sequence, remove identical metal.
Everything that does affect the part — offsets, depths, tab count and height, drill
positions, feeds, tool changes, envelope, cut length — matches.

**If Dan wants this green**, the honest options are (a) accept sequence-independence for
jobs built from independent cuts and add an order-insensitive comparison mode to the
differ, or (b) re-export the fixture from Vectric with the vectors in cut order. Option (a)
changes what "parity" means and is his call, not something to adjust quietly.
