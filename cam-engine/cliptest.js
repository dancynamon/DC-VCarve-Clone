// Guard for the clipart / shape library (D2): built-in catalogue, normalization, placement, persistence.
const CL = require('./clipart.js');
const C = require('./cadcore.js');
const CAM = require('./camcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);
const bbox = loops => loops.reduce((b, l) => l.pts.reduce((q, p) => ({ minX: Math.min(q.minX, p.x), minY: Math.min(q.minY, p.y),
  maxX: Math.max(q.maxX, p.x), maxY: Math.max(q.maxY, p.y) }), b), { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 });

// ---- the built-in catalogue ----
const lib = CL.builtinClipart();
{
  ok('clipart: ships a catalogue', lib.length >= 15, lib.length);
  ok('clipart: ids are unique', new Set(lib.map(e => e.id)).size === lib.length);
  ok('clipart: every entry has geometry', lib.every(e => e.loops.length >= 1 && e.loops.every(l => l.pts.length >= 3)));
  ok('clipart: every entry is flagged built-in', lib.every(e => e.builtin === true));
  ok('clipart: categories are grouped', CL.clipartCategories(lib).length >= 3, CL.clipartCategories(lib).join('/'));
  // normalized: x spans exactly 0..1, y starts at 0 and matches the recorded aspect
  for (const e of lib) {
    const b = bbox(e.loops);
    if (!(near(b.minX, 0, 1e-9) && near(b.maxX, 1, 1e-9) && near(b.minY, 0, 1e-9))) { ok('clipart: ' + e.id + ' normalized to the unit box', false, JSON.stringify(b)); break; }
    if (!near(b.maxY, 1 / e.aspect, 1e-6)) { ok('clipart: ' + e.id + ' aspect matches its height', false, b.maxY + ' vs ' + (1 / e.aspect)); break; }
  }
  ok('clipart: all entries normalized to the unit box with a matching aspect',
     lib.every(e => { const b = bbox(e.loops); return near(b.minX, 0, 1e-9) && near(b.maxX, 1, 1e-9) && near(b.minY, 0, 1e-9) && near(b.maxY, 1 / e.aspect, 1e-6); }));
  // winding: the largest loop of each entry is CCW (outer)
  ok('clipart: outer contours are CCW', lib.every(e => {
    const areas = e.loops.map(l => CL.signedArea(l.pts));
    const big = areas.reduce((m, a) => Math.abs(a) > Math.abs(m) ? a : m, 0);
    return big > 0; }));
}

// ---- multi-loop entries keep their holes as holes ----
{
  const gear = lib.find(e => e.id === 'gear');
  ok('clipart: gear has a bore', gear.loops.length === 2, gear.loops.length);
  ok('clipart: the bore is wound CW', CL.signedArea(gear.loops[1].pts) < 0, CL.signedArea(gear.loops[1].pts));
  const ring = lib.find(e => e.id === 'life-ring');
  ok('clipart: life ring has a centre + grip pads', ring.loops.length === 6, ring.loops.length);
  ok('clipart: life ring holes are CW', ring.loops.slice(1).every(l => CL.signedArea(l.pts) < 0));
}

// ---- placement ----
{
  const heart = lib.find(e => e.id === 'heart');
  const p = CL.placeClipart(heart, { x: 2, y: 3, w: 4, h: 4 });
  const b = bbox(p);
  ok('place: lands inside the requested box', b.minX >= 2 - 1e-9 && b.maxX <= 6 + 1e-9 && b.minY >= 3 - 1e-9 && b.maxY <= 7 + 1e-9, JSON.stringify(b));
  ok('place: keeps aspect by default', near((b.maxX - b.minX) / (b.maxY - b.minY), heart.aspect, 1e-6), (b.maxX - b.minX) / (b.maxY - b.minY));
  ok('place: touches the box on its constrained axis', near(b.maxX - b.minX, 4, 1e-6) || near(b.maxY - b.minY, 4, 1e-6), JSON.stringify(b));
  ok('place: is centred in the box', near((b.minX - 2) - (6 - b.maxX), 0, 1e-6) && near((b.minY - 3) - (7 - b.maxY), 0, 1e-6));
  const st = CL.placeClipart(heart, { x: 0, y: 0, w: 10, h: 2, keepAspect: false });
  const sb = bbox(st);
  ok('place: keepAspect false stretches to fill', near(sb.maxX - sb.minX, 10, 1e-6) && near(sb.maxY - sb.minY, 2, 1e-6), JSON.stringify(sb));
  ok('place: height defaults from the aspect', near(bbox(CL.placeClipart(heart, { w: 4 })).maxY, 4 / heart.aspect, 1e-6));
  ok('place: does not mutate the library entry', near(bbox(heart.loops).maxX, 1, 1e-9));
  // thumbnails are just a placement into a square preview box
  const th = CL.clipartThumbnail(heart, 48), tb = bbox(th);
  ok('thumbnail: fits the preview box', tb.minX >= -1e-9 && tb.maxX <= 48 + 1e-9 && tb.maxY <= 48 + 1e-9, JSON.stringify(tb));
  // placement scales linearly
  const a1 = bbox(CL.placeClipart(heart, { x: 0, y: 0, w: 2, h: 99 })), a2 = bbox(CL.placeClipart(heart, { x: 0, y: 0, w: 4, h: 99 }));
  ok('place: doubling the box doubles the art', near((a2.maxX - a2.minX) / (a1.maxX - a1.minX), 2, 1e-6));
}

// ---- making an entry from arbitrary geometry (the user's own selection) ----
{
  const sel = [
    { pts: [{ x: 10, y: 10 }, { x: 14, y: 10 }, { x: 14, y: 12 }, { x: 10, y: 12 }], closed: true },
    { pts: [{ x: 11, y: 10.5 }, { x: 11, y: 11.5 }, { x: 13, y: 11.5 }, { x: 13, y: 10.5 }], closed: true }
  ];
  const e = CL.clipartFromLoops('My Bracket', 'Aquamentor', sel);
  ok('fromLoops: slugs an id', e.id === 'my-bracket', e.id);
  ok('fromLoops: keeps the category', e.category === 'Aquamentor');
  ok('fromLoops: is not flagged built-in', e.builtin === false);
  ok('fromLoops: normalizes to the unit box', near(bbox(e.loops).maxX, 1, 1e-9) && near(bbox(e.loops).minX, 0, 1e-9));
  ok('fromLoops: records the aspect', near(e.aspect, 2, 1e-9), e.aspect);
  ok('fromLoops: keeps both loops', e.loops.length === 2);
  ok('fromLoops: round-trips back to the original size',
     near(bbox(CL.placeClipart(e, { x: 10, y: 10, w: 4, h: 2 })).maxX, 14, 1e-6));
  ok('fromLoops: drops degenerate loops', CL.clipartFromLoops('x', 'y', [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: true }].concat(sel)).loops.length === 2);
  ok('fromLoops: empty input gives an empty entry', CL.clipartFromLoops('empty', 'y', []).loops.length === 0);
}

