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
function dxfToContours(text) {
  const ctx = loadDxfParser();
  const polys = [];
  for (const e of ctx.parseDxf(text)) for (const p of ctx.entityToPolys(e)) polys.push(p);
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

module.exports = { repost, dxfToContours, repostJob, dxfIndex };

if (require.main === module) {
  const av = process.argv.slice(2), pos = [], flags = {};
  for (let i = 0; i < av.length; i++) {
    if (av[i].startsWith('--')) { const k = av[i].slice(2); flags[k] = (av[i + 1] && !av[i + 1].startsWith('--')) ? av[++i] : true; }
    else pos.push(av[i]);
  }
  if (flags.job) {
    const spec = JSON.parse(fs.readFileSync(flags.job, 'utf8'));
    const dxfPath = pos[0] || path.join(path.dirname(flags.job), spec.dxf || '');
    const out = pos[1] || path.join(path.dirname(flags.job), (spec.out || (spec.name + '.tap')));
    const r = repostJob(fs.readFileSync(dxfPath, 'utf8'), spec);
    fs.writeFileSync(out, r.gcode);
    console.log(`${dxfPath} + ${flags.job} -> ${out}`);
    for (const s of r.ops) console.log(`  T${s.tool} ${s.label}: ${s.vectors} vectors, ${s.passes} passes`);
    console.log(`  G1 ${r.lines}   G2/G3 ${r.arcs}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
    process.exit(0);
  }
  if (pos.length < 2) { console.error('usage: node repost.js <in.dxf> <out.tap> [--job spec.json | --dia N --depth N --pass N --feed N --plunge N --rpm N --clear N --side outside|inside|on --dir climb|conventional --lead none|line|arc --leadlen N --tool N --top N --op profile|pocket|drill|vcarve]'); process.exit(2); }
  const num = (k, d) => flags[k] != null ? Math.abs(parseFloat(flags[k])) : d;
  const opts = {
    op: flags.op || 'profile',
    toolNum: flags.tool != null ? parseInt(flags.tool, 10) : 1,
    toolDia: num('dia', 0.25), side: flags.side || 'outside',
    climb: (flags.dir || 'conventional') === 'climb',
    cutDepth: num('depth', 0.25), passDepth: num('pass', num('depth', 0.25)),
    feed: num('feed', 120), plunge: num('plunge', 40), rpm: num('rpm', 18000),
    topZ: flags.top != null ? parseFloat(flags.top) : 0, clearZ: num('clear', 0.25),
    leadType: flags.lead || 'none', leadLen: num('leadlen', 0.25),
    name: path.basename(pos[0]).replace(/\.dxf$/i, '')
  };
  const r = repost(fs.readFileSync(pos[0], 'utf8'), opts);
  fs.writeFileSync(pos[1], r.gcode);
  if (flags.json) console.log(JSON.stringify({ out: pos[1], ...r, gcode: undefined }, null, 2));
  else {
    console.log(`${pos[0]} -> ${pos[1]}`);
    console.log(`  contours ${r.contours} (${r.closed} closed)   passes ${r.passes}   G1 ${r.lines}   G2/G3 ${r.arcs}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
  }
}
