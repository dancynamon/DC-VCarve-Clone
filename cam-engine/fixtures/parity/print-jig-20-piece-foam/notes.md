# 20-piece male print jig — foam

**Status: DIFF** — 7 of 9 checks pass. Two residual differences, both representational
rather than behavioural. Documented rather than forced; no tolerance was loosened.

## Files
- `reference.tap` — VCarve-posted, ShopSabre ATC post.
- `source.dxf` — 21 `POLYLINE` entities, 15,545 points. 20 jig pieces + the sheet outline.
- `job.js` — rebuilds the job headlessly.

## Parameters

| Parameter | Value | How it was recovered |
|---|---|---|
| Tool | **Ø0.250", T2** | `T` word; diameter from the offset distance |
| Spindle / feed / plunge | **20000 / 80 / 30** | `S` and `F` words |
| Cut depth | **-0.7500**, single pass | Only Z level in the program |
| Clearance Z | **0.2000** | `G0 Z` retract height |
| Leads | **none** | Every pass closes exactly on its own start (0.0000 apart) |
| Tabs | none | Zero mid-cut Z lifts |

## Three things this job taught us

**1. It is mixed-side.** The 20 pieces are *cavities* — cut **inside** their contours. Only
the sheet outline is cut outside. Deriving the side from the extents (as on `xrt-50`) gives
the wrong answer here, because the extents are set by the outline and the 20 pieces do not
move them. The `xy envelope` check therefore passes either way and **cannot** settle the
question; the entry point direction can, and did.

**2. It is one tool block, not two.** The reference has a single `T2`, so the inside passes
and the outside pass have to be merged into one op. Posting them as two ops emits a
spurious TOOLCHANGE.

**3. Cut order is contained-before-container, then greedy nearest-neighbour with a free
entry point.** VCarve cuts all 20 cavities first and the sheet outline **last** — cutting
the perimeter first would free the whole panel. Within that, it tours greedily, and each
contour is entered at *whatever point on it is nearest the previous exit*, not at a fixed
vertex. Three engine changes came out of this (`orderContours`, `entry:'nearest'`, and
measuring candidate distance to the nearest point of a contour rather than its first
vertex).

## The two residual differences

**Entry point, ~0.012" out.** Pass 2 starts at ref `(4.2022, 8.6003)` vs ours
`(4.2140, 8.5968)`. The *rule* is matched — both pick the nearest point on the offset loop
to the previous exit — but on a 776-point freeform curve our offset polyline and Vectric's
differ slightly, so the two minima land in marginally different places. The tolerance is
0.001"; this is 12x that, and it is discretisation, not behaviour.

**Arc segmentation.** Ref emits 8 arcs on pass 1, all CCW; we emit 16, alternating CW/CCW.
On freeform curves Vectric keeps more of the path as polyline and fits fewer arcs, while we
fit arcs onto the flattened curve — including short concave runs, which come out CW. The
metal removed is the same: `cut length` agrees within 0.5% and the envelope, depths and
feeds all match.

## Why these were not "fixed"

Both could be made green by loosening `xyTol` or by weakening the arc-direction check.
Neither was done. The honest reading is that this fixture demonstrates the clone cuts the
same part by the same strategy, and differs from Vectric only in how the path is
*represented* on freeform geometry.

**What would settle it:** cut this jig from both programs and measure. If the parts are
interchangeable, the right change is a documented per-fixture tolerance for freeform jobs —
which is a decision for Dan, not something to quietly adjust.

## Two defects and one dead end, found by building this fixture

**The cavities were cut climb; the reference cuts them conventional.** All 8 of the
reference's corner arcs run counter-clockwise where ours ran clockwise. On a 20-cavity foam
jig that is tool loading and wall finish, not a G-code detail.

**We arc-fitted curves Vectric leaves as lines.** This fixture is what made the rule legible.
Each piece is a 776-point flattened spline with *no arcs in the source*, yet it plainly
contains circular lobes at r = 0.500 and r ≈ 0.125. Vectric emits exactly 8 arcs, every one of
radius 0.1250 — the **tool radius** — and posts the r = 0.500 lobes as 96 straight segments
each. So it is not recognising circles in the polyline at all; it is emitting the fillets its
own offsetter built. That observation is what `allowedArcRadii` encodes. See
`ARC-FITTING.md`, which also records the two fixes that were measured and made things worse.

**The cut order is not in the file.** Not DXF order, not nearest-neighbour, not
travel-minimising (ours is 19% shorter), and not encoded in layers — all 20 pieces are on one
layer with no per-piece attributes. It comes from the Aspire project's nesting order, which
the DXF export does not carry. Details and numbers in `known-diff.txt`.

## PARITY - the cut order was in the project file

Dan supplied the jig's own `.crv3d`, and the decoder (see `../CRV3D.md`) settled the last
difference. The stored toolpath runs are **in cutting order** and match the posted tour
exactly - confirming it was the project's nesting order all along, reproducible by no rule
(our nearest-neighbour tour is 19% shorter in rapid travel than Vectric's actual one).

Each pass's entry is the stored chain's **closing point**. On all 20 pieces the stored chain
closes exactly on its own start, so first and last coincide and match the `.tap` to four
decimals. The sheet outline exposed the distinction: its stored chain starts one
tessellation sliver (0.0056") into a corner arc and ends at (0.125, 0.25) - and the posted
program enters at the closing point, not the sliver. Using the closing point is exact on
all 21 passes.

`job.js` now reads order and entries from `source.crv3d`, cuts each piece with a
per-contour `startAt`, and the fixture is at full parity. The 0.012" entry residual the old
known-diff recorded was the chained-entry consequence of the wrong order, not a separate
defect.
