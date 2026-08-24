---
name: generate-cut-file
description: Turn a cut list — or a single DXF, SVG or vector PDF — into ready-to-run ShopSabre .tap machine files, nested onto foam/board sheets by color, using the Aquamentor CAD/CAM engine headlessly with no VCarve session and no browser. Trigger whenever Dan says "make a cut file", "generate the tap files", "cut this week's orders", "turn the cut list into machine files", "post this to gcode", "cut this DXF", "toolpath this", "nest these parts", "how many sheets do I need", "how much blue foam does this take", "what's the run time on this", "lay these out on a sheet", or names a part file and a bit size. ALWAYS fire after shopify-cut-list-by-color or aquamentor-order-dashboard produces a cut list and Dan wants the actual machine files. Also fire when a customer sends artwork (DXF/PDF) that must be checked for cuttable geometry before quoting. Reads geometry and writes cut files — never touches an order, an invoice or a machine, and never cuts foam for an unpaid order. Go do it, don't just explain.
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

## The fast path: a whole cut list at once

When the work started as a cut list (the usual case — `shopify-cut-list-by-color` or
`aquamentor-order-dashboard` produced it), do **not** run parts one at a time. One command takes the
list to machine files:

```bash
node "$REPO/cam-engine/cli.js" batch --in cutlist.csv --outdir "$REPO/CAD/out" --json
```

The cut list is the CSV those skills already produce — `color, shape, size, qty, order, status`. JSON
works too (`{"items":[{"part":…,"color":…,"qty":…}]}`, or a bare array). What `batch` does:

1. **Drops rows that must not be cut.** Any status matching unpaid / hold / pending / awaiting
   artwork / proof / cancelled is held back and reported. Foam is not cut for an unpaid order.
   `--include-hold` overrides, and only Dan decides that.
2. **Stops on a part it doesn't know.** A row naming a part with no catalog entry aborts the run, with
   the missing names listed. `--skip-unknown` cuts the rest and reports what it skipped — use it only
   when Dan has seen the list of skipped parts.
3. **Groups by color.** One color is one physical foam sheet, so colors never share a sheet. Parts of
   different colors are nested separately.
4. **Nests each color** onto `--sheet` (48x96 default) with real spacing, then **posts one `.tap` per
   sheet** plus the matching nested `.dxf` so the layout can be opened and checked.
5. **Cuts pre-nested parts as-is.** A catalog part marked `prenested` is already a laid-out sheet
   (`CAD/XRT-50.dxf` is 16 tubes on a 49 x 95.9 sheet) — it is posted directly, never re-nested, and
   a qty of 3 means "run this file 3 times", which the report says.

Report back per sheet: color, what's on it, run time, filename — plus total machine time, utilization,
and every held/skipped row. Those held rows are the ones Dan needs to act on.

## The catalog is the wiring

`parts.json` at the repo root is what makes a cut-list row into a cut file. Two halves:

- **`recipes`** — HOW to cut. An ordered list of ops posted into one `.tap` with tool changes.
- **`parts`** — WHICH file and which recipe, keyed by the SKU/shape name the cut list uses.

A part can instead be backed by an **existing machine file** (`"tap": "CAD/….tap"` and no recipe).
Nothing is regenerated: batch validates the file, reports its tools, depth and run time, and schedules
it. That is how the LGC 50 chair boards are catalogued, and it is the right shape for any part whose
`.tap` was made in VCarve and has already proven out on the machine. `tap` and `recipe` together are
rejected — a part is one or the other. Never replace a working `.tap` with a regenerated one unless Dan
asks: the existing file is the one that has actually run.

When a cut list names a part that isn't catalogued, that is the thing to fix — add the part rather
than working around it. Adding one needs: the DXF path, a recipe, and (if it's a pre-laid-out sheet)
`"prenested": true`. **Never invent a recipe's numbers.** Copy an existing recipe for the same
material, or read the parameters off a `.tap` that already ran, or ask. When a part already has a
working `.tap`, catalog it with `tap` rather than reverse-engineering a recipe for it.

**Parts with holes need two ops.** An outside profile cuts a hole a full tool-diameter oversized. Put
holes on their own DXF layer and give the recipe an inside op filtered to that layer, then the outside
profile excluding it — interior work first, the profile that frees the part last. The CLI warns when it
sees contours nested inside others and no inside op; if the containment is really parts inside a sheet
boundary (a jig), set `"allowNested": true` on the op so the warning stops for a recorded reason.

## Step 1 — ALWAYS inspect before cutting

For a one-off file (a customer's artwork, a new part), work it a step at a time. Never post a file you
haven't looked at — this is the step that catches the expensive mistakes.

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

## Step 2 — pick the cut parameters (single-file path)

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

If the part is already catalogued, `--recipe NAME` replaces all the cut flags and runs the whole
multi-op recipe into one file:

```bash
node "$REPO/cam-engine/cli.js" cut --in "CAD/XRT-50.dxf" --recipe foam-2in --out "CAD/XRT-50.tap"
```

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
- **Never cut a held row** without Dan explicitly saying so. Unpaid, awaiting artwork and awaiting
  proof all mean the part is not ready, and foam and machine time are not recoverable.
- **Never quietly skip a part the catalog doesn't know.** Report it and offer to add it.
- Use `--dry-run` freely to check numbers before writing anything.

## Chaining

- **shopify-cut-list-by-color** / **aquamentor-order-dashboard** produce the *what* — parts, colors,
  quantities, order numbers, status. Save that CSV and hand it straight to `batch`. Their cut list is
  already in the right shape; no reformatting needed.
- **aquamentor-inventory-sync** wants real foam demand: `batch --json --dry-run` returns `totalSheets`
  per color without writing anything, which beats an estimate.
- **aquamentor-order-dashboard**'s cut schedule wants machine minutes: `estimatedMinutes` per sheet and
  for the whole run comes back in the same report.
- **create-foam-product-proof** / **foam-proof-to-plate** handle the printed side; this handles the cut
  side of the same part.

## Full command reference

`node "$REPO/cam-engine/cli.js" help` prints every flag. Commands: `cut`, `nest`, `convert`, `info`,
`posts`. Every command takes `--json` for a machine-readable report and `--dry-run` to compute without
writing. Inputs: `.dxf`, `.svg`, vector `.pdf`, `.aqcam`. Posts: `shopsabre` (default, G2/G3 arcs),
`generic`.
