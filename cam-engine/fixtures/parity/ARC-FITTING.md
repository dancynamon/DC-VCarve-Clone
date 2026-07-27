# Arc fitting: how Vectric decides, and how we now match it

**Status: solved, except for full circles.** This file used to record an unsolved gap and two
dead ends. The dead ends are still worth keeping — they are the reason the fix looks the way
it does — but the gap itself is closed.

## What Vectric actually does

Vectric does not arc-fit the toolpath. It emits `G2`/`G3` only where it already *knows* the
geometry is an arc, which happens two ways:

1. **Round joins.** The offsetter builds an arc at a corner, of radius exactly the offset
   distance.
2. **Source arcs.** Geometry that was an arc in the drawing, offset to radius `R ± |delta|`.

The print jig is the clean proof. Each of its 20 pieces is a 776-point flattened spline with
**no arcs at all in the source**, and it contains two obviously circular lobes (r = 0.500 and
r ≈ 0.125). Vectric emits exactly **8 arcs, all of radius 0.1250 — the tool radius** — and
posts the r = 0.500 lobes as **96 straight segments each**. It is not recognising circles in
the polyline; it is emitting the fillets it built itself, and nothing else.

We were arc-fitting the finished polyline instead, which turned sampled curves into arcs
Vectric never emits: 16 arcs where it emits 8 on the print jig, 4 on `lgc-50-board-4`'s T5
where it emits none.

## The fix: track provenance, do not try to recover it

`arcR` now rides on the points. `dxfparse.bulgeArcPts` tags points flattened from a real
bulge with their radius; `cadcore`'s `arcPolyline` and `mkRoundRect` do the same for shapes
drawn in the app; `mkPoly` carries the tag through import; `shapesToContoursInput` marks
everything *else* it sees with `arcR: 0`, meaning "known not to be an arc".

`camcore.allowedArcRadii` then turns a contour's tags into the set of radii its offset can
legitimately contain — `|delta|` for round joins, and `R`, `R±|delta|` for each source arc —
and `fitArcs` rejects any circle outside that set.

The three-way distinction matters and is tested:

| point tag | meaning | effect |
|---|---|---|
| `arcR: 2` | this is an arc of radius 2 | allows 2, 2±\|delta\| |
| `arcR: 0` | this is *not* an arc | allows only \|delta\| |
| absent | nothing is known | **no filtering at all** |

That last row is the safety catch. A raw point array handed straight to `assembleContours`
carries no provenance, and treating "untagged" as "not an arc" would silently post a drawn
circle as 161 line moves. Absence of evidence is only evidence of absence when the source is
known to record it.

## Result

| fixture | before | after | reference |
|---|---|---|---|
| `print-jig` | 16 arcs | **8** | 8 |
| `lgc-50-board-4` T5 | 4 arcs | **0** | 0 |
| `xrt-50` | arcs | arcs (unchanged, still PARITY) | arcs |
| `lgc-50-board-3` cross-cuts | 1 + 2 arcs | unchanged | 1 + 2 |

## The two dead ends — do not re-run these

Both were measured across all seven fixtures before the provenance fix, and both make things
*worse*. They are recorded because each is the obvious next idea.

**Tightening `arcTol`.** At 0.0015 / 0.0008 / 0.0004 / 0.0002 / 0.0001, board 4's spline went
**4 → 4 → 5 → 6 → 8** arcs — the fitter never gives up and emits a line, it just chops the
curve smaller. Meanwhile `xrt-50` lost all 6 of its genuine arcs below 0.0015 and dropped from
PARITY to DIFF. The knob moves both cases the wrong way at once.

**A second, tighter "is it really a circle" residual threshold.** The intuition is sound — a
genuine arc fits to 1e-16, a spline only to ~1e-3 — but it fails for a subtle reason: **a
densely sampled smooth curve is locally circular to any precision you ask for.** Tighten the
threshold and the fit shortens rather than failing. Board 4 went 4 → 6 arcs, the print jig
16 → 20.

Neither tolerance nor fit quality separates the cases. Only provenance does.

## The one thing still unexplained

A **full circle** comes out of Vectric as ~100 straight segments, in a pocket's rings and in a
profile alike — four independent samples across boards 3 and 4, on the same Ø1.5 circle. Under
the rule above it should post as arcs, and under our implementation it does. The fixtures
model it with the per-op `arcs: false` flag and say so at the line, rather than inventing an
engine rule from one piece of geometry.
