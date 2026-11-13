/* cutprep.js - cut-file preparation for the Aquamentor CAD/CAM studio. Pure (no DOM); node + browser.
 *
 *  1. DXF layer split   classifyLoops / splitLayers / toDXFLayered
 *       Outside profile paths (part outer edges) go on ONE layer (OUTSIDE_PROFILE); anything contained within
 *       a part (holes, slots, cut-outs, engraving inside a part) goes on a SEPARATE layer (INSIDE_CUT), so the
 *       operator can outside-profile one layer and inside-cut / pocket the other. Layer names match the ones
 *       assembly.js already reads. Containment depth decides: depth 0 = outside, depth 1 = inside (a hole),
 *       depth 2 = an island sitting in a hole = a part again = outside, and so on. Only through-cuts count as
 *       containers (POCKET_* loops are partial depth), and reference layers (SHEET, NOTES, *_VECTOR_ONLY) are left alone.
 *  2. Stock nesting     HDPE_STOCK / nestOnStock / placeShapeOnStock / verifyNest
 *       Packs part bounding boxes onto real stock pieces (48in and 96in HDPE boards, or a 48.5x97 sheet),
 *       preferring the smallest piece that fits, honouring per-piece quantity, margin, spacing and rotation.
 *  3. .tap sanity       tapSanity / checkShopFileName
 *       Static checks on a WinCNC / ShopSabre program before it goes near the machine, and a file-name check
 *       against Claude Tasks and Projects/_state/SHOP-FILES-RULES.md (sections 4 and 5).
 */
