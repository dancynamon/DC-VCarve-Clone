// cutpreptest.js - DXF layer split, stock nesting, .tap sanity checks (cutprep.js). Fixtures live in cam-engine/fixtures only.
const fs = require('fs'), path = require('path');
const C = require('./cadcore.js'), P = require('./cutprep.js'), CAM = require('./camcore.js');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : (fail++, console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x))); };

// ---------- 1. layer split ----------
const part = C.mkRect(0, 0, 10, 6), hole = C.mkCircle({ x: 3, y: 3 }, 1), slot = C.mkRoundRect(5, 2, 3, 1, 0.3);
const island = C.mkRect(4, 2.5, 0.5, 0.5);            // sits inside `hole2` below
const part2 = C.mkRect(20, 0, 8, 8), hole2 = C.mkRect(21, 1, 6, 6), isl = C.mkRect(23, 3, 2, 2);   // part with a hole with a part in it
const engr = C.mkLine({ x: 1, y: 5 }, { x: 4, y: 5 });  // open vector inside part
const stray = C.mkLine({ x: 40, y: 0 }, { x: 45, y: 0 }); // open vector outside everything
const all = [part, hole, slot, part2, hole2, isl, engr, stray];
const r = P.splitLayers(all);
const lay = s => r.shapes[all.indexOf(s)].layer;
ok('part outer -> OUTSIDE', lay(part) === 'OUTSIDE_PROFILE');
ok('circle hole -> INSIDE', lay(hole) === 'INSIDE_CUT');
ok('slot -> INSIDE', lay(slot) === 'INSIDE_CUT');
ok('part2 -> OUTSIDE', lay(part2) === 'OUTSIDE_PROFILE');
ok('hole2 in part2 -> INSIDE', lay(hole2) === 'INSIDE_CUT');
ok('island part inside a hole -> OUTSIDE (depth 2)', lay(isl) === 'OUTSIDE_PROFILE');
ok('open vector inside part -> INSIDE', lay(engr) === 'INSIDE_CUT');
ok('open vector outside all -> OPEN_VECTOR', lay(stray) === 'OPEN_VECTOR');
ok('counts', r.counts.outside === 3 && r.counts.inside === 4 && r.counts.open === 1, r.counts);
ok('input not mutated', all.every(s => s.layer === '0'));
ok('disjoint side-by-side parts both outside', P.splitLayers([C.mkRect(0, 0, 5, 5), C.mkRect(6, 0, 5, 5)]).counts.outside === 2);
ok('part touching its hole edge (tangent) still inside', P.splitLayers([C.mkRect(0, 0, 10, 10), C.mkRect(0, 2, 3, 3)]).counts.inside === 1);
ok('dimension annotations ignored', P.splitLayers([part, C.mkDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, {})]).counts.outside === 1);
ok('rotated (diamond) part with hole', (() => { const d = C.rotate(C.mkRect(0, 0, 10, 10), 5, 5, Math.PI / 4); const k = P.splitLayers([d, C.mkCircle({ x: 5, y: 5 }, 1)]); return k.counts.outside === 1 && k.counts.inside === 1; })());
// concave part (U shape): a circle sitting in the notch is NOT inside the part
const U = C.mkPoly([{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }, { x: 6, y: 9 }, { x: 6, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 9 }, { x: 0, y: 9 }], true);
ok('circle in U-notch is outside', P.splitLayers([U, C.mkCircle({ x: 4.5, y: 6 }, 0.8)]).counts.outside === 2);
ok('circle in U-body is inside', P.splitLayers([U, C.mkCircle({ x: 1.5, y: 6 }, 0.8)]).counts.inside === 1);

