# LGC 50 — Job 1, Board 5

**Status: BLOCKED — no readable geometry.**

## Files
- `reference.tap` — usable ground truth, posted from VCarve.
- `source.crv3d` — Vectric Aspire project. **Binary, proprietary, undocumented.**
  Nothing in this repo can read it, and building a reader is the Phase 2 work we
  deliberately dropped as poor value. It is kept here so the pair stays together.

## What the .tap alone tells us
| | |
|---|---|
| Cutting passes | 20 |
| Distinct cut depths | -1.5, -1.125, -0.75, -0.375 |
| Feeds seen (ipm) | 20, 60 |
| Tool changes | 2 (tools: 8, 3) |
| Tab lifts | 4 |
| XY envelope | -0.012, 0.813 → 3.502, 87.418 |
| Total cut length | 56.1" |

## To unblock this fixture
Open the .crv3d in Aspire and **export the vectors as DXF** into this folder as
`source.dxf`. That is a couple of minutes of your time and turns this into a
first-class fixture — far cheaper than teaching this codebase to read .crv3d.

This is a **multi-tool** job (2 tool changes), so it also exercises the
TOOLCHANGE block and pass ordering across tools — coverage neither DXF fixture has.
Worth unblocking at least one of the five for that reason alone.

## Meanwhile
Even blocked this is not dead weight: it is real ShopSabre output that the G-code
parser is exercised against, which is how we know the parser handles multi-tool
programs, several distinct feeds and tab lifts from a real post rather than only
from our own.