(function (root, factory) {
  const CAD = (typeof require === 'function') ? require('./cadcore.js') : root.CADCORE;
  const mod = factory(CAD);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.CUTPREP = mod;
})(typeof self !== 'undefined' ? self : this, function (CAD) {
'use strict';

const LAYER_OUTSIDE = 'OUTSIDE_PROFILE', LAYER_INSIDE = 'INSIDE_CUT', LAYER_OPEN = 'OPEN_VECTOR';
const EPS = 1e-6;

// ======================================================================= 1. DXF layer split
function polyArea(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x * pts[i].y - pts[i].x * pts[j].y); return a / 2; }
function distToPolyEdge(p, pts) { let d = Infinity; for (let i = 0; i < pts.length; i++) { const e = CAD.distToSeg(p, pts[i], pts[(i + 1) % pts.length]); if (e < d) d = e; } return d; }
// every vertex of `inner` is inside `outer` or on its edge, and at least one is strictly inside
function loopInside(inner, outer) {
  const ib = CAD.bboxPts(inner), ob = CAD.bboxPts(outer);
  if (ib.minX < ob.minX - EPS || ib.maxX > ob.maxX + EPS || ib.minY < ob.minY - EPS || ib.maxY > ob.maxY + EPS) return false;
  let strict = 0;
  for (const p of inner) {
    if (CAD.pointInPoly(p, outer)) { if (distToPolyEdge(p, outer) > 1e-5) strict++; continue; }
    if (distToPolyEdge(p, outer) > 1e-5) return false;
  }
  if (strict) return true;
  // every vertex touches the edge (a loop identical in outline / inscribed): fall back to edge midpoints
  const m = inner.map((p, i) => { const q = inner[(i + 1) % inner.length]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; });
  return m.some(p => CAD.pointInPoly(p, outer) && distToPolyEdge(p, outer) > 1e-5) && m.every(p => CAD.pointInPoly(p, outer) || distToPolyEdge(p, outer) <= 1e-5);
}
// Reference-only layers are never machined and never count as a part: the sheet outline would otherwise contain every
// part and flip the whole drawing inside-out. Same names assembly.layerRule treats as 'sheet' / 'skip'.
function isReferenceLayer(name) {
  const n = String(name == null ? '' : name).toUpperCase().trim();
  return n === 'SHEET' || /(^|_)VECTOR_ONLY$/.test(n) || ['NOTES', 'NOTE', 'TEXT', 'DIMS', 'DIMENSIONS'].includes(n);
}
// Pockets (partial-depth) do not separate material, so they never make what sits in them a hole or an island:
// a drill in a counterbore is still inside the part, a cap inside its shoulder pocket is still a part.
function isPartialDepthLayer(name) { return /^POCKET_/i.test(String(name == null ? '' : name).trim()); }
// Loops of the machinable shapes (annotations / dimensions / reference layers are never machined, skipped).
function collectLoops(shapes) {
  const loops = [];
  shapes.forEach((s, si) => {
    if (s.annotation || s.type === 'dim' || isReferenceLayer(s.layer)) return;
    CAD.flatten(s).forEach((l, li) => {
      if (!l.pts || l.pts.length < 2) return;
      const pts = l.closed ? l.pts.slice(0, l.pts.length > 2 && Math.hypot(l.pts[0].x - l.pts[l.pts.length - 1].x, l.pts[0].y - l.pts[l.pts.length - 1].y) < 1e-9 ? -1 : undefined) : l.pts;
      loops.push({ si, li, through: !isPartialDepthLayer(s.layer), closed: !!l.closed && pts.length >= 3, pts, area: l.closed ? Math.abs(polyArea(pts)) : 0 });
    });
  });
  return loops;
}
// -> [{si, li, closed, depth, kind:'outside'|'inside'|'open', layer, parent}]  (parent = index of the immediate container)
function classifyLoops(shapes) {
  const loops = collectLoops(shapes);
  const closed = loops.filter(l => l.closed && l.through).sort((a, b) => b.area - a.area);
  for (const l of loops) {
    const containers = closed.filter(c => c !== l && c.area > l.area + EPS && loopInside(l.pts, c.pts));
    l.depth = containers.length;
    l.parent = containers.length ? loops.indexOf(containers[containers.length - 1]) : -1;   // smallest container (sorted big -> small)
    if (!l.through) { l.kind = 'inside'; }                 // a pocket is never a through profile, wherever it sits
    else if (!l.closed) { l.kind = l.depth > 0 ? 'inside' : 'open'; }
    else l.kind = (l.depth % 2 === 0) ? 'outside' : 'inside';
    l.layer = l.kind === 'outside' ? LAYER_OUTSIDE : l.kind === 'inside' ? LAYER_INSIDE : LAYER_OPEN;
  }
  return loops;
}
// New shape list with `layer` rewritten. Single-loop shapes (everything the studio draws) get their loop's layer.
// Returns { shapes, counts:{outside,inside,open}, mixed:[shape ids with loops that disagree] }.
function splitLayers(shapes, opts) {
  opts = opts || {};
  const L = { outside: opts.outside || LAYER_OUTSIDE, inside: opts.inside || LAYER_INSIDE, open: opts.open || LAYER_OPEN };
  const cls = classifyLoops(shapes), counts = { outside: 0, inside: 0, open: 0 }, mixed = [];
  const out = shapes.map(s => CAD.clone(s));
  const bySi = new Map();
  for (const c of cls) { counts[c.kind]++; if (!bySi.has(c.si)) bySi.set(c.si, []); bySi.get(c.si).push(c); }
  for (const [si, cs] of bySi) {
    const kinds = new Set(cs.map(c => c.kind));
    out[si].layer = L[cs[0].kind];
    if (kinds.size > 1) mixed.push(shapes[si].id);
  }
  return { shapes: out, counts, mixed };
}
// DXF with a LAYER table and one LWPOLYLINE per loop, each on its own classified layer (compound shapes are split by loop).
function toDXFLayered(shapes, opts) {
  opts = opts || {};
  const L = { outside: opts.outside || LAYER_OUTSIDE, inside: opts.inside || LAYER_INSIDE, open: opts.open || LAYER_OPEN };
  const cls = classifyLoops(shapes), used = new Set();
  const ent = [];
  for (const c of cls) {
    const name = L[c.kind]; used.add(name);
    ent.push('0', 'LWPOLYLINE', '8', name, '90', String(c.pts.length), '70', c.closed ? '1' : '0');
    for (const p of c.pts) ent.push('10', p.x.toFixed(5), '20', p.y.toFixed(5));
  }
  const colors = { [L.outside]: 5, [L.inside]: 1, [L.open]: 3 };
  // reference-only shapes (sheet outline, notes) ride along untouched on their own layer
  shapes.forEach(s => {
    if (s.annotation || s.type === 'dim' || !isReferenceLayer(s.layer)) return;
    for (const l of CAD.flatten(s)) { if (!l.pts || l.pts.length < 2) continue; used.add(s.layer);
      ent.push('0', 'LWPOLYLINE', '8', s.layer, '90', String(l.pts.length), '70', l.closed ? '1' : '0');
      for (const p of l.pts) ent.push('10', p.x.toFixed(5), '20', p.y.toFixed(5)); }
  });
  const tbl = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(used.size)];
  for (const n of used) tbl.push('0', 'LAYER', '2', n, '70', '0', '62', String(colors[n] || 7), '6', 'CONTINUOUS');
  tbl.push('0', 'ENDTAB', '0', 'ENDSEC');
  return [...tbl, '0', 'SECTION', '2', 'ENTITIES', ...ent, '0', 'ENDSEC', '0', 'EOF'].join('\r\n');
}

