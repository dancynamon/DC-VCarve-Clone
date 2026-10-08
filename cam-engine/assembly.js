/* assembly.js — 2D sheets -> 3D product assembly, and layer-named DXFs -> toolpaths. Pure (no DOM); node + browser.
 *
 * Claude's R12 DXFs carry the machining intent in their layer names:
 *   OUTSIDE_PROFILE            part outlines (one closed loop = one part)
 *   INSIDE_CUT                 thru cut-outs / slots inside a part (pocketed clear, no slug)
 *   DRILL_<dia>_THRU           drilled thru holes
 *   POCKET_<D>D_<depth>DEEP    blind pockets, depth read from the name
 *   *_VECTOR_ONLY, SHEET, NOTES   reference only — never cut, never solid
 * layerRule() reads a name; jobFromLayers() turns a sheet into a toolpath list in Dan's VCarve style (DAN_STYLE);
 * opResult()/postQueue() run that list through camcore so the studio and the CLI post byte-identical G-code.
 *
 * The same layers describe the solid part: extractParts() groups every cut with the outline it sits in, and
 * partSolid() builds the exact solid — the outline extruded by the sheet thickness, thru cuts as holes, pockets
 * cut to depth from the top (or bottom, for a flip setup) — as a lit triangle soup, optionally bent along an arch.
 * An assembly file (.assembly.json, stored next to the DXFs) places each part in 3D: flip, bend, translate, or
 * stand on another part's face ("on"). placeAssembly() resolves it into world-space meshes.
 */
(function (root, factory) {
  const Clip = (typeof require === 'function') ? require('./package/clipper.js') : root.ClipperLib;
  const mod = factory(Clip);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ASSEMBLY = mod;
})(typeof self !== 'undefined' ? self : this, function (ClipperLib) {
'use strict';

// ---------------------------------------------------------------- layer names -> intent
function layerRule(name) {
  const n = String(name == null ? '' : name).toUpperCase().trim();
  if (/(^|_)VECTOR_ONLY$/.test(n)) return { kind: 'skip', why: 'vector only' };
  if (n === 'SHEET') return { kind: 'sheet' };
  if (n === 'NOTES' || n === 'NOTE' || n === 'TEXT' || n === 'DIMS' || n === 'DIMENSIONS') return { kind: 'skip', why: 'notes' };
  if (n === 'OUTSIDE_PROFILE') return { kind: 'profile' };
  if (n === 'INSIDE_CUT') return { kind: 'inside' };
  let m = /^DRILL_(\d*\.?\d+)_THRU$/.exec(n);
  if (m) return { kind: 'drill', dia: +m[1] };
  m = /^POCKET_(\d*\.?\d+)D_(\d*\.?\d+)DEEP$/.exec(n);
  if (m) return { kind: 'pocket', dia: +m[1], depth: +m[2] };
  return { kind: 'unknown' };
}
const CUT_KINDS = { profile: 1, inside: 1, drill: 1, pocket: 1 };
function isLayerJob(layerNames) { return (layerNames || []).some(n => CUT_KINDS[layerRule(n).kind]); }

// Dan's VCarve job style. safeZ = the rapid height between cuts (the post still lifts to Z2 before parking).
const DAN_STYLE = {
  safeZ: 0.2,
  endmill: { toolNum: 2, toolDia: 0.25, rpm: 24000, feed: 100, plunge: 30, stepover: 0.5 },   // T2 1/4 Vortex
  drills: [{ toolNum: 8, toolDia: 0.375, rpm: 10000, feed: 62.5, plunge: 20 }],                // T8 3/8 drill
  smallPart: 6.0,      // outline whose longest side is <= this profiles with an onion skin
  onionSkin: 0.025,    // small parts stop this far above the spoilboard
  park: { x: 0, y: 115 }
};

function bboxPts(pts) { const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) { if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y; }
  return b; }
function r4(v) { return Math.round(v * 1e4) / 1e4; }

// Sheet -> toolpath list. `layers` = the layer names present (in first-seen order). Returns queue entries the
// studio keeps as-is: {name, p (camParams-compatible), sel:{layers, minSize?, maxSize?}}. Order: T8 drills first,
// then T2 pockets (biggest first, each ONE full-depth pass), slots pocketed clear, small parts (onion skin),
// sheet parts (CCW, one pass, no tabs) — so the job has exactly one tool change.
function jobFromLayers(layers, thickness, style) {
  const S = Object.assign({}, DAN_STYLE, style || {});
  const T = Math.abs(+thickness || 0.75), E = S.endmill;
  const base = t => ({ toolNum: t.toolNum, toolDia: t.toolDia, rpm: t.rpm, feed: t.feed, plunge: t.plunge, topZ: 0, clearZ: S.safeZ,
    tabs: { count: 0, length: 0.4, height: 0.1 }, leadType: 'none', leadLen: 0.25, rampLen: 0 });
  const pocketP = depth => Object.assign(base(E), { op: 'pocket', cutDepth: depth, passDepth: depth, climb: false,
    stepover: E.stepover, pocketStyle: 'offset', rampEntry: false, finishDia: 0 });
  const drills = [], pockets = [], slots = [], profiles = [], skipped = [];
  for (const name of layers || []) {
    const r = layerRule(name);
    if (r.kind === 'drill') {
      const d = (S.drills || []).find(t => Math.abs(t.toolDia - r.dia) < 0.002);
      if (d) drills.push({ name: 'Drill Ø' + r.dia + ' thru (T' + d.toolNum + ')', p: Object.assign(base(d), { op: 'drill', cutDepth: T, passDepth: T, peck: 0 }), sel: { layers: [name] } });
      else if (r.dia > E.toolDia) slots.push({ name: 'Hole Ø' + r.dia + ' milled thru (no drill that size)', p: pocketP(T), sel: { layers: [name] } });
      else skipped.push({ layer: name, why: 'Ø' + r.dia + ' hole: no drill that size and smaller than the endmill' });
    } else if (r.kind === 'pocket') {
      const depth = Math.min(r.depth, T);
      pockets.push({ dia: r.dia, depth, name: 'Pocket Ø' + r.dia + ' × ' + depth + ' deep', p: pocketP(depth), sel: { layers: [name] } });
    } else if (r.kind === 'inside') {
      slots.push({ name: 'Slots / cut-outs pocketed clear', p: pocketP(T), sel: { layers: [name] } });
    } else if (r.kind === 'profile') {
      const prof = depth => Object.assign(base(E), { op: 'profile', side: 'outside', climb: false, cutDepth: depth, passDepth: depth });
      profiles.push({ name: 'Profile small parts (onion skin ' + S.onionSkin + ')', p: prof(r4(T - S.onionSkin)), sel: { layers: [name], maxSize: S.smallPart } });
      profiles.push({ name: 'Profile sheet parts (one pass, no tabs)', p: prof(T), sel: { layers: [name], minSize: S.smallPart } });
    } else if (r.kind !== 'sheet' && r.kind !== 'skip') skipped.push({ layer: name, why: 'layer name has no machining rule' });
  }
  pockets.sort((a, b) => b.dia - a.dia || a.depth - b.depth);
  const queue = drills.concat(pockets, slots, profiles).map(q => ({ name: q.name, p: q.p, sel: q.sel, visible: true }));
  return { queue, skipped };
}

// Which shapes a layer-rule toolpath cuts. items: [{id, layer, bbox:{minX..maxY}}] (one per shape).
function selectByRule(items, sel) {
  if (!sel || !sel.layers) return items;
  const L = new Set(sel.layers);
  return items.filter(it => {
    if (!L.has(it.layer)) return false;
    const b = it.bbox; if (!b) return true;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    if (sel.maxSize != null && size > sel.maxSize + 1e-9) return false;
    if (sel.minSize != null && size <= sel.minSize + 1e-9) return false;
    return true;
  });
}

// One toolpath -> camcore ops. Same dispatch the studio has always used, plus: a pocket the endmill cannot
// enter (POCKET_0.26D with a 1/4 tool) is plunged at its centre instead of silently dropped.
function opResult(CAM, p, contours) {
  const res = (p.op === 'pocket') ? CAM.pocketOp(contours, p)
    : (p.op === 'drill') ? CAM.drillOp(contours, p)
    : (p.op === 'vcarve') ? CAM.vcarveOp(contours, Object.assign({}, p, { maxDepth: p.cutDepth, step: p.vstep }))
    : (p.op === 'inlay') ? CAM.inlayOp(contours, Object.assign({}, p, { step: p.vstep }))
    : CAM.profileOp(contours, p);
  for (const op of res.ops) op.clearZ = p.clearZ;
  if (p.op === 'pocket' && res.ops.length) {
    const op = res.ops[0], closed = contours.filter(c => c.closed && c.pts && c.pts.length >= 3);
    const ctrs = closed.map(c => centroidOf(c.pts));
    for (let ci = 0; ci < closed.length; ci++) {
      const c = closed[ci];
      // an island (or a loop holding one) is not an unreachable pocket — leave those alone
      if (closed.some((d, di) => di !== ci && (pointInPoly(ctrs[di], c.pts) || pointInPoly(ctrs[ci], d.pts)))) continue;
      const hit = op.passes.some(ps => ps.path.some(q => pointInPoly(q, c.pts)));
      if (hit) continue;
      const ctr = CAM.centroid(c.pts);
      const depths = []; let d = Math.min(p.passDepth || p.cutDepth, p.cutDepth);
      while (d < p.cutDepth - 1e-9) { depths.push(d); d += (p.passDepth || p.cutDepth); } depths.push(p.cutDepth);
      for (const dd of depths) op.passes.push({ z: (p.topZ || 0) - dd, tabHeight: 0, closed: false, path: [{ x: ctr.x, y: ctr.y, tab: false }] });
      res.warnings = (res.warnings || []).filter(w => !/Tool too large/.test(w)).concat(['Pocket narrower than the tool at ' + ctr.x.toFixed(3) + ',' + ctr.y.toFixed(3) + ' — plunged at its centre']);
    }
  }
  return res;
}

// Post a whole toolpath list. contoursFor(q) -> camcore contours for that entry. Shared by studio + CLI.
function postQueue(CAM, queue, contoursFor, post) {
  const allOps = [], points = []; let warnings = [];
  for (const q of queue) {
    if (q.visible === false) continue;
    const res = opResult(CAM, q.p, contoursFor(q));
    for (const op of res.ops) if (op.passes.length) allOps.push(op);
    if (res.points) points.push(...res.points);
    if (res.warnings) warnings = warnings.concat(res.warnings);
  }
  if (!allOps.length) return { gcode: '', ops: [], points, warnings: warnings.concat(['Job produced no cuttable passes']) };
  const P = Object.assign({}, CAM.POSTS.shopsabre, post || {});
  const ordered = CAM.orderPasses({ name: 'job - ' + allOps.length + ' ops', units: 'inch', ops: allOps });
  return { gcode: CAM.postProcess(ordered, P), ops: allOps, points, warnings };
}

// ---------------------------------------------------------------- geometry helpers
function area(pts) { let s = 0; for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += a.x * b.y - b.x * a.y; } return s / 2; }
function pointInPoly(p, pts) { let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; }
  return c; }
