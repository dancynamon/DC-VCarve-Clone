/* bitmaptrace.js — turn a raster image into cuttable vector contours. Pure (no DOM, no Node deps).
 *
 * The UI decodes the file (PNG/JPG/GIF/BMP/WEBP) with a canvas and hands us plain RGBA pixels;
 * everything from there down — threshold, despeckle, boundary trace, simplify, smooth, scale to
 * inches — lives here so it is unit-testable headless.
 *
 * Pipeline:  RGBA → thresholdBitmap → despeckle → traceBitmap → simplifyPath → smoothPath → inches
 *
 * traceBitmap walks the boundary between ink and background on the pixel grid, emitting every edge
 * with ink on its LEFT. Chained head-to-tail that yields CCW outer contours and CW holes, which is
 * exactly the winding CAM's even-odd region builder and the Clipper booleans already expect — so a
 * traced logo pockets and profiles with its counters intact, no extra hole detection needed.
 *
 * Row order: image data is top-down (canvas convention); we flip to y-up while thresholding, so
 * everything downstream is already in CAD orientation.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.BMPTRACE = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const DEFAULTS = {
  threshold: 128,      // 0..255 luma cut; pixels DARKER than this are ink
  invert: false,       // trace the light areas instead
  alphaThreshold: 16,  // pixels more transparent than this are background whatever their colour
  despeckle: 2,        // drop ink blobs / holes smaller than this many pixels (0 = keep everything)
  tol: 1.0,            // simplify tolerance, in pixels (0 = keep the raw staircase)
  smooth: 0.5,         // 0..1 corner rounding; corners sharper than cornerAngle are preserved
  cornerAngle: 60,     // degrees of turn above which a vertex counts as a corner and is never rounded
  dpi: 96,             // pixels per inch, used when widthInches is not given
  widthInches: 0,      // scale so the image is exactly this wide (overrides dpi)
  originX: 0, originY: 0,
  minLoopPts: 3
};

// ---- 1. threshold: RGBA -> Uint8Array of 0/1, flipped to y-up ----
// img: {width, height, data} where data is RGBA, row-major, TOP-down (canvas ImageData).
function thresholdBitmap(img, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const w = img.width | 0, h = img.height | 0, d = img.data;
  const bits = new Uint8Array(w * h);
  let ink = 0;
  for (let jr = 0; jr < h; jr++) {
    const jc = h - 1 - jr;                       // flip: image row 0 is the TOP, CAD y grows up
    for (let i = 0; i < w; i++) {
      const k = (jr * w + i) * 4;
      const a = d[k + 3];
      let on;
      if (a < o.alphaThreshold) on = false;      // transparent = background
      else {
        const luma = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
        on = luma < o.threshold;                 // dark = ink
      }
      if (o.invert) on = !on;
      if (on) { bits[jc * w + i] = 1; ink++; }
    }
  }
  return { bits: bits, width: w, height: h, ink: ink };
}

// ---- 2. despeckle: drop ink blobs and enclosed holes smaller than minArea pixels ----
// 4-connected labelling with an explicit stack (no recursion — a full-page scan would blow the stack).
function _components(bits, w, h, want) {
  const seen = new Uint8Array(w * h), comps = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || bits[s] !== want) continue;
    const cells = []; let touchesBorder = false;
    stack.length = 0; stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(); cells.push(p);
      const i = p % w, j = (p - i) / w;
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) touchesBorder = true;
      if (i > 0     && !seen[p - 1] && bits[p - 1] === want) { seen[p - 1] = 1; stack.push(p - 1); }
      if (i < w - 1 && !seen[p + 1] && bits[p + 1] === want) { seen[p + 1] = 1; stack.push(p + 1); }
      if (j > 0     && !seen[p - w] && bits[p - w] === want) { seen[p - w] = 1; stack.push(p - w); }
      if (j < h - 1 && !seen[p + w] && bits[p + w] === want) { seen[p + w] = 1; stack.push(p + w); }
    }
    comps.push({ cells: cells, touchesBorder: touchesBorder });
  }
  return comps;
}
function despeckle(bits, w, h, minArea) {
  if (!(minArea > 0)) return { bits: bits, removed: 0, filled: 0 };
  const out = Uint8Array.from(bits);
  let removed = 0, filled = 0;
  for (const c of _components(out, w, h, 1)) {                       // specks of ink
    if (c.cells.length < minArea) { for (const p of c.cells) out[p] = 0; removed++; }
  }
  for (const c of _components(out, w, h, 0)) {                       // pinholes inside ink
    if (!c.touchesBorder && c.cells.length < minArea) { for (const p of c.cells) out[p] = 1; filled++; }
  }
  return { bits: out, removed: removed, filled: filled };
}

// ---- 3. trace: boundary loops on the pixel grid, ink always on the left of travel ----
function traceBitmap(bits, w, h) {
  const on = (i, j) => i >= 0 && j >= 0 && i < w && j < h && bits[j * w + i] === 1;
  const vkey = (x, y) => y * (w + 1) + x;
  const outEdges = new Map();                    // start vertex key -> [[ex,ey], ...]
  const add = (sx, sy, ex, ey) => { const k = vkey(sx, sy); let a = outEdges.get(k); if (!a) { a = []; outEdges.set(k, a); } a.push([ex, ey]); };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!on(i, j)) continue;
    if (!on(i + 1, j)) add(i + 1, j,     i + 1, j + 1);   // right wall, travelling +y
    if (!on(i, j + 1)) add(i + 1, j + 1, i,     j + 1);   // top wall,   travelling -x
    if (!on(i - 1, j)) add(i,     j + 1, i,     j);       // left wall,  travelling -y
    if (!on(i, j - 1)) add(i,     j,     i + 1, j);       // bottom wall,travelling +x
  }
  const loops = [];
  const starts = Array.from(outEdges.keys());
  for (const k0 of starts) {
    let bucket = outEdges.get(k0);
    while (bucket && bucket.length) {
      const sx = k0 % (w + 1), sy = (k0 - sx) / (w + 1);
      const pts = [{ x: sx, y: sy }];
      let cx = sx, cy = sy, guard = 0;
      const limit = 8 * w * h + 16;
      while (guard++ < limit) {
        const ck = vkey(cx, cy), b = outEdges.get(ck);
        if (!b || !b.length) break;                    // dead end (shouldn't happen on a closed boundary)
        const nxt = b.shift();
        if (!b.length) outEdges.delete(ck);
        cx = nxt[0]; cy = nxt[1];
        if (cx === sx && cy === sy) break;             // closed
        pts.push({ x: cx, y: cy });
      }
      if (pts.length >= 3) loops.push({ pts: _dropCollinear(pts), closed: true });
      bucket = outEdges.get(k0);
    }
  }
  return loops;
}
// merge runs of collinear staircase vertices (the raw trace has one vertex per pixel edge)
function _dropCollinear(pts) {
  const n = pts.length; if (n < 3) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

// ---- 4. simplify (Ramer–Douglas–Peucker) ----
function _perp(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function _rdpOpen(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let best = -1, bd = tol;
    for (let i = i0 + 1; i < i1; i++) { const d = _perp(pts[i], pts[i0], pts[i1]); if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  const out = []; for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
// Closed loops are split at the vertex farthest from pts[0] first, so the simplification isn't
// anchored to one arbitrary point (which would leave a kink there on a smooth outline).
function simplifyPath(pts, tol, closed) {
  if (!(tol > 0) || pts.length < 4) return pts.slice();
  if (!closed) return _rdpOpen(pts, tol);
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const a = _rdpOpen(pts.slice(0, far + 1), tol);
  const b = _rdpOpen(pts.slice(far).concat([pts[0]]), tol);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : pts.slice();
}

// ---- 5. smooth (Chaikin corner cutting, sharp corners preserved) ----
function _turnDeg(a, b, c) {
  const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = a2 - a1; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
  return Math.abs(d) * 180 / Math.PI;
}
function smoothPath(pts, closed, amount, cornerAngle) {
  amount = Math.max(0, Math.min(1, amount == null ? 0 : amount));
  const iters = amount <= 0 ? 0 : amount < 0.5 ? 1 : 2;
  const corner = cornerAngle == null ? DEFAULTS.cornerAngle : cornerAngle;
  let cur = pts.slice();
  for (let it = 0; it < iters && cur.length >= 3; it++) {
    const n = cur.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      if (!closed && (i === 0 || i === n - 1)) { out.push(b); continue; }
      if (_turnDeg(a, b, c) >= corner) { out.push(b); continue; }        // a real corner — leave it alone
      out.push({ x: b.x + (a.x - b.x) * 0.25, y: b.y + (a.y - b.y) * 0.25 });
      out.push({ x: b.x + (c.x - b.x) * 0.25, y: b.y + (c.y - b.y) * 0.25 });
    }
    cur = out;
  }
  return cur;
}

function signedArea(pts) {
  let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}

// ---- the whole pipeline: RGBA image -> contours in inches ----
function traceImage(img, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const th = thresholdBitmap(img, o);
  const w = th.width, h = th.height;
  const ds = despeckle(th.bits, w, h, o.despeckle);
  const raw = traceBitmap(ds.bits, w, h);
  let ptsBefore = 0, ptsAfter = 0, outer = 0, holes = 0;
  const scale = o.widthInches > 0 ? (o.widthInches / w) : (1 / (o.dpi > 0 ? o.dpi : 96));
  const loops = [];
  for (const lp of raw) {
    ptsBefore += lp.pts.length;
    let p = simplifyPath(lp.pts, o.tol, true);
    p = smoothPath(p, true, o.smooth, o.cornerAngle);
    if (p.length < o.minLoopPts) continue;
    ptsAfter += p.length;
    if (signedArea(p) >= 0) outer++; else holes++;
    loops.push({ pts: p.map(q => ({ x: o.originX + q.x * scale, y: o.originY + q.y * scale })), closed: true });
  }
  return { loops: loops, stats: {
    width: w, height: h, inkPixels: th.ink, specksRemoved: ds.removed, holesFilled: ds.filled,
    loops: loops.length, outer: outer, holes: holes,
    pointsBefore: ptsBefore, pointsAfter: ptsAfter,
    scale: scale, widthInches: w * scale, heightInches: h * scale } };
}

return { DEFAULTS, thresholdBitmap, despeckle, traceBitmap, simplifyPath, smoothPath, traceImage, signedArea };
});
