#!/usr/bin/env node
/* Headless CLI for the Aquamentor CAD/CAM engine.

   The studio (cadcam-studio.html) is the interactive front end; this is the same engine
   with a shell front door, so cut files can be produced from a script, a cron job, or a
   Claude skill without opening a browser. It calls exactly the functions studio_app.js
   calls — cadcore for geometry/import/export, camcore for toolpaths and posting — so a
   .tap built here is the .tap the studio would build from the same inputs.

   Commands: cut · nest · convert · info · posts · help      (run `node cli.js help`)
*/
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = require('./cadcore.js');
const CAM = require('./camcore.js');

// ---- browser-global parsers ------------------------------------------------
// dxfparse.js and pdfparse.js are concatenated into the studio bundle as plain scripts
// (no module.exports), so pull their entry points out of a vm context the way the tests do.
// Separate contexts per file: both declare top-level consts and would collide in one.
const _ctxCache = {};
function browserScript(file) {
  if (!_ctxCache[file]) {
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), ctx);
    _ctxCache[file] = ctx;
  }
  return _ctxCache[file];
}

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  const put = (k, v) => {
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) put(a.slice(2, eq), a.slice(eq + 1));
      else {
        const k = a.slice(2), nx = argv[i + 1];
        if (nx === undefined || nx.startsWith('--')) put(k, true);
        else { put(k, nx); i++; }
      }
    } else out._.push(a);
  }
  return out;
}
const list = v => v === undefined ? [] : (Array.isArray(v) ? v : [v]);
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const flag = v => v === true || v === 'true' || v === '1' || v === 'yes';
// throw rather than exit, so main()'s handler can render the failure as JSON under --json
function die(msg) { throw new Error(msg); }

// ---- import ----------------------------------------------------------------
// One file -> shapes, using the same code path the studio's importText/importPDF use.
function loadShapes(file, notes) {
  if (!fs.existsSync(file)) die('no such file: ' + file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.dxf') {
    const ctx = browserScript('dxfparse.js');
    const ents = ctx.parseDxf(fs.readFileSync(file, 'utf8'));
    const polys = []; for (const e of ents) for (const p of ctx.entityToPolys(e)) polys.push(p);
    return C.dxfPolysToShapes(polys);
  }
  if (ext === '.svg') return C.svgToShapes(fs.readFileSync(file, 'utf8'));
  if (ext === '.pdf') {
    const ctx = browserScript('pdfparse.js');
    const loops = ctx.parsePDFVectors(new Uint8Array(fs.readFileSync(file)));
    if (!loops || !loops.length) {
      die(loops && loops.hasLiveText
        ? file + ' has no cuttable paths — it is live text. Outline the fonts (Type -> Create Outlines) and re-export as vector PDF.'
        : file + ' has no vector paths — it may be raster/scanned. Re-export as a vector PDF.');
    }
    if (loops.hasLiveText && notes) notes.push(file + ': PDF also contains live text that was NOT imported — outline the fonts to cut it.');
    return loops.map(l => C.mkPoly(l.pts, l.closed, '0')).filter(s => s.pts.length >= 2);
  }
  if (ext === '.aqcam' || ext === '.json') return C.projectFromJSON(fs.readFileSync(file, 'utf8')).shapes;
  die('unsupported input: ' + file + ' (want .dxf .svg .pdf .aqcam)');
}

// "file.dxf" or "file.dxf:4" -> {file, qty}
function parseInSpec(spec) {
  const m = String(spec).match(/^(.*?):(\d+)$/);
  return m ? { file: m[1], qty: parseInt(m[2], 10) } : { file: String(spec), qty: 1 };
}

function applyLayerFilter(shapes, args, label) {
  const only = list(args.layer).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  const skip = list(args['exclude-layer']).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  let out = shapes;
  if (only.length) out = out.filter(s => only.includes(s.layer));
  if (skip.length) out = out.filter(s => !skip.includes(s.layer));
  if (!out.length && shapes.length) {
    die(`layer filter left nothing to ${label || 'cut'} — ${shapes.length} shape(s) on layer(s): ` +
      [...new Set(shapes.map(s => s.layer))].join(', '));
  }
  return out;
}