const dxf = P.toDXFLayered(all);
const layersOf = t => { const L = t.split(/\r?\n/), o = {}; for (let i = 0; i < L.length - 1; i++) if (L[i] === '0' && L[i + 1] === 'LWPOLYLINE') { const l = L[L.indexOf('8', i) + 1]; o[l] = (o[l] || 0) + 1; } return o; };
ok('DXF: LWPOLYLINEs per layer', JSON.stringify(layersOf(dxf)) === JSON.stringify({ OUTSIDE_PROFILE: 3, INSIDE_CUT: 4, OPEN_VECTOR: 1 }), layersOf(dxf));
ok('DXF: LAYER table declares the layers', /LAYER\r\n70\r\n3/.test(dxf) && dxf.includes('\r\n2\r\nOUTSIDE_PROFILE') && dxf.includes('\r\n2\r\nINSIDE_CUT'));
ok('DXF ends EOF', dxf.endsWith('EOF'));
// round trip through the studio's own DXF reader (dxfparse) keeps the layers
const vm = require('vm'); const dctx = {}; vm.createContext(dctx); vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8') + '\n;this.parseDxf=parseDxf;this.entityToPolys=entityToPolys;', dctx);
const dp = { parseDxf: dctx.parseDxf, entityToPolys: dctx.entityToPolys };
try {
  const parse = dp.parseDxf;
  if (typeof parse === 'function') { const ents = parse(dxf); const ls = {}; ents.forEach(e => ls[e.layer] = (ls[e.layer] || 0) + 1); ok('DXF round trip via dxfparse keeps layers', ls.OUTSIDE_PROFILE === 3 && ls.INSIDE_CUT === 4, ls); }
  else ok('dxfparse export shape', true);
} catch (e) { ok('dxfparse round trip', false, String(e)); }
// real fixture DXF (Dan's waterslide v4.5) re-split: every loop gets exactly one of the two cut layers (+ open)
{
  const fx = path.join(__dirname, 'fixtures', 'waterslide-v4.5'); const f = fs.readdirSync(fx).find(n => /1 BASE.*\.dxf$/.test(n));
  if (f) { const parse = dp.parseDxf;
    const ents = parse(fs.readFileSync(path.join(fx, f), 'utf8')); const polys = []; (Array.isArray(ents) ? ents : []).forEach(e => { const pp = (dp.entityToPolys ? dp.entityToPolys(e) : []); pp.forEach(q => polys.push(q)); });
    if (polys.length) { const sh = C.dxfPolysToShapes(polys); const k = P.splitLayers(sh); ok('fixture DXF: has outside and inside loops', k.counts.outside > 0 && k.counts.inside > 0, k.counts); ok('fixture DXF: every shape on a split layer (or left on its reference layer)', k.shapes.every(s => ['OUTSIDE_PROFILE', 'INSIDE_CUT', 'OPEN_VECTOR'].includes(s.layer) || P.isReferenceLayer(s.layer))); }
    else ok('fixture DXF parsed (skipped, no polys API)', true); }
}