// ======================================================================= 2. stock nesting
// HDPE 2x4 "48in" pieces really run 48.25-48.5in; lay out for the worst case (48.25). 96in boards are used at 96.
// A 2x4 is 1.5 x 3.5 actual; its face width for routing is 3.5. The default sheet is the studio job (48.5 x 97).
const HDPE_STOCK = {
  board48: { id: 'HDPE-48', w: 48.25, h: 3.5 },
  board96: { id: 'HDPE-96', w: 96, h: 3.5 },
  sheet:   { id: 'SHEET-48.5x97', w: 48.5, h: 97 }
};
// stock: [{id,w,h,qty?}] (qty omitted = unlimited). Shelf packing per piece; a part goes to the first open piece it fits,
// else a new piece of the smallest-area stock type that fits and still has quantity.
function nestOnStock(shapes, opts) {
  opts = opts || {};
  const stock = (opts.stock && opts.stock.length ? opts.stock : [HDPE_STOCK.board96]).map(s => ({ id: s.id, w: s.w, h: s.h, qty: s.qty == null ? Infinity : s.qty, used: 0 }));
  const margin = opts.margin || 0, spacing = opts.spacing || 0, allowRotate = opts.allowRotate !== false;
  const items = shapes.map((s, i) => { const b = CAD.bbox(s); return { idx: i, w: b.maxX - b.minX, h: b.maxY - b.minY }; })
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  const pieces = [], placements = [], unplaced = [];
  const tryPiece = (pc, it) => {
    const orients = [{ w: it.w, h: it.h, rot: false }];
    if (allowRotate && Math.abs(it.w - it.h) > EPS) orients.push({ w: it.h, h: it.w, rot: true });
    let best = null;
    for (const o of orients) {
      // existing shelves first (smallest leftover height wins), then a new shelf
      for (const sh of pc.shelves) {
        if (o.h <= sh.h + EPS && sh.x + o.w <= pc.w - margin + EPS) { const sc = sh.h - o.h; if (!best || sc < best.sc) best = { o, sh, x: sh.x, y: sh.y, sc, newShelf: false }; }
      }
      const ny = pc.shelves.length ? pc.shelves[pc.shelves.length - 1].y + pc.shelves[pc.shelves.length - 1].h + spacing : margin;
      if (margin + o.w <= pc.w - margin + EPS && ny + o.h <= pc.h - margin + EPS) { const sc = 1e3 + o.h; if (!best || sc < best.sc) best = { o, sh: null, x: margin, y: ny, sc, newShelf: true }; }
    }
    if (!best) return null;
    if (best.newShelf) pc.shelves.push({ y: best.y, h: best.o.h, x: margin });
    const sh = best.newShelf ? pc.shelves[pc.shelves.length - 1] : best.sh;
    sh.x = best.x + best.o.w + spacing;
    return { x: best.x, y: best.y, w: best.o.w, h: best.o.h, rot: best.o.rot };
  };
  for (const it of items) {
    let done = false;
    for (const pc of pieces) { const r = tryPiece(pc, it); if (r) { placements.push({ idx: it.idx, piece: pc.index, stockId: pc.stockId, ...r }); pc.area += r.w * r.h; done = true; break; } }
    if (done) continue;
    const types = stock.filter(s => s.used < s.qty).sort((a, b) => a.w * a.h - b.w * b.h);
    for (const t of types) {
      const pc = { index: pieces.length, stockId: t.id, w: t.w, h: t.h, shelves: [], area: 0 };
      const r = tryPiece(pc, it);
      if (r) { t.used++; pieces.push(pc); placements.push({ idx: it.idx, piece: pc.index, stockId: pc.stockId, ...r }); pc.area += r.w * r.h; done = true; break; }
    }
    if (!done) unplaced.push(it.idx);
  }
  // layout offsets: pieces side by side along X with a gap, so a multi-piece result is viewable in one space
  const gap = opts.gap == null ? 2 : opts.gap; let ox = 0;
  const outPieces = pieces.map(pc => { const o = { index: pc.index, stockId: pc.stockId, w: pc.w, h: pc.h, ox, used: pc.area, utilization: pc.area / (pc.w * pc.h) }; ox += pc.w + gap; return o; });
  const totalStock = outPieces.reduce((s, p) => s + p.w * p.h, 0), totalParts = outPieces.reduce((s, p) => s + p.used, 0);
  const byStock = {}; outPieces.forEach(p => { byStock[p.stockId] = (byStock[p.stockId] || 0) + 1; });
  return { placements, unplaced, pieces: outPieces, byStock, utilization: totalStock ? totalParts / totalStock : 0 };
}
// Move a shape to its nested spot (piece-local coords + the piece's X offset in the combined layout).
function placeShapeOnStock(shape, pl, pieces) {
  let s = CAD.clone(shape);
  if (pl.rot) s = CAD.rotate(s, 0, 0, Math.PI / 2);
  const b = CAD.bbox(s), ox = pieces[pl.piece].ox;
  return CAD.translate(s, pl.x - b.minX + ox, pl.y - b.minY);
}
// Independent check of a finished nest: every part inside its piece (margin respected), no two parts overlap (spacing respected).
function verifyNest(result, opts) {
  opts = opts || {}; const margin = opts.margin || 0, spacing = opts.spacing || 0, errs = [];
  for (const p of result.placements) {
    const pc = result.pieces[p.piece];
    if (p.x < margin - 1e-9 || p.y < margin - 1e-9 || p.x + p.w > pc.w - margin + 1e-9 || p.y + p.h > pc.h - margin + 1e-9) errs.push('part ' + p.idx + ' outside piece ' + p.piece);
  }
  for (let i = 0; i < result.placements.length; i++) for (let j = i + 1; j < result.placements.length; j++) {
    const a = result.placements[i], b = result.placements[j]; if (a.piece !== b.piece) continue;
    if (a.x < b.x + b.w + spacing - 1e-9 && b.x < a.x + a.w + spacing - 1e-9 && a.y < b.y + b.h + spacing - 1e-9 && b.y < a.y + a.h + spacing - 1e-9) errs.push('parts ' + a.idx + ' and ' + b.idx + ' overlap/violate spacing on piece ' + a.piece);
  }
  return errs;
}

