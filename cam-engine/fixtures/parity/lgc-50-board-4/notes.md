# LGC 50 — Job 1, Board 4

**Status: READY** — DXF geometry present, an `ours` side can be built.

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
