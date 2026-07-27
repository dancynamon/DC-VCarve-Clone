# LGC 50 — Job 1, Board 4

**Status: KNOWN DIFF** — built. All six ops reproduce except two narrow differences on the
T5 op; see `known-diff.txt`. All 7 cross-cuts match, including sweep order and directions.

## T5's diameter WAS derivable — an earlier note here said otherwise

It was measured, not guessed: **0.1900" +/- 0.0001 over 78 mid-path samples** across both
T5 passes. The earlier claim that it "cannot be derived from the pair" was wrong — it was
based on the path's ENDPOINTS moving both along and across the contour, which is true, but
at any MID-path point the offset is a clean perpendicular and reads straight off.

**Confirmed against Vectric's tool database:** the tool is `T5e - Amana 49706 Roundover
0.380`, diameter **0.380"**, spindle 20000, feed 100.0, plunge 25.0, tool number 5. So it
is a genuine Ø0.380 cutter — not a Ø0.375 with an allowance, which was the alternative
hypothesis. The measured radius of 0.1900" is exactly half of it.

Worth recording that the measurement technique was validated: reading the offset off
mid-path samples gave the right answer to four decimal places, and every other T5 parameter
derived from the `.tap` (feed, plunge, RPM, tool number) matched the database too.

## The job — six ops, five tools

| | Tool | What | Geometry | Depth | Feeds |
|---|---|---|---|---|---|
| 1 | **T10** | Drill 4 | contours 7, 8, 9, 10 (0.125×0.137) | -0.5 | cut 62.5 / plunge 20, S10000 |
| 2 | **T5** | 2 shallow open cuts | contours 33, 34 (len 4.016) | -0.1 | cut 100 / plunge 25, S20000 |
| 3 | **T8** | Drill 6 | contours 0, 1/3, 2/4, 5, 6, 26 — **dedupe**, two coincident pairs | -1.5 | plunge 20, S10000 |
| 4 | **T3** | Pocket Ø1.5 | contour 27 at (1.286, 86.693) | -0.25, -0.5 | cut 60 / plunge 20 |
| 5 | **T9** | Inside finish | contour 27, Ø0.125 | -0.5 | cut 100 / plunge 30 |
| 6 | **T3** | 7 cross-cuts | contours 29–35, 4 depth steps, 9 tabs | to -1.5 | cut 60 / plunge 20 |

Ops 3–6 are the same recipe as board 3 and reuse its `job.js` structure directly. The drill
tour for op 1 is nearest-neighbour from the origin — verified against the reference:
(0.751, 71.089) → (2.751, 71.089) → (2.751, 81.611) → (0.751, 81.611).

## Settled: T5's diameter, twice over

This section used to say T5's diameter "is not recoverable from the pair" and listed two
ways to settle it. Both have since happened, and they agree:

1. **Measured from the path.** Mid-path the offset is a clean perpendicular (only the
   *endpoints* move both along and across the path, which is what the original claim was
   based on). 0.1900" ± 0.0001 over 78 samples ⇒ Ø0.380.
2. **Read from the tool database.** `T5e - Amana 49706 Roundover 0.380` — Ø0.380, S20000,
   F100, plunge 25, tool number 5. The fixture now references it by number and name via
   `tool(5, ...)` rather than carrying the measured value, so nothing here is fitted.

It is a genuine Ø0.380 cutter, not a Ø0.375 with a 0.0025" allowance, which was the
alternative hypothesis.

Everything else in this fixture's parameters now comes from that same database (see
`job.js`); the only per-toolpath overrides are the two the operator actually changed, and
both are commented at the line.

## Outcome (this section used to be a prediction, and the prediction was wrong)

It said op 6 would "almost certainly" land as a KNOWN DIFF on cut order, because
`orderStart` was fitted and board 3 disagreed with boards 1, 2 and 5. Building it answered
the question it was built to answer, and the answer was the uncomfortable one: **board 3 was
not the outlier — the rule was wrong.** Ordering is an ascending-Y sweep, not
nearest-neighbour, and direction alternates by position on the board, not by cut order. All
7 cross-cuts here match, order and direction, and so do all 5 of board 3's.

Ops 1 and 3–5 match. What is left is two narrow differences on op 2 (T5); see
`known-diff.txt`.

## Files
- `reference.tap` — ground truth, posted from VCarve with the ShopSabre ATC post.
- `source.dxf` — vectors exported from Aspire. **36 shapes** (29 closed, 7 open), 3497 points.
  Verified to import cleanly through `dxfparse.js` → `dxfPolysToShapes` →
  `assembleContours`; bbox `[0.00, 0.00] → [3.50, 97.00]` matches the DXF header extents.
- `source.crv3d` — the original Aspire project. Unreadable binary, kept as the
  source of record only; the DXF supersedes it for parity purposes.

## What the reference .tap contains
| | |
|---|---|
| Cutting passes | 43 |
| Distinct cut depths | -1.5, -1.125, -0.75, -0.5, -0.375, -0.25, -0.1 |
| Feeds seen (ipm) | 20, 25, 30, 60, 100 |
| Tool changes | 6 (tools: 10, 5, 8, 3, 9) |
| Tab lifts | 9 |
| XY envelope | -0.169, 0.819 → 3.671, 88.888 |
| Total cut length | 166.9" |

## Deriving the tool diameters — harder here, and worth knowing why
On the single-tool fixtures (`xrt-50`, `print-jig-20-piece-foam`) the tool
diameter falls straight out of the extents: the toolpath sits a uniform radius
proud of the part all the way round.

That shortcut does **not** work on this job. It is multi-tool (6 changes across
tools 10, 5, 8, 3, 9), so different contours are cut by different diameters, and the
overall envelope only reflects whichever tool cut the outermost feature. The DXF
extents here are the **board stock** (0,0 → 3.50, 97.00), not a part outline, so
comparing extents to envelope is meaningless.

The diameters have to be recovered **per contour**: group the passes by the tool
in effect, match each pass to its nearest source contour, and measure the
perpendicular offset between them. That is a job for the parity run itself.

## Why this fixture matters
Neither DXF fixture exercises TOOLCHANGE blocks, multiple tools in one program,
multipass depth stepping, or holding tabs. This one exercises all four. Board 4 is
the most demanding of the five.

## Cut direction is a property of the board, not of the toolpath

Board 4 is what proved this. Contours 4 and 5 are cut by BOTH the shallow T5 op and the
through-cutting T3 op, and both ops run them right-to-left. Ranking the serpentine within the
T5 op alone would make its lower contour the bottom-most one and send it left-to-right - a cut
a full tool-width off position. `profileOp` therefore takes `serpentineOver`, and this
fixture passes the whole drawing's open contours to the T5 op.

The rule itself, measured over all 21 cross-cuts of the five boards: the bottom-most cut runs
left to right, and each successive cut UP THE BOARD reverses. Lengthwise contours (ends
differing more in Y than in X) sit outside the serpentine entirely - contour 6 here is one,
and letting it take an alternation slot shifts the parity of everything after it.
