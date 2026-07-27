# LGC 50 — Job 1, Board 1

**Status: PARITY** — `job.js` reproduces this program exactly.

Same recipe as board 5: `T8` drills the Ø0.375 holes, `T3` makes the cross-cuts in four
0.375" depth steps with one holding tab each, offset a tool radius to the right of travel.
Board 1 has 8 holes rather than 4. Boards 1 and 2 are identical jobs.

Two ordering parameters had to be supplied, and it is worth being clear that these were
**inferred from the reference, not derived from the geometry**:
- the drill tour is nearest-neighbour from `(0, 0)` (board 5's runs from the park position
  `(0, 115)` instead);
- the cross-cut tour starts at `(3.5, 48.5)` — the right edge, mid-board.

`orderStart` is a genuine parameter (where the tool begins), but we have not established
*why* Vectric starts where it does. If a future fixture disagrees, this is the first thing
to re-examine.

## Files
- `reference.tap` — ground truth, posted from VCarve with the ShopSabre ATC post.
- `source.dxf` — vectors exported from Aspire. **32 shapes** (28 closed, 4 open), 3771 points.
  Verified to import cleanly through `dxfparse.js` → `dxfPolysToShapes` →
  `assembleContours`; bbox `[0.00, 0.00] → [3.55, 97.00]` matches the DXF header extents.
- `source.crv3d` — the original Aspire project. Unreadable binary, kept as the
  source of record only; the DXF supersedes it for parity purposes.

## What the reference .tap contains
| | |
|---|---|
| Cutting passes | 24 |
| Distinct cut depths | -1.5, -1.125, -0.75, -0.375 |
| Feeds seen (ipm) | 20, 60 |
| Tool changes | 2 (tools: 8, 3) |
| Tab lifts | 4 |
| XY envelope | -0.031, 0.813 → 3.540, 90.713 |
| Total cut length | 56.1" |

## Deriving the tool diameters — harder here, and worth knowing why
On the single-tool fixtures (`xrt-50`, `print-jig-20-piece-foam`) the tool
diameter falls straight out of the extents: the toolpath sits a uniform radius
proud of the part all the way round.

That shortcut does **not** work on this job. It is multi-tool (2 changes across
tools 8, 3), so different contours are cut by different diameters, and the
overall envelope only reflects whichever tool cut the outermost feature. The DXF
extents here are the **board stock** (0,0 → 3.55, 97.00), not a part outline, so
comparing extents to envelope is meaningless.

The diameters have to be recovered **per contour**: group the passes by the tool
in effect, match each pass to its nearest source contour, and measure the
perpendicular offset between them. That is a job for the parity run itself.

## Why this fixture matters
Neither DXF fixture exercises TOOLCHANGE blocks, multiple tools in one program,
multipass depth stepping, or holding tabs. This one exercises all four. Board 4 is
the most demanding of the five.