function centroidOf(pts) { let A = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], cr = a.x * b.y - b.x * a.y; A += cr; cx += (a.x + b.x) * cr; cy += (a.y + b.y) * cr; }
  if (Math.abs(A) < 1e-12) { let sx = 0, sy = 0; for (const p of pts) { sx += p.x; sy += p.y; } return { x: sx / pts.length, y: sy / pts.length }; }
  return { x: cx / (3 * A), y: cy / (3 * A) }; }
function closeLoop(pts) { const a = pts[0], b = pts[pts.length - 1];
  return (pts.length > 2 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) ? pts.slice(0, -1) : pts.slice(); }

// ---------------------------------------------------------------- sheet -> parts
// items: [{id, layer, pts, closed}] — every flattened loop of every shape on the sheet.
// A part = one closed loop on a profile layer, plus every cut whose centre lies inside it (smallest outline wins,
// so a cap whose clearing pocket is bigger than the cap itself still belongs to the cap).
function extractParts(items, thickness) {
  const T = Math.abs(+thickness || 0.75);
  const outlines = [], cuts = [];
  for (const it of items) {
    if (!it || !it.closed || !it.pts || it.pts.length < 3) continue;
    const r = layerRule(it.layer);
    const pts = closeLoop(it.pts);
    if (pts.length < 3) continue;
    if (r.kind === 'profile') outlines.push({ id: it.id, loop: it.loop || 0, layer: it.layer, pts, area: Math.abs(area(pts)), bbox: bboxPts(pts) });
    else if (r.kind === 'drill' || r.kind === 'inside') cuts.push({ id: it.id, layer: it.layer, kind: r.kind, pts, z0: 0, z1: T });
    else if (r.kind === 'pocket') { const d = Math.min(Math.abs(r.depth), T); cuts.push({ id: it.id, layer: it.layer, kind: d >= T - 1e-9 ? 'inside' : 'pocket', pts, z0: T - d, z1: T }); }
  }
  outlines.sort((a, b) => a.area - b.area);
  const parts = outlines.map(o => ({ key: o.id + (o.loop ? ':' + o.loop : ''), outlineId: o.id, outline: o.pts, bbox: o.bbox, area: o.area, cuts: [], ids: [o.id], thickness: T }));
  const loose = [];
  for (const c of cuts) {
    const ctr = centroidOf(c.pts);
    let host = null;
    for (let i = 0; i < outlines.length; i++) if (pointInPoly(ctr, outlines[i].pts)) { host = parts[i]; break; }
    if (host) { host.cuts.push(c); if (host.ids.indexOf(c.id) < 0) host.ids.push(c.id); }
    else loose.push(c);
  }
  // stable order: bottom-left first (reading order of the sheet), so "Part N" labels don't jump around
  parts.sort((a, b) => (a.bbox.minY - b.bbox.minY) || (a.bbox.minX - b.bbox.minX));
  return { parts, loose };
}
// a short fingerprint of a part's machined geometry: rebuild its mesh only when this changes
function partSignature(part, extra) {
  const q = v => Math.round(v * 2000);
  const loop = pts => pts.map(p => q(p.x) + ',' + q(p.y)).join(' ');
  return part.thickness + '|' + loop(part.outline) + '|' + part.cuts.map(c => c.z0.toFixed(4) + ':' + c.z1.toFixed(4) + ':' + loop(c.pts)).sort().join('/') + '|' + (extra || '');
}
// which part was picked from a sheet point (assembly refs use a point inside the outline)
function partAt(parts, pt) {
  let best = null;
  for (const p of parts) if (pointInPoly(pt, p.outline) && (!best || p.area < best.area)) best = p;
  if (best) return best;
  let bd = Infinity;
  for (const p of parts) { const c = centroidOf(p.outline), d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d < bd) { bd = d; best = p; } }
  return best;
}

