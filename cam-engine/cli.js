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

// Layer filter for a recipe op spec — returns [] rather than failing, so an "optional" op
// (a hole pass on a part that has no holes) can be skipped instead of aborting the job.
function filterShapes(shapes, spec) {
  const split = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const only = split(spec.layer), skip = split(spec['exclude-layer'] || spec.excludeLayer);
  let out = shapes;
  if (only.length) out = out.filter(s => only.includes(s.layer));
  if (skip.length) out = out.filter(s => !skip.includes(s.layer));
  return out;
}

// Count closed contours sitting inside another closed contour. A hole cut with an OUTSIDE profile
// comes out a full tool-diameter oversized, and nothing in the g-code reveals it afterwards — so
// flag the geometry rather than quietly cutting it wrong.
function nestedCount(contours) {
  const closed = contours.filter(c => c.closed && c.pts && c.pts.length >= 3);
  let n = 0;
  for (const c of closed) if (closed.some(d => d !== c && C.pointInPoly(c.pts[0], d.pts))) n++;
  return n;
}

// Summarize an existing machine file: tools used, cut depths, run time.
function tapSummary(g) {
  const lines = g.replace(/\r/g, '').split('\n');
  const tools = [], depths = new Set();
  for (const ln of lines) {
    const t = ln.match(/^T(\d+)\s*$/); if (t) { const n = +t[1]; if (tools[tools.length - 1] !== n) tools.push(n); }
    const z = ln.match(/Z(-[\d.]+)/); if (z) depths.add(+(+z[1]).toFixed(4));
  }
  return { tools, maxDepth: depths.size ? Math.min(...depths) : 0, minutes: estimateMinutes(g), lines: lines.length };
}

// ---- parametric parts ------------------------------------------------------
// A part can be described rather than drawn. The cut list's size column drives the dimensions, so
// one catalog entry covers every size of a shape and no dxf is needed per variant.
const OUTLINE_LAYER = 'OUTLINE', HOLES_LAYER = 'HOLES';

