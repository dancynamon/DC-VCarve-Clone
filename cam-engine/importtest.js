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

// --- Vectric .tool database import ---------------------------------------------------
// The field layout in tooldbparse.js was derived by hex-dumping, not documented, so it is
// only as good as the ground truth it was checked against. `T5e - Amana 49706 Roundover
// 0.380` was read off Vectric's own Tool Database dialog: every one of these seven numbers
// is what the dialog shows. If the layout is ever wrong, this is where it shows up.
const TDB = require('./tooldbparse.js');
const dbPath = path.join(__dirname, 'fixtures', 'tooldb', 'aquamentor-2026-07-27.tool');
if (!fs.existsSync(dbPath)) {
  ok('tooldb: fixture database present', false, dbPath);
} else {
  const res = TDB.parseToolDb(fs.readFileSync(dbPath));
  ok('tooldb: parses many tools', res.tools.length > 50, res.tools.length);

  const t5e = res.tools.find(t => t.name === 'T5e - Amana 49706 Roundover 0.380');
  ok('tooldb: T5e found', !!t5e);
  if (t5e) {
    const near = (v, t) => Math.abs(v - t) < 1e-6;
    ok('tooldb: T5e number 5', t5e.toolNum === 5, t5e.toolNum);
    ok('tooldb: T5e dia 0.380', near(t5e.dia, 0.38), t5e.dia);
    ok('tooldb: T5e pass depth 0.750', near(t5e.passDepth, 0.75), t5e.passDepth);
    ok('tooldb: T5e stepover 0.304 (80%)', near(t5e.stepover, 0.304) && Math.abs(t5e.stepoverPct - 0.8) < 1e-6, t5e.stepover);
    ok('tooldb: T5e feed 100', near(t5e.feed, 100), t5e.feed);
    ok('tooldb: T5e plunge 25', near(t5e.plunge, 25), t5e.plunge);
    ok('tooldb: T5e spindle 20000', t5e.rpm === 20000, t5e.rpm);
  }

  // the drill is the tool whose speed the parity fixtures got wrong before this importer
  // existed: 10000 rpm, not the 18000 the fixture had hardcoded
  const t8 = res.tools.find(t => t.name === 'T8 - Drill (0.375")');
  ok('tooldb: T8 drill found', !!t8);
  if (t8) {
    ok('tooldb: T8 dia 0.375', Math.abs(t8.dia - 0.375) < 1e-6, t8.dia);
    ok('tooldb: T8 spindle 10000', t8.rpm === 10000, t8.rpm);
    // the stored feed is 62.46; Vectric's dialog and the posted G-code both round it to 62.5
    ok('tooldb: T8 feed posts as 62.5', t8.feed.toFixed(1) === '62.5', t8.feed);
  }

  // every record must be plausible - a mis-derived offset shows up as junk geometry
  ok('tooldb: all diameters plausible', res.tools.every(t => t.dia > 0.001 && t.dia < 12));
  ok('tooldb: all spindles plausible', res.tools.every(t => t.rpm >= 0 && t.rpm <= 120000));
  ok('tooldb: all tool numbers 1..99', res.tools.every(t => t.toolNum >= 1 && t.toolNum < 100));

  // conversion into the app's tool-library shape
  const lib = TDB.toolsToLibrary(res.tools);
  ok('tooldb: library has one entry per tool', lib.length === res.tools.length, lib.length + ' vs ' + res.tools.length);
  ok('tooldb: library ids are unique', new Set(lib.map(t => t.id)).size === lib.length);
  ok('tooldb: library ids are non-empty slugs', lib.every(t => /^[a-z0-9][a-z0-9-]*$/.test(t.id)));
  ok('tooldb: library entries carry every field defaultTools() has',
    lib.every(t => ['id', 'name', 'op', 'toolNum', 'dia', 'angle', 'feed', 'plunge', 'rpm'].every(k => t[k] != null)));
  ok('tooldb: library ops are all known', lib.every(t => ['profile', 'pocket', 'drill', 'vcarve'].includes(t.op)));
  const named = n => lib.find(t => t.name === n);
  ok('tooldb: drill classified as drill', named('T8 - Drill (0.375")').op === 'drill');
  ok('tooldb: V-bit classified as vcarve', named('V-Bit (60 deg 0.25")').op === 'vcarve');
  ok('tooldb: V-bit angle read from name', named('V-Bit (60 deg 0.25")').angle === 60);
  ok('tooldb: end mill classified as profile', named('End Mill (0.25 inch)').op === 'profile');

  // a file that is not a tool database must come back empty with a warning, not with garbage
  const junk = TDB.parseToolDb(Buffer.from('not a vectric tool database, just some ascii text '.repeat(20)));
  ok('tooldb: junk input yields no tools', junk.tools.length === 0, junk.tools.length);
  ok('tooldb: junk input warns', junk.warnings.length > 0);
}

console.log(`\n${pass}/${pass + fail} import checks passed`);
process.exit(fail ? 1 : 0);