// ---------------------------------------------------------------- Clipper glue
const SC = 100000;
const toI = pts => pts.map(p => new ClipperLib.IntPoint(Math.round(p.x * SC), Math.round(p.y * SC)));
const fromI = path => path.map(q => ({ x: q.X / SC, y: q.Y / SC }));
// outline minus the union of cut loops -> [{outer:[pts], holes:[[pts]]}] (outer CCW, holes CW)
function regionMinus(outline, cutLoops) {
  const c = new ClipperLib.Clipper();
  c.AddPath(toI(outline), ClipperLib.PolyType.ptSubject, true);
  for (const lp of cutLoops) c.AddPath(toI(lp), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map(e => ({ outer: fromI(e.outer), holes: e.holes.map(fromI) }));
}
function regionDiff(a, b) {   // a, b: ExPolygon lists -> a minus b
  const c = new ClipperLib.Clipper();
  for (const e of a) { c.AddPath(toI(e.outer), ClipperLib.PolyType.ptSubject, true); for (const h of e.holes) c.AddPath(toI(h), ClipperLib.PolyType.ptSubject, true); }
  for (const e of b) { c.AddPath(toI(e.outer), ClipperLib.PolyType.ptClip, true); for (const h of e.holes) c.AddPath(toI(h), ClipperLib.PolyType.ptClip, true); }
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map(e => ({ outer: fromI(e.outer), holes: e.holes.map(fromI) }));
}

// ---------------------------------------------------------------- triangulation (ear clipping with hole bridges)
// A compact earcut: flat [x0,y0,x1,y1,...] + hole start indices -> triangle vertex indices. Same algorithm family as
// mapbox/earcut (bridge each hole to the outer ring, then clip ears, curing self-touching leftovers by splitting).
function earcut(data, holeIndices) {
  const hasHoles = holeIndices && holeIndices.length;
  const outerLen = hasHoles ? holeIndices[0] * 2 : data.length;
  let outer = linkedList(data, 0, outerLen, true);
  const tris = [];
  if (!outer || outer.next === outer.prev) return tris;
  if (hasHoles) outer = eliminateHoles(data, holeIndices, outer);
  earcutLinked(outer, tris, 0);
  return tris;
}
function Node(i, x, y) { this.i = i; this.x = x; this.y = y; this.prev = null; this.next = null; this.steiner = false; }
function insertNode(i, x, y, last) { const p = new Node(i, x, y);
  if (!last) { p.prev = p; p.next = p; } else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p; }
function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; }
function signedAreaFlat(data, start, end) { let s = 0; for (let i = start, j = end - 2; i < end; i += 2) { s += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; } return s; }
function linkedList(data, start, end, clockwise) {
  let last = null;
  if (clockwise === (signedAreaFlat(data, start, end) > 0)) { for (let i = start; i < end; i += 2) last = insertNode(i / 2, data[i], data[i + 1], last); }
  else { for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i], data[i + 1], last); }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}