// '20x10' · '24 x 18' · '20" x 10"' · '18in' · '48' -> {w,h}
function parseSize(text) {
  if (text === undefined || text === null || text === '') return null;
  const t = String(text).toLowerCase()
    .replace(/["\u201d\u2019']/g, ' ')
    .replace(/(\d)\s*(?:inches|inch|in)\b/g, '$1 ')
    .replace(/\s+/g, ' ').trim();
  const two = t.match(/^(\d*\.?\d+)\s*[x\u00d7*]\s*(\d*\.?\d+)/);
  if (two) return { w: +two[1], h: +two[2] };
  const one = t.match(/^(\d*\.?\d+)$/);
  if (one) return { w: +one[1], h: +one[1], single: true };
  return null;
}

function buildHoles(spec, w, h, key) {
  const out = [];
  for (const hl of (spec.holes || [])) {
    const kind = String(hl.kind || 'circle').toLowerCase();
    if (kind === 'grid') {
      const rows = int(hl.rows, 1), cols = int(hl.cols, 1), d = Math.abs(num(hl.d, 1));
      const mx = Math.abs(num(hl.marginX, num(hl.margin, d))), my = Math.abs(num(hl.marginY, num(hl.margin, d)));
      if (rows < 1 || cols < 1) die(`part "${key}": hole grid needs rows and cols >= 1`);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = cols === 1 ? w / 2 : mx + (w - 2 * mx) * c / (cols - 1);
        const y = rows === 1 ? h / 2 : my + (h - 2 * my) * r / (rows - 1);
        out.push(C.mkCircle({ x, y }, d / 2, HOLES_LAYER));
      }
    } else if (kind === 'circle') {
      out.push(C.mkCircle({ x: num(hl.x, w / 2), y: num(hl.y, h / 2) }, Math.abs(num(hl.d, 1)) / 2, HOLES_LAYER));
    } else if (kind === 'rect') {
      const hw = Math.abs(num(hl.w, 1)), hh = Math.abs(num(hl.h, 1));
      out.push(C.mkRect(num(hl.x, w / 2) - hw / 2, num(hl.y, h / 2) - hh / 2, hw, hh, HOLES_LAYER));
    } else die(`part "${key}": unknown hole kind "${kind}" — use circle, rect or grid`);
  }
  return out;
}

// Build a part's geometry from its description. Outline lands on OUTLINE, holes on HOLES, so the
// same two-op recipe pattern (inside for the holes, outside for the profile) applies unchanged.
function buildShape(spec, sizeText, key) {
  const kind = String(spec.kind || 'rect').toLowerCase();
  const size = parseSize(sizeText);
  const w = Math.abs(size ? size.w : num(spec.w, 0));
  const h = Math.abs(size ? (size.single ? (spec.h !== undefined && spec.w === undefined ? size.w : size.h) : size.h) : num(spec.h, 0));
  if (!(w > 0) || !(h > 0)) {
    die(`part "${key}": no size — the cut list row has no usable size and the catalog entry has no w/h. ` +
      `Add a size like "20x10" to the row, or w/h to the catalog entry.`);
  }
  let outline;
  switch (kind) {
    case 'rect': outline = C.mkRect(0, 0, w, h, OUTLINE_LAYER); break;
    case 'roundrect': {
      const r = Math.min(Math.abs(num(spec.r, Math.min(w, h) * 0.15)), Math.min(w, h) / 2);
      outline = C.mkRoundRect(0, 0, w, h, r, OUTLINE_LAYER); break;
    }
    case 'capsule': case 'stadium':
      outline = C.mkRoundRect(0, 0, w, h, Math.min(w, h) / 2, OUTLINE_LAYER); break;
    case 'circle': {
      const d = Math.abs(num(spec.d, Math.min(w, h)));
      outline = C.mkCircle({ x: d / 2, y: d / 2 }, d / 2, OUTLINE_LAYER); break;
    }
    case 'ellipse': outline = C.mkEllipse({ x: w / 2, y: h / 2 }, w / 2, h / 2, 0, OUTLINE_LAYER); break;
    case 'polygon': {
      const n = int(spec.sides, 6);
      if (n < 3) die(`part "${key}": a polygon needs at least 3 sides`);
      outline = C.fitShapeTo(C.mkPolygon({ x: 0, y: 0 }, 1, n, undefined, OUTLINE_LAYER), 0, 0, w, h); break;
    }
    case 'star': {
      const n = int(spec.points, 5), inner = Math.min(Math.max(num(spec.innerRatio, 0.5), 0.05), 0.95);
      if (n < 3) die(`part "${key}": a star needs at least 3 points`);
      outline = C.fitShapeTo(C.mkStar({ x: 0, y: 0 }, 1, inner, n, undefined, OUTLINE_LAYER), 0, 0, w, h); break;
    }
    default:
      die(`part "${key}": unknown shape kind "${kind}" — use rect, roundrect, capsule, circle, ellipse, polygon or star`);
  }
  // normalize so the part sits at the origin, whatever the generator centred on
  const b = C.bbox(outline);
  const shapes = [C.translate(outline, -b.minX, -b.minY)];
  const ob = C.bbox(shapes[0]);
  const holes = buildHoles(spec, ob.maxX - ob.minX, ob.maxY - ob.minY, key);
  for (const hole of holes) {
    const hb = C.bbox(hole);
    if (hb.minX < ob.minX - 1e-9 || hb.minY < ob.minY - 1e-9 || hb.maxX > ob.maxX + 1e-9 || hb.maxY > ob.maxY + 1e-9) {
      die(`part "${key}": a hole falls outside the ${(ob.maxX - ob.minX).toFixed(2)}x${(ob.maxY - ob.minY).toFixed(2)} outline — check its position or the grid margin`);
    }
    shapes.push(hole);
  }
  return shapes;
}

// ---- catalog: part files + their cut recipes -------------------------------
function catalogPath(args) {
  return path.resolve(args.catalog ? String(args.catalog) : path.join(__dirname, '..', 'parts.json'));
}
function loadCatalog(args) {
  const p = catalogPath(args);
  if (!fs.existsSync(p)) die(`no parts catalog at ${p} — create one or pass --catalog <file>`);
  let cat; try { cat = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`parts catalog ${p} is not valid JSON: ${e.message}`); }
  cat.__dir = path.dirname(p); cat.__path = p;
  cat.parts = cat.parts || {}; cat.recipes = cat.recipes || {}; cat.defaults = cat.defaults || {};
  return cat;
}
const catFile = (cat, f) => path.resolve(cat.__dir, f);
function getRecipe(cat, name, forPart) {
  const r = cat.recipes[name];
  if (!r) die(`part "${forPart}" uses recipe "${name}", which is not in ${cat.__path} (have: ${Object.keys(cat.recipes).join(', ') || 'none'})`);
  if (!Array.isArray(r.ops) || !r.ops.length) die(`recipe "${name}" has no ops`);
  return r;
}

