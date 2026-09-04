#!/usr/bin/env node
// repost.js — re-post a DXF straight through the engine, no browser.
//
// Reads a DXF, runs one CAM operation over every closed contour in it, and writes G-code with the
// ShopSabre post. Exists so a job whose only surviving source is its .dxf can be regenerated after an
// engine fix without hand-rebuilding it in the UI. Same code paths as the studio: dxfparse ->
// cadcore.dxfPolysToShapes -> camcore.assembleContours -> <op>Op -> orderPasses -> postProcess.
//
//   node cam-engine/repost.js in.dxf out.tap --dia 0.25 --depth 1.5 --pass 1.5 \
//        --feed 100 --plunge 30 --rpm 24000 --clear 0.8 --side outside --dir conventional \
//        --lead line --leadlen 0.25
//
// Anything not given falls back to the profileOp defaults. --json prints the summary as JSON.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require(path.join(__dirname, 'camcore.js'));
const C = require(path.join(__dirname, 'cadcore.js'));

function loadDxfParser() {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8'), ctx);
  return ctx;
}
// Hand this a .tap by mistake and the parser finds no entities, the CAM ops find no contours, and you
// get a valid-looking program that cuts nothing. Fail at the door instead.
function assertDxf(text, label) {
  label = label || 'input';
  if (typeof text !== 'string' || !text.length) throw new Error(`${label} is empty`);
  if (!/^\s*(2|ENTITIES)\s*$/m.test(text) || !/\bENTITIES\b/.test(text))
    throw new Error(`${label} does not look like a DXF (no ENTITIES section)`);
}
function dxfToContours(text) {
  assertDxf(text, 'DXF');
  const ctx = loadDxfParser();
  const polys = [];
  for (const e of ctx.parseDxf(text)) for (const p of ctx.entityToPolys(e)) polys.push(p);
  if (!polys.length) throw new Error('DXF parsed, but it contains no usable vectors');
  return CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));
}
function repost(dxfText, opts) {
  const o = Object.assign({ op: 'profile', name: 'repost', post: 'shopsabre' }, opts || {});
  const contours = dxfToContours(dxfText);
  const res = (o.op === 'pocket') ? CAM.pocketOp(contours, o)
    : (o.op === 'drill') ? CAM.drillOp(contours, o)
    : (o.op === 'vcarve') ? CAM.vcarveOp(contours, Object.assign({}, o, { maxDepth: o.cutDepth, step: o.vstep }))
    : CAM.profileOp(contours, o);
  for (const op of res.ops) op.clearZ = o.clearZ != null ? o.clearZ : 0.25;
  const job = CAM.orderPasses({ name: o.name, units: 'inch', ops: res.ops });
  const g = CAM.postProcess(job, CAM.POSTS[o.post] || CAM.POSTS.shopsabre);
  const passes = res.ops.reduce((n, op) => n + op.passes.length, 0);
  return { gcode: g, contours: contours.length, closed: contours.filter(c => c.closed).length, passes,
           warnings: res.warnings, arcs: (g.match(/^G[23] /gm) || []).length, lines: (g.match(/^G1 /gm) || []).length };
}