// ---- g-code -> segments, so the engine's own estimator can time the job -----
function gcodeSegs(g) {
  const segs = []; let x = 0, y = 0, z = 0, mode = null;
  for (const raw of g.split(/\r?\n/)) {
    const ln = raw.trim().toUpperCase();
    if (!ln || ln[0] === '(' || ln[0] === '%') continue;
    const m = ln.match(/^G(0|1|2|3)(?![0-9.])/);
    if (m) mode = 'G' + m[1];
    if (!mode) continue;
    const pv = c => { const r = ln.match(new RegExp(c + '(-?[\\d.]+)')); return r ? +r[1] : null; };
    const nx = pv('X'), ny = pv('Y'), nz = pv('Z'), ni = pv('I'), nj = pv('J');
    if (nx === null && ny === null && nz === null) continue;
    const x1 = nx === null ? x : nx, y1 = ny === null ? y : ny, z1 = nz === null ? z : nz;
    if (mode === 'G2' || mode === 'G3') {
      // estimateTime measures a segment by hypot(dx,dy) — an arc's chord would undercount it,
      // so emit a synthetic straight segment whose length is the true arc length r*theta.
      const cx = x + (ni || 0), cy = y + (nj || 0), r = Math.hypot(x - cx, y - cy);
      const a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
      let d = (mode === 'G2') ? (a0 - a1) : (a1 - a0);
      while (d < 0) d += 2 * Math.PI;
      if (d < 1e-9) d = 2 * Math.PI;                       // full circle
      segs.push({ x0: x, y0: y, z0: z, x1: x + r * d, y1: y, z1: z1, rapid: false });
    } else {
      segs.push({ x0: x, y0: y, z0: z, x1, y1, z1, rapid: mode === 'G0' });
    }
    x = x1; y = y1; z = z1;
  }
  return segs;
}
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${m.toFixed(1)} min`;
const fmtBox = b => b ? `${(b.maxX - b.minX).toFixed(3)}" x ${(b.maxY - b.minY).toFixed(3)}" at (${b.minX.toFixed(3)}, ${b.minY.toFixed(3)})` : 'empty';

// ---- cut -------------------------------------------------------------------
function camParams(args) {
  const op = String(args.op || 'profile').toLowerCase();
  if (!['profile', 'pocket', 'drill', 'vcarve'].includes(op)) die('--op must be profile|pocket|drill|vcarve');
  const toolNum = int(args.tool, 1);
  const finishDia = Math.abs(num(args['finish-dia'], 0));
  const clearDia = Math.abs(num(args['clear-dia'], 0));
  // second-tool numbers must differ from the primary, matching the studio's fallback
  const other = n => int(n, toolNum === 1 ? 2 : 1) === toolNum ? (toolNum === 1 ? 2 : 1) : int(n, toolNum === 1 ? 2 : 1);
  return {
    op, toolNum,
    toolDia: Math.abs(num(args.dia, 0.25)),
    side: String(args.side || 'outside').toLowerCase(),
    climb: String(args.dir || 'climb').toLowerCase() !== 'conventional',
    cutDepth: Math.abs(num(args.depth, 0.25)),
    passDepth: Math.abs(num(args.pass, 0.125)),
    topZ: num(args.topz, 0),
    safeZ: Math.abs(num(args.safez, 0.25)),
    clearZ: Math.abs(num(args.clearz, 0.25)),
    feed: num(args.feed, 120),
    plunge: num(args.plunge, 40),
    rpm: num(args.rpm, 18000),
    stepover: Math.min(Math.max(num(args.stepover, 40) / 100, 0.05), 0.9),
    pocketStyle: String(args['pocket-style'] || 'offset').toLowerCase(),
    rampEntry: flag(args['helix-entry']),
    finishDia, finishNum: other(args['finish-tool']),
    peck: Math.abs(num(args.peck, 0)),
    bitAngle: num(args.vangle, 90),
    vstep: Math.abs(num(args.vstep, 0.02)),
    flatDepth: Math.abs(num(args.vflat, 0)),
    clearDia, clearNum: other(args['clear-tool']),
    leadType: String(args.lead || 'none').toLowerCase(),
    leadLen: Math.abs(num(args['lead-len'], 0.25)),
    rampLen: Math.abs(num(args['ramp-len'], 0)),
    tabs: { count: int(args.tabs, 0), length: num(args['tab-len'], 0.4), height: num(args['tab-height'], 0.1) },
  };
}
// Same dispatch + clearZ stamping as studio_app.js buildOpRes().
function buildOpRes(p, contours) {
  const res = (p.op === 'pocket') ? CAM.pocketOp(contours, p)
    : (p.op === 'drill') ? CAM.drillOp(contours, p)
      : (p.op === 'vcarve') ? CAM.vcarveOp(contours, Object.assign({}, p, { maxDepth: p.cutDepth, step: p.vstep }))
        : CAM.profileOp(contours, p);
  for (const op of res.ops) op.clearZ = p.clearZ;   // vcarve with a flat depth returns 2 ops (endmill + V-bit)
  return res;
}

function cmdCut(args) {
  const ins = list(args.in).concat(args._.slice(1));
  if (!ins.length) die('cut needs --in <file.dxf|svg|pdf|aqcam>');
  const notes = [];
  let shapes = [];
  for (const spec of ins) {
    const { file, qty } = parseInSpec(spec);
    // :N is a nesting quantity. Repeating a part here would stack identical toolpaths on the same
    // coordinates and cut it N times in place — nest first, then cut the nested sheet.
    if (qty > 1) die(`"${spec}": :N is a nest quantity, not a cut quantity — it would cut the same part ${qty}x in place. Run "nest --in ${file}:${qty} --out nested.dxf" first, then cut nested.dxf.`);
    shapes = shapes.concat(loadShapes(file, notes));
  }
  shapes = applyLayerFilter(shapes, args, 'cut');
  if (!shapes.length) die('nothing to cut — no shapes imported');

  const p = camParams(args);
  const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
  const closedN = contours.filter(c => c.closed).length;
  if (!contours.length) die('no contours assembled from ' + shapes.length + ' shape(s)');
  if (p.op !== 'profile' && !closedN) die(`--op ${p.op} needs closed contour(s); all ${contours.length} contour(s) are open`);

  const res = buildOpRes(p, contours);
  const postName = String(args.post || 'shopsabre').toLowerCase();
  if (!CAM.POSTS[postName]) die('unknown post "' + postName + '" — have: ' + Object.keys(CAM.POSTS).join(', '));
  const post = Object.assign({}, CAM.POSTS[postName]);
  post.arcs = (p.op !== 'drill') && !flag(args['no-arcs']);

  const label = p.op === 'profile' ? p.side.toUpperCase() : p.op.toUpperCase();
  const jobName = String(args.name || path.basename(parseInSpec(ins[0]).file, path.extname(parseInSpec(ins[0]).file)));
  const g = CAM.postProcess({ name: jobName + ' - ' + label, units: 'inch', ops: res.ops }, post);

  const passes = res.ops.reduce((n, op) => n + op.passes.length, 0);
  if (!passes) die('toolpath is empty — no passes generated' + (res.warnings.length ? ' (' + res.warnings.join('; ') + ')' : ''));
  const est = CAM.estimateTime(gcodeSegs(g), { feed: p.feed, plunge: p.plunge, rapid: 300 });
  const bb = C.bboxAll(shapes);
  const out = args.out ? String(args.out)
    : path.join(path.dirname(parseInSpec(ins[0]).file), jobName + '.tap');

  if (!flag(args['dry-run'])) fs.writeFileSync(out, g);

  const report = {
    ok: true, command: 'cut', op: p.op, out: flag(args['dry-run']) ? null : out,
    shapes: shapes.length, contours: contours.length, closedContours: closedN,
    ops: res.ops.length, passes, lines: g.split(/\r?\n/).length,
    arcs: (g.match(/^G[23] /gm) || []).length,
    tool: { num: p.toolNum, dia: p.toolDia }, post: postName,
    cutDepth: p.cutDepth, passDepth: p.passDepth,
    bbox: bb && { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY },
    estimatedMinutes: +est.minutes.toFixed(2),
    warnings: res.warnings.concat(notes),
  };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`${p.op} (${p.op === 'profile' ? p.side : p.toolDia + '" tool'}) -> ${report.out || '(dry run)'}`);
  console.log(`  ${shapes.length} shape(s) -> ${contours.length} contour(s) (${closedN} closed)`);
  console.log(`  ${passes} pass(es), ${report.lines} lines, ${report.arcs} arc move(s), post: ${postName}`);
  console.log(`  extents ${fmtBox(bb)} · depth ${p.cutDepth}" in ${p.passDepth}" passes`);
  console.log(`  est. run time ${fmtMin(est.minutes)} at F${p.feed}`);
  for (const w of report.warnings) console.log('  ! ' + w);
}

// ---- nest ------------------------------------------------------------------
// Each input file is ONE part: its shapes (outline + holes) move together, so a part
// never gets scattered across the sheet the way per-shape nesting would scatter it.
function placeGroup(shapes, pl, spread) {
  let g = shapes.map(C.clone);
  if (pl.rot) g = g.map(s => C.rotate(s, 0, 0, Math.PI / 2));
  const b = C.bboxAll(g);
  const ox = spread ? pl.sheet * ((spread.sheetW || 0) + (spread.gap || 0)) : 0;
  return g.map(s => C.translate(s, pl.x - b.minX + ox, pl.y - b.minY));
}

function cmdNest(args) {
  const ins = list(args.in).concat(args._.slice(1));
  if (!ins.length) die('nest needs --in <file.dxf>[:qty] (repeatable)');
  const notes = [];
  const groups = [];    // [{name, shapes}]
  for (const spec of ins) {
    const { file, qty } = parseInSpec(spec);
    const base = applyLayerFilter(loadShapes(file, notes), args, 'nest');
    const nm = path.basename(file);
    for (let i = 0; i < qty; i++) groups.push({ name: qty > 1 ? `${nm} #${i + 1}` : nm, shapes: base.map(C.clone) });
  }
  if (!groups.length) die('nothing to nest');

  const sheet = String(args.sheet || '48x96').toLowerCase().split(/[x*]/);
  const sheetW = Math.abs(num(sheet[0], 48)), sheetH = Math.abs(num(sheet[1], 96));
  const margin = Math.abs(num(args.margin, 0)), spacing = Math.abs(num(args.spacing, 0.25));
  const allowRotate = !flag(args['no-rotate']);

  // nest bbox proxies (nestShapes measures by bbox), then move each real group into place
  const proxies = groups.map(gr => {
    const b = C.bboxAll(gr.shapes);
    return C.mkPoly([{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], true, '0');
  });
  const r = C.nestShapes(proxies, { sheetW, sheetH, margin, spacing, allowRotate });
  if (!r.placements.length) die(`every part is too large for a ${sheetW}" x ${sheetH}" sheet — check --sheet`);

  const spread = { sheetW, gap: 2 };
  const bySheet = new Map();
  for (const pl of r.placements) {
    const placed = placeGroup(groups[pl.idx].shapes, pl, flag(args['per-sheet']) ? null : spread);
    if (!bySheet.has(pl.sheet)) bySheet.set(pl.sheet, []);
    bySheet.get(pl.sheet).push(...placed);
  }

  const outArg = String(args.out || 'nested.dxf');
  const ext = path.extname(outArg).toLowerCase() || '.dxf';
  const stem = path.join(path.dirname(outArg), path.basename(outArg, path.extname(outArg)));
  const render = sh => ext === '.svg' ? C.toSVG(sh) : C.toDXF(sh);
  const written = [];
  if (!flag(args['dry-run'])) {
    if (flag(args['per-sheet'])) {
      for (const [n, sh] of [...bySheet.entries()].sort((a, b) => a[0] - b[0])) {
        const f = `${stem}-sheet${n + 1}${ext}`; fs.writeFileSync(f, render(sh)); written.push(f);
      }
    } else {
      const all = [...bySheet.entries()].sort((a, b) => a[0] - b[0]).flatMap(e => e[1]);
      fs.writeFileSync(stem + ext, render(all)); written.push(stem + ext);
    }
  }

  const report = {
    ok: true, command: 'nest', out: written,
    parts: groups.length, placed: r.placements.length,
    unplaced: r.unplaced.map(i => groups[i].name),
    sheets: r.sheets, sheetW, sheetH, spacing, margin, rotateAllowed: allowRotate,
    utilization: +(r.utilization * 100).toFixed(1),
    placements: r.placements.map(pl => ({ part: groups[pl.idx].name, sheet: pl.sheet + 1, x: +pl.x.toFixed(3), y: +pl.y.toFixed(3), w: +pl.w.toFixed(3), h: +pl.h.toFixed(3), rotated: !!pl.rot })),
    warnings: notes,
  };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`nested ${r.placements.length}/${groups.length} part(s) onto ${r.sheets} sheet(s) of ${sheetW}" x ${sheetH}"`);
  console.log(`  utilization ${report.utilization}% · spacing ${spacing}" · margin ${margin}" · rotate ${allowRotate ? 'on' : 'off'}`);
  for (const pl of report.placements) console.log(`  sheet ${pl.sheet}: ${pl.part} at (${pl.x}, ${pl.y}) ${pl.w}x${pl.h}${pl.rotated ? ' rotated' : ''}`);
  if (report.unplaced.length) console.log(`  ! too large for the sheet: ${report.unplaced.join(', ')}`);
  for (const f of written) console.log(`  wrote ${f}`);
  for (const w of notes) console.log('  ! ' + w);
}

