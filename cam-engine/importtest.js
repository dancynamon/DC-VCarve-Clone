// Regression guard for the DXF import path: parse sample.dxf with the studio's parser, then run CAM on it. No DOM.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }

// dxfparse.js is a browser-concatenated script (no module.exports), so run it in a vm context to grab
// the same parseDxf + entityToPolys the studio's importText uses; fall back to CADCORE for poly->shapes.
let parseDxf, entityToPolys, dxfCtx;
try {
  const ctx = {}; vm.createContext(ctx); dxfCtx = ctx;
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8'), ctx);
  parseDxf = ctx.parseDxf; entityToPolys = ctx.entityToPolys;
} catch (e) { /* leave undefined -> check below fails clearly */ }
ok('dxfparse exposes parseDxf + entityToPolys', typeof parseDxf === 'function' && typeof entityToPolys === 'function');

const dxf = fs.readFileSync(path.join(__dirname, 'sample.dxf'), 'utf8');
const ents = parseDxf(dxf);
const polys = []; for (const e of ents) for (const p of entityToPolys(e)) polys.push(p);
const shapes = C.dxfPolysToShapes(polys);

ok('import yields >=2 shapes', shapes.length >= 2, shapes.length);
const totalPts = shapes.reduce((n, s) => n + (s.pts ? s.pts.length : 0), 0);
ok('import has >0 total points', totalPts > 0, totalPts);
ok('at least one closed shape', shapes.some(s => s.closed), JSON.stringify(shapes.map(s => s.closed)));

const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
const res = CAM.profileOp(contours, { side: 'outside', toolDia: 0.25, cutDepth: 0.25, passDepth: 0.5 });
ok('profileOp on imported shapes has passes', res.ops[0].passes.length > 0, res.ops[0].passes.length);
const g = CAM.postProcess({ name: 'import', units: 'inch', ops: res.ops }, CAM.POSTS.shopsabre);
ok('postProcess produces g-code', g.length > 0 && /G90/.test(g), g.length);

// --- BLOCK/INSERT explosion: two INSERTs of one block expand to two placed shapes ---
const dxfB = fs.readFileSync(path.join(__dirname, 'sample-block.dxf'), 'utf8');
const entsB = parseDxf(dxfB);
const polysB = []; for (const e of entsB) for (const p of entityToPolys(e)) polysB.push(p);
const shapesB = C.dxfPolysToShapes(polysB);
ok('block: 2 INSERTs expand to >=2 shapes', shapesB.length >= 2, shapesB.length);
ok('block: >=2 closed shapes', shapesB.filter(s => s.closed).length >= 2, shapesB.filter(s => s.closed).length);
const at = (x, y) => shapesB.some(s => { const b = C.bbox(s); return Math.abs(b.minX - x) < 1e-6 && Math.abs(b.minY - y) < 1e-6; });
ok('block: instance placed at (3,3)', at(3, 3), JSON.stringify(shapesB.map(s => { const b = C.bbox(s); return [b.minX, b.minY]; })));
ok('block: instance placed at (8,5)', at(8, 5));
const cB = CAM.assembleContours(C.shapesToContoursInput(shapesB));
const rB = CAM.profileOp(cB, { side: 'outside', toolDia: 0.25, cutDepth: 0.25, passDepth: 0.5 });
ok('block: profileOp on exploded inserts has passes', rB.ops[0].passes.length > 0, rB.ops[0].passes.length);
const gB = CAM.postProcess({ name: 'block', units: 'inch', ops: rB.ops }, CAM.POSTS.shopsabre);
ok('block: postProcess produces g-code', gB.length > 0 && /G90/.test(gB), gB.length);