// ---- library management ----
{
  let L = CL.builtinClipart();
  const n0 = L.length;
  const mine = CL.clipartFromLoops('Logo', 'Aquamentor', [{ pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], closed: true }]);
  L = CL.upsertClipart(L, mine);
  ok('library: upsert adds', L.length === n0 + 1);
  L = CL.upsertClipart(L, CL.clipartFromLoops('Logo', 'Aquamentor', [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 3 }, { x: 0, y: 3 }], closed: true }]));
  ok('library: upsert replaces by id', L.length === n0 + 1 && near(L.find(e => e.id === 'logo').aspect, 1 / 3, 1e-9));
  L = CL.removeClipart(L, 'logo');
  ok('library: remove drops it', L.length === n0 && !L.find(e => e.id === 'logo'));
}

// ---- .aqclip persistence ----
{
  const json = CL.libraryToJSON(CL.builtinClipart());
  const back = CL.libraryFromJSON(json);
  ok('aqclip: round-trips every entry', back.length === lib.length);
  ok('aqclip: geometry survives', near(bbox(back[0].loops).maxX, 1, 1e-9) && back[0].loops.length === lib[0].loops.length);
  ok('aqclip: ids survive', back.map(e => e.id).join() === lib.map(e => e.id).join());
  let threw = false; try { CL.libraryFromJSON('nope'); } catch (e) { threw = /invalid JSON/.test(e.message); }
  ok('aqclip: rejects garbage', threw);
  threw = false; try { CL.libraryFromJSON('{"format":"aqcam","version":1,"entries":[]}'); } catch (e) { threw = /Not a clipart library/.test(e.message); }
  ok('aqclip: rejects a foreign file', threw);
  threw = false; try { CL.libraryFromJSON('{"format":"aqclip","version":42,"entries":[]}'); } catch (e) { threw = /Unsupported clipart version/.test(e.message); }
  ok('aqclip: rejects an unknown version', threw);
  threw = false; try { CL.libraryFromJSON('{"format":"aqclip","version":1,"entries":[{"name":"bad","loops":[]}]}'); } catch (e) { threw = /no usable shapes/.test(e.message); }
  ok('aqclip: rejects a library with no usable geometry', threw);
  // hostile entries are normalized, not trusted
  const dirty = CL.normalizeClipart({ name: 'X', aspect: -5, loops: [{ pts: [{ x: '1', y: null }, { x: 2, y: 2 }, { x: 0, y: 3 }] }], evil: 1 });
  ok('aqclip: bad aspect falls back to 1', dirty.aspect === 1);
  ok('aqclip: coerces point numbers', dirty.loops[0].pts[0].x === 1 && dirty.loops[0].pts[0].y === 0);
  ok('aqclip: drops unknown keys', !('evil' in dirty), Object.keys(dirty).join(','));
}

// ---- placed clipart machines like any other geometry ----
{
  const ring = lib.find(e => e.id === 'life-ring');
  const loops = CL.placeClipart(ring, { x: 0, y: 0, w: 6, h: 6 });
  const shapes = loops.map(l => C.mkPoly(l.pts, true, 'clipart'));
  ok('integration: becomes CAD shapes', shapes.every(s => s.type === 'path' && s.closed));
  const cont = CAM.assembleContours(C.shapesToContoursInput(shapes));
  const pk = CAM.pocketOp(cont, { toolDia: 0.25, cutDepth: 0.2, passDepth: 0.2, stepover: 0.45 });
  ok('integration: pockets with its holes intact', pk.ops[0].passes.length > 0, JSON.stringify(pk.warnings));
  // the bore must be left uncut: no pass point sits near the centre
  const centreHit = pk.ops[0].passes.some(p => p.path.some(q => Math.hypot(q.x - 3, q.y - 3) < 1.0));
  ok('integration: the ring centre is not machined', !centreHit);
  const g = CAM.postProcess({ name: 'CLIP', units: 'inch', ops: pk.ops }, CAM.POSTS.shopsabre);
  ok('integration: posts to G-code', g.length > 200 && /G1|G01/.test(g));
  ok('integration: exports to DXF', C.toDXF(shapes).indexOf('LWPOLYLINE') > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
