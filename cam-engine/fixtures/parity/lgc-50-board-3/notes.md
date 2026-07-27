# LGC 50 — Job 1, Board 3

**Status: KNOWN DIFF** — 4 ops decoded and built; drills and the finishing pass match
exactly, cross-cut ordering does not. No tolerance was loosened.

## What the job is

| | Tool | What | Detail |
|---|---|---|---|
| Op 1 | **T8** | Drill 10 holes | Ø0.375 and one Ø0.25, plain plunge to -1.5, S10000 |
| Op 2 | **T3** | Pocket a Ø1.5 circle | at (1.296, 86.693), 2 depth steps, 6 rings @ 0.09375" stepover |
| Op 3 | **T9** | Inside-profile finish | Ø0.125 around that same circle at -0.5, feed 100 |
| Op 4 | **T3** | 5 cross-cuts | 4 depth steps each, tabs by constant 3" spacing (1/1/1/2/3) |

## Two things this fixture found

**The DXF contains duplicate circles** — six coincident pairs. Selecting holes by size alone
drills 16 where the job needs 10, so the selection dedupes by centroid. Worth knowing the
source files carry this; Vectric's "check vectors" would flag it.

**Pocket rings were emitted as separate passes.** We retracted and re-plunged between every
ring — 12 passes where the reference has 2 — which is slow and leaves an entry mark on each
ring. `pocketOp` now takes `linkRings`, cutting innermost-first and stepping outward in one
continuous pass per depth, which is what Vectric does. Also confirmed the stepover here is
25% of tool diameter (0.09375" on a Ø0.375 tool), read off the ring radii.

## What matches

All 10 drill positions **and their order** (nearest-neighbour from the origin). The T9
finishing pass length, 4.319", exactly. The pocket's structure: 2 passes, 6 rings, correct
stepover.

## What does not, and why

**Cross-cut order.** See `known-diff.txt`. Under `entry:'serpentine'` the travel direction
decides which side the tool-radius offset lands, so a wrong order also shifts the envelope
and the total cut length — one root cause, four failing checks.

The tour start `(3.5, 48.5)` that reproduces boards 1, 2 and 5 does not reproduce this
board. `orderStart` is already **fitted rather than derived** (see OVERNIGHT-REPORT.md), and
inventing a third per-fixture value would compound that rather than explain it. Left
visible instead.

**Pocket ring radii** sit ~0.006" outside Vectric's — Clipper's offset of a 64-gon against
whatever Vectric does with the true circle. Same class as `print-jig`'s residual.

**Arc fitting.** We fit arcs to the pocket rings; Vectric emits them as G1 polylines. The
metal is the same.

## Files
- `reference.tap` — ground truth, posted from VCarve with the ShopSabre ATC post.
- `source.dxf` — vectors exported from Aspire. **28 shapes** (23 closed, 5 open), 2396 points.
  Verified to import cleanly through `dxfparse.js` → `dxfPolysToShapes` →
  `assembleContours`; bbox `[0.00, 0.00] → [3.52, 97.00]` matches the DXF header extents.
- `source.crv3d` — the original Aspire project. Unreadable binary, kept as the
  source of record only; the DXF supersedes it for parity purposes.

## What the reference .tap contains
| | |
|---|---|
| Cutting passes | 33 |
| Distinct cut depths | -1.5, -1.125, -0.75, -0.5, -0.375, -0.25 |
| Feeds seen (ipm) | 20, 30, 60, 100 |
| Tool changes | 4 (tools: 8, 3, 9) |
| Tab lifts | 8 |
| XY envelope | -0.141, 0.819 → 3.684, 88.888 |
| Total cut length | 131.9" |

## Deriving the tool diameters — harder here, and worth knowing why
On the single-tool fixtures (`xrt-50`, `print-jig-20-piece-foam`) the tool
diameter falls straight out of the extents: the toolpath sits a uniform radius
proud of the part all the way round.

That shortcut does **not** work on this job. It is multi-tool (4 changes across
tools 8, 3, 9), so different contours are cut by different diameters, and the
overall envelope only reflects whichever tool cut the outermost feature. The DXF
extents here are the **board stock** (0,0 → 3.52, 97.00), not a part outline, so
comparing extents to envelope is meaningless.

The diameters have to be recovered **per contour**: group the passes by the tool
in effect, match each pass to its nearest source contour, and measure the
perpendicular offset between them. That is a job for the parity run itself.

## Why this fixture matters
Neither DXF fixture exercises TOOLCHANGE blocks, multiple tools in one program,
multipass depth stepping, or holding tabs. This one exercises all four. Board 4 is
the most demanding of the five.
