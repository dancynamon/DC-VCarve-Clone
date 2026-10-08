// assembly.js: layer-name toolpath defaults, part extraction, the solid mesher, the arch bend, placement and the
// incremental rebuild — checked on the waterslide B6-SBH v4.5 DXFs (fixtures/waterslide-v4.5). No DOM.
const fs = require('fs'), path = require('path');
const CAM = require('./camcore.js'), C = require('./cadcore.js'), A = require('./assembly.js'), G = require('./glview.js');
const { loadDxfShapes, moveLoops, postSheet } = require('./asmtap.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }
const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-6 : t);
const FIX = path.join(__dirname, 'fixtures', 'waterslide-v4.5');
const asm = JSON.parse(fs.readFileSync(path.join(FIX, 'Waterslide B6-SBH v4.5.assembly.json'), 'utf8'));
const sheetFile = id => path.join(FIX, asm.sheets.find(s => s.id === id).file);
const itemsOf = shapes => { const out = []; for (const s of shapes) C.flatten(s).forEach((lp, i) => out.push({ id: s.id, loop: i, layer: s.layer, pts: lp.pts, closed: lp.closed })); return out; };

// ---- layer names
const R = A.layerRule;
ok('OUTSIDE_PROFILE', R('OUTSIDE_PROFILE').kind === 'profile');
ok('INSIDE_CUT', R('INSIDE_CUT').kind === 'inside');
ok('DRILL_0.375_THRU', R('DRILL_0.375_THRU').kind === 'drill' && R('DRILL_0.375_THRU').dia === 0.375);
ok('POCKET_2.06D_0.91DEEP', R('POCKET_2.06D_0.91DEEP').kind === 'pocket' && R('POCKET_2.06D_0.91DEEP').dia === 2.06 && R('POCKET_2.06D_0.91DEEP').depth === 0.91);
ok('POCKET_.5D_.25DEEP (no leading zero)', R('POCKET_.5D_.25DEEP').depth === 0.25);
ok('*_VECTOR_ONLY skipped', R('CAP_CENTER_0.50_VECTOR_ONLY').kind === 'skip');
ok('SHEET / NOTES not cut', R('SHEET').kind === 'sheet' && R('NOTES').kind === 'skip');
ok('lower-case names', R('drill_0.375_thru').kind === 'drill');
ok('unknown layer', R('0').kind === 'unknown' && !A.isLayerJob(['0', 'NOTES']) && A.isLayerJob(['0', 'OUTSIDE_PROFILE']));

// ---- Dan's job defaults
const job = A.jobFromLayers(['SHEET', 'OUTSIDE_PROFILE', 'DRILL_0.375_THRU', 'INSIDE_CUT', 'POCKET_2.06D_0.91DEEP', 'POCKET_0.26D_1.12DEEP', 'NOTES', 'X_VECTOR_ONLY', 'MYSTERY'], 1.5);
const Q = job.queue;
ok('T8 drill first', Q[0].p.op === 'drill' && Q[0].p.toolNum === 8 && Q[0].p.toolDia === 0.375, Q[0].name);
ok('drill to exactly -T', Q[0].p.cutDepth === 1.5 && Q[0].p.peck === 0);
ok('safe Z 0.20 on every toolpath', Q.every(q => q.p.clearZ === 0.2));
const pk = Q.filter(q => q.p.op === 'pocket');
ok('pockets one full-depth pass', pk.every(q => q.p.passDepth === q.p.cutDepth));
ok('pockets biggest first', pk[0].sel.layers[0] === 'POCKET_2.06D_0.91DEEP' && pk[0].p.cutDepth === 0.91);
ok('slots pocketed clear thru', pk.some(q => q.sel.layers[0] === 'INSIDE_CUT' && q.p.cutDepth === 1.5));
const pf = Q.filter(q => q.p.op === 'profile');
ok('profiles CCW (conventional outside), one pass, no tabs', pf.length === 2 && pf.every(q => q.p.side === 'outside' && q.p.climb === false && q.p.passDepth === q.p.cutDepth && q.p.tabs.count === 0));
ok('small parts onion skin -T+0.025', pf[0].p.cutDepth === 1.475 && pf[0].sel.maxSize === 6 && pf[1].p.cutDepth === 1.5 && pf[1].sel.minSize === 6);
ok('profiles last, one tool change', Q.slice(-2).every(q => q.p.op === 'profile') && Q.filter(q => q.p.toolNum === 8).length === 1);
ok('unknown layer reported, not cut', job.skipped.some(s => s.layer === 'MYSTERY') && !Q.some(q => q.sel.layers.indexOf('X_VECTOR_ONLY') >= 0));
ok('no-drill-that-size hole is milled', A.jobFromLayers(['DRILL_0.5_THRU'], 1).queue[0].p.op === 'pocket');
const sel = A.selectByRule([{ layer: 'OUTSIDE_PROFILE', bbox: { minX: 0, minY: 0, maxX: 2, maxY: 2 } }, { layer: 'OUTSIDE_PROFILE', bbox: { minX: 0, minY: 0, maxX: 35, maxY: 71 } }], pf[0].sel);
ok('size filter picks the small part', sel.length === 1 && sel[0].bbox.maxX === 2);

