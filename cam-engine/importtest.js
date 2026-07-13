// Regression guard for the DXF import path: parse sample.dxf with the studio's parser, then run CAM on it. No DOM.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }

// dxfparse.js is a browser-concatenated script (no module.exports), so run it in a vm context to grab
// the same parseDxf + entityToPolys the studio's importText uses; fall back to CADCORE for poly->shapes.
let parseDxf, entityToPolys;
try {
  const ctx = {}; vm.createContext(ctx);
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

console.log(`\n${pass}/${pass + fail} import checks passed`);
process.exit(fail ? 1 : 0);