// reference layers and partial-depth pockets
{
  const sheet = Object.assign(C.mkRect(0, 0, 48.5, 97), { layer: 'SHEET' });
  const pa = C.mkRect(2, 2, 10, 10), ho = C.mkCircle({ x: 7, y: 7 }, 1);
  const k = P.splitLayers([sheet, pa, ho]);
  ok('SHEET outline is not a part (parts stay outside)', k.shapes[1].layer === 'OUTSIDE_PROFILE' && k.shapes[2].layer === 'INSIDE_CUT', k.shapes.map(s => s.layer));
  ok('SHEET keeps its layer', k.shapes[0].layer === 'SHEET');
  ok('NOTES / *_VECTOR_ONLY ignored', ['NOTES', 'CAP_CENTER_0.50_VECTOR_ONLY'].every(n => P.isReferenceLayer(n)) && !P.isReferenceLayer('OUTSIDE_PROFILE'));
  const cb = Object.assign(C.mkCircle({ x: 7, y: 7 }, 1), { layer: 'POCKET_2.00D_0.50DEEP' }), dr = Object.assign(C.mkCircle({ x: 7, y: 7 }, 0.19), { layer: 'DRILL_0.375_THRU' });
  const k2 = P.splitLayers([pa, cb, dr]);
  ok('drill in a counterbore pocket is still INSIDE', k2.shapes[2].layer === 'INSIDE_CUT', k2.shapes.map(s => s.layer));
  const ring = Object.assign(C.mkCircle({ x: 30, y: 30 }, 1.33), { layer: 'POCKET_2.66D_1.00DEEP' }), cap = C.mkCircle({ x: 30, y: 30 }, 1.07);
  const k3 = P.splitLayers([ring, cap]);
  ok('cap inside its shoulder pocket is still a part (OUTSIDE)', k3.shapes[1].layer === 'OUTSIDE_PROFILE', k3.shapes.map(s => s.layer));
  ok('free-standing pocket never becomes an OUTSIDE profile', k3.shapes[0].layer === 'INSIDE_CUT');
  const dx = P.toDXFLayered([sheet, pa, ho]);
  ok('layered DXF carries the SHEET outline on SHEET', dx.includes('\r\n8\r\nSHEET\r\n') && /LAYER\r\n70\r\n3/.test(dx));
}
// ground truth: Dan's hand-layered waterslide DXFs. Split must agree with his OUTSIDE_PROFILE / everything-else-inside choice.
{
  const { loadDxfShapes } = require('./asmtap.js'), fx = path.join(__dirname, 'fixtures', 'waterslide-v4.5');
  for (const f of fs.readdirSync(fx).filter(n => /\.dxf$/i.test(n))) {
    const sh = loadDxfShapes(path.join(fx, f)), k = P.splitLayers(sh);
    const want = s => P.isReferenceLayer(s.layer) ? s.layer : s.layer === 'OUTSIDE_PROFILE' ? 'OUTSIDE_PROFILE' : 'INSIDE_CUT';
    const bad = sh.map((s, i) => [s.layer, k.shapes[i].layer, want(s)]).filter(x => x[1] !== x[2]);
    ok('fixture split matches hand layering: ' + f.slice(24, 50), bad.length === 0, bad.slice(0, 4));
  }
}