// ---- posting the real sheets
const slideTap = postSheet(loadDxfShapes(sheetFile('slide')), 1.5).gcode;
const lines = slideTap.split(/\r\n/);
ok('slide: T8 then T2, one change', lines.filter(l => /^T\d+$/.test(l)).join(',') === 'T8,T2');
ok('slide: drills plunge to -1.5000', (slideTap.match(/G1 Z-1\.5000 F20\.0/g) || []).length === 10 && slideTap.indexOf('Z-1.525') < 0);
ok('slide: rapids at Z0.2000', /G0 X\S+ Y\S+ Z0\.2000/.test(slideTap) && slideTap.indexOf('Z0.2500') < 0);
ok('slide: pockets one pass at -0.5', (slideTap.match(/G1 Z-0\.5000 F30\.0/g) || []).length === 10);
ok('slide: profile one pass -1.5, CCW', (slideTap.match(/G1 Z-1\.5000 F30\.0/g) || []).length === 1);
ok('slide: park X0 Y115', /G0 Z2\.0000\r\nG0 X0\.0000 Y115\.0000/.test(slideTap));
const red = postSheet(loadDxfShapes(sheetFile('red')), 1.5);
ok('red: caps onion skin -1.4750', (red.gcode.match(/G1 Z-1\.4750 F30\.0/g) || []).length === 20, (red.gcode.match(/G1 Z-1\.4750/g) || []).length);
ok('red: steps cut thru -1.5', (red.gcode.match(/G1 Z-1\.5000 F30\.0/g) || []).length === 2);
ok('red: 0.26D pockets cut (tiny ring, like the reference), not dropped', (red.gcode.match(/G1 Z-1\.1200 F30\.0/g) || []).length === 6);
const tiny = A.opResult(CAM, A.jobFromLayers(['POCKET_0.20D_0.30DEEP'], 1.5).queue[0].p, CAM.assembleContours(C.shapesToContoursInput([C.mkCircle({ x: 3, y: 3 }, 0.1)])));
ok('pocket narrower than the tool is plunged at its centre', tiny.ops[0].passes.length === 1 && tiny.ops[0].passes[0].path.length === 1 && near(tiny.ops[0].passes[0].path[0].x, 3, 1e-3) && tiny.warnings.some(w => /plunged/.test(w)), JSON.stringify(tiny.warnings));
ok('red: vector-only circles not cut', !red.queue.some(q => /VECTOR_ONLY/.test(q.sel.layers.join())));
const base = postSheet(loadDxfShapes(sheetFile('base')), 1.5);
ok('base: slots cleared (more than one ring each)', (base.gcode.match(/G1 Z-1\.5000 F30\.0/g) || []).length >= 5);

