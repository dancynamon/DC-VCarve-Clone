#!/usr/bin/env node
// aqcam-cli.js — headless bridge between Claude-made cut files and the studio's .aqcam project format.
//
//   node cam-engine/aqcam-cli.js from-dxf sheet.dxf --out job.aqcam [--thickness 1.5] [--w 48.5 --h 97] [--name N]
//        Layer-named DXF (OUTSIDE_PROFILE / INSIDE_CUT / DRILL_<d>_THRU / POCKET_<D>D_<d>DEEP / SHEET / NOTES)
//        -> .aqcam with the vectors AND Dan's toolpath queue (assembly.jobFromLayers), ready to open, edit, save.
//   node cam-engine/aqcam-cli.js post job.aqcam --out job.tap [--aircut] [--force]
//        .aqcam (as Claude wrote it or as Dan saved it from the studio) -> .tap. Same code path as the
//        studio's Post Job: every toolpath (hidden ones included), visible layers only, ShopSabre post, arcs on.
//        The program is run through cutprep.tapSanity (job thickness + sheet bounds) before it is written;
//        a program with sanity errors is NOT written unless --force. The shop file-name rule is reported as a warning.
//   node cam-engine/aqcam-cli.js check job.tap [--thickness 1.5] [--w 48.5 --h 97]
//        Static sanity check of any .tap (ours or Vectric's) + the shop file-name rule. Exit 1 on errors.
//   node cam-engine/aqcam-cli.js split part.dxf --out part-split.dxf
//        Re-layer a DXF: outer profiles -> OUTSIDE_PROFILE, everything inside a part -> INSIDE_CUT, stray open -> OPEN_VECTOR.
//   node cam-engine/aqcam-cli.js info job.aqcam         toolpath list, tools, layers, shape counts (JSON)
//   node cam-engine/aqcam-cli.js preview job.aqcam --out job.svg   vectors + posted toolpath, top view
const fs = require('fs'), path = require('path');
const CAM = require('./camcore.js'), C = require('./cadcore.js'), A = require('./assembly.js');
const { loadDxfShapes } = require('./asmtap.js');
const CP = require('./cutprep.js');

const KIND_COLOR = { profile: '#1b2b3f', inside: '#0000ff', drill: '#c000c0', pocket: '#00a000', sheet: '#b0b0b0', skip: '#808080', unknown: '#e0c000' };

function fromDxf(file, o) {
  const shapes = loadDxfShapes(file);
  if (!shapes.length) throw new Error('DXF has no usable vectors: ' + file);
  const names = []; for (const s of shapes) if (names.indexOf(s.layer) < 0) names.push(s.layer);
  const T = +o.thickness || 1.5;
  const job = A.jobFromLayers(names, T);
  const b = C.bboxAll(shapes);
  const layers = new Map(names.map(n => [n, { visible: true, color: KIND_COLOR[A.layerRule(n).kind] || '#1b2b3f' }]));
  const jobDims = { w: +o.w || Math.max(48.5, Math.ceil(b.maxX * 100) / 100), h: +o.h || Math.max(97, Math.ceil(b.maxY * 100) / 100), thickness: T, origin: 'bl', show: true };
  const name = o.name || path.basename(file).replace(/\.dxf$/i, '');
  const text = C.projectToJSON({ shapes, layers }, jobDims, job.queue, { name, savedAt: Date.now(), app: 'Aquamentor CAD/CAM', view: '2d', source: path.basename(file) });
  return { text, queue: job.queue, skipped: job.skipped, shapes: shapes.length, layers: names };
}

function loadProject(file) { return C.projectFromJSON(fs.readFileSync(file, 'utf8')); }

// the studio's contoursForOp, headless: visible layers only; sel-rule ops by layer/size, id ops by shape id
function contoursFor(proj) {
  const vis = new Set(proj.layers.filter(l => l.visible !== false).map(l => l.name));
  const live = proj.shapes.filter(s => s.type === 'path' && (vis.has(s.layer) || !proj.layers.some(l => l.name === s.layer)));
  return q => {
    let sh;
    if (q.sel) sh = A.selectByRule(live.map(s => ({ id: s.id, layer: s.layer, bbox: C.bboxAll([s]), shape: s })), q.sel).map(it => it.shape);
    else sh = (q.ids && q.ids.length) ? live.filter(s => q.ids.indexOf(s.id) >= 0) : live;
    return CAM.assembleContours(C.shapesToContoursInput(sh));
  };
}

