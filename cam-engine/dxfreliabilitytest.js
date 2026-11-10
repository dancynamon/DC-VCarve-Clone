// Guard for the DXF reader/writer: units, true splines, what is dropped being named, mirrors, OCS, and edit-save-reopen.
const fs = require('fs'), path = require('path'), vm = require('vm');
const C = require('./cadcore.js');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8') + ';this.parseDxf=parseDxf;this.entityToPolys=entityToPolys;this.dxfDeBoor=dxfDeBoor;', ctx);
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t === undefined ? 1e-6 : t);
const wrap = body => ['0', 'SECTION', '2', 'ENTITIES'].concat(body, ['0', 'ENDSEC', '0', 'EOF']).join('\n');
const header = v => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(v), '0', 'ENDSEC'];
const importDxf = t => { const ents = ctx.parseDxf(t), polys = []; for (const e of ents) for (const p of ctx.entityToPolys(e)) polys.push(p); return { ents, polys, shapes: C.dxfPolysToShapes(polys) }; };
const boxOf = pts => pts.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
const line = (x1, y1, x2, y2) => ['0', 'LINE', '8', 'L', '10', x1, '20', y1, '11', x2, '21', y2];

// ---- refusal messages ----
try { ctx.parseDxf(''); ok('zero-byte DXF throws', false); } catch (e) { ok('zero-byte DXF says so', /empty \(0 bytes\)/.test(e.message), e.message); }
try { ctx.parseDxf('AutoCAD Binary DXF\r\n\x1a\0'); ok('binary DXF throws', false); } catch (e) { ok('binary DXF says so', /binary DXF/.test(e.message), e.message); }