// Build the posted op list for one recipe against a set of shapes. Ops run in catalog order;
// interior work belongs before the outside profile that frees the part.
function opsFromRecipe(cat, recipeName, shapes, notes, label) {
  const recipe = getRecipe(cat, recipeName, label);
  const ops = [], warnings = [];
  recipe.ops.forEach((spec, i) => {
    const sh = filterShapes(shapes, spec);
    const where = `recipe "${recipeName}" op ${i + 1} (${spec.op || 'profile'}${spec.layer ? ' on layer ' + spec.layer : ''})`;
    if (!sh.length) {
      if (spec.optional) { notes.push(`${label}: ${where} skipped — no matching geometry`); return; }
      die(`${where}: no geometry matches — mark the op "optional": true if that is expected`);
    }
    const p = camParams(spec);
    const contours = CAM.assembleContours(C.shapesToContoursInput(sh));
    if (!contours.length) die(`${where}: no contours assembled`);
    if (p.op !== 'profile' && !contours.some(c => c.closed)) die(`${where}: --op ${p.op} needs closed contour(s)`);
    // Containment alone cannot distinguish a hole in a part from a part inside a sheet boundary
    // (a jig), so flag it and let the catalog record the answer once via "allowNested": true.
    if (p.op === 'profile' && p.side === 'outside' && !spec.allowNested) {
      const holes = nestedCount(contours);
      if (holes) warnings.push(`${where}: ${holes} contour(s) sit inside another. If they are holes, this outside profile cuts them ${p.toolDia}" oversized — give them their own inside op filtered by layer. If they are parts inside a sheet boundary, set "allowNested": true on the op.`);
    }
    const res = buildOpRes(p, contours);
    ops.push(...res.ops);
    for (const w of res.warnings) warnings.push(`${where}: ${w}`);
  });
  // a profile that frees the part should be the last thing the recipe does
  const outs = recipe.ops.map((sp, i) => ({ sp, i })).filter(x => (x.sp.op || 'profile') === 'profile' && (x.sp.side || 'outside') === 'outside');
  const last = outs[outs.length - 1];
  if (last && last.i !== recipe.ops.length - 1) {
    warnings.push(`recipe "${recipeName}": an outside profile runs at op ${last.i + 1} of ${recipe.ops.length} — the part is cut free before the later op(s) run`);
  }
  if (!ops.length) die(`recipe "${recipeName}" produced no toolpath for ${label}`);
  return { ops, warnings };
}

// Consecutive ops that use the same tool at the same speeds don't need a tool change between
// them — the post emits a full spindle stop, T-word, restart and dwell per op — so fold them
// into one op. Order is preserved; only adjacent, identical-setup ops merge.
function mergeOps(ops) {
  const key = o => [o.kind, o.toolNum, o.rpm, o.feed, o.plunge, o.safeZ, o.topZ, o.clearZ].join('|');
  const out = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    if (prev && key(prev) === key(op)) prev.passes = prev.passes.concat(op.passes);
    else out.push(Object.assign({}, op, { passes: op.passes.slice() }));
  }
  return out;
}