// ======================================================================= 3. .tap sanity
// Static checks for a WinCNC / ShopSabre program (inch, absolute, incremental arc centres, bare "Z2" safe line).
// opts: { thickness (stock, default 1.5), overcut (default 0.05), bounds {minX,minY,maxX,maxY}, maxFeed (400),
//         maxPlungeFeed (100), minSafeZ (0.05), arcTol (0.003), units 'inch' }
function tapSanity(text, opts) {
  opts = opts || {};
  const thickness = opts.thickness == null ? 1.5 : opts.thickness, overcut = opts.overcut == null ? 0.05 : opts.overcut;
  const maxDepth = thickness + overcut, maxFeed = opts.maxFeed || 400, maxPlunge = opts.maxPlungeFeed || 100;
  const minSafeZ = opts.minSafeZ == null ? 0.05 : opts.minSafeZ, arcTol = opts.arcTol || 0.003, B = opts.bounds || null;
  const errors = [], warnings = [], tools = new Set();
  const err = (n, m) => errors.push((n ? 'line ' + n + ': ' : '') + m), warn = (n, m) => warnings.push((n ? 'line ' + n + ': ' : '') + m);
  const lines = String(text).split(/\r?\n/);
  let x = 0, y = 0, z = 2, mode = null, feed = null, tool = null, spindle = false, haveMove = false, endedSpindleOff = false;
  let minZ = Infinity, cutLen = 0, cutMoves = 0, rapidIntoMaterial = 0, lastZ = null;
  let bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, lastCode = '', nonblank = 0;
  if (/NaN|undefined|Infinity/i.test(text)) err(0, 'program contains NaN / undefined / Infinity');
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!line || line[0] === '%') return;
    nonblank++; lastCode = line;
    if (/^G4\b/.test(line)) return;                                  // dwell: "X" is seconds, not a coordinate
    if (/\bG21\b/.test(line) && opts.units !== 'mm') err(n, 'G21 (metric) in an inch program');
    if (/\bG91\b/.test(line)) err(n, 'G91 incremental positioning (program assumes absolute G90)');
    const tm = line.match(/^T(\d+)/); if (tm) { tool = +tm[1]; tools.add(tool); }
    if (/^M0*5\b/.test(line)) spindle = false;
    if (/^M0*[34]\b/.test(line)) spindle = true;
    const sm = line.match(/^S(\d+(?:\.\d+)?)/); if (sm && +sm[1] > 0) { if (!/M0*5\b/.test(line)) { /* speed set; spindle starts at M3 */ } }
    const gm = line.match(/G0*([0-3])(?![0-9])/); if (gm) mode = 'G' + gm[1];
    const v = c => { const m = line.match(new RegExp('(?:^|[^A-Z])' + c + '\\s*(-?\\d*\\.?\\d+)')); return m ? +m[1] : null; };
    const F = v('F'); if (F !== null) { feed = F; if (F > maxFeed) warn(n, 'feed F' + F + ' exceeds ' + maxFeed); if (F <= 0) err(n, 'feed F' + F + ' is not positive'); }
    if (/^Z-?[\d.]+$/.test(line)) { z = v('Z'); return; }            // bare "Z2" safe-height setting
    const nx = v('X'), ny = v('Y'), nz = v('Z');
    if (nx === null && ny === null && nz === null) return;
    if (/^M|^T\d|^S\d|^F\d/.test(line) && !gm) return;
    if (mode === null) { err(n, 'motion before any G0/G1/G2/G3'); mode = 'G0'; }
    const x0 = x, y0 = y, z0 = z;
    if (nx !== null) x = nx; if (ny !== null) y = ny; if (nz !== null) z = nz; haveMove = true; lastZ = z;
    const xyMove = Math.hypot(x - x0, y - y0) > 1e-9;
    if (mode === 'G0') {
      if (xyMove && (z0 < 0 - 1e-9 || z < 0 - 1e-9)) { rapidIntoMaterial++; err(n, 'rapid G0 XY move with tool below Z0 (z ' + z0 + ' -> ' + z + ')'); }
      return;
    }
    // cutting move
    cutMoves++;
    if (tool === null) err(n, 'cutting move before any tool (T) call');
    if (!spindle) err(n, 'cutting move with spindle off / never started (M3)');
    if (feed === null) err(n, 'cutting move before any feed (F) was set');
    if (z < minZ) minZ = z;
    if (z < -maxDepth - 1e-9) err(n, 'Z' + z + ' cuts deeper than ' + (-maxDepth).toFixed(3) + ' (stock ' + thickness + ' + ' + overcut + ' overcut)');
    if (nz !== null && z < z0 - 1e-9 && !xyMove && F !== null && F > maxPlunge) warn(n, 'plunge feed F' + F + ' exceeds ' + maxPlunge);
    if (mode === 'G2' || mode === 'G3') {
      const I = v('I'), J = v('J');
      if (I === null && J === null) err(n, mode + ' arc without I/J centre');
      else {
        const cx = x0 + (I || 0), cy = y0 + (J || 0), r0 = Math.hypot(I || 0, J || 0), r1 = Math.hypot(x - cx, y - cy);
        if (r0 < 1e-6) err(n, mode + ' arc with zero radius');
        else if (Math.abs(r0 - r1) > arcTol) err(n, mode + ' arc radius mismatch start ' + r0.toFixed(4) + ' vs end ' + r1.toFixed(4));
        cutLen += Math.PI * r0 / 2;                                   // rough: only used as a "did it cut anything" figure
      }
    } else cutLen += Math.hypot(x - x0, y - y0, z - z0);
    for (const [px, py] of [[x0, y0], [x, y]]) { if (px < bb.minX) bb.minX = px; if (px > bb.maxX) bb.maxX = px; if (py < bb.minY) bb.minY = py; if (py > bb.maxY) bb.maxY = py; }
    if (B && (x < B.minX - 1e-9 || x > B.maxX + 1e-9 || y < B.minY - 1e-9 || y > B.maxY + 1e-9)) err(n, 'cut point (' + x + ',' + y + ') outside bounds');
  });
  if (!nonblank) err(0, 'empty program');
  else if (!cutMoves) err(0, 'program has no cutting moves');
  if (tools.size === 0 && cutMoves) err(0, 'no tool (T) call in program');
  if (cutMoves && lastZ !== null && lastZ < minSafeZ) warn(0, 'program ends with tool at Z' + lastZ + ' (below safe ' + minSafeZ + ')');
  if (cutMoves && spindle) warn(0, 'spindle is still on at end of program (no M5)');
  if (cutMoves && minZ !== Infinity && minZ > -0.01) warn(0, 'deepest cut is Z' + minZ + ': nothing cuts into the material');
  if (cutMoves && minZ !== Infinity && minZ > -(thickness - 0.1) && !opts.allowPartialDepth) { /* pockets / engraves legitimately are shallow: informational only */ }
  return { ok: errors.length === 0, errors, warnings,
    stats: { lines: lines.length, tools: [...tools].sort((a, b) => a - b), cutMoves, minZ: minZ === Infinity ? null : minZ, cutBounds: cutMoves ? bb : null, rapidIntoMaterial } };
}