function equals(a, b) { return a.x === b.x && a.y === b.y; }
function triArea(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py); }
function filterPoints(start, end) {
  if (!start) return start; if (!end) end = start;
  let p = start, again;
  do { again = false;
    if (!p.steiner && (equals(p, p.next) || triArea(p.prev, p, p.next) === 0)) { removeNode(p); p = end = p.prev; if (p === p.next) break; again = true; }
    else p = p.next;
  } while (again || p !== end);
  return end;
}
function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (triArea(a, b, c) >= 0) return false;
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (!(p.x === a.x && p.y === a.y) && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) && triArea(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}
function earcutLinked(ear, tris, pass) {
  if (!ear) return;
  let stop = ear, prev, next;
  while (ear.prev !== ear.next) {
    prev = ear.prev; next = ear.next;
    if (isEar(ear)) { tris.push(prev.i, ear.i, next.i); removeNode(ear); ear = next.next; stop = next.next; continue; }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), tris, 1);
      else if (pass === 1) { ear = cureLocalIntersections(filterPoints(ear), tris); earcutLinked(ear, tris, 2); }
      else if (pass === 2) splitEarcut(ear, tris);
      break;
    }
  }
}
function intersects(p1, q1, p2, q2) {
  const o1 = Math.sign(triArea(p1, q1, p2)), o2 = Math.sign(triArea(p1, q1, q2)), o3 = Math.sign(triArea(p2, q2, p1)), o4 = Math.sign(triArea(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  const onSeg = (p, q, r) => q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
  if (o1 === 0 && onSeg(p1, p2, q1)) return true; if (o2 === 0 && onSeg(p1, q2, q1)) return true;
  if (o3 === 0 && onSeg(p2, p1, q2)) return true; if (o4 === 0 && onSeg(p2, q1, q2)) return true;
  return false;
}
function locallyInside(a, b) { return triArea(a.prev, a, a.next) < 0 ? triArea(a, b, a.next) >= 0 && triArea(a, a.prev, b) >= 0 : triArea(a, b, a.prev) < 0 || triArea(a, a.next, b) < 0; }
function cureLocalIntersections(start, tris) {
  let p = start;
  do { const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      tris.push(a.i, p.i, b.i); removeNode(p); removeNode(p.next); p = start = b; }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}
function intersectsPolygon(a, b) { let p = a;
  do { if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true; p = p.next; } while (p !== a);
  return false; }
function middleInside(a, b) { let p = a, inside = false; const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do { if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside; p = p.next; } while (p !== a);
  return inside; }
function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (triArea(a.prev, a, b.prev) || triArea(a, b.prev, b))) ||
     (equals(a, b) && triArea(a.prev, a, a.next) > 0 && triArea(b.prev, b, b.next) > 0));
}
function splitPolygon(a, b) {
  const a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
function splitEarcut(start, tris) {
  let a = start;
  do { let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next); c = filterPoints(c, c.next);
        earcutLinked(a, tris, 0); earcutLinked(c, tris, 0); return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}
function eliminateHoles(data, holeIndices, outer) {
  const queue = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * 2, end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length;
    const list = linkedList(data, start, end, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x || a.y - b.y);
  for (const h of queue) outer = eliminateHole(h, outer);
  return outer;
}
function getLeftmost(start) { let p = start, l = start; do { if (p.x < l.x || (p.x === l.x && p.y < l.y)) l = p; p = p.next; } while (p !== start); return l; }
function eliminateHole(hole, outer) {
  const bridge = findHoleBridge(hole, outer);
  if (!bridge) return outer;
  const b2 = splitPolygon(bridge, hole);
  filterPoints(b2, b2.next);
  return filterPoints(bridge, bridge.next);
}
function sectorContainsSector(m, p) { return triArea(m.prev, m, p.prev) < 0 && triArea(p.next, m, m.next) < 0; }
function findHoleBridge(hole, outer) {
  let p = outer, qx = -Infinity, m = null;
  const hx = hole.x, hy = hole.y;
  do {   // nearest edge crossing the ray from the hole's leftmost point going left
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}
// ExPolygon {outer, holes} -> triangles as [[a,b,c] of {x,y}], CCW (facing +z)
function triangulateEx(ex) {
  const data = [], holes = [], pts = [];
  const push = loop => { for (const p of loop) { data.push(p.x, p.y); pts.push(p); } };
  push(ex.outer);
  for (const h of ex.holes) { holes.push(pts.length); push(h); }
  const idx = earcut(data, holes), out = [];
  for (let i = 0; i < idx.length; i += 3) {
    let a = pts[idx[i]], b = pts[idx[i + 1]], c = pts[idx[i + 2]];
    const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cr) < 1e-14) continue;
    if (cr < 0) { const t = b; b = c; c = t; }
    out.push([a, b, c]);
  }
  return out;
}

// split a CCW triangle by horizontal lines y = ys[k] (sorted) into convex pieces -> triangles. Keeps a bent
// surface exact: each piece lies inside one straight segment of the bend.
function splitTriByY(tri, ys) {
  const lo = Math.min(tri[0].y, tri[1].y, tri[2].y), hi = Math.max(tri[0].y, tri[1].y, tri[2].y);
  const cuts = [];
  for (const y of ys) if (y > lo + 1e-9 && y < hi - 1e-9) cuts.push(y);
  if (!cuts.length) return [tri];
  const out = [];
  let poly = tri.slice();
  const clip = (pg, y, keepBelow) => { const r = [];
    for (let i = 0; i < pg.length; i++) { const a = pg[i], b = pg[(i + 1) % pg.length];
      const ina = keepBelow ? a.y <= y : a.y >= y, inb = keepBelow ? b.y <= y : b.y >= y;
      if (ina) r.push(a);
      if (ina !== inb) { const t = (y - a.y) / (b.y - a.y); r.push({ x: a.x + (b.x - a.x) * t, y }); } }
    return r; };
  for (const y of cuts) {
    const below = clip(poly, y, true);
    for (let i = 1; i + 1 < below.length; i++) out.push([below[0], below[i], below[i + 1]]);
    poly = clip(poly, y, false);
    if (poly.length < 3) break;
  }
  for (let i = 1; i + 1 < poly.length; i++) out.push([poly[0], poly[i], poly[i + 1]]);
  return out;
}

