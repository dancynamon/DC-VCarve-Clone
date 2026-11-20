# Parity fixtures: real VCarve jobs as the gate

The other suites grade this code against its own intentions. These grade it against Vectric.

Each folder is one real job:

| File | What it is |
|---|---|
| `reference.tap` | Posted by VCarve with `ShopSabre_DC_ATC_speed_arc_inch.pp`. Never edit it. |
| `source.crv3d` | The VCarve job the `.tap` came from. Our side is re-posted from this. |
| `source.dxf` | The same vectors exported as DXF. Kept for reference; the gate does not read it. |

`node cam-engine/paritytest.js` (part of `npm test`) runs every folder through the `batch.js`
pipeline: recover the recipe from Vectric's program (`tap2spec.js`), re-post it from the CRV with
our CAM (`repost.js`), and compare the two cuts at material level, 0.005" (`tapcompare.js`).

`expected.json` records where each job stands:

- A job listed `PASS` that stops passing **fails the suite**. That is a regression.
- Any other status is a known gap. It is printed with its reason and never fails the suite, so
  adding a job that does not match yet cannot turn `npm test` red.
- A known gap that starts passing is printed as `promote`. Run
  `node cam-engine/paritytest.js --update` to record it.

## Adding a job

1. Make a folder named after the job.
2. Copy in the `.tap` as `reference.tap` and the `.crv3d` (or `.crv`) as `source.crv3d`.
3. Run `node cam-engine/paritytest.js --update` and commit the folder with `expected.json`.

## What the recipe is recovered from

The recipe (tool, side, depths, tabs and where they sit, leads) is read back out of Vectric's own
program, then cut again from the CRV vectors with our CAM. So a pass means: given the same choices
the operator made in VCarve, our toolpath removes the same material. It does not prove our defaults
match VCarve's defaults.

## Where the jobs stand

See `expected.json` and the output of `paritytest.js` for the current list and the reason for each
gap. `xrt-50` has only a DXF, so it has no CRV to re-post from and is listed `UNPAIRED`.
