# Overnight parity run — report

Branch `claude/cad-vcarve-clone-readiness-mhqzyd`. Scope was Phase 1b (parity fixtures) +
Phase 1c (expose the parity-critical parameters in the studio UI).

## Where things stand

| Fixture | Status |
|---|---|
| `xrt-50` | **PARITY** |
| `lgc-50-board-1` | **PARITY** |
| `lgc-50-board-2` | **PARITY** |
| `lgc-50-board-5` | **PARITY** |
| `print-jig-20-piece-foam` | **KNOWN DIFF** — cut order only, and it is not in the DXF |
| `lgc-50-board-3` | **KNOWN DIFF** — one pass's start angle, nothing else |
| `lgc-50-board-4` | **KNOWN DIFF** — T5 entry 0.0018" out |

**Phase 1c: done.** `npm test` is green at **435 checks**.

### Final tally
4 fixtures at parity, 3 as documented known differences. **15 defects found and fixed** —
several of which produced wrong metal, not just mismatched text.

### Follow-up session: the ordering rule was wrong in principle

Board 4 got built, and it overturned two earlier conclusions:

- **T5's diameter was derivable after all.** Measured 0.1900" +/- 0.0001 over 78 mid-path
  samples. The earlier "cannot be derived" was based on endpoint behaviour and did not
  consider that mid-path the offset is a clean perpendicular.
- **Cut ordering is an ascending-Y sweep that wraps, not nearest-neighbour.** Verified
  against all five LGC boards (4, 4, 5, 7 and 4 cuts). NN only *coincided* on the four-cut
  boards, where a mid-board start tours the same way; at 5 and 7 cuts it diverges
  immediately. The rule shipped overnight was wrong in principle, not merely
  mis-parameterised — and the three boards that passed with it passed for the wrong reason.
- **Direction is side-alternation, not vector comparison.** Comparing travel vectors breaks
  when a contour curves enough that both endpoints sit on the same side, which is exactly
  board 4's first cut. Alternating the side is stable there and reproduces boards 1, 2, 4
  and 5 (7/7 on board 4). Board 3 is the lone counter-example.

## Fourteen defects found and fixed

Every one of these needed a real Vectric program to find. None was visible from inside the
codebase, and several produced *wrong metal*, not just mismatched text.

**Cut the wrong shape or the wrong place**

1. **Straight edges posted as enormous arcs** — the bottom edge of the XRT-50 came out as
   `G3 … J794.4170`, a radius-794" arc bowing **0.3" off course**. A near-straight run fits
   a huge circle through every sample while wandering between them. Two guards now:
   `runIsStraight` (are the *points* collinear — testing the fitted circle is the wrong
   question) and `arcFollowsPolyline` (bound the sagitta between consecutive samples).
2. **Open contours could not be offset at all.** Every open contour was cut *on* the line
   regardless of `side`, because Clipper only closes open paths into a ribbon. Vectric
   offsets separation cuts by the tool radius so the kerf falls on the waste side — we were
   cutting **half a tool-width off position**. Added `offsetOpenPath` + `openSide`.
3. **The sheet outline was cut first.** Passes came out in raw DXF order, so on the print
   jig the outline was cut before the 20 pieces — **freeing the whole panel and every part
   in it**. `orderContours` now cuts contained contours before their container.
4. **Open contours got no holding tabs** — `withTabs` was gated on `c.closed`, so a
   part-off cut, the case that most needs tabs, got none.
5. **DXF arc flattening ignored radius** — a 90° arc always got 8 segments whether it
   spanned 0.1" or 30", leaving the polyline 0.014" inside the true arc at r=2.875. Now
   sagitta-based, holding chord error under 0.001".

**Cut in the wrong order or entered in the wrong place**

6. **Contour start point discarded.** `offsetLoop` is Clipper, whose output begins at an
   arbitrary vertex; nothing rotated it back, so the plunge, lead-in and tab phase landed
   somewhere unrelated to the drawn vector — on the XRT-50, the opposite corner.
