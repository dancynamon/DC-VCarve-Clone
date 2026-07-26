# LGC 50 — Job 1, Board 1

**Status: READY** — DXF geometry present, an `ours` side can be built.

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