// ---------------------------------------------------------------- bend (sheet bent along its length)
// spec {type:'arch', footA, footB, chord}: a sheet of length L lies flat for footA, rises in a raised-cosine arch
// (tangent-continuous with both feet), and lands flat for footB, the two foot ends `chord` apart. The sheet length
// is fixed, so the arch height comes out of it: lengthen the slide in 2D and the arch rises.
function archPath(spec, L) {
  const fa = Math.max(0, +spec.footA || 0), fb = Math.max(0, +spec.footB || 0);
  const chord = +spec.chord || L, span = Math.max(1e-6, chord - fa - fb), want = L - fa - fb;
  const N = Math.max(16, spec.samples || 160);
  const arcLen = R => { let s = 0, px = 0, py = 0; for (let k = 1; k <= 400; k++) { const t = k / 400, x = t * span, y = R * (1 - Math.cos(2 * Math.PI * t)) / 2; s += Math.hypot(x - px, y - py); px = x; py = y; } return s; };
  let R = 0;
  if (want > span + 1e-6) { let lo = 0, hi = want; for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (arcLen(mid) < want) lo = mid; else hi = mid; } R = (lo + hi) / 2; }
  const pts = [{ u: 0, h: 0 }];
  if (fa > 0) pts.push({ u: fa, h: 0 });
  for (let k = 1; k < N; k++) { const t = k / N; pts.push({ u: fa + t * span, h: R * (1 - Math.cos(2 * Math.PI * t)) / 2 }); }
  pts.push({ u: fa + span, h: 0 });
  if (fb > 0) pts.push({ u: fa + span + fb, h: 0 });
  // arc-length parameter, rescaled so the path is exactly the sheet length (a chord polyline is a hair short)
  const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].h - pts[i - 1].h));
  const k = L / s[s.length - 1];
  const vertices = pts.map((p, i) => ({ s: s[i] * k, u: p.u, h: p.h }));
  return { vertices, rise: R, span, chord, length: L };
}
// path vertices {s,u,h} -> a mapper (s, z) -> {u, h, tu, th, nu, nh}: point on the bent sheet at arc length s,
// z above the path along the (mitred) normal, plus the unit tangent and normal there.
function bendMapper(path) {
  const V = path.vertices, n = V.length;
  const segT = [], segN = [];
  for (let i = 0; i < n - 1; i++) { const du = V[i + 1].u - V[i].u, dh = V[i + 1].h - V[i].h, m = Math.hypot(du, dh) || 1;
    segT.push([du / m, dh / m]); segN.push([-dh / m, du / m]); }
  const miter = [], unitN = [];
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)], b = segN[Math.min(n - 2, i)];
    let mu = a[0] + b[0], mh = a[1] + b[1]; const m = Math.hypot(mu, mh) || 1; mu /= m; mh /= m;
    const c = Math.max(0.2, mu * b[0] + mh * b[1]);
    unitN.push([mu, mh]); miter.push([mu / c, mh / c]);
  }
  const breaks = V.slice(1, -1).map(v => v.s);
  function at(s, z) {
    let i = 0, lo = 0, hi = n - 2;
    if (s <= V[0].s) i = 0; else if (s >= V[n - 1].s) i = n - 2;
    else { while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (V[mid].s <= s) lo = mid; else hi = mid - 1; } i = Math.min(lo, n - 2); }
    const a = V[i], b = V[i + 1], L = (b.s - a.s) || 1, t = (s - a.s) / L;   // t outside [0,1] extrapolates the end segments
    const nu = miter[i][0] + (miter[i + 1][0] - miter[i][0]) * Math.max(0, Math.min(1, t));
    const nh = miter[i][1] + (miter[i + 1][1] - miter[i][1]) * Math.max(0, Math.min(1, t));
    let un = unitN[i][0] + (unitN[i + 1][0] - unitN[i][0]) * Math.max(0, Math.min(1, t));
    let uh = unitN[i][1] + (unitN[i + 1][1] - unitN[i][1]) * Math.max(0, Math.min(1, t));
    const m = Math.hypot(un, uh) || 1; un /= m; uh /= m;
    return { u: a.u + (b.u - a.u) * t + z * nu, h: a.h + (b.h - a.h) * t + z * nh, tu: uh, th: -un, nu: un, nh: uh };
  }
  return { at, breaks };
}

// ---------------------------------------------------------------- the solid
// part: {outline, cuts:[{pts, z0, z1}], thickness}. Local frame: sheet x/y, z = 0 bottom .. T top (as cut).
// map(x, y, z) -> {p:[x,y,z], frame(n) -> world normal}; optional ybreaks for bent parts.
// Returns {positions, normals, tris} (non-indexed soup, flat walls, smooth bent faces) in local or mapped space.
function partSolid(part, opts) {
  const o = opts || {};
  const T = part.thickness;
  const outline = area(part.outline) > 0 ? part.outline : part.outline.slice().reverse();
  const cuts = part.cuts.map(c => ({ pts: c.pts, z0: Math.max(0, Math.min(T, c.z0)), z1: Math.max(0, Math.min(T, c.z1)) })).filter(c => c.z1 - c.z0 > 1e-6);
  const levels = [0, T];
  for (const c of cuts) for (const z of [c.z0, c.z1]) if (!levels.some(l => Math.abs(l - z) < 1e-6)) levels.push(z);
  levels.sort((a, b) => a - b);
  const bands = [];   // bands[k] = solid section between levels[k] and levels[k+1]
  for (let k = 0; k + 1 < levels.length; k++) {
    const lo = levels[k], hi = levels[k + 1];
    const cover = cuts.filter(c => c.z0 <= lo + 1e-6 && c.z1 >= hi - 1e-6).map(c => c.pts);
    bands.push(regionMinus(outline, cover));
  }
  const pos = [], nrm = [];
  const ybreaks = o.ybreaks || null;
  const map = o.map || ((x, y, z) => ({ p: [x, y, z], n: v => v }));
  const emitFace = (exs, z, up) => {
    for (const ex of exs) for (const t0 of triangulateEx(ex)) {
      const pieces = ybreaks ? splitTriByY(t0, ybreaks) : [t0];
      for (const t of pieces) {
        const tri = up ? t : [t[0], t[2], t[1]];
        for (const q of tri) { const m = map(q.x, q.y, z); pos.push(m.p[0], m.p[1], m.p[2]); const nn = m.n([0, 0, up ? 1 : -1]); nrm.push(nn[0], nn[1], nn[2]); }
      }
    }
  };
  // horizontal faces: up-facing where the band below is solid and the band above is not, and vice versa
  for (let k = 0; k < levels.length; k++) {
    const below = k > 0 ? bands[k - 1] : [], above = k < bands.length ? bands[k] : [];
    const up = k === 0 ? [] : (k === levels.length - 1 ? below : regionDiff(below, above));
    const dn = k === levels.length - 1 ? [] : (k === 0 ? above : regionDiff(above, below));
    if (up.length) emitFace(up, levels[k], true);
    if (dn.length) emitFace(dn, levels[k], false);
  }
  // walls of each band, outward = right of the edge (outer CCW, holes CW)
  for (let k = 0; k < bands.length; k++) {
    const z0 = levels[k], z1 = levels[k + 1];
    for (const ex of bands[k]) for (const ring of [ex.outer].concat(ex.holes)) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy); if (len < 1e-9) continue;
        const wn = [dy / len, -dx / len, 0];
        const pts = [a];
        if (ybreaks) { const ys = ybreaks.filter(y => (y > Math.min(a.y, b.y) + 1e-9) && (y < Math.max(a.y, b.y) - 1e-9));
          if (dy < 0) ys.reverse();
          for (const y of ys) { const t = (y - a.y) / dy; pts.push({ x: a.x + dx * t, y }); } }
        pts.push(b);
        for (let j = 0; j + 1 < pts.length; j++) {
          const p = pts[j], q = pts[j + 1];
          const A = map(p.x, p.y, z0), B = map(q.x, q.y, z0), C = map(q.x, q.y, z1), D = map(p.x, p.y, z1);
          const nA = A.n(wn), nB = B.n(wn);
          for (const [M, N] of [[A, nA], [B, nB], [C, nB], [A, nA], [C, nB], [D, nA]]) { pos.push(M.p[0], M.p[1], M.p[2]); nrm.push(N[0], N[1], N[2]); }
        }
      }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), vertexCount: pos.length / 3, levels };
}