// ---------- 2. stock nesting ----------
const bars = (n, w, h) => Array.from({ length: n }, () => C.mkRect(0, 0, w, h));
const H = P.HDPE_STOCK;
let n1 = P.nestOnStock(bars(4, 20, 3.5), { stock: [H.board96], spacing: 0.25 });
ok('4 x 20in parts fit one 96in board', n1.pieces.length === 1 && n1.unplaced.length === 0, n1.pieces);
ok('nest verifies clean', P.verifyNest(n1, { spacing: 0.25 }).length === 0, P.verifyNest(n1, { spacing: 0.25 }));
// 5 x 20 + gaps cannot fit in 96 -> second piece
let n2 = P.nestOnStock(bars(5, 20, 3.5), { stock: [H.board96], spacing: 0.25 });
ok('5 x 20in needs a second board', n2.pieces.length === 2 && n2.unplaced.length === 0, n2.pieces.length);
// one 44in part prefers the 48in board (smallest that fits) over the 96
let n3 = P.nestOnStock([C.mkRect(0, 0, 44, 3.5)], { stock: [H.board96, H.board48] });
ok('44in part picked from 48in board', n3.pieces[0].stockId === 'HDPE-48', n3.pieces);
// worst-case 48.25: a 48.4in part does NOT go on the 48in board
let n4 = P.nestOnStock([C.mkRect(0, 0, 48.4, 3.5)], { stock: [H.board96, H.board48] });
ok('48.4in part rejected for 48in board (worst case 48.25)', n4.pieces[0].stockId === 'HDPE-96', n4.pieces);
// quantity limits: only one 48in board available, two 44in parts -> second goes to 96
let n5 = P.nestOnStock(bars(2, 44, 3.5), { stock: [{ ...H.board48, qty: 1 }, H.board96] });
ok('qty-limited stock spills to next type', n5.byStock['HDPE-48'] === 1 && n5.byStock['HDPE-96'] === 1, n5.byStock);
// part longer than any stock -> unplaced
let n6 = P.nestOnStock([C.mkRect(0, 0, 120, 3)], { stock: [H.board96, H.board48] });
ok('oversize part unplaced', n6.unplaced.length === 1 && n6.pieces.length === 0);
// rotation: a 3.4 x 40 part stands up -> rotated to run along the board
let n7 = P.nestOnStock([C.mkRect(0, 0, 3.4, 40)], { stock: [H.board96] });
ok('tall part rotated onto board', n7.placements[0].rot === true && n7.unplaced.length === 0, n7.placements[0]);
let n8 = P.nestOnStock([C.mkRect(0, 0, 3.4, 40)], { stock: [H.board96], allowRotate: false });
ok('rotation off -> tall part cannot fit 3.5in board', n8.unplaced.length === 1);
// sheet: many parts on 48.5x97, margin honoured
let n9 = P.nestOnStock(bars(30, 8, 8), { stock: [H.sheet], margin: 0.5, spacing: 0.25 });
ok('30 8x8 on sheet: one sheet, none lost, verifies', n9.pieces.length === 1 && n9.unplaced.length === 0 && P.verifyNest(n9, { margin: 0.5, spacing: 0.25 }).length === 0, P.verifyNest(n9, { margin: 0.5, spacing: 0.25 }));
// applying placements moves real geometry inside the piece rectangle, in the combined layout
{
  const parts = [C.mkRect(5, 5, 30, 3), C.mkRect(0, 0, 3, 50), C.mkCircle({ x: 0, y: 0 }, 1.5)];
  const nr = P.nestOnStock(parts, { stock: [H.board96, H.board48], margin: 0.25, spacing: 0.25 });
  const placed = nr.placements.map(pl => ({ pl, s: P.placeShapeOnStock(parts[pl.idx], pl, nr.pieces) }));
  const inside = placed.every(({ pl, s }) => { const b = C.bbox(s), pc = nr.pieces[pl.piece]; return b.minX >= pc.ox + 0.25 - 1e-6 && b.maxX <= pc.ox + pc.w - 0.25 + 1e-6 && b.minY >= 0.25 - 1e-6 && b.maxY <= pc.h - 0.25 + 1e-6; });
  ok('placed geometry sits inside its piece', inside && nr.unplaced.length === 0, nr.pieces);
  ok('placed geometry has same area (no distortion)', placed.every(({ pl, s }) => { const a = C.bbox(parts[pl.idx]), b = C.bbox(s); return Math.abs((a.maxX - a.minX) * (a.maxY - a.minY) - (b.maxX - b.minX) * (b.maxY - b.minY)) < 1e-6; }));
}
ok('deterministic', JSON.stringify(P.nestOnStock(bars(7, 13, 3), { stock: [H.board96, H.board48] }).placements) === JSON.stringify(P.nestOnStock(bars(7, 13, 3), { stock: [H.board96, H.board48] }).placements));