// File name against SHOP-FILES-RULES v2 sections 4/5: "<SKU> - <step#> <PART> - <sheet WxL> - <thickness>.tap", no versions / dates / banned words, max ~70.
function checkShopFileName(name) {
  const errs = [], base = String(name);
  if (base.length > 70) errs.push('longer than 70 characters (' + base.length + ')');
  if (!/\.(tap)$/i.test(base)) errs.push('CNC shop file must be .tap');
  const stem = base.replace(/\.tap$/i, '');
  if (/(^|[\s_-])(v\d+(\.\d+)*|rev\s?[a-z0-9]+)(?=$|[\s_.-])/i.test(stem)) errs.push('contains a version / rev');
  for (const w of ['CURRENT', 'CUT THIS', 'FINAL', 'NEW', 'USE THIS', 'PRODUCTION', 'FEEDBACK']) if (new RegExp('(^|[^A-Z])' + w + '([^A-Z]|$)', 'i').test(stem)) errs.push('banned word "' + w + '"');
  if (/\b(19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(stem)) errs.push('contains a date');
  if (!/^[A-Za-z0-9]+(-[A-Za-z0-9]+)+ - \d+[A-Za-z]? .+ - [\d.]+x[\d.]+ - [\d.]+in$/.test(stem)) errs.push('does not match "<SKU> - <step#> <PART> - <WxL> - <thickness>in"');
  return { ok: errs.length === 0, errors: errs };
}

return { LAYER_OUTSIDE, LAYER_INSIDE, LAYER_OPEN, isReferenceLayer, classifyLoops, splitLayers, toDXFLayered,
  HDPE_STOCK, nestOnStock, placeShapeOnStock, verifyNest, tapSanity, checkShopFileName };
});