// ---- triangulation
const sq = (x, y, s, ccw) => { const p = [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]; return ccw ? p : p.reverse(); };
const triArea = ts => ts.reduce((a, t) => a + ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[1].y - t[0].y) * (t[2].x - t[0].x)) / 2, 0);
const t1 = A.triangulateEx({ outer: sq(0, 0, 10, true), holes: [sq(2, 2, 2, false), sq(6, 5, 3, false)] });
ok('earcut: square with two holes', near(triArea(t1), 100 - 4 - 9, 1e-9) && t1.every(t => ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[1].y - t[0].y) * (t[2].x - t[0].x)) > 0), triArea(t1));
const ring = n => Array.from({ length: n }, (_, i) => ({ x: 5 + 3 * Math.cos(2 * Math.PI * i / n), y: 5 + 3 * Math.sin(2 * Math.PI * i / n) }));
const t2 = A.triangulateEx({ outer: sq(0, 0, 10, true), holes: [ring(64).reverse()] });
ok('earcut: circle hole', near(triArea(t2), 100 - Math.abs(A.area(ring(64))), 1e-6));
const st = A.splitTriByY([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], [1, 2.5]);
ok('split triangle by y keeps area', near(triArea(st), 8, 1e-9) && st.length >= 3);

// ---- parts + solids
const vol = m => { const P = m.positions; let v = 0;
  for (let i = 0; i < P.length; i += 9) v += P[i] * (P[i + 4] * P[i + 8] - P[i + 5] * P[i + 7]) - P[i + 1] * (P[i + 3] * P[i + 8] - P[i + 5] * P[i + 6]) + P[i + 2] * (P[i + 3] * P[i + 7] - P[i + 4] * P[i + 6]);
  return v / 6; };
const baseParts = A.extractParts(itemsOf(loadDxfShapes(sheetFile('base'))), 1.5);
ok('base: one part, 16 cuts', baseParts.parts.length === 1 && baseParts.parts[0].cuts.length === 16 && !baseParts.loose.length);
const bp = baseParts.parts[0];
const expectV = (() => { let v = Math.abs(A.area(bp.outline)) * 1.5; const lay = l => bp.cuts.filter(c => c.layer === l);
  for (const c of lay('INSIDE_CUT')) v -= Math.abs(A.area(c.pts)) * 1.5;
  for (const c of lay('POCKET_2.06D_0.91DEEP')) v -= Math.abs(A.area(c.pts)) * 0.91;
  for (const c of lay('DRILL_0.375_THRU')) v -= Math.abs(A.area(c.pts)) * (1.5 - 0.91);
  return v; })();
const bm = A.partSolid(bp);
ok('base solid volume = outline - slots - pockets - holes', near(vol(bm), expectV, 0.05), vol(bm).toFixed(3) + ' vs ' + expectV.toFixed(3));
const redParts = A.extractParts(itemsOf(loadDxfShapes(sheetFile('red'))), 1.5);
ok('red: 22 parts (2 steps + 20 caps)', redParts.parts.length === 22 && !redParts.loose.length);
const cap = A.partAt(redParts.parts, { x: 9.1, y: 1.58 });
ok('cap owns its oversize clearing pocket', cap.cuts.some(c => /2\.66D/.test(c.layer)) && cap.cuts.length === 2);
const cm = A.partSolid(cap);
const capV = Math.abs(A.area(cap.outline)) * 0.5 - Math.abs(A.area(cap.cuts.find(c => /0\.55D/.test(c.layer)).pts)) * 0.18;
ok('cap: 1.0 pocketed off the top leaves a 0.5 cap', near(vol(cm), capV, 0.01) && near(G.meshBounds(cm.positions)[5], 0.5, 1e-6), vol(cm).toFixed(4) + ' vs ' + capV.toFixed(4));
ok('signature changes with geometry only', A.partSignature(bp) === A.partSignature(A.extractParts(itemsOf(loadDxfShapes(sheetFile('base'))), 1.5).parts[0]));