// ---- convert / info --------------------------------------------------------
function cmdConvert(args) {
  const ins = list(args.in).concat(args._.slice(1));
  if (!ins.length || !args.out) die('convert needs --in <file> and --out <file.dxf|.svg>');
  const notes = [];
  let shapes = [];
  for (const spec of ins) { const { file } = parseInSpec(spec); shapes = shapes.concat(loadShapes(file, notes)); }
  shapes = applyLayerFilter(shapes, args, 'convert');
  const out = String(args.out), ext = path.extname(out).toLowerCase();
  if (ext !== '.dxf' && ext !== '.svg') die('--out must end in .dxf or .svg');
  const text = ext === '.svg' ? C.toSVG(shapes) : C.toDXF(shapes);
  if (!flag(args['dry-run'])) fs.writeFileSync(out, text);
  const report = { ok: true, command: 'convert', out, shapes: shapes.length, warnings: notes };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`converted ${shapes.length} shape(s) -> ${out}`);
  for (const w of notes) console.log('  ! ' + w);
}

function cmdInfo(args) {
  const ins = list(args.in).concat(args._.slice(1));
  if (!ins.length) die('info needs --in <file>');
  const notes = [];
  const files = ins.map(spec => {
    const { file } = parseInSpec(spec);
    const shapes = loadShapes(file, notes);
    const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
    const b = C.bboxAll(shapes);
    const layers = {};
    for (const s of shapes) layers[s.layer] = (layers[s.layer] || 0) + 1;
    return {
      file, shapes: shapes.length, closedShapes: shapes.filter(s => s.closed).length,
      points: shapes.reduce((n, s) => n + (s.pts ? s.pts.length : 0), 0),
      contours: contours.length, closedContours: contours.filter(c => c.closed).length,
      layers,
      bbox: b && { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, w: b.maxX - b.minX, h: b.maxY - b.minY },
    };
  });
  const report = { ok: true, command: 'info', files, warnings: notes };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  for (const f of files) {
    console.log(f.file);
    console.log(`  ${f.shapes} shape(s), ${f.closedShapes} closed, ${f.points} points`);
    console.log(`  ${f.contours} contour(s) after joining, ${f.closedContours} closed`);
    console.log(`  layers: ${Object.entries(f.layers).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`);
    console.log(`  extents ${fmtBox(f.bbox)}`);
  }
  for (const w of notes) console.log('  ! ' + w);
}