// ---- job specs: several ops over hand-picked DXF vectors ----------------------------------------
// A one-op-over-everything re-post only fits the simplest jobs. Real jobs machine specific vectors
// with specific tools, so a spec names them: { name, ops:[ {op, select:[[layer, index, override?]],
// ...params} ] }. `select` addresses a vector by its layer and its position within that layer in DXF
// order, which is stable for a given file; an override object on an entry sets per-vector `side` /
// `reverse` (Vectric lets each vector in one toolpath sit on its own side of the line).
function dxfIndex(text) {
  assertDxf(text, 'DXF');
  const ctx = loadDxfParser(), byLayer = {};
  for (const e of ctx.parseDxf(text)) for (const p of ctx.entityToPolys(e)) {
    const L = e.layer || '0';
    (byLayer[L] = byLayer[L] || []).push({ closed: !!p.closed, pts: (p.pts || p).map(q => ({ x: q.x, y: q.y })) });
  }
  return byLayer;
}
function selectEntries(index, select) {
  const out = [];
  for (const s of (select || [])) {
    const [layer, i, over] = Array.isArray(s) ? s : [s.layer, s.index, s.override];
    const arr = index[layer];
    if (!arr) throw new Error(`spec references missing layer "${layer}"`);
    if (!arr[i]) throw new Error(`spec references missing vector ${layer}[${i}] (layer has ${arr.length})`);
    out.push({ layer, i, over: over || {}, ent: arr[i] });
  }
  return out;
}
function repostJob(dxfText, spec) {
  const index = dxfIndex(dxfText), ops = [], warnings = [], summary = [];
  for (const raw of (spec.ops || [])) {
    const o = Object.assign({ op: 'profile', toolNum: 1, toolDia: 0.25, rpm: 18000, feed: 120,
                             plunge: 40, cutDepth: 0.25, passDepth: 0.25, topZ: 0, clearZ: 0.25 }, raw);
    const entries = selectEntries(index, o.select);
    const passes = [];
    let kind = o.op;
    if (o.op === 'drill') {
      // one hole per selected vector, at its centroid
      const cs = [];
      for (const e of entries) for (const c of CAM.assembleContours([{ closed: e.ent.closed, pts: e.ent.pts }])) cs.push(c);
      const r = CAM.drillOp(cs, o);
      r.ops[0].passes.forEach(p => passes.push(p));
      r.warnings.forEach(w => warnings.push(`${o.label || o.op}: ${w}`));
    } else {
      for (const e of entries) {
        const cs = CAM.assembleContours([{ closed: e.ent.closed, pts: e.ent.pts }]);
        const p = Object.assign({}, o, e.over);
        const r = (o.op === 'pocket') ? CAM.pocketOp(cs, p)
          : (o.op === 'vcarve') ? CAM.vcarveOp(cs, Object.assign({}, p, { maxDepth: p.cutDepth, step: p.vstep }))
          : CAM.profileOp(cs, p);
        for (const sub of r.ops) sub.passes.forEach(q => passes.push(q));
        r.warnings.forEach(w => warnings.push(`${o.label || o.op} ${e.layer}[${e.i}]: ${w}`));
      }
    }
    ops.push({ kind, toolNum: o.toolNum, rpm: o.rpm, feed: o.feed, plunge: o.plunge,
               safeZ: o.safeZ, topZ: o.topZ, clearZ: o.clearZ, passes });
    summary.push({ label: o.label || o.op, tool: o.toolNum, vectors: entries.length, passes: passes.length });
  }
  let job = { name: spec.name || 'job', units: 'inch', ops };
  if (spec.reorder) job = CAM.orderPasses(job);
  const g = CAM.postProcess(job, CAM.POSTS[spec.post] || CAM.POSTS.shopsabre);
  return { gcode: g, ops: summary, warnings,
           arcs: (g.match(/^G[23] /gm) || []).length, lines: (g.match(/^G1 /gm) || []).length };
}

module.exports = { repost, dxfToContours, repostJob, dxfIndex, assertDxf, parseArgs };

// ---- CLI argument parsing -----------------------------------------------------------------------
// Every flag is declared with a type, and anything not declared is an ERROR rather than a silent
// no-op: `--diameter 0.25` used to be accepted and ignored, leaving the default 0.25" tool in place,
// which on a job cut with a 1/2" bit is a scrapped sheet. Same reasoning for rejecting non-numeric
// values and unknown enum members.
const FLAGS = {
  job:  { type: 'path', help: 'job spec .json (multi-op)' },
  dxf:  { type: 'path', help: 'override the spec\'s source DXF' },
  out:  { type: 'path', help: 'override the output .tap' },
  op:   { type: 'enum', of: ['profile', 'pocket', 'drill', 'vcarve'] },
  side: { type: 'enum', of: ['outside', 'inside', 'on', 'left', 'right'] },
  dir:  { type: 'enum', of: ['climb', 'conventional'] },
  lead: { type: 'enum', of: ['none', 'line', 'arc'] },
  post: { type: 'enum', of: ['shopsabre', 'generic'] },
  tool: { type: 'int' },
  dia: { type: 'num' }, depth: { type: 'num' }, pass: { type: 'num' }, feed: { type: 'num' },
  plunge: { type: 'num' }, rpm: { type: 'num' }, clear: { type: 'num' }, leadlen: { type: 'num' },
  top: { type: 'num', signed: true },
  reverse: { type: 'bool' }, json: { type: 'bool' },
};
function parseArgs(av) {
  const pos = [], flags = {};
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    const spec = FLAGS[k];
    if (!spec) throw new Error(`unknown option --${k}`);
    if (spec.type === 'bool') { flags[k] = true; continue; }
    const v = av[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`--${k} needs a value`);
    i++;
    if (spec.type === 'num' || spec.type === 'int') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`--${k} needs a number, got "${v}"`);
      if (spec.type === 'int' && !Number.isInteger(n)) throw new Error(`--${k} needs a whole number, got "${v}"`);
      if (!spec.signed && n < 0) throw new Error(`--${k} cannot be negative, got "${v}"`);
      flags[k] = n;
    } else if (spec.type === 'enum') {
      if (spec.of.indexOf(v) < 0) throw new Error(`--${k} must be one of ${spec.of.join('|')}, got "${v}"`);
      flags[k] = v;
    } else flags[k] = v;
  }
  return { pos, flags };
}
const USAGE = [
  'usage:',
  '  single op over every vector in a DXF:',
  '    node repost.js <in.dxf> <out.tap> [--op profile|pocket|drill|vcarve] [--tool N] [--dia N]',
  '        [--side outside|inside|on|left|right] [--reverse] [--dir climb|conventional]',
  '        [--depth N] [--pass N] [--feed N] [--plunge N] [--rpm N] [--clear N] [--top N]',
  '        [--lead none|line|arc] [--leadlen N] [--post shopsabre|generic] [--json]',
  '',
  '  several ops over hand-picked vectors:',
  '    node repost.js --job <spec.aqjob.json> [--dxf <in.dxf>] [--out <out.tap>]',
  '    (with --job the paths come from the spec or from --dxf/--out; positional arguments are refused)',
].join('\n');