// ---- g-code -> segments, so the engine's own estimator can time the job -----
function gcodeSegs(g) {
  const segs = []; let x = 0, y = 0, z = 0, mode = null, feed = 0;
  for (const raw of g.split(/\r?\n/)) {
    const ln = raw.trim().toUpperCase();
    if (!ln || ln[0] === '(' || ln[0] === '%') continue;
    const m = ln.match(/^G(0|1|2|3)(?![0-9.])/);
    if (m) mode = 'G' + m[1];
    if (!mode) continue;
    const pv = c => { const r = ln.match(new RegExp(c + '(-?[\\d.]+)')); return r ? +r[1] : null; };
    const nf = pv('F'); if (nf !== null && nf > 0) feed = nf;
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
      segs.push({ x0: x, y0: y, z0: z, x1: x + r * d, y1: y, z1: z1, rapid: false, feed });
    } else {
      segs.push({ x0: x, y0: y, z0: z, x1, y1, z1, rapid: mode === 'G0', feed });
    }
    x = x1; y = y1; z = z1;
  }
  return segs;
}
// Every move is timed at the feed the g-code commands for it, so a job whose ops run at different
// feeds (or whose plunges are slower than its cuts) is not timed at one blanket rate.
function estimateMinutes(g, fallbackFeed) {
  const segs = gcodeSegs(g);
  const buckets = new Map();
  for (const s of segs) {
    const k = s.rapid ? 'rapid' : String(s.feed || fallbackFeed || 120);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s);
  }
  let min = 0;
  for (const [k, group] of buckets) {
    const f = k === 'rapid' ? 120 : +k;
    min += CAM.estimateTime(group, { feed: f, plunge: f, rapid: 300 }).minutes;
  }
  return min;
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
  const described = args.shape !== undefined && args.shape !== true;
  if (!ins.length && !described) die('cut needs --in <file.dxf|svg|pdf|aqcam>, or --shape <kind> --size WxH');
  const notes = [];
  let shapes = [];
  if (described) {
    const spec = { kind: String(args.shape) };
    for (const k of ['r', 'd', 'sides', 'points', 'innerRatio']) if (args[k] !== undefined) spec[k] = num(args[k], undefined);
    if (args.holes !== undefined) {
      // --holes 3x2@4 -> a 3-across, 2-down grid of 4in circles
      const m = String(args.holes).match(/^(\d+)\s*[x\u00d7]\s*(\d+)\s*@\s*(\d*\.?\d+)$/);
      if (!m) die('--holes wants COLSxROWS@DIA, e.g. --holes 3x2@4');
      spec.holes = [{ kind: 'grid', cols: +m[1], rows: +m[2], d: +m[3], margin: num(args['hole-margin'], +m[3]) }];
    }
    shapes = buildShape(spec, args.size, String(args.shape));
  }
  for (const spec of ins) {
    const { file, qty } = parseInSpec(spec);
    // :N is a nesting quantity. Repeating a part here would stack identical toolpaths on the same
    // coordinates and cut it N times in place — nest first, then cut the nested sheet.
    if (qty > 1) die(`"${spec}": :N is a nest quantity, not a cut quantity — it would cut the same part ${qty}x in place. Run "nest --in ${file}:${qty} --out nested.dxf" first, then cut nested.dxf.`);
    shapes = shapes.concat(loadShapes(file, notes));
  }
  shapes = applyLayerFilter(shapes, args, 'cut');
  if (!shapes.length) die('nothing to cut — no shapes imported');

  const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
  const closedN = contours.filter(c => c.closed).length;
  if (!contours.length) die('no contours assembled from ' + shapes.length + ' shape(s)');

  // --recipe runs a named multi-op recipe from the parts catalog into one file (with tool
  // changes); otherwise the flags describe a single op.
  const useRecipe = args.recipe !== undefined && args.recipe !== true;
  let res, p;
  if (useRecipe) {
    const cat = loadCatalog(args);
    p = camParams({});
    res = opsFromRecipe(cat, String(args.recipe), shapes, notes, ins.length ? path.basename(parseInSpec(ins[0]).file) : String(args.shape));
  } else {
    p = camParams(args);
    if (p.op !== 'profile' && !closedN) die(`--op ${p.op} needs closed contour(s); all ${contours.length} contour(s) are open`);
    res = buildOpRes(p, contours);
  }
  const postName = String(args.post || 'shopsabre').toLowerCase();
  if (!CAM.POSTS[postName]) die('unknown post "' + postName + '" — have: ' + Object.keys(CAM.POSTS).join(', '));
  const post = Object.assign({}, CAM.POSTS[postName]);
  post.arcs = (useRecipe || p.op !== 'drill') && !flag(args['no-arcs']);

  const label = useRecipe ? String(args.recipe).toUpperCase() : (p.op === 'profile' ? p.side.toUpperCase() : p.op.toUpperCase());
  const jobName = String(args.name || (ins.length
    ? path.basename(parseInSpec(ins[0]).file, path.extname(parseInSpec(ins[0]).file))
    : `${args.shape}${args.size ? '-' + String(args.size).replace(/\s+/g, '') : ''}`));
  const g = CAM.postProcess({ name: jobName + ' - ' + label, units: 'inch', ops: mergeOps(res.ops) }, post);

  const passes = res.ops.reduce((n, op) => n + op.passes.length, 0);
  if (!passes) die('toolpath is empty — no passes generated' + (res.warnings.length ? ' (' + res.warnings.join('; ') + ')' : ''));
  const estMinutes = estimateMinutes(g, p.feed);
  const bb = C.bboxAll(shapes);
  const out = args.out ? String(args.out)
    : path.join(ins.length ? path.dirname(parseInSpec(ins[0]).file) : '.', jobName + '.tap');

  if (!flag(args['dry-run'])) fs.writeFileSync(out, g);

  const report = {
    ok: true, command: 'cut', op: useRecipe ? `recipe:${args.recipe}` : p.op, out: flag(args['dry-run']) ? null : out,
    shapes: shapes.length, contours: contours.length, closedContours: closedN,
    ops: res.ops.length, passes, lines: g.split(/\r?\n/).length,
    arcs: (g.match(/^G[23] /gm) || []).length,
    tool: { num: p.toolNum, dia: p.toolDia }, post: postName,
    cutDepth: p.cutDepth, passDepth: p.passDepth,
    bbox: bb && { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY },
    estimatedMinutes: +estMinutes.toFixed(2),
    warnings: res.warnings.concat(notes),
  };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`${useRecipe ? 'recipe ' + args.recipe : p.op + ' (' + (p.op === 'profile' ? p.side : p.toolDia + '" tool') + ')'} -> ${report.out || '(dry run)'}`);
  console.log(`  ${shapes.length} shape(s) -> ${contours.length} contour(s) (${closedN} closed)`);
  console.log(`  ${passes} pass(es), ${report.lines} lines, ${report.arcs} arc move(s), post: ${postName}`);
  console.log(`  extents ${fmtBox(bb)}${useRecipe ? '' : ` · depth ${p.cutDepth}" in ${p.passDepth}" passes`}`);
  console.log(`  est. run time ${fmtMin(estMinutes)}`);
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