function cmdPosts(args) {
  const posts = Object.entries(CAM.POSTS).map(([k, p]) => ({ key: k, name: p.name, arcs: !!p.arcs, decimals: p.decimals, safeZ: p.safeZ }));
  if (flag(args.json)) { console.log(JSON.stringify({ ok: true, command: 'posts', posts }, null, 2)); return; }
  for (const p of posts) console.log(`${p.key.padEnd(12)} ${p.name}${p.arcs ? ' (G2/G3 arcs)' : ''}`);
}

const HELP = `Aquamentor CAD/CAM — headless CLI (same engine as cadcam-studio.html)

  node cli.js cut     --in <file> [--out job.tap] [options]     DXF/SVG/PDF -> toolpath -> .tap
  node cli.js nest    --in <file>[:qty] ... [--out nested.dxf]  pack parts onto sheets
  node cli.js convert --in <file> --out <file.dxf|.svg>         format conversion
  node cli.js info    --in <file>                               inspect geometry before cutting
  node cli.js posts                                             list post processors

Input: .dxf .svg .pdf (vector) .aqcam — repeat --in to combine files.
Quantity: append :N to a nest input to place N copies (nest only; cut would stack them in place).

cut options
  --op profile|pocket|drill|vcarve   (default profile)
  --side outside|inside|on           profile only (default outside)
  --dir climb|conventional           (default climb)
  --tool N --dia IN                  tool number and diameter (default 1, 0.25)
  --depth IN --pass IN               total cut depth / depth per pass (default 0.25, 0.125)
  --topz Z --safez Z --clearz Z      material top / safe Z / clearance Z (default 0, 0.25, 0.25)
  --feed F --plunge F --rpm N        (default 120, 40, 18000)
  --tabs N --tab-len IN --tab-height IN            holding tabs (default 0, 0.4, 0.1)
  --lead none|arc|line --lead-len IN --ramp-len IN lead-in/out
  --stepover PCT --pocket-style offset|raster      pocket only (default 40, offset)
  --helix-entry --finish-dia IN --finish-tool N    pocket only
  --peck IN                          drill only
  --vangle DEG --vstep IN --vflat IN --clear-dia IN --clear-tool N   vcarve only
  --post shopsabre|generic --no-arcs --name NAME

nest options
  --sheet WxH        sheet size in inches (default 48x96)
  --margin IN        keep-out border (default 0)
  --spacing IN       gap between parts (default 0.25)
  --no-rotate        never rotate a part 90 degrees
  --per-sheet        write one file per sheet instead of sheets spread side by side

common
  --layer A,B  --exclude-layer C     filter imported geometry by layer
  --json                             machine-readable report on stdout
  --dry-run                          compute and report, write nothing

examples
  node cli.js info --in "CAD/XRT-50.dxf"
  node cli.js cut --in "CAD/XRT-50.dxf" --dia 0.25 --depth 0.55 --pass 0.25 --tabs 4 --out XRT-50.tap
  node cli.js nest --in "part-a.dxf:12" --in "part-b.dxf:4" --sheet 48x96 --spacing 0.5 --out nested.dxf
`;

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = (args._[0] || (flag(args.help) ? 'help' : '')).toLowerCase();
  try {
    switch (cmd) {
      case 'cut': return cmdCut(args);
      case 'nest': return cmdNest(args);
      case 'convert': return cmdConvert(args);
      case 'info': return cmdInfo(args);
      case 'posts': return cmdPosts(args);
      case 'help': case '': return console.log(HELP);
      default: die('unknown command "' + cmd + '" — try: node cli.js help');
    }
  } catch (e) {
    if (flag(args.json)) console.log(JSON.stringify({ ok: false, command: cmd, error: e.message }, null, 2));
    else console.error('error: ' + e.message);
    process.exit(1);
  }
}
main();
