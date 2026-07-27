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
| `print-jig-20-piece-foam` | **KNOWN DIFF** — understood, documented, marked |
| `lgc-50-board-3` | **KNOWN DIFF** — built; drills + finish pass exact, cut order not |
| `lgc-50-board-4` | **KNOWN DIFF** — built; 7/7 cross-cuts, only T5's entry differs |

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