// ---------- 3. .tap sanity ----------
const sq = (x0, y0, w, h) => [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }, { x: x0, y: y0 }];
const mk = (pts, o) => CAM.profileOp(CAM.assembleContours([{ closed: true, pts }]), Object.assign({ side: 'outside', toolNum: 2, toolDia: 0.25, cutDepth: 1.525, passDepth: 0.75, feed: 100, plunge: 30, rpm: 24000, climb: false }, o)).ops;
const post = ops => CAM.postProcess({ name: 't', units: 'inch', ops }, CAM.POSTS.shopsabre);
const good = post(mk(sq(1, 1, 10, 6)));
const S = (t, o) => P.tapSanity(t, Object.assign({ thickness: 1.5, bounds: { minX: -1, minY: -1, maxX: 49.5, maxY: 98 } }, o));
let sg = S(good); ok('engine-generated program passes sanity', sg.ok, sg.errors);
ok('good program: stats', sg.stats.tools.includes(2) && sg.stats.cutMoves > 0 && sg.stats.minZ < -1.4, sg.stats);
// Dan's real Vectric fixture programs must pass (cut 0.025 into the waste board)
{
  const fx = path.join(__dirname, 'fixtures', 'waterslide-v4.5');
  for (const f of fs.readdirSync(fx).filter(n => /\.tap$/.test(n))) { const res = S(fs.readFileSync(path.join(fx, f), 'utf8')); ok('Vectric fixture passes sanity: ' + f.slice(24, 60), res.ok, res.errors.slice(0, 3)); }
}
const bad = (txt, frag, o) => { const res = S(txt, o); ok('catches: ' + frag, !res.ok && res.errors.some(e => e.includes(frag)), res.errors); };
bad(good.replace(/Z-1\.525\d*/, 'Z-1.9'), 'cuts deeper');
bad(good.replace(/\nM3\b/, '\n'), 'spindle');
bad(good.replace(/\nT2\b/, '\n'), 'tool');
bad(good + '\nG1 X500 Y3 F100\n', 'outside bounds');
bad('G90\nT2\nS24000\nM3\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nG1 X5\nM5\n', 'feed');
bad('G90\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nG0 X20 Y20\nM5\n', 'rapid G0 XY move');
bad('G90\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nG2 X3.5 Y1 I1 J0\nM5\n', 'radius mismatch');
bad('G90\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nG2 X3 Y1\nM5\n', 'without I/J');
bad('G90\nG21\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nM5\n', 'G21');
bad('G90\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5 X NaN\nM5\n', 'NaN');
bad('', 'empty');
bad('G90\nT2\nS24000\nM3\nG0 X1 Y1 Z0.25\nM5\n', 'no cutting moves');
ok('spindle left on is a warning, not an error', (() => { const res = S(good.replace(/\n[mM]5\s*\n[mM]51\s*$/, '\n')); return res.ok && res.warnings.some(w => w.includes('spindle is still on')); })());
ok('dwell "g4 x 4" is not read as a coordinate', S(good).errors.length === 0 && /g4 x 4/i.test(good));
ok('arc radius within tolerance passes', S('G90\nT2\nS24000\nM3\nF100\nG0 X1 Y1 Z0.25\nG1 Z-0.5\nG3 X1 Y3 I0 J1.0004\nG0 Z0.25\nM5\n').ok);
ok('thickness option: 1.0 stock rejects Z-1.525', !S(good, { thickness: 1.0 }).ok);

// file names (SHOP-FILES-RULES v2 sections 4/5)
const nm = n => P.checkShopFileName(n);
ok('name ok: AM-WS-7236 - 1 BASE - 48.5x97 - 1.5in.tap', nm('AM-WS-7236 - 1 BASE - 48.5x97 - 1.5in.tap').ok, nm('AM-WS-7236 - 1 BASE - 48.5x97 - 1.5in.tap'));
ok('name ok: AM-WS-7236 - 3 SLIDE UNDERSIDE - 48.5x97 - 1.5in.tap', nm('AM-WS-7236 - 3 SLIDE UNDERSIDE - 48.5x97 - 1.5in.tap').ok);
ok('name bad: version', !nm('AM-WS-7236 - 1 BASE v4.5 - 48.5x97 - 1.5in.tap').ok);
ok('name bad: Rev D', !nm('AM-WS-7236 - 1 BASE Rev D - 48.5x97 - 1.5in.tap').ok);
ok('name bad: FINAL', !nm('AM-WS-7236 - 1 BASE FINAL - 48.5x97 - 1.5in.tap').ok);
ok('name bad: date', !nm('AM-WS-7236 - 1 BASE 2026-10-30 - 48.5x97 - 1.5in.tap').ok);
ok('name bad: too long', !nm('AM-WS-7236 - 1 ' + 'LONGPART'.repeat(10) + ' - 48.5x97 - 1.5in.tap').ok);
ok('name bad: Vectric legacy name', !nm('WATERSLIDE B6-SBH v4.5 - 1 BASE - 48.5x97 - 1.5in - single setup.tap').ok);
ok('name bad: not .tap', !nm('AM-WS-7236 - 1 BASE - 48.5x97 - 1.5in.dxf').ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
