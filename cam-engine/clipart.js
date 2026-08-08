/* clipart.js — a shape library: reusable vector art you drop into a job. Pure (no DOM, no deps).
 *
 * Every entry is stored NORMALIZED: x runs 0..1 and y runs 0..(1/aspect), so a piece can be placed
 * at any size without carrying its original scale around. Loops keep CAM winding — outer contours
 * CCW, holes CW — so a placed gear or life-ring pockets with its centre left uncut, exactly like the
 * bitmap tracer's output.
 *
 * The built-in catalogue is generated procedurally rather than shipped as a blob of coordinates:
 * it stays a few hundred bytes of code instead of a few hundred KB of data, and every piece can be
 * regenerated at any smoothness.
 *
 * User entries are made from the current selection with clipartFromLoops(), and a whole library
 * exports/imports as versioned .aqclip JSON.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.CLIPART = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const TAU = Math.PI * 2;

// ---- little geometry helpers (local, so this file stays dependency-free) ----
function _arc(cx, cy, r, a0, a1, n) { const out = []; n = n || 48; for (let i = 0; i <= n; i++) out.push({ x: cx + r * Math.cos(a0 + (a1 - a0) * i / n), y: cy + r * Math.sin(a0 + (a1 - a0) * i / n) }); return out; }
function _circle(cx, cy, r, n) { const out = []; n = n || 64; for (let i = 0; i < n; i++) { const a = i / n * TAU; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } return out; }
function signedArea(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; } return a / 2; }
function _ccw(pts) { return signedArea(pts) >= 0 ? pts : pts.slice().reverse(); }
function _cw(pts) { return signedArea(pts) < 0 ? pts : pts.slice().reverse(); }
function _bbox(loops) {
  let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const l of loops) for (const p of l.pts) { if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y; }
  return b;
}
function slugId(name) { return String(name || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'clip'; }

// ---- normalize any loop set into the unit box (x 0..1, y 0..1/aspect) ----
function normalizeLoops(loops) {
  const clean = (loops || []).filter(l => l && l.pts && l.pts.length >= 3);
  if (!clean.length) return { loops: [], aspect: 1 };
  const b = _bbox(clean);
  const w = (b.maxX - b.minX) || 1, h = (b.maxY - b.minY) || 1, k = 1 / w;
  return {
    aspect: w / h,
    loops: clean.map(l => ({ closed: true, pts: l.pts.map(p => ({ x: (p.x - b.minX) * k, y: (p.y - b.minY) * k })) }))
  };
}
// Make a library entry from arbitrary world-space loops (e.g. the current selection).
function clipartFromLoops(name, category, loops) {
  const n = normalizeLoops(loops);
  return { id: slugId(name), name: String(name || 'Clip'), category: String(category || 'My shapes'),
    aspect: n.aspect, loops: n.loops, builtin: false };
}
// Scale an entry into a target box. keepAspect fits it inside and centres it; otherwise it stretches.
function placeClipart(entry, box) {
  const e = entry || {}, o = box || {};
  const x = o.x || 0, y = o.y || 0, w = o.w > 0 ? o.w : 1, h = o.h > 0 ? o.h : (w / (e.aspect || 1));
  const uh = 1 / (e.aspect || 1);                       // the entry's own height in unit space
  let sx, sy, ox = 0, oy = 0;
  if (o.keepAspect === false) { sx = w; sy = h / uh; }
  else { const k = Math.min(w, h / uh); sx = sy = k; ox = (w - k) / 2; oy = (h - k * uh) / 2; }
  return (e.loops || []).map(l => ({ closed: true, pts: l.pts.map(p => ({ x: x + ox + p.x * sx, y: y + oy + p.y * sy })) }));
}
// Loops laid out inside a size x size preview box (for UI swatches).
function clipartThumbnail(entry, size) { size = size > 0 ? size : 48; return placeClipart(entry, { x: 0, y: 0, w: size, h: size, keepAspect: true }); }

// ---- built-in catalogue (procedural) ----
function _entry(id, name, category, loops) {
  const n = normalizeLoops(loops);
  return { id: id, name: name, category: category, aspect: n.aspect, loops: n.loops, builtin: true };
}
function _heart() {
  const pts = [];
  for (let i = 0; i < 120; i++) { const t = i / 120 * TAU;
    pts.push({ x: 16 * Math.pow(Math.sin(t), 3), y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) }); }
  return [{ pts: _ccw(pts), closed: true }];
}
function _star(n, rI) {
  const pts = []; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i / (n * 2) * TAU; const r = i % 2 ? rI : 1; pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) }); }
  return [{ pts: _ccw(pts), closed: true }];
}
function _arrow() {
  return [{ closed: true, pts: _ccw([{ x: 0, y: 0.3 }, { x: 0.55, y: 0.3 }, { x: 0.55, y: 0 }, { x: 1, y: 0.5 }, { x: 0.55, y: 1 }, { x: 0.55, y: 0.7 }, { x: 0, y: 0.7 }]) }];
}
function _chevron() {
  return [{ closed: true, pts: _ccw([{ x: 0, y: 0 }, { x: 0.35, y: 0 }, { x: 0.7, y: 0.5 }, { x: 0.35, y: 1 }, { x: 0, y: 1 }, { x: 0.35, y: 0.5 }]) }];
}
function _cross(t) {
  const a = (1 - t) / 2, b = a + t;
  return [{ closed: true, pts: _ccw([{ x: a, y: 0 }, { x: b, y: 0 }, { x: b, y: a }, { x: 1, y: a }, { x: 1, y: b }, { x: b, y: b }, { x: b, y: 1 }, { x: a, y: 1 }, { x: a, y: b }, { x: 0, y: b }, { x: 0, y: a }, { x: a, y: a }]) }];
}
function _diamond() { return [{ closed: true, pts: _ccw([{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }]) }]; }
function _ngon(n) { const pts = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i / n * TAU; pts.push({ x: Math.cos(a), y: Math.sin(a) }); } return [{ pts: _ccw(pts), closed: true }]; }
function _gear(teeth) {
  const rO = 1, rR = 0.82, hole = 0.34, pts = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = i / teeth * TAU, q = TAU / teeth / 4;
    pts.push(...(_arc(0, 0, rO, a0 - q * 0.8, a0 + q * 0.8, 4)));
    pts.push(...(_arc(0, 0, rR, a0 + q * 1.4, a0 + q * 2.6, 4)));
  }
  return [{ pts: _ccw(pts), closed: true }, { pts: _cw(_circle(0, 0, hole, 48)), closed: true }];
}
function _roundRect(w, h, r) {
  const pts = [];
  pts.push(..._arc(w - r, r, r, -Math.PI / 2, 0, 8));
  pts.push(..._arc(w - r, h - r, r, 0, Math.PI / 2, 8));
  pts.push(..._arc(r, h - r, r, Math.PI / 2, Math.PI, 8));
  pts.push(..._arc(r, r, r, Math.PI, Math.PI * 1.5, 8));
  return [{ pts: _ccw(pts), closed: true }];
}
function _ellipse(rx, ry) { const pts = []; for (let i = 0; i < 72; i++) { const a = i / 72 * TAU; pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) }); } return [{ pts: _ccw(pts), closed: true }]; }
function _banner() {
  return [{ closed: true, pts: _ccw([{ x: 0, y: 0 }, { x: 0.16, y: 0.28 }, { x: 0, y: 0.56 }, { x: 0.1, y: 0.56 },
    { x: 0.1, y: 1 }, { x: 0.9, y: 1 }, { x: 0.9, y: 0.56 }, { x: 1, y: 0.56 }, { x: 0.84, y: 0.28 }, { x: 1, y: 0 }, { x: 0.9, y: 0 }, { x: 0.9, y: 0.44 }, { x: 0.1, y: 0.44 }, { x: 0.1, y: 0 }]) }];
}
function _shield() {
  const pts = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0.45 }];
  pts.push(..._arc(0.5, 0.45, 0.5, 0, -Math.PI, 28).slice(1));
  return [{ pts: _ccw(pts), closed: true }];
}
function _lifeRing() {
  const outer = _circle(0, 0, 1, 72), inner = _cw(_circle(0, 0, 0.55, 56));
  const blocks = [];
  for (let k = 0; k < 4; k++) {                       // the four grip pads, as holes in the ring
    const a = k * Math.PI / 2 + Math.PI / 4, w = 0.22;
    const c = { x: Math.cos(a), y: Math.sin(a) }, n = { x: -Math.sin(a), y: Math.cos(a) };
    const p = [];
    for (const [ra, s] of [[1.02, -1], [1.02, 1], [0.53, 1], [0.53, -1]]) p.push({ x: c.x * ra + n.x * w * s, y: c.y * ra + n.y * w * s });
    blocks.push({ pts: _cw(p), closed: true });
  }
  return [{ pts: _ccw(outer), closed: true }, { pts: inner, closed: true }].concat(blocks);
}
function _drop() {
  const pts = [{ x: 0, y: 1 }];
  pts.push(..._arc(0, -0.15, 0.62, Math.PI * 0.72, -Math.PI * 0.28 - TAU, 56));
  return [{ pts: _ccw(pts), closed: true }];
}
function _waves() {
  const out = [];
  for (let row = 0; row < 3; row++) {
    const y0 = row * 0.34, top = [], bot = [];
    for (let i = 0; i <= 48; i++) { const x = i / 48; const y = y0 + 0.06 + 0.05 * Math.sin(x * TAU * 1.5); top.push({ x, y: y + 0.07 }); bot.push({ x, y: y }); }
    out.push({ pts: _ccw(top.concat(bot.reverse())), closed: true });
  }
  return out;
}
function _noSymbol() {
  const outer = _circle(0, 0, 1, 72), inner = _cw(_circle(0, 0, 0.78, 64));
  const a = Math.PI / 4, n = { x: -Math.sin(a), y: Math.cos(a) }, d = { x: Math.cos(a), y: Math.sin(a) }, w = 0.11, L = 0.78;
  const bar = [
    { x: -d.x * L + n.x * w, y: -d.y * L + n.y * w }, { x: d.x * L + n.x * w, y: d.y * L + n.y * w },
    { x: d.x * L - n.x * w, y: d.y * L - n.y * w }, { x: -d.x * L - n.x * w, y: -d.y * L - n.y * w }];
  return [{ pts: _ccw(outer), closed: true }, { pts: inner, closed: true }, { pts: _ccw(bar), closed: true }];
}
function _ladder() {
  const out = [], railW = 0.14;
  out.push({ pts: _ccw([{ x: 0, y: 0 }, { x: railW, y: 0 }, { x: railW, y: 1 }, { x: 0, y: 1 }]), closed: true });
  out.push({ pts: _ccw([{ x: 1 - railW, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1 - railW, y: 1 }]), closed: true });
  for (let k = 0; k < 3; k++) { const y = 0.18 + k * 0.31;
    out.push({ pts: _ccw([{ x: railW, y: y }, { x: 1 - railW, y: y }, { x: 1 - railW, y: y + 0.12 }, { x: railW, y: y + 0.12 }]), closed: true }); }
  return out;
}
function builtinClipart() { return [
  _entry('heart', 'Heart', 'Basic', _heart()),
  _entry('star5', 'Star (5)', 'Basic', _star(5, 0.42)),
  _entry('burst12', 'Starburst', 'Basic', _star(12, 0.66)),
  _entry('arrow', 'Arrow', 'Basic', _arrow()),
  _entry('chevron', 'Chevron', 'Basic', _chevron()),
  _entry('cross', 'Cross', 'Basic', _cross(0.34)),
  _entry('diamond', 'Diamond', 'Basic', _diamond()),
  _entry('hexagon', 'Hexagon', 'Basic', _ngon(6)),
  _entry('gear', 'Gear', 'Basic', _gear(12)),
  _entry('plaque-round', 'Plaque (round corner)', 'Plaques', _roundRect(1.6, 1, 0.18)),
  _entry('plaque-oval', 'Plaque (oval)', 'Plaques', _ellipse(1.5, 1)),
  _entry('banner', 'Banner ribbon', 'Plaques', _banner()),
  _entry('shield', 'Shield', 'Plaques', _shield()),
  _entry('life-ring', 'Life ring', 'Pool & safety', _lifeRing()),
  _entry('water-drop', 'Water drop', 'Pool & safety', _drop()),
  _entry('waves', 'Waves', 'Pool & safety', _waves()),
  _entry('no-symbol', 'No / prohibited', 'Pool & safety', _noSymbol()),
  _entry('pool-ladder', 'Pool ladder', 'Pool & safety', _ladder())
]; }
function clipartCategories(list) {
  const seen = [], out = [];
  for (const e of (list || [])) if (seen.indexOf(e.category) < 0) { seen.push(e.category); out.push(e.category); }
  return out;
}

// ---- library management + versioned .aqclip persistence ----
const CLIP_FORMAT = 'aqclip', CLIP_VERSION = 1;
function normalizeClipart(e) {
  e = e && typeof e === 'object' ? e : {};
  const loops = (Array.isArray(e.loops) ? e.loops : []).filter(l => l && Array.isArray(l.pts) && l.pts.length >= 3)
    .map(l => ({ closed: true, pts: l.pts.map(p => ({ x: +p.x || 0, y: +p.y || 0 })) }));
  const name = String(e.name || 'Clip');
  return { id: e.id ? slugId(e.id) : slugId(name), name: name, category: String(e.category || 'My shapes'),
    aspect: (+e.aspect > 0 ? +e.aspect : 1), loops: loops, builtin: !!e.builtin };
}
function upsertClipart(list, e) { const n = normalizeClipart(e); const out = (list || []).filter(x => x.id !== n.id); out.push(n); return out; }
function removeClipart(list, id) { return (list || []).filter(x => x.id !== id); }
function libraryToJSON(list) {
  return JSON.stringify({ format: CLIP_FORMAT, version: CLIP_VERSION,
    entries: (list || []).map(normalizeClipart).filter(e => e.loops.length) }, null, 2);
}
function libraryFromJSON(text) {
  let o; try { o = JSON.parse(text); } catch (e) { throw new Error('Not a clipart library (invalid JSON)'); }
  if (!o || o.format !== CLIP_FORMAT) throw new Error('Not a clipart library');
  if (o.version !== CLIP_VERSION) throw new Error('Unsupported clipart version ' + o.version);
  if (!Array.isArray(o.entries)) throw new Error('Clipart library has no entries');
  const out = o.entries.map(normalizeClipart).filter(e => e.loops.length);
  if (!out.length) throw new Error('Clipart library has no usable shapes');
  return out;
}

return { builtinClipart, clipartCategories, placeClipart, clipartThumbnail, clipartFromLoops,
  normalizeLoops, normalizeClipart, upsertClipart, removeClipart, libraryToJSON, libraryFromJSON,
  signedArea, slugId, CLIP_FORMAT, CLIP_VERSION };
});
