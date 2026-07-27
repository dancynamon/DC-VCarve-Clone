# LGC 50 — Job 1, Board 4

**Status: KNOWN DIFF** — built. All six ops reproduce except two narrow differences on the
T5 op; see `known-diff.txt`. All 7 cross-cuts match, including sweep order and directions.

## T5's diameter WAS derivable — an earlier note here said otherwise

It was measured, not guessed: **0.1900" +/- 0.0001 over 78 mid-path samples** across both
T5 passes. The earlier claim that it "cannot be derived from the pair" was wrong — it was
based on the path's ENDPOINTS moving both along and across the contour, which is true, but
at any MID-path point the offset is a clean perpendicular and reads straight off.

0.1900 does not decompose to a standard tool: it is 0.1875 + 0.0025, so most likely a
Ø0.375 cutter carrying a 0.0025" allowance (Vectric's "allowance offset"), or a Ø0.38
cutter. The effective offset is what reproduces the path; the decomposition is ambiguous
and does not matter for parity.

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

## The one thing that needs a decision

**T5's tool diameter is not recoverable from the pair.** Its toolpath starts at
x = 3.6712, which is 0.17" beyond the 3.5" board edge, so the cut is offset outward from
contour 33 — but the offset distance depends on a diameter that appears nowhere in the
`.tap` (G-code carries no tool geometry) and cannot be read off the DXF. Deriving it the way
the single-tool fixtures did needs a contour whose offset is unambiguous, and this one's
endpoints move both along and across the path.

Two ways to settle it: read the diameter off the tool list in Vectric for tool 5, or accept
it as a fitted parameter the way `orderStart` already is.

## Expected outcome once built

Ops 1 and 3–5 should match. Op 6 will almost certainly land as a **KNOWN DIFF** on cut
order, for the same reason board 3 does: `orderStart` is fitted rather than derived, and the
value that reproduces boards 1, 2 and 5 does not reproduce board 3. Board 4 is the fixture
that would tell us whether board 3 is the outlier or the rule itself is wrong — which is
the main reason it is worth building.

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