// ---- cut list -> nested sheets -> machine files -----------------------------
// Accepts the CSV the by-color cut list produces, or the equivalent JSON.
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {}; head.forEach((h, i) => { o[h] = (r[i] === undefined ? '' : r[i]).trim(); }); return o;
  });
}
// A row is on hold unless it is clearly ready to cut — never burn foam for an unpaid order.
const HOLD = /hold|unpaid|pending|await|artwork|proof|cancel|refund/i;

function loadCutList(file) {
  if (!fs.existsSync(file)) die('no such cut list: ' + file);
  const ext = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, 'utf8');
  let meta = {}, rows;
  if (ext === '.csv') rows = parseCSV(text);
  else {
    let o; try { o = JSON.parse(text); } catch (e) { die(`cut list ${file} is not valid JSON: ${e.message}`); }
    if (Array.isArray(o)) rows = o;
    else { rows = o.items || o.parts || o.rows || []; meta = o; }
    if (!Array.isArray(rows)) die(`cut list ${file}: expected an array of items`);
  }
  if (!rows.length) die(`cut list ${file} has no rows`);
  const items = rows.map((r, i) => {
    const pick = (...keys) => { for (const k of keys) if (r[k] !== undefined && String(r[k]).trim() !== '') return String(r[k]).trim(); return ''; };
    const qtyRaw = pick('qty', 'quantity', 'count');
    const qty = qtyRaw === '' ? 1 : parseInt(qtyRaw, 10);
    if (!Number.isFinite(qty) || qty < 1) die(`cut list row ${i + 1}: qty "${qtyRaw}" is not a positive whole number`);
    const part = pick('part', 'sku', 'shape', 'product');
    if (!part) die(`cut list row ${i + 1}: no part/sku/shape column value`);
    return { part, color: pick('color', 'colour') || 'unspecified', qty, order: pick('order', 'order#', 'order_id'), status: pick('status', 'state'), size: pick('size') };
  });
  return { meta, items };
}

// A part is either cut from geometry (file + recipe) or backed by a machine file that already
// exists (tap). Both at once is ambiguous about which one batch should honour.
function checkPart(cat, entry, key) {
  if (entry.tap && entry.recipe) die(`part "${key}" has both "tap" and "recipe" — a tap-backed part is used as-is, so drop one`);
  if (entry.file && entry.shape) die(`part "${key}" has both "file" and "shape" — a part is either drawn or described, not both`);
  if (!entry.tap && !entry.file && !entry.shape) die(`part "${key}" has none of "file", "shape" or "tap"`);
  if (!entry.tap && !entry.recipe) die(`part "${key}" has no "recipe"`);
}

// Load one catalog part's geometry, honouring any layer filter the part declares.
function partShapes(cat, entry, key, notes, sizeText) {
  if (entry.shape) {
    const built = buildShape(entry.shape, sizeText !== undefined && sizeText !== '' ? sizeText : entry.shape.size, key);
    return filterShapes(built, entry).length ? filterShapes(built, entry) : built;
  }
  if (!entry.file) die(`part "${key}" in the catalog has no "file"`);
  const f = catFile(cat, entry.file);
  if (!fs.existsSync(f)) die(`part "${key}": no such file ${f}`);
  const all = loadShapes(f, notes);
  const kept = filterShapes(all, entry);
  if (!kept.length) die(`part "${key}": its layer filter left no geometry — file has layer(s): ${[...new Set(all.map(s => s.layer))].join(', ')}`);
  return kept;
}

