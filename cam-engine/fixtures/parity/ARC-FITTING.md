# Arc fitting: what Vectric does, what we do, and two dead ends

This is the one substantive difference left across the parity fixtures, and it is worth
writing down properly because two obvious fixes have been measured and **both make it worse**.
Do not re-run them.

## The observation

We arc-fit the finished toolpath: `fitArcs` walks the offset polyline and emits `G2`/`G3`
wherever a run of points lies on a circle within `arcTol` (0.0015"). Vectric evidently does
not do this. Its arcs come from geometry it already knows to be circular.

Where the two agree and disagree, across every fixture:

| Source geometry | Reference | Ours | Agree? |
|---|---|---|---|
| `xrt-50` — closed polyline, 5 bulge arcs of 7 vertices | arcs | arcs | **yes** |
| `lgc-50-board-3` cross-cut, 2-point line | no arcs | no arcs | **yes** |
| `lgc-50-board-3` cross-cut, 3 points, one corner, offset outward | 1 arc | 1 arc | **yes** (round join) |
| `lgc-50-board-3` lengthwise cut, 5 points with 2 bulges | 2 arcs | 2 arcs | **yes** |
| `lgc-50-board-4` T5 — 130-point flattened spline, no bulges | **no arcs** | 4 arcs | no |
| `print-jig` piece — 776-point closed polyline, no bulges | **8 arcs** | 16 arcs | no |
| `lgc-50-board-3/4` Ø1.5 circle (pocket rings **and** finish profile) | **no arcs** | arcs | no |

Two things fall out of the table:

- Vectric is not simply "carrying source bulges through". The print-jig pieces have **no**
  bulges at all — they are 776-point flattened splines — and Vectric still emits 8 arcs. It
  recognises the exactly-circular lobes inside that polyline (r = 0.500 and r ≈ 0.125).
- Vectric is not simply "arc-fitting everything circular" either, or the Ø1.5 circle would
  come out as arcs. It comes out as **100 straight segments**, in the pocket rings and in the
  T9 finishing profile alike — four independent samples across two boards.

The circle case is the odd one and we have no explanation for it. It is modelled with the
per-op `arcs: false` flag rather than guessed at in the engine, and the fixtures say so at
the line.

## Dead end 1: tightening `arcTol`

The intuition is that our fitter is too permissive, so tighten it. Measured across all seven
fixtures at 0.0015 / 0.0008 / 0.0004 / 0.0002 / 0.0001:

- `lgc-50-board-4`'s spline went **4 → 4 → 5 → 6 → 8** arcs. Tightening makes the fitter chop
  the curve into *more*, shorter arcs — it never gives up and emits a line.
- `xrt-50` lost all 6 of its genuine arcs below 0.0015 and went from PARITY to DIFF.
- `print-jig` lost its arcs too, at 0.0004.

So the knob moves both cases the wrong way at once. There is no setting where genuine arcs
survive and spline-fitted ones do not.

## Dead end 2: a second, tighter "is it really a circle" threshold

The better intuition: a run that really came from an arc lies on its circle to floating-point
noise (measured: 1e-16 on a synthetic exact circle, 1e-5 on Clipper's integer grid), while a
spline only lies on one to within whatever `arcTol` allowed (measured: ~1e-3). So accept an
arc only when the residual is tiny.

This fails, and the reason is worth understanding: **a densely sampled smooth curve is
locally circular to any precision you ask for.** Tighten the residual threshold and the
fitter does not reject the arc, it just shortens the span until the residual fits. Board 4
went 4 → 6 arcs and the print jig 16 → 20.

The difference between the two cases is not tolerance and it is not fit quality. It is that
Vectric knows the arc's *identity* — carried from import, or constructed as a round join —
where we only ever see sampled points.

## What would actually fix it

Track arc provenance instead of recovering it: keep an arc as an arc through DXF import,
through offsetting, and out to the post, rather than flattening to a polyline and fitting
circles back out of it. That is a real change to the geometry pipeline, not a tuning
exercise, and it would fix `lgc-50-board-4`, the print jig, and the extra split arcs all at
once.

Until then this is a **representation** difference, not a metal difference: our arcs follow
the reference polyline within 0.0015", and the parity harness's cut-length check confirms the
paths agree (board 4 within 0.01%).

## One thing that is already fixed

Our fitter used to split a single circular lobe into two `G2`s. The print jig's r=0.500 lobe
came out as 210.8° + 67.4°. That is *not* a greedy-restart bug that merging can fix — the two
fitted circles differ by 0.0025" in centre and radius, because the underlying offset polyline
is only circular to about that, so merging them would move the path further than `arcTol`
allows. It is the same provenance problem in a smaller costume.