7. **Entry point degenerate at convex corners.** The offset there is an arc centred on the
   vertex, so *every* point is exactly one tool-radius away and distance alone picks
   arbitrarily. Now placed along the corner's outward bisector.
8. **Candidate ordering measured from the first vertex** rather than the nearest point of a
   contour, which mis-ranks candidates and broke an exact tie the wrong way.
9. **Tabs applied to every depth pass.** A tab 0.1" above the floor only exists on the pass
   that reaches the floor; we emitted a spurious Z lift on all four passes of every cut —
   16 where the reference has 4.

10. **Pocket rings emitted as separate passes** — we retracted and re-plunged between every
    concentric ring, 12 passes where board 3's reference has 2. Slow, and it leaves an entry
    mark on each ring. `pocketOp` now takes `linkRings`, cutting innermost-first and
    stepping outward as one continuous pass per depth.
11. **Offset tolerance was coarser than the arc-fit tolerance** — Clipper ran at 0.003"
    while arc fitting demanded 0.0015", so corner arcs could never be recovered and posted
    as strings of G1. Offset now runs at 0.0005".

**Could not be set at all**

12. **`safeZ` was dead.** `postProcess` reads `op.clearZ` and falls back to 0.25"; every op
    builder set a `safeZ` that nothing read, and `studio_app` hardcoded `clearZ:0.25`.
    Cutting 1.5" foam with a quarter-inch retract is a real snag. Now settable (Phase 1c).
13. **Lead angle and overcut were engine-only.** Vectric's linear leads sit exactly 15.00°
    off tangent and carry 0.25" past the contour start; both were implemented but
    unreachable from the app. Now on the CAM panel.
14. **My own tab-spacing tests were dead code** — appended below `process.exit()`, so they
    never ran and the suite reported a false green on the feature they guarded. This is the
    exact failure mode the parity harness exists to prevent, reproduced inside the
    harness's own test file. Fixed; count went 141 → 145.

## Features added to match Vectric

- `leadAngle` / `overcut` — measured at 15.00° and 0.25", not guessed.
- `openSide` + `offsetOpenPath` — one-sided offset of open paths.
- `entry:'serpentine'` — successive parallel cuts alternate direction. Strict nearest-end
  agrees almost everywhere but flips on a near-tie (89.53" vs 89.71" on board 1's last
  cut); alternation matched **8 of 8** cut directions across boards 1 and 5.
- `order:'optimize'` on `profileOp` and `drillOp` — contained-first, then nearest-neighbour.
- `tabs.spacing` — constant-spacing tabs, `round(length / spacing)`.

## Three things I want you to check, not take on trust

**1. `orderStart` is fitted, not derived.** Boards 1/2/5 reach parity using a tour start
point — `(0,0)` for one drill tour, `(0,115)` for another, `(3.5, 48.5)` for the cross-cut
tours. The *ordering rule* is genuine and general; the *start point* I read back from the
references. I do not know why Vectric starts where it does. If board 3 or 4 disagrees, this
is the first thing to re-examine.

**2. Two test expectations changed.**
- `arctest`: "rect outside has 4 corner arcs" now expects **5**. The entry point correctly
  lands on a corner and splits that arc; xrt-50's reference splits its entry corner arc the
  same way. The companion "4 line edges" assertion still guards the intent.
- `test.js`: "profile tabs present" now checks the **final** pass, not `passes[0]`, plus a
  new assertion that shallow passes carry none. The old expectation encoded defect 9.

**3. A known-diff mechanism now exists.** `print-jig` fails two checks for reasons that are
understood and written down, so it carries a `known-diff.txt`: it reports as `[KNOWN DIFF]`
but does not fail the suite. Without this the gate sits permanently red and stops catching
regressions. A fixture *without* the marker still fails, so a new difference is never
silently absorbed — but it is a mechanism that could be abused, so it is worth knowing it
is there.

## What remains

**`print-jig`** — entry point 0.012" out and arc segmentation differs (8 arcs vs our 16) on
freeform curves. The rule is matched; our offset polyline and Vectric's put the same minimum
in slightly different places. Cut length agrees within 0.5%. **Settling this needs a real
cut**: make the jig from both programs and see whether the parts are interchangeable. If
they are, the right change is a documented freeform tolerance — your call, not mine.

