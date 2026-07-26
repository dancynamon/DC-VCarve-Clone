# Parity fixtures — real VCarve jobs as ground truth

Everything else in `npm test` grades this codebase against its own intentions.
These fixtures grade it against **Vectric**. That is the whole point: a job that
passes here is one you have evidence the clone cuts the same way VCarve does.

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