// ---------------------------------------------------------------- placement
function v3add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function v3scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function v3norm(a) { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; }

// Local -> world mapper for one placed part. entry: {flip, bend, place:{at,rotate}, on:{...}, anchor, rotate, lift}
// resolveOn(partId) -> that part's mapper (for "on"). Returns {map(x,y,z)->{p,n(v)}, ybreaks}.
function partMapper(part, entry, resolveOn) {
  const T = part.thickness, bb = bboxPts(part.outline);
  const cx2 = bb.minX + bb.maxX;
  const flip = !!entry.flip;
  const pre = (x, y, z) => flip ? [cx2 - x, y, T - z] : [x, y, z];
  const preN = v => flip ? [-v[0], v[1], -v[2]] : v;
  let mid, ybreaks = null, info = {};
  if (entry.bend && entry.bend.type === 'arch') {
    const L = bb.maxY - bb.minY, path = archPath(entry.bend, L), bm = bendMapper(path);
    ybreaks = bm.breaks.map(s => s + bb.minY);
    info.rise = path.rise; info.span = path.span;
    mid = (x, y, z) => { const f = bm.at(y - bb.minY, z); return { p: [x, f.u, f.h], f }; };
    mid.n = (v, f) => [v[0], v[1] * f.tu + v[2] * f.nu, v[1] * f.th + v[2] * f.nh];
  } else { mid = (x, y, z) => ({ p: [x, y, z], f: null }); mid.n = v => v; }
  let post;
  if (entry.on && resolveOn) {
    const host = resolveOn(entry.on.part);
    if (!host) return null;
    const face = entry.on.face === 'bottom' ? 'bottom' : 'top';
    const at = entry.on.at || [0, 0];
    const hz = face === 'top' ? host.T : 0, e = 0.05;
    const P = (x, y) => host.map(x, y, hz).p;
    const p0 = P(at[0], at[1]);
    const ex = v3norm([P(at[0] + e, at[1])[0] - P(at[0] - e, at[1])[0], P(at[0] + e, at[1])[1] - P(at[0] - e, at[1])[1], P(at[0] + e, at[1])[2] - P(at[0] - e, at[1])[2]]);
    const eyr = [P(at[0], at[1] + e)[0] - P(at[0], at[1] - e)[0], P(at[0], at[1] + e)[1] - P(at[0], at[1] - e)[1], P(at[0], at[1] + e)[2] - P(at[0], at[1] - e)[2]];
    let n = v3norm(v3cross(ex, eyr)); if (face === 'bottom') n = v3scale(n, -1);
    const ey = v3cross(n, ex);
    const anc = entry.anchor || [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
    const th = (+entry.rotate || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), lift = +entry.lift || 0;
    const ancF = flip ? [cx2 - anc[0], anc[1]] : anc;
    post = (q) => { const dx = q[0] - ancF[0], dy = q[1] - ancF[1], rx = dx * c - dy * s, ry = dx * s + dy * c;
      return v3add(v3add(v3add(p0, v3scale(ex, rx)), v3scale(ey, ry)), v3scale(n, q[2] + lift)); };
    post.n = v => { const rx = v[0] * c - v[1] * s, ry = v[0] * s + v[1] * c; return v3add(v3add(v3scale(ex, rx), v3scale(ey, ry)), v3scale(n, v[2])); };
  } else {
    const pl = entry.place || {}, t = pl.at || [0, 0, 0], th = (+pl.rotate || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    post = q => [q[0] * c - q[1] * s + t[0], q[0] * s + q[1] * c + t[1], q[2] + t[2]];
    post.n = v => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
  }
  const map = (x, y, z) => { const a = pre(x, y, z), m = mid(a[0], a[1], a[2]);
    return { p: post(m.p), n: v => v3norm(post.n(mid.n(preN(v), m.f))) }; };
  return { map, ybreaks, T, info };   // flip mirrors x and z only, so the bend's y breaks still apply
}

// Merge the cuts of a second setup (e.g. "2B underside, flip in place") into its part: mirrored about the
// part's centre line and measured from the bottom face.
function setupCuts(part, setupItems, mirror) {
  const bb = bboxPts(part.outline), cx2 = bb.minX + bb.maxX, cy2 = bb.minY + bb.maxY, T = part.thickness;
  const out = [];
  for (const it of setupItems) {
    if (!it.closed || !it.pts || it.pts.length < 3) continue;
    const r = layerRule(it.layer); if (r.kind !== 'pocket' && r.kind !== 'drill' && r.kind !== 'inside') continue;
    const pts = closeLoop(it.pts).map(p => ({ x: mirror === 'x' ? cx2 - p.x : p.x, y: mirror === 'y' ? cy2 - p.y : p.y }));
    if (!pointInPoly(centroidOf(pts), part.outline)) continue;
    const d = r.kind === 'pocket' ? Math.min(r.depth, T) : T;
    out.push({ id: it.id, layer: it.layer, kind: r.kind, pts, z0: 0, z1: d, setup: true });
  }
  return out;
}

// Flat layout when no assembly file is loaded: every sheet's parts at their sheet positions, sheets side by side.
function defaultAssembly(sheetList) {
  const parts = []; let x = 0;
  for (const sh of sheetList) {
    parts.push({ id: sh.id + ':*', sheet: sh.id, all: true, place: { at: [x, 0, 0] } });
    x += (sh.w || 48) + 6;
  }
  return { format: 'aqcam-assembly', version: 1, name: 'Sheets (flat)', sheets: sheetList.map(s => ({ id: s.id })), parts };
}

// Resolve an assembly against the current sheets into placed meshes, reusing every mesh whose inputs did not change.
//   asm    : the .assembly.json object
//   sheets : {sheetId: {items:[{id,loop,layer,pts,closed}], thickness}}
//   cache  : Map kept by the caller between calls (part bindings + built meshes)
// A part's mesh key = its machined geometry + its placement + its host's placement (for "on"), so moving a hole
// rebuilds that one part, and reshaping a host re-places the parts standing on it.
function buildAssembly(asm, sheets, cache) {
  cache = cache || new Map();
  const extracted = {}, errors = [], rebuilt = [];
  const sheetParts = id => { if (!extracted[id]) { const sh = sheets[id]; extracted[id] = sh ? extractParts(sh.items, sh.thickness) : { parts: [], loose: [] }; } return extracted[id]; };
  const sheetDef = new Map((asm.sheets || []).map(s => [s.id, s]));
  const entries = [], used = new Set();
  for (const e of asm.parts || []) {
    if (!sheets[e.sheet]) { errors.push('part ' + e.id + ': sheet "' + e.sheet + '" is not loaded'); continue; }
    const ex = sheetParts(e.sheet);
    if (e.all) { ex.parts.forEach((p, i) => { used.add(p); entries.push(Object.assign({}, e, { id: e.sheet + ':' + (i + 1), all: false, _part: p })); }); continue; }
    const bound = cache.get('bind:' + e.id);
    let p = (bound && ex.parts.find(q => q.outlineId === bound)) || partAt(ex.parts, { x: e.at[0], y: e.at[1] });
    if (!p) { errors.push('part ' + e.id + ': no outline near ' + e.at.join(',') + ' on sheet ' + e.sheet); continue; }
    cache.set('bind:' + e.id, p.outlineId); used.add(p);
    entries.push(Object.assign({}, e, { _part: p }));
  }
  const byId = new Map(entries.map(e => [e.id, e]));
  // second setups (flip-in-place underside jobs) add their cuts to the part they were run on
  for (const s of asm.sheets || []) {
    if (!s.setupOf || !sheets[s.id]) continue;
    const host = byId.get(s.setupOf.part); if (!host) continue;
    host._part = Object.assign({}, host._part, { cuts: host._part.cuts.concat(setupCuts(host._part, sheets[s.id].items, s.setupOf.mirror || 'x')),
      ids: host._part.ids.slice() });
    host._setupSheets = (host._setupSheets || []).concat([s.id]);
  }
  const mappers = new Map(), mkeys = new Map(), visiting = new Set();
  const placementKey = e => JSON.stringify({ flip: e.flip, bend: e.bend, place: e.place, on: e.on, anchor: e.anchor, rotate: e.rotate, lift: e.lift });
  function mapperFor(id) {
    if (mappers.has(id)) return mappers.get(id);
    const e = byId.get(id); if (!e || visiting.has(id)) return null;
    visiting.add(id);
    let hostKey = '';
    const bb = bboxPts(e._part.outline);
    const m = partMapper(e._part, e, hid => { const hm = mapperFor(hid); if (hm) hostKey += '<' + mkeys.get(hid); else errors.push('part ' + id + ': cannot stand on "' + hid + '"'); return hm; });
    visiting.delete(id);
    mappers.set(id, m);
    mkeys.set(id, placementKey(e) + [bb.minX, bb.minY, bb.maxX, bb.maxY].map(v => v.toFixed(4)).join(',') + e._part.thickness + hostKey);
    return m;
  }
  const out = [];
  for (const e of entries) {
    const m = mapperFor(e.id); if (!m) continue;
    const key = partSignature(e._part) + '#' + mkeys.get(e.id);
    const prev = cache.get('mesh:' + e.id);
    let mesh;
    if (prev && prev.key === key) mesh = prev.mesh;
    else { mesh = partSolid(e._part, { map: m.map, ybreaks: m.ybreaks }); cache.set('mesh:' + e.id, { key, mesh }); rebuilt.push(e.id); }
    const sd = sheetDef.get(e.sheet) || {};
    const pbb = bboxPts(e._part.outline);
    out.push({ id: e.id, label: e.label || e.id, sheet: e.sheet, color: e.color || sd.color || '#8fa3bf', ids: e._part.ids, outlineId: e._part.outlineId,
      setupSheets: e._setupSheets || [], mesh, info: m.info,
      map: m.map, T: m.T, outline: e._part.outline, bbox: pbb, cx2: pbb.minX + pbb.maxX });   // map/T/outline: toolpath playback
  }
  const unplaced = [];
  for (const id in extracted) for (const p of extracted[id].parts) if (!used.has(p)) unplaced.push({ sheet: id, key: p.key, bbox: p.bbox });
  return { parts: out, errors, rebuilt, unplaced };
}

// ---------------------------------------------------------------- toolpath playback
// G-code -> timed moves {x0,y0,z0,x1,y1,z1,rapid,tool,feed,t0,t1,line}. Arcs are tessellated and long lines split
// (maxSeg) so every piece can be bent with its part. Time = length / feed (rapids at opts.rapid ipm), seconds.
function tapMoves(text, opts) {
  const o = Object.assign({ rapid: 300, arcStep: 0.05, maxSeg: 0.5 }, opts || {});
  let x = 0, y = 0, z = 2, mode = 'G0', feed = 60, tool = 0, t = 0, n = 0;
  const out = [];
  const push = (x1, y1, z1, rapid) => {
    const len = Math.hypot(x1 - x, y1 - y, z1 - z);
    if (len < 1e-9) return;
    const pieces = Math.max(1, Math.ceil(Math.hypot(x1 - x, y1 - y) / o.maxSeg));
    for (let i = 1; i <= pieces; i++) {
      const f = i / pieces, ax = x + (x1 - x) * (i - 1) / pieces, ay = y + (y1 - y) * (i - 1) / pieces, az = z + (z1 - z) * (i - 1) / pieces;
      const bx = x + (x1 - x) * f, by = y + (y1 - y) * f, bz = z + (z1 - z) * f;
      const dt = Math.hypot(bx - ax, by - ay, bz - az) / Math.max(1e-6, rapid ? o.rapid : feed) * 60;
      out.push({ x0: ax, y0: ay, z0: az, x1: bx, y1: by, z1: bz, rapid, tool, feed: rapid ? o.rapid : feed, t0: t, t1: t + dt, line: n });
      t += dt;
    }
    x = x1; y = y1; z = z1;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    n++;
    const ln = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!ln) continue;
    const tm = /^T(\d+)/.exec(ln); if (tm) { tool = +tm[1]; continue; }
    if (/^G4\b|^G0?4\s/.test(ln) || /^[MS%]/.test(ln) || /^G9[01]\b/.test(ln) || /^G2[01]\b/.test(ln) || /^G1[789]\b/.test(ln) || /^G4[09]\b/.test(ln)) continue;
    const v = c => { const r = new RegExp(c + '\\s*(-?\\d*\\.?\\d+)').exec(ln); return r ? +r[1] : null; };
    const g = /^G0*([0-3])(?![0-9])/.exec(ln); if (g) mode = 'G' + g[1];
    const F = v('F'); if (F != null) feed = F;
    const nx = v('X'), ny = v('Y'), nz = v('Z');
    if (nx == null && ny == null && nz == null) continue;
    const X1 = nx == null ? x : nx, Y1 = ny == null ? y : ny, Z1 = nz == null ? z : nz;
    if ((mode === 'G2' || mode === 'G3') && (v('I') != null || v('J') != null)) {
      const cx = x + (v('I') || 0), cy = y + (v('J') || 0), r = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(Y1 - cy, X1 - cx);
      if (mode === 'G2') { while (a1 >= a0 - 1e-12) a1 -= 2 * Math.PI; } else { while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI; }
      const k = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / o.arcStep)), z0 = z;
      for (let i = 1; i <= k; i++) { const a = a0 + (a1 - a0) * i / k;
        push(i === k ? X1 : cx + r * Math.cos(a), i === k ? Y1 : cy + r * Math.sin(a), z0 + (Z1 - z0) * i / k, false); }
    } else push(X1, Y1, Z1, mode === 'G0');
  }
  return out;
}
// Timed moves -> world-space line buffers, through the placed part each move sits on.
// targets: [{outline, bbox, map(x,y,z)->{p,n}, T, setup?:{cx2}}] — a setup target is a flip-in-place second setup:
// its sheet x is mirrored and its Z0 is the part's bottom face. Moves farther than `reach` from every part
// (the final park, the Z2 lift at the origin) are left out of the picture but keep their time.
function toolpathWorld(moves, targets, opts) {
  const o = Object.assign({ reach: 1.0, cutColors: { 8: [0.82, 0.32, 0.9] }, cutColor: [1, 0.72, 0.16], rapidColor: [0.52, 0.58, 0.68] }, opts || {});
  const pick = (x, y) => {
    let best = null, bd = Infinity;
    for (const tg of targets) {
      const b = tg.bbox, dx = Math.max(b.minX - x, 0, x - b.maxX), dy = Math.max(b.minY - y, 0, y - b.maxY), d = Math.hypot(dx, dy);
      if (d === 0 && pointInPoly({ x, y }, tg.outline)) return tg;
      const c = tg._c || (tg._c = centroidOf(tg.outline)), dd = d + 1e-3 * Math.hypot(c.x - x, c.y - y);
      if (dd < bd) { bd = dd; best = tg; }
    }
    return bd <= o.reach ? best : null;
  };
  const world = (tg, x, y, z) => tg.setup ? tg.map(tg.setup.cx2 - x, y, -z) : tg.map(x, y, tg.T + z);
  const n = moves.length;
  const pos = new Float32Array(n * 6), col = new Float32Array(n * 6), at = new Float32Array(n * 6), axis = new Float32Array(n * 3), drawn = new Uint8Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const m = moves[i], ta = pick(m.x0, m.y0), tb = pick(m.x1, m.y1);
    if (!ta || !tb) continue;
    const A = world(ta, m.x0, m.y0, m.z0), B = world(tb, m.x1, m.y1, m.z1), up = B.n(tb.setup ? [0, 0, -1] : [0, 0, 1]);
    const c = m.rapid ? o.rapidColor : (o.cutColors[m.tool] || o.cutColor);
    pos.set([A.p[0], A.p[1], A.p[2], B.p[0], B.p[1], B.p[2]], v * 6);
    col.set([c[0], c[1], c[2], c[0], c[1], c[2]], v * 6);
    at.set([A.p[0], A.p[1], A.p[2], B.p[0], B.p[1], B.p[2]], i * 6);
    axis.set(up, i * 3); drawn[i] = 1; v++;
    m._v = v;   // lines to draw once this move is done
  }
  let last = 0;
  const upto = new Uint32Array(n);   // vertex count to draw after move i
  for (let i = 0; i < n; i++) { if (drawn[i]) last = moves[i]._v; upto[i] = last * 2; }
  return { positions: pos.subarray(0, v * 6), colors: col.subarray(0, v * 6), vertexCount: v * 2, upto, at, axis, drawn,
    total: n ? moves[n - 1].t1 : 0 };
}
// Playhead t (s) -> {move index, tool tip world point, tool axis, vertices to draw}; null before anything is shown.
function toolpathAt(moves, tw, t) {
  const n = moves.length; if (!n) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (moves[mid].t1 < t) lo = mid + 1; else hi = mid; }
  let i = lo;
  while (i > 0 && !tw.drawn[i]) i--;                   // park / off-part moves: hold the tool at the last visible point
  if (!tw.drawn[i]) return { index: lo, tip: null, axis: null, vertices: 0, tool: moves[lo].tool };
  const m = moves[i], f = i === lo && m.t1 > m.t0 ? Math.max(0, Math.min(1, (t - m.t0) / (m.t1 - m.t0))) : 1;
  const a = tw.at.subarray(i * 6, i * 6 + 6);
  const tip = [a[0] + (a[3] - a[0]) * f, a[1] + (a[4] - a[1]) * f, a[2] + (a[5] - a[2]) * f];
  const verts = (i > 0 ? tw.upto[i - 1] : 0) + (f > 0 ? 2 : 0);
  return { index: lo, tip, axis: Array.from(tw.axis.subarray(i * 3, i * 3 + 3)), vertices: Math.min(tw.upto[i], verts), tool: m.tool, line: m.line, rapid: m.rapid };
}