function cmdBatch(args) {
  const file = args.in ? String(list(args.in)[0]) : args._[1];
  if (!file) die('batch needs --in <cutlist.csv|.json>');
  const cat = loadCatalog(args);
  const { meta, items } = loadCutList(file);
  const notes = [], warnings = [];

  // split off rows that must not be cut, and rows with no part file
  const held = [], unknown = [], ready = [];
  for (const it of items) {
    if (it.status && HOLD.test(it.status) && !flag(args['include-hold'])) { held.push(it); continue; }
    if (!cat.parts[it.part]) { unknown.push(it); continue; }
    ready.push(it);
  }
  if (unknown.length && !flag(args['skip-unknown'])) {
    die(`no part file for: ${[...new Set(unknown.map(u => u.part))].join(', ')} — add them to ${cat.__path}, or pass --skip-unknown to cut the rest`);
  }
  for (const u of unknown) notes.push(`skipped "${u.part}"${u.order ? ' (' + u.order + ')' : ''} — not in the parts catalog`);
  for (const h of held) notes.push(`held "${h.part}"${h.order ? ' (' + h.order + ')' : ''} — status "${h.status}"`);
  if (!ready.length) die('nothing to cut — every row is held or unknown');
  for (const it of ready) checkPart(cat, cat.parts[it.part], it.part);

  const sheetSpec = String(args.sheet || meta.sheet || cat.defaults.sheet || '48x96').toLowerCase().split(/[x*]/);
  const sheetW = Math.abs(num(sheetSpec[0], 48)), sheetH = Math.abs(num(sheetSpec[1], 96));
  const spacing = Math.abs(num(args.spacing, num(meta.spacing, num(cat.defaults.spacing, 0.5))));
  const margin = Math.abs(num(args.margin, num(meta.margin, num(cat.defaults.margin, 0.25))));
  const allowRotate = !flag(args['no-rotate']);
  const postName = String(args.post || cat.defaults.post || 'shopsabre').toLowerCase();
  if (!CAM.POSTS[postName]) die('unknown post "' + postName + '" — have: ' + Object.keys(CAM.POSTS).join(', '));
  const outDir = path.resolve(String(args.outdir || cat.defaults.outdir || '.'));
  if (!flag(args['dry-run'])) fs.mkdirSync(outDir, { recursive: true });
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

  // colour is the physical sheet, so it is the grouping key
  const byColor = new Map();
  for (const it of ready) {
    const k = it.color.toLowerCase();
    if (!byColor.has(k)) byColor.set(k, []);
    byColor.get(k).push(it);
  }

  const written = [], sheetsOut = [], prenestedOut = [], tapOut = [];
  let totalMinutes = 0;

  const postOps = (ops, name, outPath) => {
    const post = Object.assign({}, CAM.POSTS[postName]);
    if (flag(args['no-arcs'])) post.arcs = false;
    const g = CAM.postProcess({ name, units: 'inch', ops: mergeOps(ops) }, post);
    const minutes = estimateMinutes(g, ops[0] && ops[0].feed);
    if (!flag(args['dry-run'])) { fs.writeFileSync(outPath, g); written.push(outPath); }
    totalMinutes += minutes;
    return { lines: g.split(/\r?\n/).length, arcs: (g.match(/^G[23] /gm) || []).length, minutes: +minutes.toFixed(2) };
  };

  for (const [color, group] of byColor) {
    // a part backed by an existing machine file is run as-is: nothing is regenerated, so the file
    // that already proved out on the machine is the file that gets run
    for (const it of group.filter(it => cat.parts[it.part].tap)) {
      const entry = cat.parts[it.part];
      const f = catFile(cat, entry.tap);
      if (!fs.existsSync(f)) die(`part "${it.part}": no such machine file ${f}`);
      const sum = tapSummary(fs.readFileSync(f, 'utf8'));
      totalMinutes += sum.minutes * it.qty;
      tapOut.push({
        color, part: it.part, file: f, runs: it.qty, existing: true, order: it.order || null,
        tools: sum.tools, maxDepth: sum.maxDepth, lines: sum.lines,
        minutesPerRun: +sum.minutes.toFixed(2), minutes: +(sum.minutes * it.qty).toFixed(2),
      });
    }

    // a pre-nested part file is already a laid-out sheet — cut it as-is, never re-nest it
    const flat = [], pre = group.filter(it => !cat.parts[it.part].tap && cat.parts[it.part].prenested);
    for (const it of group.filter(it => !cat.parts[it.part].tap && !cat.parts[it.part].prenested)) {
      const entry = cat.parts[it.part];
      const shapes = partShapes(cat, entry, it.part, notes, it.size);
      for (let i = 0; i < it.qty; i++) flat.push({ item: it, entry, shapes: shapes.map(C.clone) });
    }

    for (const it of pre) {
      const entry = cat.parts[it.part];
      const shapes = partShapes(cat, entry, it.part, notes, it.size);
      const label = `${slug(color)}-${slug(it.part)}`;
      const built = opsFromRecipe(cat, entry.recipe, shapes, notes, it.part);
      warnings.push(...built.warnings);
      const outPath = path.join(outDir, label + '.tap');
      const info = postOps(built.ops, `${it.part} (${color})`, outPath);
      prenestedOut.push({ color, part: it.part, file: outPath, runs: it.qty, prenested: true, order: it.order || null, ...info });
      if (it.qty > 1) notes.push(`${it.part}: pre-nested sheet — run ${path.basename(outPath)} ${it.qty} times`);
    }
    if (!flat.length) continue;

    const proxies = flat.map(g => {
      const b = C.bboxAll(g.shapes);
      return C.mkPoly([{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], true, '0');
    });
    const r = C.nestShapes(proxies, { sheetW, sheetH, margin, spacing, allowRotate });
    for (const i of r.unplaced) warnings.push(`${flat[i].item.part} (${color}) does not fit a ${sheetW}" x ${sheetH}" sheet — not cut`);
    if (!r.placements.length) continue;

    const sheets = new Map();
    for (const pl of r.placements) {
      if (!sheets.has(pl.sheet)) sheets.set(pl.sheet, []);
      sheets.get(pl.sheet).push({ ...flat[pl.idx], placed: placeGroup(flat[pl.idx].shapes, pl, null) });
    }

    for (const [n, members] of [...sheets.entries()].sort((a, b) => a[0] - b[0])) {
      const label = `${slug(color)}-sheet${n + 1}`;
      // one .tap per sheet; ops are grouped by recipe so mixed parts can share the sheet
      const ops = [], byRecipe = new Map();
      for (const m of members) {
        const rn = m.entry.recipe;
        if (!byRecipe.has(rn)) byRecipe.set(rn, []);
        byRecipe.get(rn).push(...m.placed);
      }
      for (const [rn, shapes] of byRecipe) {
        const built = opsFromRecipe(cat, rn, shapes, notes, `${color} sheet ${n + 1} / ${rn}`);
        ops.push(...built.ops);
        warnings.push(...built.warnings);
      }
      const dxfPath = path.join(outDir, label + '.dxf');
      const tapPath = path.join(outDir, label + '.tap');
      if (!flag(args['dry-run'])) { fs.writeFileSync(dxfPath, C.toDXF(members.flatMap(m => m.placed))); written.push(dxfPath); }
      const info = postOps(ops, `${color} sheet ${n + 1}`, tapPath);
      const counts = {};
      for (const m of members) {
        const k = m.entry.shape && m.item.size ? `${m.item.part} ${m.item.size}` : m.item.part;
        counts[k] = (counts[k] || 0) + 1;
      }
      sheetsOut.push({
        color, sheet: n + 1, file: tapPath, dxf: dxfPath, parts: counts,
        pieces: members.length, recipes: [...byRecipe.keys()],
        orders: [...new Set(members.map(m => m.item.order).filter(Boolean))], ...info,
      });
    }
    notes.push(`${color}: ${r.placements.length} piece(s) on ${r.sheets} sheet(s), ${(r.utilization * 100).toFixed(0)}% utilization`);
  }

  const report = {
    ok: true, command: 'batch', cutList: path.resolve(file), catalog: cat.__path,
    outDir, sheet: `${sheetW}x${sheetH}`, spacing, margin, post: postName,
    colors: [...byColor.keys()],
    sheets: sheetsOut, prenested: prenestedOut, existingTaps: tapOut,
    totalSheets: sheetsOut.length, totalPieces: sheetsOut.reduce((n, s) => n + s.pieces, 0),
    estimatedMinutes: +totalMinutes.toFixed(2),
    held: held.map(h => ({ part: h.part, order: h.order || null, status: h.status })),
    unknownParts: [...new Set(unknown.map(u => u.part))],
    written: flag(args['dry-run']) ? [] : written,
    notes, warnings,
  };
  if (flag(args.json)) { console.log(JSON.stringify(report, null, 2)); return; }
  const nestedBit = report.totalSheets ? `${report.totalPieces} piece(s) nested on ${report.totalSheets} sheet(s) of ${sheetW}" x ${sheetH}"` : '';
  const preBit = prenestedOut.length ? `${prenestedOut.length} pre-nested sheet file(s)` : '';
  const tapBit = tapOut.length ? `${tapOut.length} existing machine file(s)` : '';
  console.log(`cut list: ${path.basename(file)} -> ${[nestedBit, preBit, tapBit].filter(Boolean).join(' + ') || 'nothing to cut'}`);
  for (const s of sheetsOut) {
    const mix = Object.entries(s.parts).map(([k, v]) => `${v}x ${k}`).join(', ');
    console.log(`  ${s.color} sheet ${s.sheet}: ${mix} · ${fmtMin(s.minutes)} · ${path.basename(s.file)}`);
  }
  for (const p of prenestedOut) console.log(`  ${p.color} ${p.part}: pre-nested${p.runs > 1 ? `, run ${p.runs}x` : ''} · ${fmtMin(p.minutes)} · ${path.basename(p.file)}`);
  for (const t of tapOut) console.log(`  ${t.color} ${t.part}: existing file, T${t.tools.join('/T')} to ${t.maxDepth}"${t.runs > 1 ? `, run ${t.runs}x` : ''} · ${fmtMin(t.minutes)} · ${path.basename(t.file)}`);
  console.log(`  total machine time ${fmtMin(totalMinutes)}`);
  for (const n of notes) console.log('  · ' + n);
  for (const w of warnings) console.log('  ! ' + w);
}

const HELP = `Aquamentor CAD/CAM — headless CLI (same engine as cadcam-studio.html)

  node cli.js cut     --in <file> [--out job.tap] [options]     DXF/SVG/PDF -> toolpath -> .tap
  node cli.js nest    --in <file>[:qty] ... [--out nested.dxf]  pack parts onto sheets
  node cli.js convert --in <file> --out <file.dxf|.svg>         format conversion
  node cli.js info    --in <file>                               inspect geometry before cutting
  node cli.js batch   --in <cutlist.csv|.json> [--outdir DIR]   cut list -> nested sheets -> .tap
  node cli.js posts                                             list post processors

Input: .dxf .svg .pdf (vector) .aqcam — repeat --in to combine files.
Quantity: append :N to a nest input to place N copies (nest only; cut would stack them in place).

cut options
  --shape KIND --size WxH            describe the part instead of importing one:
                                     rect roundrect capsule circle ellipse polygon star
                                     extras: --r IN --d IN --sides N --points N --innerRatio F
                                     --holes COLSxROWS@DIA [--hole-margin IN]
  --recipe NAME                      run a multi-op recipe from the parts catalog into one file
                                     (tool changes included); the flags below describe a single op
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

batch options
  reads a cut list (color, part/sku/shape, qty, order, status) and turns it into machine files:
  parts are grouped by COLOUR (one colour = one physical sheet), nested, and posted one .tap per
  sheet. Parts marked "prenested" in the catalog are cut as-is instead of being re-nested.
  --catalog FILE     parts catalog (default parts.json beside the repo root)
  --outdir DIR       where the .tap/.dxf files go (default from the catalog)
  --sheet WxH --spacing IN --margin IN --no-rotate --post NAME    override catalog defaults
  --skip-unknown     cut the rest when a row names a part with no catalog entry (default: stop)
  --include-hold     also cut rows whose status looks like a hold (unpaid, awaiting artwork, ...)

common
  --layer A,B  --exclude-layer C     filter imported geometry by layer
  --json                             machine-readable report on stdout
  --dry-run                          compute and report, write nothing

examples
  node cli.js info --in "CAD/XRT-50.dxf"
  node cli.js cut --in "CAD/XRT-50.dxf" --dia 0.25 --depth 0.55 --pass 0.25 --tabs 4 --out XRT-50.tap
  node cli.js nest --in "part-a.dxf:12" --in "part-b.dxf:4" --sheet 48x96 --spacing 0.5 --out nested.dxf
  node cli.js cut --in "CAD/XRT-50.dxf" --recipe foam-2in --out XRT-50.tap
  node cli.js batch --in cutlist.csv --outdir CAD/out
  node cli.js cut --shape roundrect --size 20x10 --recipe foam-2in --out kickboard.tap
  node cli.js cut --shape rect --size 24x18 --holes 3x2@4 --recipe foam-holes --out mat.tap
`;

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = (args._[0] || (flag(args.help) ? 'help' : '')).toLowerCase();
  try {
    switch (cmd) {
      case 'cut': return cmdCut(args);
      case 'nest': return cmdNest(args);
      case 'batch': return cmdBatch(args);
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
