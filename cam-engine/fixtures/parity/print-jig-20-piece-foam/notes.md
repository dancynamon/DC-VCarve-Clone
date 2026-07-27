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