// ---- units ----
{
  const t = header(2).concat(['0', 'SECTION', '2', 'ENTITIES'], line(0, 0, 10, 0), ['0', 'ENDSEC', '0', 'EOF']).join('\n');
  const r = importDxf(t);
  ok('$INSUNITS=2 feet scaled to inches', near(r.shapes[0].pts[1].x, 120), r.shapes[0].pts[1].x);
  ok('feet scale is reported', r.ents.report.some(x => x.code === 'UNITS_SCALED' && x.level === 'warn'));
  const mm = importDxf(header(4).concat(['0', 'SECTION', '2', 'ENTITIES'], line(0, 0, 25.4, 0), ['0', 'ENDSEC', '0', 'EOF']).join('\n'));
  ok('$INSUNITS=4 mm scaled to inches', near(mm.shapes[0].pts[1].x, 1));
  const none = importDxf(wrap(line(0, 0, 5, 0)));
  ok('no units stated reads as inches, noted', near(none.shapes[0].pts[1].x, 5) && none.ents.report.some(x => x.code === 'UNITS_ASSUMED' && x.level === 'info'));
  const inch = importDxf(header(1).concat(['0', 'SECTION', '2', 'ENTITIES'], line(0, 0, 5, 0), ['0', 'ENDSEC', '0', 'EOF']).join('\n'));
  ok('inches are clean', inch.ents.report.length === 0, JSON.stringify(inch.ents.report));
}
// ---- real splines ----
{
  // A clamped cubic with four control points is one Bezier: B(0.5) = (P0+3P1+3P2+P3)/8. Catmull-Rom through the control points is nowhere near it.
  const s = ['0', 'SPLINE', '8', 'S', '70', '8', '71', '3', '72', '8', '73', '4', '74', '0'];
  for (const k of [0, 0, 0, 0, 1, 1, 1, 1]) s.push('40', k);
  for (const [x, y] of [[0, 0], [0, 10], [10, 10], [10, 0]]) s.push('10', x, '20', y);
  const r = importDxf(wrap(s));
  const pts = r.polys[0].pts, want = { x: 5, y: 7.5 };
  const dev = Math.min(...pts.map(p => Math.hypot(p.x - want.x, p.y - want.y)));
  ok('true spline passes through its Bezier midpoint', dev < 0.01, dev);
  ok('true spline is not the control polygon', Math.max(...pts.map(p => p.y)) <= 7.5 + 1e-6, Math.max(...pts.map(p => p.y)));
  const fitOnly = ['0', 'SPLINE', '8', 'S', '70', '8', '71', '3', '74', '4'];
  for (const [x, y] of [[0, 0], [1, 2], [2, 0], [3, 2]]) fitOnly.push('11', x, '21', y);
  const f = importDxf(wrap(fitOnly));
  ok('fit-point spline is reported as approximate', f.ents.report.some(x => x.code === 'SPLINE_FIT_ONLY' && x.level === 'warn') && f.polys.length === 1, JSON.stringify(f.ents.report));
  const bad = importDxf(wrap(['0', 'SPLINE', '8', 'S', '70', '8', '71', '3']));
  ok('unreadable spline is named', bad.ents.report.some(x => x.code === 'SPLINE_UNREADABLE' && x.level === 'loss'));
}
// ---- what is dropped says so ----
{
  const r = importDxf(wrap(line(0, 0, 1, 0).concat(['0', 'TEXT', '8', 'L', '10', '0', '20', '0', '40', '1', '1', 'HELLO'], ['0', 'MTEXT', '8', 'L', '10', '0', '20', '0', '40', '1', '1', 'WORLD'], ['0', 'HATCH', '8', 'L'], ['0', 'POINT', '8', 'L', '10', '1', '20', '2'], ['0', 'DIMENSION', '8', 'L'])));
  const t = r.ents.report.find(x => x.code === 'DROPPED_TEXT');
  ok('TEXT is reported with its strings', t && t.level === 'loss' && t.count === 2 && t.items.join().indexOf('HELLO') >= 0, JSON.stringify(t));
  ok('other entity types are named', ['DROPPED_HATCH', 'DROPPED_POINT', 'DROPPED_DIMENSION'].every(c => r.ents.report.some(x => x.code === c)), JSON.stringify(r.ents.report.map(x => x.code)));
  ok('the geometry that can import still does', r.shapes.length === 1);
  const paper = importDxf(wrap(line(0, 0, 1, 0).concat(['0', 'LINE', '8', 'L', '67', '1', '10', '9', '20', '9', '11', '8', '21', '8'])));
  ok('paper space is not imported as model', paper.shapes.length === 1 && paper.ents.report.some(x => x.code === 'PAPER_SPACE'), JSON.stringify(paper.ents.report));
  const tilt = importDxf(wrap(['0', 'CIRCLE', '8', 'L', '10', '0', '20', '0', '40', '1', '210', '0.7', '220', '0', '230', '0.7']));
  ok('a tilted entity is refused and named', tilt.shapes.length === 0 && tilt.ents.report.some(x => x.code === 'TILTED'));
}
// ---- blocks ----
const blockDoc = (insert, body) => ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B', '10', '0', '20', '0'].concat(body, ['0', 'ENDBLK', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'], insert, ['0', 'ENDSEC', '0', 'EOF']).join('\n');
{
  const arc = ['0', 'ARC', '8', 'L', '10', '0', '20', '0', '40', '1', '50', '0', '51', '90'];
  const r = importDxf(blockDoc(['0', 'INSERT', '2', 'B', '10', '0', '20', '0', '41', '-1', '42', '1'], arc));
  const pts = r.polys[0].pts;
  ok('mirrored INSERT arc stays in the right quadrant', pts.every(p => p.x <= 1e-9 && p.y >= -1e-9), JSON.stringify(pts.slice(0, 2)));
  ok('mirrored INSERT arc is the short way', pts.length < 200 && near(boxOf(pts).x0, -1, 0.01) && near(boxOf(pts).y1, 1, 0.01));
  const lw = ['0', 'LWPOLYLINE', '8', 'L', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '2', '20', '0'];
  const m = importDxf(blockDoc(['0', 'INSERT', '2', 'B', '10', '0', '20', '0', '41', '-1', '42', '1'], lw));
  // bulge +1 from (0,0) to (2,0) sweeps below the chord; mirrored in X it runs -x and must still sweep below
  ok('mirrored INSERT polyline bulge flips', near(boxOf(m.polys[0].pts).y0, -1, 0.02) && near(boxOf(m.polys[0].pts).y1, 0, 0.02), JSON.stringify(boxOf(m.polys[0].pts)));
  const sy = importDxf(blockDoc(['0', 'INSERT', '2', 'B', '10', '0', '20', '0', '41', '3'], line(0, 0, 0, 1)));
  ok('INSERT Y scale defaults to 1, not to X scale', near(sy.shapes[0].pts[1].y, 1) && near(sy.shapes[0].pts[1].x, 0), JSON.stringify(sy.shapes[0].pts));
  const arr = importDxf(blockDoc(['0', 'INSERT', '2', 'B', '10', '0', '20', '0', '70', '3', '71', '2', '44', '5', '45', '7'], line(0, 0, 1, 0)));
  ok('MINSERT expands its rows and columns', arr.shapes.length === 6 && near(Math.max(...arr.shapes.map(s => s.pts[0].y)), 7) && near(Math.max(...arr.shapes.map(s => s.pts[0].x)), 10), arr.shapes.length);
  const miss = importDxf(wrap(['0', 'INSERT', '2', 'NOPE', '10', '0', '20', '0']));
  ok('a missing block is named', miss.ents.report.some(x => x.code === 'MISSING_BLOCK' && x.items[0] === 'NOPE'));
}
// ---- OCS extrusion ----
{
  const c = importDxf(wrap(['0', 'CIRCLE', '8', 'L', '10', '5', '20', '3', '40', '1', '230', '-1']));
  ok('flipped circle mirrors in X', near(boxOf(c.polys[0].pts).x0, -6, 0.01) && near(boxOf(c.polys[0].pts).x1, -4, 0.01), JSON.stringify(boxOf(c.polys[0].pts)));
  const a = importDxf(wrap(['0', 'ARC', '8', 'L', '10', '0', '20', '0', '40', '1', '50', '0', '51', '90', '230', '-1']));
  ok('flipped arc lands in the mirrored quadrant', a.polys[0].pts.every(p => p.x <= 1e-9 && p.y >= -1e-9), JSON.stringify(a.polys[0].pts.slice(0, 2)));
  const p = importDxf(wrap(['0', 'LWPOLYLINE', '8', 'L', '90', '2', '70', '0', '230', '-1', '10', '0', '20', '0', '42', '1', '10', '2', '20', '0']));
  ok('flipped polyline bulge', near(boxOf(p.polys[0].pts).y0, -1, 0.02) && near(boxOf(p.polys[0].pts).x1, 0, 0.02), JSON.stringify(boxOf(p.polys[0].pts)));
  const l = importDxf(wrap(['0', 'LINE', '8', 'L', '230', '-1', '10', '5', '20', '0', '11', '6', '21', '0']));
  ok('LINE is in world coordinates, extrusion ignored', near(l.shapes[0].pts[0].x, 5));
}
// ---- partial ellipses ----
{
  const ell = (s0, s1) => ['0', 'ELLIPSE', '8', 'L', '10', '0', '20', '0', '11', '2', '21', '0', '40', '0.5', '41', s0, '42', s1];
  ok('a full ellipse is closed', importDxf(wrap(ell(0, 6.283185307179586))).shapes[0].closed === true);
  const half = importDxf(wrap(ell(0, Math.PI)));
  ok('a half ellipse stays open', half.shapes[0].closed === false && near(boxOf(half.polys[0].pts).y0, 0, 1e-6), JSON.stringify(boxOf(half.polys[0].pts)));
}
// ---- export ----
{
  const arcPts = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI; arcPts.push({ x: 1 + 2 * Math.cos(a), y: 2 * Math.sin(a) }); }
  const shapes = [C.mkRect(0, 0, 4, 2, 'CUT'), C.mkCircle({ x: 10, y: 10 }, 2.5, 'HOLES'), C.mkPoly(arcPts, false, 'ARC')];
  const layers = new Map([['CUT', { color: '#ff0000' }], ['HOLES', { color: '#0000ff' }], ['ARC', { color: '#00a000' }], ['EMPTY', { color: '#808080' }]]);
  const t = C.toDXF(shapes, { layers });
  ok('export declares inches', /\$INSUNITS\r\n70\r\n1/.test(t));
  ok('export writes a LAYER table with colours', /\n2\r\nCUT\r\n70\r\n0\r\n62\r\n1\r\n/.test(t) && /\n2\r\nHOLES\r\n70\r\n0\r\n62\r\n5/.test(t), t.slice(0, 200));
  ok('export keeps an empty layer', /\n2\r\nEMPTY\r\n70/.test(t));
  ok('a circle exports as a CIRCLE', /\nCIRCLE\r\n/.test(t) && /\n40\r\n2\.500000/.test(t));
  ok('an arc exports with a bulge, 6 decimals', /\n42\r\n-?\d\.\d{6}/.test(t) && (t.match(/LWPOLYLINE/g) || []).length === 2);
  const back = importDxf(t);
  ok('round trip: same shape count', back.shapes.length === 3, back.shapes.length);
  ok('round trip: layers named', ['CUT', 'HOLES', 'ARC'].every(n => back.polys.some(p => p.layer === n)));
  ok('round trip: closure', back.shapes.map(s => s.closed).join() === 'true,true,false', back.shapes.map(s => s.closed).join());
  const arcBack = back.polys.find(p => p.layer === 'ARC').pts;
  ok('round trip: the arc is true (every point on its radius)', arcBack.every(p => near(Math.hypot(p.x - 1, p.y), 2, 1e-5)), Math.max(...arcBack.map(p => Math.abs(Math.hypot(p.x - 1, p.y) - 2))));
  const tbl = {}; C.registerDxfLayers(new Map(), back.polys.map(p => p), back.ents.layerTable);
  ok('round trip: the LAYER table restores colours', back.ents.layerTable.CUT.color === 1 && back.ents.layerTable.HOLES.color === 5, JSON.stringify(back.ents.layerTable));
  const reg = new Map(); C.registerDxfLayers(reg, back.polys, back.ents.layerTable);
  ok('round trip: registered layers keep their colour', reg.get('CUT').color === '#ff0000' && reg.get('HOLES').color === '#0000ff', JSON.stringify([...reg]));
  // edit, save, reopen
  const moved = back.shapes.map(s => C.translate(s, 1.5, -0.25));
  const again = importDxf(C.toDXF(moved));
  const boxA = boxOf(back.shapes.flatMap(s => s.pts)), boxB = boxOf(again.shapes.flatMap(s => s.pts));
  ok('edit + save + reopen moves everything by exactly the edit', near(boxB.x0, boxA.x0 + 1.5, 1e-4) && near(boxB.y1, boxA.y1 - 0.25, 1e-4), JSON.stringify([boxA, boxB]));
  const jagged = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
  const j = C.dxfLoopVertices(jagged, false);
  ok('a staircase is not mistaken for an arc', j.verts.every(v => !v.bulge) && j.verts.length === 5);
  const oct = []; for (let i = 0; i < 8; i++) oct.push({ x: 5 * Math.cos(i * Math.PI / 4), y: 5 * Math.sin(i * Math.PI / 4) });
  const o = C.dxfLoopVertices(oct, true);
  ok('a real polygon is not rounded', !o.circle && o.verts.every(v => !v.bulge), JSON.stringify(o));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
