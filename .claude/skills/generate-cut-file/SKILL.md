---
name: generate-cut-file
description: Turn a DXF, SVG or vector PDF into a ready-to-run ShopSabre .tap cut file — and nest parts onto foam/board sheets — using the Aquamentor CAD/CAM engine headlessly, with no VCarve session and no browser. Trigger whenever Dan says "make a cut file", "generate the tap file", "post this to gcode", "cut this DXF", "toolpath this", "nest these parts", "how many sheets do I need", "lay these out on a sheet", "what's the run time on this", "convert this DXF to SVG", or names a part file and a bit size. Also fire when a cut list from shopify-cut-list-by-color or aquamentor-order-dashboard needs actual machine files, and when a customer sends artwork (DXF/PDF) that has to be checked for cuttable geometry before quoting. Reads geometry and writes cut files — never touches an order, an invoice or a machine. Go do it, don't just explain.
---

# Generate a cut file (headless CAD/CAM)

The Aquamentor CAD/CAM engine (`cadcam-studio.html`) has a shell front door: `cam-engine/cli.js`.
It is the **same engine** the studio runs — same geometry, same toolpaths, same ShopSabre post — so a
`.tap` produced here is the `.tap` the studio would produce from the same inputs. That means cut files
can be generated from a Cowork session, a script or a cron job without opening the app.

## Step 0 — locate the engine

Look in this order and use the first that exists:

```bash
for d in "$AQCAM_HOME" ~/code/aquamentor-cadcam ~/DC-VCarve-Clone ~/code/DC-VCarve-Clone; do
  [ -f "$d/cam-engine/cli.js" ] && echo "$d" && break
done
```

If none exists, clone it once — `git clone https://github.com/dancynamon/DC-VCarve-Clone.git ~/code/aquamentor-cadcam`
— then continue. No `npm install` is needed; the engine has zero dependencies. Run everything as
`node "$REPO/cam-engine/cli.js" …`.

## Step 1 — ALWAYS inspect before cutting

Never post a file you haven't looked at. This is the step that catches the expensive mistakes.

```bash
node "$REPO/cam-engine/cli.js" info --in "part.dxf" --json
```

Check and report:

- **`closedContours`** — profile cutting wants closed contours. Pocket, drill and vcarve **require**
  them. If `closedContours` is 0 but `contours` is not, the geometry is open: say so and stop, don't
  post a toolpath that cuts air.
- **`bbox.w` / `bbox.h`** — must fit the sheet. A 49" wide part does not fit a 48" sheet.
- **`layers`** — if the file has cut/engrave/reference layers, pick with `--layer` or `--exclude-layer`
  rather than cutting everything.
- A vector PDF that reports live text has un-cuttable type in it — the CLI says so. Tell Dan to outline
  the fonts and re-export; do not silently cut the paths that did come through.

## Step 2 — pick the cut parameters

**Never invent a depth, feed or speed.** If Dan didn't give them and the job isn't an obvious repeat of
one below, ask. These are the parameters his own production files actually use — cite them as the
starting point, and confirm before running:

| Job | Tool | RPM | Feed | Depth | Passes |
|---|---|---|---|---|---|
| Rescue tube foam (XRT-50) | T1, 0.25" | 24000 | 100 | 1.5" | single pass |
| LGC 50 board | T8 / T10 | 10000 | 62.5 | 1.5" | 5 × 0.375" |
| Foam print jig | T2 | 20000 | 80 | 0.75" | single pass |

Foam cuts full depth in one pass; board stock is stepped down. Match `--pass` to `--depth` for a single
pass, or set `--pass` smaller for multipass. Clearance in his files is `0.8` for foam on the bed and
`0.2` for thin jig stock — pass it as `--clearz`.

Add `--tabs N` on any part that would otherwise come loose and get thrown. Foam parts on a spoilboard
usually don't need them; small board parts do.

## Step 3 — nest, if there is more than one part

```bash
node "$REPO/cam-engine/cli.js" nest \
  --in "kickboard.dxf:12" --in "mat.dxf:4" \
  --sheet 48x96 --spacing 0.5 --margin 0.25 \
  --out "nested.dxf" --json
```

Each input file is **one part** — its outline and holes move together. `:N` repeats it. Report
`sheets`, `utilization` and anything in `unplaced` (that means it doesn't fit the sheet at all — a real
problem, not a rounding issue). Use `--per-sheet` when Dan wants one file per sheet to load
individually; the default writes all sheets side by side in one DXF.

Sheet sizes: foam is 48x96 unless he says otherwise. Always leave `--spacing` for kerf and handling —
0.5" is a safe default, never 0.

## Step 4 — post the toolpath

```bash
node "$REPO/cam-engine/cli.js" cut \
  --in "nested.dxf" --op profile --side outside \
  --tool 1 --dia 0.25 --depth 1.5 --pass 1.5 \
  --feed 100 --rpm 24000 --clearz 0.8 --tabs 0 \
  --post shopsabre --out "CAD/job-name.tap" --json
```

Ops: `profile` (cut a part out — `--side outside` for the part, `inside` for a hole, `on` for a line),
`pocket` (clear an area), `drill` (a hole at each closed contour's centroid), `vcarve` (V-bit carving).

## Step 5 — verify and report

From the `--json` report, confirm and hand back:

- `passes` > 0 and `lines` looks sane (a real job is hundreds to thousands of lines, not 20)
- `bbox` still inside the sheet
- `estimatedMinutes` — this is machine time; give it to Dan, it feeds the cut schedule
- every entry in `warnings` — surface them, don't swallow them

Then tell him: the output path, the op, tool and depth used, sheets and utilization if nested, and the
estimated run time.

## Guardrails

- **Never overwrite an existing `.tap`** without asking. Check first; his `CAD/` folder holds files that
  have already run on the machine.
- **Never guess feeds, speeds or depths.** Wrong numbers break bits and scrap material. Ask.
- **Never claim a file is machine-ready if the CLI emitted a warning.** Report the warning.
- Cut files belong in the repo's `CAD/` folder or wherever Dan says — not in a temp directory he'll
  never find again.
- This skill reads geometry and writes cut files. It never touches Shopify, QBO, a shipping label or
  the machine itself.
- Use `--dry-run` freely to check numbers before writing anything.

## Chaining

- **shopify-cut-list-by-color** / **aquamentor-order-dashboard** produce the *what* — parts, colors,
  quantities. This skill produces the *how* — nested sheets and machine files. Feed the per-color part
  list straight into `nest --in part.dxf:qty`, then `cut` each sheet.
- **aquamentor-inventory-sync** wants sheet counts: `nest --json` gives `sheets` and `utilization` for a
  real foam demand number instead of an estimate.
- **create-foam-product-proof** / **foam-proof-to-plate** handle the printed side; this handles the cut
  side of the same part.

## Full command reference

`node "$REPO/cam-engine/cli.js" help` prints every flag. Commands: `cut`, `nest`, `convert`, `info`,
`posts`. Every command takes `--json` for a machine-readable report and `--dry-run` to compute without
writing. Inputs: `.dxf`, `.svg`, vector `.pdf`, `.aqcam`. Posts: `shopsabre` (default, G2/G3 arcs),
`generic`.