// ---- arch
const L = 71.485, path0 = A.archPath({ type: 'arch', footA: 9, footB: 7.5, chord: 55.8601 }, L);
ok('arch keeps the sheet length', near(path0.vertices[path0.vertices.length - 1].s, L, 1e-9));
ok('arch lands on the chord', near(path0.vertices[path0.vertices.length - 1].u, 55.8601, 1e-6));
ok('arch height from length', path0.rise > 17.5 && path0.rise < 18.3, path0.rise);
const bmp = A.bendMapper(path0);
ok('arch: feet flat, normal up', near(bmp.at(3, 0).h, 0, 1e-9) && near(bmp.at(3, 1.5).h, 1.5, 1e-9) && near(bmp.at(70, 0).h, 0, 1e-9));
const longer = A.archPath({ type: 'arch', footA: 9, footB: 7.5, chord: 55.8601 }, L + 2);
ok('a longer slide rises higher', longer.rise > path0.rise + 0.5);

// ---- the assembly
const shapes = {}, sheets = {};
for (const s of asm.sheets) { shapes[s.id] = loadDxfShapes(path.join(FIX, s.file)); sheets[s.id] = { items: itemsOf(shapes[s.id]), thickness: s.thickness }; }
ok('assembly file validates', A.validateAssembly(asm).length === 0, A.validateAssembly(asm));
const cache = new Map();
let b = A.buildAssembly(asm, sheets, cache);
ok('24 parts placed, nothing unplaced', b.parts.length === 24 && !b.errors.length && !b.unplaced.length, b.errors.join('; ') + ' unplaced ' + b.unplaced.length);
const P = id => b.parts.find(p => p.id === id), BB = id => G.meshBounds(P(id).mesh.positions);
ok('base on the floor, 1.5 thick', near(BB('base')[2], 0, 1e-6) && near(BB('base')[5], 1.5, 1e-6));
ok('slide feet sit on the base', near(BB('slide')[2], 1.5, 1e-4));
ok('slide apex ~21" off the floor', BB('slide')[5] > 20.5 && BB('slide')[5] < 21.3, BB('slide')[5]);
ok('slide got the 2B underside counterbores', P('slide').setupSheets[0] === 'slideB' && P('slide').ids.length === 21);
// the parts' bolt holes line up in the world: map hole centres through each part's mapper
const mp = (entry, part, resolve) => A.partMapper(part, entry, resolve);
const slidePart = A.partAt(A.extractParts(sheets.slide.items, 1.5).parts, { x: 18, y: 36 });
const basePart = A.extractParts(sheets.base.items, 1.5).parts[0];
const E = id => asm.parts.find(p => p.id === id);
const mSlide = mp(E('slide'), slidePart), mBase = mp(E('base'), basePart);
const d3 = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
const footA = d3(mSlide.map(4.25, 6.7347, 0).p, mBase.map(31.75, 6.75, 0).p), footB = d3(mSlide.map(4.25, 68.3894, 0).p, mBase.map(31.75, 52.7798, 0).p);
ok('foot bolts line up: slide over base (both ends)', footA < 0.01 && footB < 0.01, footA.toFixed(4) + ' / ' + footB.toFixed(4));
const stepPart = A.partAt(A.extractParts(sheets.red.items, 1.5).parts, { x: 2, y: 12.25 });
const mStep = mp(E('step1'), stepPart, id => id === 'slide' ? mSlide : null);
const sb = d3(mStep.map(2, 5.25, 0).p, mSlide.map(25, 47.401, 1.5).p), sb2 = d3(mStep.map(2, 19.25, 0).p, mSlide.map(11, 47.401, 1.5).p);
ok('step bolts line up with the slide step holes', sb < 0.05 && sb2 < 0.05, sb.toFixed(4) + ' / ' + sb2.toFixed(4));
ok('step tops at about 12 and 6 in', near(BB('step1')[5] - 1.5, 12.3, 2.5) && near(BB('step2')[5] - 1.5, 6.4, 2.5) && BB('step1')[5] > BB('step2')[5]);
ok('foot caps on top of the slide feet', near(BB('CT1')[2], 3.0, 1e-3) && near(BB('CT1')[5], 3.5, 1e-3));
// incremental rebuild
b = A.buildAssembly(asm, sheets, cache);
ok('unchanged sheets rebuild nothing', b.rebuilt.length === 0);
moveLoops(shapes.slide, 'DRILL_0.375_THRU@4.25,6.7347=0.5,0'); moveLoops(shapes.slide, 'POCKET_2.00D_0.50DEEP@4.25,6.7347=0.5,0');
sheets.slide = { items: itemsOf(shapes.slide), thickness: 1.5 };
let t0 = Date.now(); b = A.buildAssembly(asm, sheets, cache); const ms = Date.now() - t0;
ok('moving a foot hole rebuilds only the slide', b.rebuilt.join() === 'slide', b.rebuilt.join());
ok('...in well under 200 ms', ms < 200, ms + ' ms');
const sNow = b.parts.find(p => p.id === 'slide');
const hitOld = G.pickParts({ o: [4.25, 6.75, 100], d: [0, 0, -1] }, [{ id: 's', positions: sNow.mesh.positions }]);
const hitNew = G.pickParts({ o: [4.75, 6.75, 100], d: [0, 0, -1] }, [{ id: 's', positions: sNow.mesh.positions }]);
ok('mesh: old hole centre is counterbore floor, new one is open', hitOld && near(100 - hitOld.t, 2.5, 1e-3) && !hitNew, (hitOld && (100 - hitOld.t)) + ' / ' + JSON.stringify(hitNew));
// reshape the host: lengthen the slide outline 1" -> slide + everything standing on it re-placed, base untouched
const sl = shapes.slide, oi = sl.findIndex(s => s.layer === 'OUTSIDE_PROFILE');
sl[oi] = Object.assign(C.scale(sl[oi], 18, 0.25, 1, (71.485 + 1) / 71.485), { id: sl[oi].id });
sheets.slide = { items: itemsOf(sl), thickness: 1.5 };
b = A.buildAssembly(asm, sheets, cache);
ok('reshaping the slide re-places the parts on it, not the base', b.rebuilt.indexOf('slide') >= 0 && b.rebuilt.indexOf('step1') >= 0 && b.rebuilt.indexOf('CT1') >= 0 && b.rebuilt.indexOf('base') < 0 && b.rebuilt.indexOf('CB1') < 0, b.rebuilt.join());
ok('...and the arch rises', b.parts.find(p => p.id === 'slide').info.rise > path0.rise + 0.2);
// flat default layout
const flat = A.buildAssembly(A.defaultAssembly([{ id: 'red', w: 48.5 }]), { red: sheets.red }, new Map());
ok('no assembly file: every part extruded flat', flat.parts.length === 22 && flat.parts.every(p => G.meshBounds(p.mesh.positions)[2] >= -1e-9));
ok('bad assembly reports problems', A.validateAssembly({ format: 'x', sheets: [], parts: [{ id: 'a', sheet: 'q' }] }).length >= 3);

// ---- picking math
const proj = G.perspective(0.8, 1, 0.1, 1000), view = G.lookAt([0, 0, 50], [0, 0, 0], [0, 1, 0]);
const r0 = G.screenRay(G.multiply(proj, view), 200, 200, 100, 100);
ok('centre pixel ray points at the target', near(r0.d[2], -1, 1e-6) && near(r0.o[0], 0, 1e-6));
const hit = G.pickParts(r0, [{ id: 'a', positions: new Float32Array([-1, -1, 5, 1, -1, 5, 0, 1, 5]) }, { id: 'b', positions: new Float32Array([-1, -1, 2, 1, -1, 2, 0, 1, 2]) }]);
ok('pick returns the nearest part', hit && hit.id === 'a');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
