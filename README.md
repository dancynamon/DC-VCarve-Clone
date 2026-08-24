# Aquamentor CAD/CAM

Browser-based 2D CNC CAD/CAM (VCarve-style) for Aquamentor / WaterLine CNC.
Single self-contained HTML — no install, offline, posts G-code for ShopSabre (WinCNC).

## Quick start
```
npm test      # full suite: CAM, arc-fit, CAD, smoke, DXF/SVG import, PDF import, CLI
npm run build # regenerates cadcam-studio.html from cam-engine/ sources
open cadcam-studio.html            # the interactive studio
node cam-engine/cli.js help        # the same engine, headless
```

## What it does
- **CAD editor:** job/material setup, draw line/polyline/rect/rounded-rect/circle/ellipse/arc/polygon/star/text,
  select/move/scale/rotate, node edit, offset, weld/subtract/intersect, mirror, array, align, snapping, measure, tooltips, layers, undo/redo.
- **Import/Export:** DXF + SVG (editable) in; DXF/SVG out.
- **CAM:** Profile (outside/inside/on, climb/conv, multipass, tabs) → G2/G3 arcs → ShopSabre post → backplot → Export .tap.

## Headless CLI
`cam-engine/cli.js` is a shell front door to the same engine the studio runs — same geometry, same
toolpaths, same post — so cut files can be produced from a script, a cron job or a Claude skill with no
browser. Zero dependencies; `node cam-engine/cli.js help` lists every flag.

```
node cam-engine/cli.js info --in "CAD/XRT-50.dxf"
node cam-engine/cli.js cut  --in "CAD/XRT-50.dxf" --dia 0.25 --depth 1.5 --pass 1.5 \
                            --feed 100 --rpm 24000 --clearz 0.8 --out XRT-50.tap
node cam-engine/cli.js nest --in "kickboard.dxf:12" --in "mat.dxf:4" \
                            --sheet 48x96 --spacing 0.5 --out nested.dxf
```

- **`cut`** — DXF/SVG/vector-PDF/.aqcam in, toolpath out (`profile` · `pocket` · `drill` · `vcarve`),
  posted through `shopsabre` or `generic`. Reports passes, arc moves, extents and estimated run time.
- **`nest`** — packs parts onto sheets; each input file is one part, `:N` repeats it, so outlines and
  holes stay together. Reports sheets, utilization and anything too large to place.
- **`batch`** — a whole cut list to machine files in one pass (below).
- **`convert`** — format conversion between DXF and SVG. **`info`** — inspect geometry before cutting.
- **`cut --recipe NAME`** — run a catalogued multi-op recipe into one file instead of flag-by-flag.
- Every command takes `--json` for a machine-readable report and `--dry-run` to compute without writing.
  `--layer` / `--exclude-layer` filter imported geometry.

### Cut list -> machine files
`batch` takes the by-color cut list straight through to `.tap` files:

```
node cam-engine/cli.js batch --in cutlist.csv --outdir CAD/out
```

The cut list is `color, shape, size, qty, order, status` (CSV or JSON). `batch` holds back rows whose
status reads unpaid / hold / awaiting artwork, stops on a part with no catalog entry, groups the rest
by color (one color = one physical sheet), nests each color, and posts one `.tap` per sheet alongside
the nested `.dxf`. Pre-nested parts are cut as-is rather than re-nested.

`parts.json` at the repo root is the wiring: `recipes` say how to cut (an ordered op list posted into
one file with tool changes), `parts` say which DXF and which recipe, keyed by the name the cut list
uses. A part can instead name an existing `.tap` (`"tap": "CAD/….tap"`), in which case that file is
scheduled and reported but never regenerated — that is how the LGC 50 chair boards are catalogued, and
`parts.json` records the tap-vs-dxf analysis behind that choice. A part with holes gets an inside op filtered to a HOLES layer, then an outside profile excluding
it — an outside profile over a hole cuts it a full tool-diameter oversized, and the CLI warns when it
sees nested contours with no inside op. Adjacent ops sharing a tool are merged so the post doesn't
emit a pointless tool change. Output lands in `CAD/out/`, which is gitignored as regenerable.

### Using it from Claude
`.claude/skills/generate-cut-file/` wraps the CLI as a skill, so a Claude Code session in this repo can
build cut files on request. To reach it from Cowork or any other session, link it into your user skills:

```
ln -s "$PWD/.claude/skills/generate-cut-file" ~/.claude/skills/generate-cut-file
```

## Layout
- `cadcam-studio.html` — built app (run `npm run build` to regenerate).
- `cam-engine/` — sources: `cadcore.js` (CAD), `camcore.js` (CAM), `studio_app.js` (UI), `studio_shell.html` (markup/CSS), `dxfparse.js`, `pdfparse.js`, `cli.js` (headless front door), `build.js`, `package/clipper.js`, tests,
  ShopSabre `.pp`, roadmap README.
- `parts.json` — part catalog: cut recipes, and which DXF each cut-list name maps to.
- `.claude/skills/generate-cut-file/` — the CLI wrapped as a Claude skill.

## Roadmap (next)
TTF-outline text · Pocket / V-carve toolpaths · snap-to-job-corners · tool & material library · DXF BLOCK/INSERT expansion.
See `cam-engine/README.md`.
# DC-VCarve-Clone