function post(file) {
  const proj = loadProject(file);
  if (!proj.opsQueue.length) throw new Error('No toolpaths in ' + file + ' (open it in the studio and add some, or rebuild from the DXF)');
  const byTool = {};
  const add = (t, d) => { (byTool[t] = byTool[t] || []); if (byTool[t].indexOf(d) < 0) byTool[t].push(d); };
  for (const q of proj.opsQueue) { add(q.p.toolNum, q.p.toolDia); if (q.p.op === 'vcarve' && q.p.clearDia > 0) add(q.p.clearNum, q.p.clearDia); }
  for (const t in byTool) if (byTool[t].length > 1) throw new Error('T' + t + ' used with Ø' + byTool[t].join(' and Ø') + ' — fix tool numbers');
  const queue = proj.opsQueue.map(q => Object.assign({}, q, { visible: true }));
  const r = A.postQueue(CAM, queue, contoursFor(proj), { arcs: true });
  if (!r.gcode) throw new Error('Job produced no cuttable passes');
  return { gcode: r.gcode, ops: r.ops, warnings: r.warnings, proj, sanity: sanityFor(r.gcode, proj.job) };
}

// cutprep.tapSanity against the job: stock thickness, and the sheet plus one inch all round (tool radius / leads)
function sanityFor(gcode, job, o) {
  o = o || {}; const J = job || {}, w = +o.w || J.w || 48.5, h = +o.h || J.h || 97;
  return CP.tapSanity(gcode, { thickness: +o.thickness || J.thickness || 1.5, bounds: { minX: -1, minY: -1, maxX: w + 1, maxY: h + 1 } });
}

function check(file, o) {
  const s = sanityFor(fs.readFileSync(file, 'utf8'), null, o || {});
  const name = CP.checkShopFileName(path.basename(file));
  return { file, ok: s.ok, errors: s.errors, warnings: s.warnings, stats: s.stats, fileName: name };
}

function split(file) {
  const shapes = loadDxfShapes(file);
  if (!shapes.length) throw new Error('DXF has no usable vectors: ' + file);
  return { dxf: CP.toDXFLayered(shapes), counts: CP.splitLayers(shapes).counts };
}

function stats(g) {
  let x = 0, y = 0, z = 0, minZ = Infinity, cut = 0, rapid = 0, plunges = 0, mode = null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, tools = [];
  for (const raw of g.split(/\r?\n/)) {
    const ln = raw.trim().toUpperCase(); if (!ln || ln[0] === '(') continue;
    const t = ln.match(/\bT(\d+)/); if (t && /M6|^T/.test(ln) || (t && /Z2/.test(ln))) { if (tools.indexOf('T' + t[1]) < 0) tools.push('T' + t[1]); }
    const m = ln.match(/^(G[0-3])\b/); if (m) mode = m[1];
    const v = c => { const r = ln.match(new RegExp(c + '(-?[\\d.]+)')); return r ? +r[1] : null; };
    const nx = v('X'), ny = v('Y'), nz = v('Z'); const x0 = x, y0 = y, z0 = z;
    if (nx != null) x = nx; if (ny != null) y = ny; if (nz != null) z = nz;
    if (!mode) continue;
    const d = Math.hypot(x - x0, y - y0, z - z0);
    if (mode === 'G0') rapid += d; else { cut += d; if (z < z0 && x === x0 && y === y0) plunges++; if (z < 0) { b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y); } }
    if (z < minZ) minZ = z;
  }
  const r4 = n => Math.round(n * 1e4) / 1e4;
  return { lines: g.split(/\r?\n/).length, tools, minZ: r4(minZ), cutIn: r4(cut), rapidIn: r4(rapid), plunges,
    cutBounds: isFinite(b.minX) ? [r4(b.minX), r4(b.minY), r4(b.maxX), r4(b.maxY)] : null,
    arcs: (g.match(/^G[23] /gm) || []).length };
}