// Non-uniform INSERT scale: CIRC block (circle r=0.75 at cx=1,cy=0.75) inserted with sx=2,sy=1
// → the tessellated circle's world bbox should be ~3.0 wide x 1.5 tall (ratio ≈ 2.0)
const stretchedShape = shapesB.find(s => {
  const b = C.bbox(s); const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return h > 0.1 && w / h > 1.8 && w / h < 2.2;
});
ok('non-uniform INSERT: stretched circle width~2x height', !!stretchedShape,
  JSON.stringify(shapesB.map(s => { const b = C.bbox(s); return { w: (b.maxX - b.minX).toFixed(2), h: (b.maxY - b.minY).toFixed(2) }; })));

// --- SVG import: rect + closed triangle path with viewBox (exercises y-flip) ---
const svgText = fs.readFileSync(path.join(__dirname, 'sample.svg'), 'utf8');
const svgShapes = C.svgToShapes(svgText);
ok('svg: >=2 shapes', svgShapes.length >= 2, svgShapes.length);
const svgPts = svgShapes.reduce((n, s) => n + (s.pts ? s.pts.length : 0), 0);
ok('svg: >0 total points', svgPts > 0, svgPts);
ok('svg: >=1 closed shape', svgShapes.some(s => s.closed), JSON.stringify(svgShapes.map(s => s.closed)));
ok('svg: >=2 closed shapes (rect and triangle both closed)', svgShapes.filter(s => s.closed).length >= 2, svgShapes.filter(s => s.closed).length);
const svgC = CAM.assembleContours(C.shapesToContoursInput(svgShapes));
const svgRes = CAM.profileOp(svgC, { side: 'outside', toolDia: 0.25, cutDepth: 0.25, passDepth: 0.5 });
ok('svg: profileOp has passes', svgRes.ops[0].passes.length > 0, svgRes.ops[0].passes.length);
const svgG = CAM.postProcess({ name: 'svgimport', units: 'inch', ops: svgRes.ops }, CAM.POSTS.shopsabre);
ok('svg: postProcess produces g-code', svgG.length > 0 && /G90/.test(svgG), svgG.length);

// --- ELLIPSE in BLOCK/INSERT: verifies dxfApplyPair + dxfTransformEntity handle ELLIPSE type ---
const dxfE = fs.readFileSync(path.join(__dirname, 'sample-ellipse-block.dxf'), 'utf8');
const entsE = parseDxf(dxfE);
const polysE = []; for (const e of entsE) for (const p of entityToPolys(e)) polysE.push(p);
const shapesE = C.dxfPolysToShapes(polysE);
ok('ellipse block: >=1 shape from exploded INSERT', shapesE.length >= 1, shapesE.length);
const totalPtsE = shapesE.reduce((n, s) => n + (s.pts ? s.pts.length : 0), 0);
ok('ellipse block: >0 total points', totalPtsE > 0, totalPtsE);

// --- DXF round-trip: export imported shapes back to DXF, re-parse, assert shape count preserved ---
const dxfOut = C.toDXF(shapes);
const entsRT = parseDxf(dxfOut);
const polysRT = []; for (const e of entsRT) for (const p of entityToPolys(e)) polysRT.push(p);
const shapesRT = C.dxfPolysToShapes(polysRT);
ok('dxf round-trip: >=2 shapes', shapesRT.length >= 2, shapesRT.length);
ok('dxf round-trip: >=1 closed shape', shapesRT.some(s => s.closed), JSON.stringify(shapesRT.map(s => s.closed)));

// --- SVG round-trip: export imported shapes to SVG, re-import, assert shape count preserved ---
const svgOut = C.toSVG(shapes);
const shapesRTsvg = C.svgToShapes(svgOut);
ok('svg round-trip: >=2 shapes', shapesRTsvg.length >= 2, shapesRTsvg.length);
ok('svg round-trip: >=1 closed shape', shapesRTsvg.some(s => s.closed), JSON.stringify(shapesRTsvg.map(s => s.closed)));