function validateAssembly(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (a.format !== 'aqcam-assembly') errs.push('format must be "aqcam-assembly"');
  if (!Array.isArray(a.sheets) || !a.sheets.length) errs.push('sheets[] missing');
  if (!Array.isArray(a.parts)) errs.push('parts[] missing');
  const ids = new Set((a.sheets || []).map(s => s.id));
  for (const p of a.parts || []) {
    if (!p.id) errs.push('part without id');
    if (!ids.has(p.sheet)) errs.push('part ' + p.id + ': unknown sheet ' + p.sheet);
    if (!p.all && !(Array.isArray(p.at) && p.at.length === 2)) errs.push('part ' + p.id + ': at:[x,y] (a point inside its outline) required');
  }
  for (const s of a.sheets || []) if (s.setupOf && !(a.parts || []).some(p => p.id === s.setupOf.part)) errs.push('sheet ' + s.id + ': setupOf.part ' + (s.setupOf && s.setupOf.part) + ' is not a part');
  return errs;
}

return { layerRule, isLayerJob, DAN_STYLE, jobFromLayers, selectByRule, opResult, postQueue,
  extractParts, partSignature, partAt, setupCuts, partSolid, partMapper, archPath, bendMapper, buildAssembly,
  earcut, triangulateEx, splitTriByY, regionMinus, defaultAssembly, validateAssembly, tapMoves, toolpathWorld, toolpathAt,
  pointInPoly, centroidOf, bboxPts, area };
});