function preview(proj, g) {
  const J = proj.job, s = 10, pad = 1;
  const W = (J.w + 2 * pad) * s, H = (J.h + 2 * pad) * s;
  const X = v => ((v + pad) * s).toFixed(2), Y = v => ((J.h + pad - v) * s).toFixed(2);
  const col = {}; for (const l of proj.layers) col[l.name] = l.color;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>`,
    `<rect x="${X(0)}" y="${Y(J.h)}" width="${J.w * s}" height="${J.h * s}" fill="#f3f1ea" stroke="#999"/>`];
  for (const sh of proj.shapes) { if (sh.type !== 'path' || !sh.pts || sh.pts.length < 2) continue;
    out.push(`<path d="M${sh.pts.map(p => X(p.x) + ' ' + Y(p.y)).join(' L')}${sh.closed ? 'Z' : ''}" fill="none" stroke="${col[sh.layer] || '#1b2b3f'}" stroke-width="1.2"/>`); }
  let x = 0, y = 0, z = 0, mode = null, d = '';
  for (const raw of g.split(/\r?\n/)) { const ln = raw.trim().toUpperCase(); if (!ln || ln[0] === '(') continue;
    const m = ln.match(/^(G[0-3])\b/); if (m) mode = m[1];
    const v = c => { const r = ln.match(new RegExp(c + '(-?[\\d.]+)')); return r ? +r[1] : null; };
    const nx = v('X'), ny = v('Y'), nz = v('Z'); const x0 = x, y0 = y;
    if (nx != null) x = nx; if (ny != null) y = ny; if (nz != null) z = nz;
    if (mode && mode !== 'G0' && z < 0 && (x !== x0 || y !== y0)) d += `M${X(x0)} ${Y(y0)} L${X(x)} ${Y(y)} `; }   // arcs drawn as chords
  out.push(`<path d="${d}" fill="none" stroke="#e08a00" stroke-width="0.6" opacity="0.8"/></svg>`);
  return out.join('\n');
}

function aircut(g) {   // same transform as aircut.js, in-process
  const AC = require('./aircut.js'); return AC.aircut(g, { retract: 0.75 }).gcode;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const flag = k => { const i = args.indexOf(k); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const cmd = args.shift();
  const outOpt = () => { const o = opt('--out'); if (!o) throw new Error(cmd + ' needs --out <file>'); return o; };
  try {
    if (cmd === 'from-dxf') {
      const out = outOpt(), o = { thickness: opt('--thickness'), w: opt('--w'), h: opt('--h'), name: opt('--name') };
      const r = fromDxf(args[0], o); fs.writeFileSync(out, r.text);
      console.log(JSON.stringify({ wrote: out, shapes: r.shapes, layers: r.layers, toolpaths: r.queue.map(q => q.name + ' · T' + q.p.toolNum + ' · ' + q.p.cutDepth + '"'), skipped: r.skipped }, null, 1));
    } else if (cmd === 'post') {
      const out = outOpt(), air = flag('--aircut'), force = flag('--force');
      const r = post(args[0]);
      const nameChk = CP.checkShopFileName(path.basename(out));
      if (!r.sanity.ok && !force) {
        console.error(JSON.stringify({ refused: out, sanityErrors: r.sanity.errors, sanityWarnings: r.sanity.warnings }, null, 1));
        throw new Error('posted program failed the .tap sanity check — not written (use --force to write anyway)');
      }
      fs.writeFileSync(out, r.gcode);
      const res = { wrote: out, ops: r.ops.length, warnings: r.warnings, stats: stats(r.gcode),
        sanity: { ok: r.sanity.ok, errors: r.sanity.errors, warnings: r.sanity.warnings },
        fileName: nameChk.ok ? 'ok' : nameChk.errors };
      if (air) { const ao = out.replace(/\.tap$/i, '') + '-AIRCUT.tap'; fs.writeFileSync(ao, aircut(r.gcode)); res.aircut = ao; }
      console.log(JSON.stringify(res, null, 1));
    } else if (cmd === 'check') {
      const r = check(args[0], { thickness: opt('--thickness'), w: opt('--w'), h: opt('--h') });
      console.log(JSON.stringify(r, null, 1)); if (!r.ok) process.exit(1);
    } else if (cmd === 'split') {
      const out = outOpt(); const r = split(args[0]); fs.writeFileSync(out, r.dxf);
      console.log(JSON.stringify({ wrote: out, counts: r.counts }, null, 1));
    } else if (cmd === 'info') {
      const p = loadProject(args[0]);
      console.log(JSON.stringify({ name: p.meta.name, job: p.job, layers: p.layers.map(l => l.name + (l.visible ? '' : ' (hidden)')), shapes: p.shapes.length,
        toolpaths: p.opsQueue.map((q, i) => (i + 1) + '. ' + (q.name || q.label) + ' · ' + q.p.op + ' T' + q.p.toolNum + ' Ø' + q.p.toolDia + ' · ' + q.p.cutDepth + '" · ' + (q.sel ? 'layers ' + q.sel.layers.join(',') : (q.ids.length ? q.ids.length + ' sel' : 'all'))) }, null, 1));
    } else if (cmd === 'preview') {
      const out = outOpt(); const r = post(args[0]); fs.writeFileSync(out, preview(r.proj, r.gcode)); console.log('wrote ' + out);
    } else { console.error('usage: aqcam-cli.js from-dxf|post|check|split|info|preview ... (see header)'); process.exit(2); }
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
}
module.exports = { fromDxf, post, stats, preview, contoursFor, sanityFor, check, split };
