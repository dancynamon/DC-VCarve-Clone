# CRV reader tooling

The reader itself is `cam-engine/crvparse.js` (bundled into the studio); its unit tests are `cam-engine/crvtest.js`
on the committed fixture `cam-engine/samples/NEMA-Outlet-Covers.crv`.

## Regression corpus (not committed — no licence on the source repos)
Two public repos carry 22 more Aspire 7.006 / 7.015 / 7.514 files with bitmaps, 3D-model previews, holding tabs,
beziers and text. Fetch them next to this repo and run the corpus check:

```bash
git clone --depth 1 https://github.com/jlucidar/CNC-Design ../crv-corpus/jlucidar
git clone --depth 1 https://github.com/makermichael/PiPad  ../crv-corpus/pipad
node cam-engine/crvcorpus.js ../crv-corpus --export /tmp/crv-oracle     # every file must decode to the terminal marker
pip install pillow numpy && python3 tools/crv/oracle.py /tmp/crv-oracle  # compare against each file's embedded preview
```

Dan's own archive (`Dropbox/VCarve Pro/`) is the corpus that matters; point `crvcorpus.js` at it the same way. A FAIL
is the parser refusing an unseen layout — report the literal message and the file, add the layout, never a
resync-by-scanning heuristic.

## What the oracle proves
`PreviewData/Preview2D_GIF` is VCarve's own render of the vectors. `oracle.py` rasterises our decoded vectors into that
frame and measures ink both ways. "Ours covered by preview" must stay near 1.0 — a decoded stroke VCarve did not draw
is a decode error. "Preview covered by ours" is lower whenever the preview also shows toolpath previews, model renders or
bitmaps, which the reader drops on purpose.