// --- adaptive arc tessellation: chord sag must stay <= ~0.004" regardless of radius ---
// A fixed angular step made the flat-sidedness scale with radius (a 2.875" round end came in 0.0138"
// off, a 12" one 0.058"). Measure the worst departure of each chord from the true arc.
function maxSag(pts, cx, cy, r) {
  let worst = 0;
  for (let i = 1; i < pts.length; i++) {
    const c = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    worst = Math.max(worst, r - Math.sqrt(Math.max(0, r * r - c * c / 4)));
  }
  return worst;
}
function radial(pts, cx, cy, r) { let w = 0; for (const p of pts) w = Math.max(w, Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)); return w; }
const SAG_LIMIT = 0.0045;
for (const r of [0.5, 2.875, 12, 40]) {
  const cp = dxfCtx.circlePts(0, 0, r);
  ok(`circlePts r=${r}: sag <= ${SAG_LIMIT}"`, maxSag(cp, 0, 0, r) <= SAG_LIMIT, maxSag(cp, 0, 0, r).toFixed(5));
  ok(`circlePts r=${r}: on circle`, radial(cp, 0, 0, r) < 1e-9);
  const ap = dxfCtx.arcPts(0, 0, r, 0, 90);
  ok(`arcPts r=${r}: sag <= ${SAG_LIMIT}"`, maxSag(ap, 0, 0, r) <= SAG_LIMIT, maxSag(ap, 0, 0, r).toFixed(5));
  // 90-degree bulge (tan(90/4)) from (r,0) to (0,r) about the origin
  const bp = dxfCtx.bulgeArcPts({ x: r, y: 0 }, { x: 0, y: r }, Math.tan(Math.PI / 8));
  ok(`bulgeArcPts r=${r}: sag <= ${SAG_LIMIT}"`, maxSag(bp, 0, 0, r) <= SAG_LIMIT, maxSag(bp, 0, 0, r).toFixed(5));
  ok(`bulgeArcPts r=${r}: on circle`, radial(bp, 0, 0, r) < 1e-6, radial(bp, 0, 0, r));
  const ep = dxfCtx.ellipsePts({ cx: 0, cy: 0, majorX: r, majorY: 0, ratio: 1 });
  ok(`ellipsePts r=${r}: sag <= ${SAG_LIMIT}"`, maxSag(ep, 0, 0, r) <= SAG_LIMIT, maxSag(ep, 0, 0, r).toFixed(5));
}
// small radii must not explode into needless points
ok('circlePts r=0.5 stays compact', dxfCtx.circlePts(0, 0, 0.5).length <= 80, dxfCtx.circlePts(0, 0, 0.5).length);
ok('circlePts r=40 refines', dxfCtx.circlePts(0, 0, 40).length > 64, dxfCtx.circlePts(0, 0, 40).length);

// --- repost.js: DXF -> CAM -> G-code with no browser (used to regenerate jobs whose only source is a .dxf) ---
const RP = require('./repost.js');
const rp = RP.repost(dxf, { toolDia: 0.25, side: 'outside', climb: false, cutDepth: 0.25, passDepth: 0.25,
                            feed: 100, plunge: 30, rpm: 24000, clearZ: 0.8, leadType: 'line', leadLen: 0.25 });
ok('repost: contours found', rp.contours >= 2, rp.contours);
ok('repost: emits g-code', /G90/.test(rp.gcode) && /M50/.test(rp.gcode), rp.gcode.length);
ok('repost: one pass per closed contour', rp.passes === rp.closed, `${rp.passes} vs ${rp.closed}`);
ok('repost: rapids retract to clearZ', /G0 Z0\.8000/.test(rp.gcode));
ok('repost: cut depth honoured', /Z-0\.2500/.test(rp.gcode));
ok('repost: plunge feed applied', /F30\.0/.test(rp.gcode));
ok('repost: spindle speed applied', /S24000/.test(rp.gcode));
ok('repost: no warnings on sample.dxf', rp.warnings.length === 0, JSON.stringify(rp.warnings));

console.log(`\n${pass}/${pass + fail} import checks passed`);
process.exit(fail ? 1 : 0);