**`lgc-50-board-3`** — BUILT, known diff. All 10 drill positions and their order match
exactly, as does the T9 finishing pass length (4.319"). Cross-cut *order* does not, and
under `entry:'serpentine'` that single root cause cascades into the envelope and cut-length
checks too, since travel direction decides which side the offset lands. Two defects came out
of it: pocket rings were emitted as separate passes (12 where the reference has 2,
retracting and re-plunging between every ring — now `linkRings`), and the source DXF carries
**duplicate circles**, six coincident pairs, so hole selection must dedupe or it drills 16
instead of 10. Original decode: `T8` drills 10 holes (note the DXF has
**duplicate circles** — six coincident pairs — and one Ø0.25 hole among the Ø0.375s, so the
selection needs dedup); `T3` pockets a Ø1.5 circle at (1.296, 86.693) in 2 depth steps,
rings spiralling **outward** from the centre; `T9` is a Ø0.125 inside-profile finishing pass
at -0.5; then `T3` cuts 5 contours in 4 depth steps with **constant-spacing tabs** (1/1/1/2/3
tabs for lengths 3.5/3.6/3.6/5.8/9.0 = round(L/3")).

**`lgc-50-board-4`** — decoded in full, not built; see its `notes.md` for the complete op
table. Ops 3–6 reuse board 3's recipe directly and its T10 drill tour is verified as
nearest-neighbour from the origin. **One thing genuinely cannot be derived**: T5's tool
diameter. Its path starts 0.17" beyond the board edge so the cut is offset outward, but
G-code carries no tool geometry and the DXF cannot supply it. Either read it off Vectric's
tool list for tool 5, or accept it as fitted the way `orderStart` already is. I stopped
rather than guess unattended.

Board 4 is worth building for one specific reason: it is the fixture that would tell us
whether board 3's ordering mismatch is an outlier or whether the `orderStart` rule itself is
wrong.

## Cost

Check `/cost`. My estimate for the remaining work was 12–19% of the weekly budget for
1b + 1c; 1c is done and five of seven fixtures are resolved, with the two hardest left.

## Follow-up: the tool database is now the source of truth

Your exported Vectric tool database is in `fixtures/tooldb/aquamentor-2026-07-27.tool`, and
`cam-engine/tooldbparse.js` reads it: **71 tools**.

The format is MFC `CArchive` serialisation, which means the class markers (`mcEndMillTool`,
`mcDrillTool`, ...) appear **exactly once each** no matter how many tools there are — each
class is named on first use and referenced by index afterwards. So records cannot be found
by class; they are anchored on the tool name, and every numeric field sits at a fixed
negative offset from it. The layout is written out at the top of `tooldbparse.js`.

The derivation is only as good as its ground truth, so it is pinned to yours: your Tool
Database screenshot of `T5e - Amana 49706 Roundover 0.380`. All seven fields read back
exactly — Ø0.380, pass depth 0.750, stepover 0.304 (80%), S20000, F100.0, plunge 25.0, tool
number 5 — and `importtest.js` asserts each of them, so a wrong offset shows up as a test
failure rather than as a wrong toolpath.

### It found a defect in the differ on its first use

`lgc-50-board-5`'s fixture ran T8 at **18000 rpm where the reference says S10000** — and
parity passed. The differ was not comparing the S word at all. Wrong spindle speed is
behaviourally real (burnt tools, melted foam), so that was a hole in the comparison, not
just a wrong number in a fixture.

`parity.js` now checks **spindle speeds**. Adding it turned boards 1, 2 and 5 red
immediately; correcting them from the database turned them green again. That ordering
matters: the check went in first and was allowed to fail.

### What changed

- All seven fixtures reference tools via `tool(num, name)` + `toolOpts(t)` instead of
  hardcoding diameters, feeds, plunges and speeds. Per-toolpath overrides are commented at
  the line.
- **The database confirmed the reverse-engineering.** Nothing moved: every fixture landed
  on exactly the status it had before. `xrt-50`'s Ø0.25/F100/plunge 30/S24000 is `T1 -
  Vortex Custom Tool for Rescue Tubes` with nothing overridden. Board 4's T5 — the diameter
  I said could not be derived, then measured at 0.1900" ± 0.0001 — is `T5e - Amana 49706
  Roundover 0.380`, Ø0.380 exactly.
- The studio can import a `.tool` file: **CAM panel → Import .tool**. It merges rather than
  replaces, so presets you built in the app survive a re-import.

### Two things to check, not take on trust

**`op` and `angle` are guessed from the tool NAME.** The record's class is what says whether
a tool drills or V-carves, and as above, the class is not recoverable per record — the name
is the only signal left. Anything unrecognised imports as `profile`, which is the safe
default (cuts a contour rather than plunging or carving). The import message says so. Both
fields are editable in the tool panel; correct them there before cutting.

**`T8 - Drill (0.375")` stores its feed as 62.46, not 62.5.** Vectric's dialog rounds it to
62.5 and so does the post, so the G-code matches the reference exactly — but the stored value
is 62.46. Most likely it was originally entered in metric (1586.5 mm/min). Harmless, worth
knowing.

## Follow-up: boards 3 and 4

Both are down to narrow, understood residuals. Five defects came out of it, three of which
produced wrong metal.

### The serpentine rule was wrong in principle

Board 3's two backwards cross-cuts were not an outlier. Measured across **all 21 cross-cuts
of the five boards**: the bottom-most cut runs left to right, and each cut UP THE BOARD
reverses. The alternation is by **position on the board**, not by the order the cuts are
made in — and those are different lists, because the tour is an ascending-Y sweep that starts
mid-board and wraps. On boards 1, 2, 4 and 5 the wrap happened to fall where both readings
agree; on board 3 it does not. Since the kerf is always to the right of travel, a reversed
cut is a **full tool-width out of position**.

This is the second time an ordering rule has been right on four boards for the wrong reason.
The lesson both times: a rule that fits every sample can still be wrong, and the way to tell
is to state it in physical terms and check the statement, not the outcome.

Two riders, from the same measurement:

- A **lengthwise** contour is not part of the serpentine. It has no left or right, and
  letting it consume an alternation slot shifts the parity of every cut after it.
- Direction belongs to where a cut sits on the **drawing**, not to which toolpath makes it.
  Board 4's shallow T5 op and its through-cutting T3 op both cut contours 4 and 5, both
  right-to-left. Hence `serpentineOver`.

The fitted `seedRight` heuristic is gone. Nothing about the direction rule is fitted now.

### Open-path corners were mitred where Vectric fillets

On the outside of a turn the two offset segments pull apart and the tool sweeps an arc about
the vertex. We ran it out to a sharp mitre point the cutter never traces — board 3's first
cross-cut came out **5.9236" long where the reference is 5.8446"**, and the reference emits
that corner as a G3. Closed contours already got round joins from Clipper; open ones now
match.

### The pocket, measured properly

Six rings, least-squares circle fit, **identical on boards 3 and 4 to five decimals**. Three
separate things were wrong:

- **Entry.** Every reference ring starts on the same ray as the source circle's own first
  vertex, so the links between rings are radial. We entered each ring nearest to where the
  last one finished, which walks the entry around the pocket.
- **Allowance.** The outermost ring sits 0.19385" from the wall where the tool radius is
  0.1875 — Vectric leaves **0.00635" of stock** for the T9 finishing pass, which itself takes
  the full radius. `pocketOp` now has an `allowance` option.
- **Representation.** Vectric emits the rings as ~100 G1 segments per revolution, not G2/G3.

The 0.09384" ring spacing and the 0.00635" allowance are **measured off the reference, not
read from a dialog** — the same status `orderStart` has. Neither is a round number (25% of
the 0.375 tool would be 0.09375), so both are worth confirming against the Vectric job file.
The mechanism is a real Vectric feature; only the values are fitted.

### Arc fitting: two dead ends, written down

The remaining representation gap has its own file, `ARC-FITTING.md`, because two obvious
fixes were measured and **both make it worse**:

- Tightening `arcTol` chops a spline into *more* arcs (4 → 8 as tol went 0.0015 → 0.0001)
  while genuine arcs on `xrt-50` and the print jig drop out entirely.
- A second, tighter "is this really a circle" threshold fails too — a densely sampled smooth
  curve is locally circular to any precision you ask for, so the fit just shortens.

The real difference is that Vectric knows an arc's *identity* (carried from import, or
constructed as a round join) where we only see sampled points. Fixing it properly means
tracking arc provenance through the geometry pipeline, which is a real change, not tuning.
Until then it is a representation difference, not a metal difference: cut lengths agree to
within 0.01%.

### What is left

- **board 3** — one pass, one number: the T9 finishing profile enters at 148.23° round the
  circle, we enter at 0°. Same circle, same length, plunging into already-cleared pocket. Not
  the source start, not nearest to the previous pass, not nearest to park, not the antipode;
  board 4's identical circle does the same thing, so it is deterministic — most likely just
  where Vectric's offsetter begins its output polygon.
- **board 4** — T5's entry 0.0018" out. Decomposed, the perpendicular offset is exactly right
  (0.18996" against a 0.1900" tool radius); the residual is 0.00176" of *along-path* position
  at the endpoint, where Vectric is evidently using the underlying spline tangent that the
  DXF does not give us. Plus the arc-representation gap above.

## Follow-up: the print jig, and arc fitting solved

All three remaining fixtures are now down to **one failing check each**, and all three are
entry-point or ordering, not geometry.

### Arc fitting: solved, by tracking provenance instead of recovering it

The print jig is what made the rule legible. Each of its 20 pieces is a 776-point flattened
spline with **no arcs in the source**, and it plainly contains circular lobes at r = 0.500 and
r ≈ 0.125. Vectric emits exactly **8 arcs, every one of radius 0.1250 — the tool radius** —
and posts the r = 0.500 lobes as 96 straight segments each. It is not recognising circles in
the polyline at all. It is emitting the fillets its own offsetter built, and nothing else.

So Vectric emits an arc only where it already knows the geometry is one: a round join at
`|delta|`, or a source arc offset to `R ± |delta|`. We were arc-fitting the finished polyline,
inventing arcs it never emits.

`arcR` now rides on the points from wherever the arc was created — `dxfparse` tags flattened
bulges, `cadcore` tags drawn circles and rounded corners — and `allowedArcRadii` turns that
into the set of radii a toolpath may legitimately contain. Anything outside it posts as lines.

| | before | after | reference |
|---|---|---|---|
| `print-jig` | 16 arcs | **8** | 8 |
| `lgc-50-board-4` T5 | 4 arcs | **0** | 0 |
| `xrt-50` | arcs | unchanged, still PARITY | arcs |

There is a deliberate three-way distinction here, and the third case is the safety catch:
`arcR: 2` means "an arc of radius 2", `arcR: 0` means "known not to be an arc", and **no tag
at all means no filtering** — because a raw point array carries no provenance, and treating
that as "not an arc" would silently post a drawn circle as 161 line moves.

**Two earlier attempts are recorded in `ARC-FITTING.md` so nobody repeats them.** Tightening
`arcTol` makes it worse (a spline gets chopped into more, shorter arcs — 4 → 8 — while genuine
arcs drop out). A tighter "is it really a circle" residual test fails too, because a densely
sampled smooth curve is locally circular to any precision you ask for; the fit just shortens.
Neither tolerance nor fit quality separates the cases. Only provenance does.

### The print jig's cavities were being cut the wrong way round

All 8 of the reference's corner arcs run counter-clockwise where ours ran clockwise: the
cavities are **conventional**, not climb. On a 20-cavity foam jig that is tool loading and
wall finish, not a G-code detail. It was invisible until the arc count matched.

### What is left on the print jig, and why it stays left

The order the 20 pieces are cut in. Matched piece-for-piece by bounding box and ignoring
program order, **all 21 passes agree**: worst piece-size difference 0.0000", worst cut-length
difference 0.0042" (0.017%), worst arc-count difference 0. Every piece is cut identically;
only the sequence differs.

And the sequence is not in the DXF. It is not DXF order (that is plain row-major), not
nearest-neighbour (at step 3 the NN choice is 5.17" away and the reference takes one 7.18"
away), not travel-minimising (**our tour is 19% shorter in rapid travel than Vectric's**), and
not encoded in layers — all 20 pieces sit on one layer with no per-piece attributes. It comes
from the Aspire project's nesting order, which the DXF export flattens away.

That is a different kind of "unresolved" from the others: not a rule we have failed to find,
but information the input does not contain.

## Where all seven stand

| Fixture | Status | What differs |
|---|---|---|
| `xrt-50` | **PARITY** | — |
| `lgc-50-board-1` | **PARITY** | — |
| `lgc-50-board-2` | **PARITY** | — |
| `lgc-50-board-5` | **PARITY** | — |
| `lgc-50-board-3` | KNOWN DIFF | one pass's start angle on a circle |
| `lgc-50-board-4` | KNOWN DIFF | one entry point, 0.0018" |
| `print-jig` | KNOWN DIFF | the order 20 identical cuts are made in |

No fixture has a geometry difference left.

## Follow-up: boards 3 and 4, and why a Vectric circle is not an arc

Both remaining differences were attacked directly. Neither yielded, and in both cases the
reason is now specific rather than vague — but the investigation solved a *different* open
question outright.

### Solved: why Vectric posts a circle as ~100 straight lines

`ARC-FITTING.md` had one case the provenance rule could not explain. Measuring the
tessellation answers it. The angular steps are **not uniform** — smallest (3.277°) exactly at
0/90/180/270° and largest (3.799°) at the diagonals, 25 steps per quadrant. That is the
fingerprint of a **rational quadratic NURBS circle**: four quarter segments with control
weights 1, cos 45°, 1, flattened at uniform parameter steps.

```
measured : 3.277 3.355 3.420 3.484 3.551 3.603 3.655 3.694 3.734 3.752 3.781 3.798 3.796 ...
predicted: 3.279 3.352 3.421 3.487 3.548 3.603 3.653 3.695 3.731 3.760 3.780 3.793 3.797 ...
worst element-wise difference: 0.008 deg, over all 25
```

A cubic Bezier circle predicts the *opposite* pattern, so this identifies the representation
rather than merely fitting a curve. **Vectric's circle is not an arc internally.** It is a
NURBS curve; the offset of a NURBS curve is another NURBS curve; there is no arc left to emit.
The provenance rule was right all along — a Vectric circle has no arc provenance to carry.

**Your call on one thing.** Matching this would make our output worse: two `G2` moves describe
a circle exactly, a hundred `G1` moves approximate it. The fixtures model Vectric's behaviour
with the per-op `arcs: false` flag so the comparison stays honest, and the engine still emits
arcs by default. Imitating the NURBS flattening app-wide is a deliberate decision, not a
defect to fix.

### board 3 — the T9 start angle, and why it is probably not in the file

The reference enters the finishing circle at **148.2336°** (board 4: 148.2307° on the same
part — deterministic, not noise). It is tessellation vertex 9 of 25 inside the 180→90°
quadrant, not on a segment boundary.

Every candidate rule was tested and ruled out: not the source contour's start (0°, which is
where we enter and which reproduces *every* other closed profile in the fixtures — xrt-50 at
full parity, and all six pocket rings on this same circle); not nearest to the previous tool
position (the tool retracts in place at 0° and there is no park move before the toolchange);
not the antipode, not nearest to park, not nearest to the origin, not any drill position.

Vectric's Profile toolpath carries a **per-contour start point the operator can place by
hand**, stored in the `.crv3d`. A DXF export re-emits a circle in canonical form starting at
+x — and `source.dxf`'s four bulge vertices sit at 0/90/180/270° to five decimals, so any start
point the project carried was normalised away on export. Same class as the print jig's cut
order: information the input does not contain.

### board 4 — 0.0018", and ours is already the better of the two options

The residual decomposes cleanly: the perpendicular offset is **exact** (0.18996" against a
0.1900" tool radius) and the difference is 0.00176" of *along-path* position at the endpoint.

Both principled endpoint tangents were tried. The first-chord normal (what we use) lands
0.0018" out; a second-order one-sided estimate lands **0.0034" out** — it moves the wrong way,
because the chord directions increase along the path (115.90 → 116.95 → 118.00°), so the true
tangent at the endpoint is *below* the first chord while Vectric's is *above* it. Flattening
error does not explain the gap either: at the local radius of ~1.09" a 0.020" chord sits
0.00005" off the true spline — thirty times too small.

The likely reading is board 3's again: Vectric offset the real spline in the `.crv3d`, and the
DXF hands us a sampled polyline of it. 1.8 thou, on an entry into air, with a 0.380" cutter.

### Honest summary

Three fixtures are still KNOWN DIFF, and all three now fail on **exactly one check each**,
none of which is a geometry difference:

| Fixture | What differs | Why it stays |
|---|---|---|
| `lgc-50-board-3` | one pass's start angle on a circle | per-contour start point, lives in the .crv3d |
| `lgc-50-board-4` | one entry point, 0.0018" | spline tangent, lives in the .crv3d |
| `print-jig` | order of 20 identical cuts | nesting order, lives in the .crv3d |

That is a pattern, not a coincidence: what is left in all three cases is information the DXF
export does not carry. Reading a `.crv3d` directly is the only thing that would settle them,
and it is a much larger piece of work than anything done so far.

## Follow-up: the .crv3d decoder

"Reading a .crv3d is the only thing that would settle them" turned out to be a smaller job
than predicted, because the format is two things we had already met: an **OLE2 compound
file** (the old Office container — documented, unencrypted) wrapping **MFC CArchive**
streams (the `.tool` database serialisation). `crv3dparse.js` reads the container completely
and decodes `Toolpaths/ToolpathData`; `CRV3D.md` is the format writeup.

Three findings, in increasing order of consequence:

1. **The tool records inside are byte-identical to the `.tool` database layout** — the
   existing parser reads them unchanged, one per toolpath, with the operator's overrides
   baked in. Feed 60 on T3 where the database says 80: every override the fixtures had
   annotated by hand is now confirmed by the project file itself.

2. **The computed toolpaths are stored, fully tessellated, in machine coordinates.** Only
   line segments — arcs arrive pre-flattened, which independently confirms the NURBS
   finding. And a board's file carries sibling boards' toolpaths too (board 3 contains
   board 4's T5 cuts, offset on the sheet), so runs must be selected by geometry.

3. **Board 3 is now at PARITY.** The 148.23° was an operator-placed start point, stored in
   the project and destroyed by DXF export. The fixture reads it via a new `startAt` option
   on `profileOp`, selecting the stored run by geometry (all points on the r=0.6875 finish
   circle). Board 4's T9 had the same issue masked behind its T5 failure — a full per-pass
   audit found it, and it gets the same fix.

**Board 4 stays a KNOWN DIFF, now with the complete explanation.** The project file
contains the true cubic bezier: exact endpoint tangent 115.372°. Vectric's own stored
toolpath samples it into 65 segments whose first chord runs at 116.425° — and the reference
entry is perpendicular to that chord, not to the true tangent. Ours is perpendicular to our
first chord (115.90°, the DXF's finer flattening). Same policy, different sampling, of the
same curve; Vectric's entry is a degree off its own true tangent. Cloning that means
cloning its tessellator's step selection — imitating an artifact. The 0.0018" appears on
all ten passes touching the two spline contours and nowhere else; every other pass in the
program matches within 0.001".

**The print jig's cut order would yield to exactly this decoder** — the stored runs are in
cutting order — but its `.crv` project file is not in the repo. If you still have it, drop
it in `print-jig-20-piece-foam/` and say so.

Score: 5 of 7 fixtures at full PARITY. The two remaining known diffs are one tessellation
artifact of 0.0018" and one missing input file.