if (require.main === module) {
  const die = m => { console.error(`repost: ${m}\n\n${USAGE}`); process.exit(2); };
  let pos, flags;
  try { ({ pos, flags } = parseArgs(process.argv.slice(2))); } catch (e) { die(e.message); }

  // never write a .tap over one of the inputs — a slipped argument should not eat a source file
  const guardOut = (out, ins) => {
    if (/\.(dxf|svg|pdf|aqjob\.json|json)$/i.test(out)) die(`refusing to write G-code to "${out}" — that is a source file`);
    for (const i of ins) if (i && path.resolve(i) === path.resolve(out)) die(`output "${out}" is the same file as an input`);
  };

  if (flags.job) {
    // The old code took pos[0] as the DXF and pos[1] as the output, so `--job spec.json out.tap`
    // silently fed out.tap to the DXF parser. Overrides are named now, and positionals are refused.
    if (pos.length) die(`with --job, pass overrides as --dxf/--out; got positional argument "${pos[0]}"`);
    let spec;
    try { spec = JSON.parse(fs.readFileSync(flags.job, 'utf8')); }
    catch (e) { die(`cannot read job spec ${flags.job}: ${e.message}`); }
    const base = path.dirname(flags.job);
    const dxfPath = flags.dxf || (spec.dxf && path.join(base, spec.dxf));
    if (!dxfPath) die(`job spec has no "dxf" field — pass --dxf <in.dxf>`);
    const out = flags.out || path.join(base, spec.out || (spec.name || 'job') + '.tap');
    guardOut(out, [dxfPath, flags.job]);
    let dxfText;
    try { dxfText = fs.readFileSync(dxfPath, 'utf8'); assertDxf(dxfText, dxfPath); } catch (e) { die(e.message); }
    let r;
    try { r = repostJob(dxfText, spec); } catch (e) { die(e.message); }
    fs.writeFileSync(out, r.gcode);
    console.log(`${dxfPath} + ${flags.job} -> ${out}`);
    for (const s of r.ops) console.log(`  T${s.tool} ${s.label}: ${s.vectors} vectors, ${s.passes} passes`);
    console.log(`  G1 ${r.lines}   G2/G3 ${r.arcs}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
    process.exit(0);
  }

  const inPath = flags.dxf || pos[0], outPath = flags.out || pos[1];
  if (!inPath || !outPath) die('need an input .dxf and an output .tap');
  if (pos.length > 2) die(`unexpected extra argument "${pos[2]}"`);
  guardOut(outPath, [inPath]);
  const num = (k, d) => flags[k] != null ? flags[k] : d;
  const opts = {
    op: flags.op || 'profile',
    toolNum: flags.tool != null ? flags.tool : 1,
    toolDia: num('dia', 0.25), side: flags.side || 'outside', reverse: !!flags.reverse,
    climb: (flags.dir || 'conventional') === 'climb',
    cutDepth: num('depth', 0.25), passDepth: num('pass', num('depth', 0.25)),
    feed: num('feed', 120), plunge: num('plunge', 40), rpm: num('rpm', 18000),
    topZ: num('top', 0), clearZ: num('clear', 0.25),
    leadType: flags.lead || 'none', leadLen: num('leadlen', 0.25),
    post: flags.post || 'shopsabre',
    name: path.basename(inPath).replace(/\.dxf$/i, '')
  };
  let r, inText;
  try { inText = fs.readFileSync(inPath, 'utf8'); assertDxf(inText, inPath); } catch (e) { die(e.message); }
  try { r = repost(inText, opts); } catch (e) { die(e.message); }
  fs.writeFileSync(outPath, r.gcode);
  if (flags.json) console.log(JSON.stringify({ out: outPath, ...r, gcode: undefined }, null, 2));
  else {
    console.log(`${inPath} -> ${outPath}`);
    console.log(`  contours ${r.contours} (${r.closed} closed)   passes ${r.passes}   G1 ${r.lines}   G2/G3 ${r.arcs}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
  }
}
