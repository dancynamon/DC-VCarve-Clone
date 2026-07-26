# Parity fixtures — real VCarve jobs as ground truth

Everything else in `npm test` grades this codebase against its own intentions.
These fixtures grade it against **Vectric**. That is the whole point: a job that
passes here is one you have evidence the clone cuts the same way VCarve does.

## Current inventory

| Fixture | Geometry | Ops | Status |
|---|---|---|---|
All seven have DXF geometry and import cleanly through `dxfparse.js`.

| Fixture | Geometry | Ops | Order |
|---|---|---|---|
| `xrt-50` | 16 shapes, all closed, 736 pts | 1 tool, outside profile, 16-up, Ø0.25", Z-1.5, arc leads | **1st** — simplest |
| `print-jig-20-piece-foam` | 21 shapes, all closed, 15,545 pts | 1 tool, outside profile, Ø0.25", Z-0.75 | **2nd** — dense freeform |
| `lgc-50-board-5` | 27 shapes (23 closed), 3,911 pts | 2 toolchanges, 4 depths, 4 tabs, 20 passes | **3rd** — smallest multi-tool |
| `lgc-50-board-1` | 32 shapes (28 closed), 3,771 pts | 2 toolchanges, 4 depths, 4 tabs, 24 passes | 4th |
| `lgc-50-board-2` | 32 shapes (28 closed), 3,771 pts | identical to board 1 | 5th |
| `lgc-50-board-3` | 28 shapes (23 closed), 2,396 pts | 4 toolchanges, 3 tools, 8 tabs, 33 passes | 6th |
| `lgc-50-board-4` | 36 shapes (29 closed), 3,497 pts | 6 toolchanges, 5 tools, 9 tabs, 43 passes | **last** — hardest |

Suggested order is easiest-first on purpose: the first fixture surfaces most of
the shared bugs (offset direction, arc fitting, depth stepping), and fixing those
against the simplest possible job is far cheaper than debugging them inside a
6-toolchange program.

A fixture with a `reference.tap` but no `ours.tap`/`job.js` reports as **PENDING**,
not as a failure — banking a job must never turn `npm test` red, or the incentive
runs backwards. See each fixture's `notes.md` for parameters derived from the pair.

`.crv` / `.crv3d` cannot be read by anything in this repo and there is no plan to
change that. The `lgc-*` folders keep theirs as the source of record only; the
DXF exports supersede them. To add a new fixture from a VCarve job, export the
vectors as DXF alongside the posted `.tap`.

## What to put here

One directory per job, named after the real job:

```
fixtures/parity/
  pvc-sign-11.5x17.5/
    reference.tap      <- REQUIRED. Posted straight out of VCarve. Do not edit it.
    job.js             <- builds the same job through our CAM (see _template/)
    notes.md           <- optional: tool, material, anything odd about the job
  drill-pattern-6up/
    reference.tap
    ours.tap           <- alternative: paste our Export .tap instead of a job.js
```

Directories starting with `_` are skipped by the runner.

## How to produce `reference.tap`

1. Open the real job in VCarve.
2. Post it with the **same post-processor you actually cut with** —
   `ShopSabre_DC_ATC_speed_arc_inch.pp`. If you post with a different one, the
   comparison is meaningless.
3. Save the `.tap` in here unmodified. Comments, line numbers, blank lines and
   CRLF are all fine — the parser normalizes them away.

## How to produce our side

Either is fine:

- **`ours.tap`** — build the job in the studio, Export .tap, drop it in. Fastest,
  and it exercises the real UI path.
- **`job.js`** — reproduces the job headlessly so it re-runs on every `npm test`
  and catches regressions forever. Copy `_template/job.js`.

`ours.tap` is the quick way to get a first answer. `job.js` is what makes the
fixture a permanent regression test. Start with `ours.tap`, convert later.

## What gets compared

Dialect is ignored — modal vs explicit G-words, comments, line numbers, inch vs
mm, CRLF, decimal padding. What is compared is what the spindle does:

| Check | Catches |
|---|---|
| pass count | missing or extra passes |
| xy envelope | wrong part size, wrong offset side, wrong origin |
| cut depths | wrong pass depth, wrong total depth, wrong Z zero |
| cut order | different sequencing (rapids, part ordering) |
| arc directions | climb vs conventional flipped, G2/G3 wrong |
| cut length | missing geometry, wrong offset radius |
| feed rates | wrong feed/plunge |
| tool changes | missing toolchange blocks |
| tab lifts | wrong tab count or missing tabs |

Default tolerances: **0.001"** on XY and Z, **0.05** in/min on feeds, **0.5%**
on total cut length. Override per-fixture in `job.js` if a job legitimately
needs looser bounds.

## Reading the output

```
PARITY  fixture: pvc-sign-11.5x17.5
DIFF    fixture: drill-pattern-6up
         x cut order: pass 3 starts ref (12.0000,4.5000) vs ours (30.5000,4.5000)
```

A `DIFF` is not automatically a bug in the clone. It is a **question to answer**:
either the clone is wrong, or VCarve makes a different-but-valid choice and you
write that difference down as intentional. Both outcomes are progress; an
unexamined `DIFF` is not.
