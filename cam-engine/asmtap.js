#!/usr/bin/env node
// asmtap.js — post a layer-named DXF (OUTSIDE_PROFILE / INSIDE_CUT / DRILL_<d>_THRU / POCKET_<D>D_<d>DEEP) to a .tap
// with the same layer defaults and the same code path the studio uses (assembly.js jobFromLayers + postQueue).
//
//   node cam-engine/asmtap.js sheet.dxf [--thickness 1.5] [--out sheet.tap] [--list]
//        [--move LAYER@X,Y=DX,DY ...]   move every loop on LAYER whose centre is within 0.01 of X,Y by DX,DY
//
// --move is how the headless check reproduces a 2D edit ("move one foot hole"): the studio's moved TAP must equal
// this one byte for byte.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js'), C = require('./cadcore.js'), A = require('./assembly.js');

function loadDxfShapes(file) {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8'), ctx);
  const polys = [];
  for (const e of ctx.parseDxf(fs.readFileSync(file, 'utf8'))) for (const p of ctx.entityToPolys(e)) polys.push(p);
  return C.dxfPolysToShapes(polys);
}
// shapes -> {items for selection, contoursFor(q)} — the studio's contoursFromOp, minus layer visibility
function selector(shapes) {
  const items = shapes.map(s => ({ id: s.id, layer: s.layer, bbox: C.bboxAll([s]), shape: s }));
  return q => CAM.assembleContours(C.shapesToContoursInput(A.selectByRule(items, q.sel).map(it => it.shape)));
}
function moveLoops(shapes, spec) {   // "LAYER@X,Y=DX,DY"
  const m = /^(.+)@(-?[\d.]+),(-?[\d.]+)=(-?[\d.]+),(-?[\d.]+)$/.exec(spec);
  if (!m) throw new Error('bad --move ' + spec);
  const [, layer, x, y, dx, dy] = m; let n = 0;
  for (let i = 0; i < shapes.length; i++) { const s = shapes[i]; if (s.layer !== layer) continue;
    const b = C.bboxAll([s]); if (Math.hypot((b.minX + b.maxX) / 2 - +x, (b.minY + b.maxY) / 2 - +y) > 0.01) continue;
    shapes[i] = C.translate(s, +dx, +dy); shapes[i].id = s.id; n++; }
  return n;
}
function postSheet(shapes, thickness) {
  const layers = []; for (const s of shapes) if (layers.indexOf(s.layer) < 0) layers.push(s.layer);
  const job = A.jobFromLayers(layers, thickness);
  const r = A.postQueue(CAM, job.queue, selector(shapes), { arcs: true });
  return { gcode: r.gcode, queue: job.queue, skipped: job.skipped, warnings: r.warnings };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const moves = []; for (let i; (i = args.indexOf('--move')) >= 0;) moves.push(args.splice(i, 2)[1]);
  const T = parseFloat(opt('--thickness') || '1.5'), out = opt('--out');
  const list = args.indexOf('--list') >= 0; if (list) args.splice(args.indexOf('--list'), 1);
  const file = args[0];
  if (!file) { console.error('usage: asmtap.js sheet.dxf [--thickness 1.5] [--out x.tap] [--list] [--move LAYER@X,Y=DX,DY]'); process.exit(2); }
  const shapes = loadDxfShapes(file);
  for (const mv of moves) { const n = moveLoops(shapes, mv); if (!n) { console.error('--move matched nothing: ' + mv); process.exit(1); } }
  const r = postSheet(shapes, T);
  if (list) { r.queue.forEach((q, i) => console.log((i + 1) + '. ' + q.name + '  T' + q.p.toolNum + ' depth ' + q.p.cutDepth + ' · layers ' + q.sel.layers.join(',')));
    r.skipped.forEach(s => console.log('   skipped ' + s.layer + ': ' + s.why)); r.warnings.forEach(w => console.log('   warn: ' + w)); }
  if (out) { fs.writeFileSync(out, r.gcode); console.log('wrote ' + out + ' (' + r.gcode.split(/\r?\n/).length + ' lines)'); }
  else if (!list) process.stdout.write(r.gcode);
}
module.exports = { loadDxfShapes, selector, moveLoops, postSheet };
