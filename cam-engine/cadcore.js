/* cadcore.js - Aquamentor 2D CAD engine (pure, no DOM). Node + browser.
 * Polyline-centric document model. Curves are tessellated; CAM re-fits arcs.
 * Depends on Clipper (window.ClipperLib in browser, require in Node).        */
(function (root, factory) {
  const Clip = (typeof require === 'function') ? require('./package/clipper.js') : root.ClipperLib;
  const mod = factory(Clip);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.CADCORE = mod;
})(typeof self !== 'undefined' ? self : this, function (ClipperLib) {
'use strict';
const S = 100000;
let _id = 1;
const uid = () => 'g' + (_id++);
const TAU = Math.PI * 2;

// ---------- helpers ----------
// Chord height (sagitta) a tessellated arc is allowed to depart from the true curve, in inches.
// A FIXED angular step made big arcs coarse — a 12" radius circle carried 0.06" of faceting, which
// is both a cutting-accuracy problem and enough to stop the CAM arc-fitter recognising it as a
// circle. Deriving the step from the radius keeps that error constant at any size.
const ARC_CHORD_H = 0.004;
function arcStepFor(r) {
  if (!(r > 0)) return 0.20;
  const c = 1 - ARC_CHORD_H / r;
  if (c <= -1 || c >= 1) return 0.20;
  return Math.max(0.015, Math.min(0.20, 2 * Math.acos(c)));
}
function arcPolyline(cx, cy, r, a0, a1, ccw, maxSeg) {
  // a0,a1 radians. ccw true -> increasing angle.
  let span = a1 - a0;
  if (ccw && span < 0) span += TAU;
  if (!ccw && span > 0) span -= TAU;
  const n = Math.max(2, Math.ceil(Math.abs(span) / (maxSeg || arcStepFor(r))));
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: cx + r * Math.cos(a0 + span * i / n), y: cy + r * Math.sin(a0 + span * i / n) });
  return out;
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

// ---------- shape constructors (all produce {type:'path', pts, closed, prim}) ----------
function mkLine(a, b, layer) { return { id: uid(), type: 'path', layer: layer || '0', closed: false, pts: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], prim: { kind: 'line' } }; }
function mkPoly(pts, closed, layer) { return { id: uid(), type: 'path', layer: layer || '0', closed: !!closed, pts: pts.map(p => ({ x: p.x, y: p.y })), prim: { kind: 'poly' } }; }
function mkRect(x, y, w, h, layer) {
  return { id: uid(), type: 'path', layer: layer || '0', closed: true,
    pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], prim: { kind: 'rect', x, y, w, h } };
}
function mkCircle(c, r, layer) {
  return { id: uid(), type: 'path', layer: layer || '0', closed: true,
    pts: arcPolyline(c.x, c.y, r, 0, TAU, true).slice(0, -1), prim: { kind: 'circle', cx: c.x, cy: c.y, r } };
}
function mkEllipse(c, rx, ry, rot, layer) {
  rot = rot || 0; const pts = [];
  const n = Math.max(48, Math.ceil(TAU / arcStepFor(Math.max(rx, ry))));   // constant chord height, like arcPolyline
  for (let i = 0; i < n; i++) { const a = i / n * TAU; const lx = rx * Math.cos(a), ly = ry * Math.sin(a);
    pts.push({ x: c.x + lx * Math.cos(rot) - ly * Math.sin(rot), y: c.y + lx * Math.sin(rot) + ly * Math.cos(rot) }); }
  return { id: uid(), type: 'path', layer: layer || '0', closed: true, pts, prim: { kind: 'ellipse', cx: c.x, cy: c.y, rx, ry, rot } };
}
function mkArc(c, r, a0, a1, ccw, layer) {
  return { id: uid(), type: 'path', layer: layer || '0', closed: false,
    pts: arcPolyline(c.x, c.y, r, a0, a1, ccw), prim: { kind: 'arc', cx: c.x, cy: c.y, r, a0, a1, ccw } };
}
function mkRoundRect(x,y,w,h,r,layer){
  r=Math.max(0,Math.min(r, Math.min(w,h)/2)); const pts=[]; const seg=10;
  const corner=(cx,cy,a0)=>{ for(let i=0;i<=seg;i++){const a=a0+i/seg*(Math.PI/2); pts.push({x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)});} };
  if(r<1e-6){ return mkRect(x,y,w,h,layer); }
  corner(x+w-r, y+r, -Math.PI/2);
  corner(x+w-r, y+h-r, 0);
  corner(x+r, y+h-r, Math.PI/2);
  corner(x+r, y+r, Math.PI);
  return { id: uid(), type:'path', layer: layer||'0', closed:true, pts, prim:{ kind:'roundrect', x,y,w,h,r } };
}
function mkPolygon(c, r, n, rot, layer) {
  rot = rot || -Math.PI / 2; const pts = [];
  for (let i = 0; i < n; i++) { const a = rot + i / n * TAU; pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
  return { id: uid(), type: 'path', layer: layer || '0', closed: true, pts, prim: { kind: 'polygon', cx: c.x, cy: c.y, r, n, rot } };
}
function mkStar(c, rO, rI, n, rot, layer) {
  rot = rot || -Math.PI / 2; const pts = [];
  for (let i = 0; i < n * 2; i++) { const a = rot + i / (n * 2) * TAU; const r = i % 2 ? rI : rO; pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
  return { id: uid(), type: 'path', layer: layer || '0', closed: true, pts, prim: { kind: 'star', cx: c.x, cy: c.y, rO, rI, n, rot } };
}
// ---------- bezier curves ----------
// A bezier node: { x, y, hx0,hy0 (incoming handle), hx1,hy1 (outgoing handle), type:'smooth'|'corner' }.
// The cubic between node i and i+1 uses anchor_i, out-handle_i, in-handle_{i+1}, anchor_{i+1}.
function _cubicSample(p0, c1, c2, p3, segs, out) {
  for (let k = 1; k <= segs; k++) {
    const t = k / segs, mt = 1 - t;
    out.push({
      x: mt*mt*mt*p0.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*p3.x,
      y: mt*mt*mt*p0.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*p3.y
    });
  }
}
function flattenBezier(nodes, closed, tol) {
  tol = tol || 0.01; const out = [];
  if (!nodes || !nodes.length) return out;
  out.push({ x: nodes[0].x, y: nodes[0].y });
  const seg = (a, b) => {
    const p0 = { x: a.x, y: a.y }, c1 = { x: a.hx1, y: a.hy1 }, c2 = { x: b.hx0, y: b.hy0 }, p3 = { x: b.x, y: b.y };
    const est = Math.hypot(c1.x-p0.x, c1.y-p0.y) + Math.hypot(c2.x-c1.x, c2.y-c1.y) + Math.hypot(p3.x-c2.x, p3.y-c2.y);
    const segs = Math.max(2, Math.min(64, Math.round(est / tol) || 2));
    _cubicSample(p0, c1, c2, p3, segs, out);
  };
  for (let i = 0; i < nodes.length - 1; i++) seg(nodes[i], nodes[i + 1]);
  if (closed && nodes.length >= 2) seg(nodes[nodes.length - 1], nodes[0]);
  return out;
}
function mkBezier(nodes, closed, layer) {
  const nd = nodes.map(n => ({ x: n.x, y: n.y, hx0: n.hx0 == null ? n.x : n.hx0, hy0: n.hy0 == null ? n.y : n.hy0,
    hx1: n.hx1 == null ? n.x : n.hx1, hy1: n.hy1 == null ? n.y : n.hy1, type: n.type || 'corner' }));
  return { id: uid(), type: 'path', layer: layer || '0', closed: !!closed, pts: flattenBezier(nd, closed), prim: { kind: 'bezier', nodes: nd } };
}
function reflowBezier(shape) { if (shape.prim && shape.prim.kind === 'bezier') shape.pts = flattenBezier(shape.prim.nodes, shape.closed); return shape; }
// Keep a 'smooth' node's handles collinear+symmetric when one side is dragged ('out' moved hx1 -> mirror hx0, or 'in').
function mirrorSmoothHandle(node, movedSide) {
  if (movedSide === 'out') { node.hx0 = 2*node.x - node.hx1; node.hy0 = 2*node.y - node.hy1; }
  else { node.hx1 = 2*node.x - node.hx0; node.hy1 = 2*node.y - node.hy0; }
  return node;
}

// ---------- bbox / flatten ----------
function flatten(shape) {
  if (shape.type === 'text') return textShapes(shape).flatMap(flatten);
  if (shape.type === 'dim') return dimensionGeometry(shape.prim).loops;
  const pts = shape.pts.slice();
  if (shape.closed && pts.length && dist(pts[0], pts[pts.length - 1]) > 1e-9) pts.push({ x: pts[0].x, y: pts[0].y });
  return [{ pts, closed: shape.closed }];
}
function bbox(shape) {
  if (shape.type === 'dim') return bboxPts(flatten(shape).flatMap(l => l.pts));
  return bboxPts(shape.type === 'text' ? textShapes(shape).flatMap(s => s.pts) : shape.pts);
}
function bboxPts(pts) {
  let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) { if (p.x < b.minX) b.minX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.x > b.maxX) b.maxX = p.x; if (p.y > b.maxY) b.maxY = p.y; }
  return b;
}
function bboxAll(shapes) {
  let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of shapes) { const sb = bbox(s); b.minX = Math.min(b.minX, sb.minX); b.minY = Math.min(b.minY, sb.minY); b.maxX = Math.max(b.maxX, sb.maxX); b.maxY = Math.max(b.maxY, sb.maxY); }
  return b;
}

// ---------- hit testing ----------
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function hitTest(shape, p, tol) {
  const f = flatten(shape);
  for (const loop of f) {
    const pts = loop.pts;
    for (let i = 0; i + 1 < pts.length; i++) if (distToSeg(p, pts[i], pts[i + 1]) <= tol) return true;
    if (loop.closed && shape.fill && pointInPoly(p, pts)) return true;
  }
  return false;
}

// ---------- snapping ----------
function snapPoints(shape) {
  const out = [];
  if (shape.type === 'text') { const b = bbox(shape); out.push({ x: b.minX, y: b.minY, kind: 'corner' }); return out; }
  if (shape.type === 'dim') return shape.pts.map(p => ({ x: p.x, y: p.y, kind: 'node' }));
  const pts = shape.pts;
  for (const p of pts) out.push({ x: p.x, y: p.y, kind: 'node' });
  for (let i = 0; i + 1 < pts.length; i++) out.push({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2, kind: 'mid' });
  if (shape.closed && pts.length) out.push({ x: (pts[pts.length - 1].x + pts[0].x) / 2, y: (pts[pts.length - 1].y + pts[0].y) / 2, kind: 'mid' });
  const pr = shape.prim;
  if (pr && (pr.kind === 'circle' || pr.kind === 'polygon' || pr.kind === 'star' || pr.kind === 'ellipse' || pr.kind === 'arc')) out.push({ x: pr.cx, y: pr.cy, kind: 'center' });
  return out;
}
// snap targets for an axis-aligned rectangle (job/material): 4 corners, 4 edge midpoints, center.
function rectSnapPoints(x0, y0, x1, y1) {
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
  return [
    { x: x0, y: y0, kind: 'corner' }, { x: x1, y: y0, kind: 'corner' },
    { x: x1, y: y1, kind: 'corner' }, { x: x0, y: y1, kind: 'corner' },
    { x: xm, y: y0, kind: 'mid' }, { x: xm, y: y1, kind: 'mid' },
    { x: x0, y: ym, kind: 'mid' }, { x: x1, y: ym, kind: 'mid' },
    { x: xm, y: ym, kind: 'center' }
  ];
}

// ---------- transforms (mutate a cloned shape, drop prim if distorted) ----------
function applyToShape(shape, fn, keepPrim) {
  const s = clone(shape);
  if (s.type === 'text') { const a = fn({ x: s.x, y: s.y }); s.x = a.x; s.y = a.y; return s; }
  if (s.type === 'dim') {   // move the defining points; the annotation redraws from them
    const pr = s.prim; pr.a = fn(pr.a); pr.b = fn(pr.b); if (pr.c) pr.c = fn(pr.c);
    return syncDimension(s);
  }
  s.pts = s.pts.map(fn);
  if (!keepPrim) s.prim = { kind: 'poly' };
  else if (s.prim && s.prim.kind === 'bezier' && Array.isArray(s.prim.nodes)) {   // keep curve editable: move handles too
    s.prim.nodes = s.prim.nodes.map(nd => {
      const a = fn({ x: nd.x, y: nd.y }), i0 = fn({ x: nd.hx0, y: nd.hy0 }), i1 = fn({ x: nd.hx1, y: nd.hy1 });
      return { x: a.x, y: a.y, hx0: i0.x, hy0: i0.y, hx1: i1.x, hy1: i1.y, type: nd.type };
    });
  }
  return s;
}
function translate(shape, dx, dy) {
  const s = applyToShape(shape, p => ({ x: p.x + dx, y: p.y + dy }), true);
  if (s.prim) { const pr = s.prim; if ('cx' in pr) { pr.cx += dx; pr.cy += dy; } if ('x' in pr) { pr.x += dx; pr.y += dy; } if (s.type==='text'){} }
  return s;
}
function rotate(shape, cx, cy, ang) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return applyToShape(shape, p => { const dx = p.x - cx, dy = p.y - cy; return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca }; });
}
function scale(shape, cx, cy, sx, sy) {
  sy = (sy == null ? sx : sy);
  const s = applyToShape(shape, p => ({ x: cx + (p.x - cx) * sx, y: cy + (p.y - cy) * sy }), shape.prim && shape.prim.kind === 'circle' && Math.abs(sx - sy) < 1e-9);
  if (s.prim && s.prim.kind === 'circle') { s.prim.cx = cx + (s.prim.cx - cx) * sx; s.prim.cy = cy + (s.prim.cy - cy) * sy; s.prim.r *= Math.abs(sx); }
  return s;
}
function mirror(shape, axis, at) {
  // axis 'x' = flip horizontally about vertical line x=at; 'y' = flip vertically about y=at
  const s = applyToShape(shape, p => axis === 'x' ? { x: 2 * at - p.x, y: p.y } : { x: p.x, y: 2 * at - p.y });
  if (s.type === 'dim') return s;
  s.pts.reverse(); // keep winding sane
  return s;
}

// ---------- offset & boolean via Clipper ----------
function toClip(pts) { return pts.map(p => new ClipperLib.IntPoint(Math.round(p.x * S), Math.round(p.y * S))); }
function fromClip(path) { return path.map(p => ({ x: p.X / S, y: p.Y / S })); }
function offsetShapes(shapes, delta, join) {
  const co = new ClipperLib.ClipperOffset(2, 0.003 * S);
  const jt = join === 'miter' ? ClipperLib.JoinType.jtMiter : join === 'square' ? ClipperLib.JoinType.jtSquare : ClipperLib.JoinType.jtRound;
  for (const s of shapes) for (const loop of flatten(s)) {
    if (loop.closed) co.AddPath(toClip(loop.pts), jt, ClipperLib.EndType.etClosedPolygon);
    else co.AddPath(toClip(loop.pts), jt, ClipperLib.EndType.etOpenRound);
  }
  const sol = new ClipperLib.Paths(); co.Execute(sol, delta * S);
  return sol.map(p => mkPoly(fromClip(p), true));
}
function booleanOp(shapesA, shapesB, op) {
  const c = new ClipperLib.Clipper();
  const add = (shapes, pt) => { for (const s of shapes) for (const loop of flatten(s)) if (loop.closed) c.AddPath(toClip(loop.pts), pt, true); };
  add(shapesA, ClipperLib.PolyType.ptSubject);
  add(shapesB || [], ClipperLib.PolyType.ptClip);
  const ct = op === 'union' ? ClipperLib.ClipType.ctUnion : op === 'diff' ? ClipperLib.ClipType.ctDifference : op === 'intersect' ? ClipperLib.ClipType.ctIntersection : ClipperLib.ClipType.ctXor;
  const sol = new ClipperLib.Paths();
  c.Execute(ct, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map(p => mkPoly(fromClip(p), true));
}

// ---------- SVG path import ----------
function svgPathToShapes(d, layer) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0; const num = () => parseFloat(toks[i++]);
  let cx = 0, cy = 0, sx = 0, sy = 0, cmd = '', pcx = 0, pcy = 0;
  const shapes = []; let cur = [];
  const flush = (closed) => { if (cur.length >= 2) shapes.push(mkPoly(cur, closed)); cur = []; };
  function cubic(x1, y1, x2, y2, x, y) { const n = 24; for (let k = 1; k <= n; k++) { const t = k / n, mt = 1 - t;
    cur.push({ x: mt*mt*mt*cx + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x, y: mt*mt*mt*cy + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y }); } cx = x; cy = y; }
  function quad(x1, y1, x, y) { const n = 20; for (let k = 1; k <= n; k++) { const t = k / n, mt = 1 - t;
    cur.push({ x: mt*mt*cx + 2*mt*t*x1 + t*t*x, y: mt*mt*cy + 2*mt*t*y1 + t*t*y }); } cx = x; cy = y; }
  while (i < toks.length) {
    let t = toks[i];
    if (/[a-zA-Z]/.test(t)) { cmd = t; i++; } 
    const rel = cmd === cmd.toLowerCase(); const C = cmd.toUpperCase();
    if (C === 'M') { if (cur.length) flush(false); let x = num(), y = num(); if (rel) { x += cx; y += cy; } cx = x; cy = y; sx = x; sy = y; cur = [{ x, y }]; cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { let x = num(), y = num(); if (rel) { x += cx; y += cy; } cx = x; cy = y; cur.push({ x, y }); }
    else if (C === 'H') { let x = num(); if (rel) x += cx; cx = x; cur.push({ x, y: cy }); }
    else if (C === 'V') { let y = num(); if (rel) y += cy; cy = y; cur.push({ x: cx, y }); }
    else if (C === 'C') { let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num(); if (rel) { x1+=cx;y1+=cy;x2+=cx;y2+=cy;x+=cx;y+=cy; } pcx = x2; pcy = y2; cubic(x1, y1, x2, y2, x, y); }
    else if (C === 'S') { let x2 = num(), y2 = num(), x = num(), y = num(); if (rel) { x2+=cx;y2+=cy;x+=cx;y+=cy; } const x1 = 2*cx - pcx, y1 = 2*cy - pcy; pcx = x2; pcy = y2; cubic(x1, y1, x2, y2, x, y); }
    else if (C === 'Q') { let x1 = num(), y1 = num(), x = num(), y = num(); if (rel) { x1+=cx;y1+=cy;x+=cx;y+=cy; } pcx = x1; pcy = y1; quad(x1, y1, x, y); }
    else if (C === 'T') { let x = num(), y = num(); if (rel) { x+=cx;y+=cy; } const x1 = 2*cx - pcx, y1 = 2*cy - pcy; pcx = x1; pcy = y1; quad(x1, y1, x, y); }
    else if (C === 'A') { let rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), x = num(), y = num(); if (rel) { x+=cx;y+=cy; } arcTo(cur, cx, cy, rx, ry, rot * Math.PI / 180, laf, sf, x, y); cx = x; cy = y; }
    else if (C === 'Z') { cur.push({ x: sx, y: sy }); flush(true); cx = sx; cy = sy; }
    else { i++; }
  }
  if (cur.length) flush(false);
  return shapes;
}
function arcTo(cur, x0, y0, rx, ry, phi, laf, sf, x, y) {
  if (rx === 0 || ry === 0) { cur.push({ x, y }); return; }
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  let L = x1p*x1p/(rx*rx) + y1p*y1p/(ry*ry); if (L > 1) { rx *= Math.sqrt(L); ry *= Math.sqrt(L); }
  let sign = (laf !== sf) ? 1 : -1;
  let num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p; num = Math.max(0, num);
  let co = sign * Math.sqrt(num / (rx*rx*y1p*y1p + ry*ry*x1p*x1p) || 0);
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x) / 2, cy = sp * cxp + cp * cyp + (y0 + y) / 2;
  const ang = (ux, uy, vx, vy) => { const d = Math.sqrt((ux*ux+uy*uy)*(vx*vx+vy*vy)); let c = (ux*vx+uy*vy)/d; c=Math.max(-1,Math.min(1,c)); let a = Math.acos(c); if (ux*vy-uy*vx < 0) a = -a; return a; };
  let th0 = ang(1, 0, (x1p - cxp)/rx, (y1p - cyp)/ry);
  let dth = ang((x1p - cxp)/rx, (y1p - cyp)/ry, (-x1p - cxp)/rx, (-y1p - cyp)/ry);
  if (!sf && dth > 0) dth -= TAU; if (sf && dth < 0) dth += TAU;
  const n = Math.max(2, Math.ceil(Math.abs(dth) / 0.2));
  for (let k = 1; k <= n; k++) { const th = th0 + dth * k / n; const ex = Math.cos(th) * rx, ey = Math.sin(th) * ry;
    cur.push({ x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy }); }
}
function svgToShapes(svgText) {
  const shapes = [];
  const reP = /<path[^>]*\sd="([^"]+)"/gi; let m;
  while ((m = reP.exec(svgText))) shapes.push(...svgPathToShapes(m[1]));
  const reR = /<rect[^>]*>/gi; while ((m = reR.exec(svgText))) { const a = attrs(m[0]); if (a.width && a.height) shapes.push(mkRect(+a.x||0, +a.y||0, +a.width, +a.height)); }
  const reC = /<circle[^>]*>/gi; while ((m = reC.exec(svgText))) { const a = attrs(m[0]); if (a.r) shapes.push(mkCircle({ x:+a.cx||0, y:+a.cy||0 }, +a.r)); }
  const reE = /<ellipse[^>]*>/gi; while ((m = reE.exec(svgText))) { const a = attrs(m[0]); if (a.rx) shapes.push(mkEllipse({ x:+a.cx||0, y:+a.cy||0 }, +a.rx, +a.ry)); }
  const reL = /<line[^>]*>/gi; while ((m = reL.exec(svgText))) { const a = attrs(m[0]); shapes.push(mkLine({ x:+a.x1||0, y:+a.y1||0 }, { x:+a.x2||0, y:+a.y2||0 })); }
  const rePl = /<(polyline|polygon)[^>]*>/gi; while ((m = rePl.exec(svgText))) { const a = attrs(m[0]); if (a.points) { const ps = (a.points.match(/-?\d*\.?\d+/g)||[]).map(Number); const pts=[]; for (let k=0;k+1<ps.length;k+=2) pts.push({x:ps[k],y:ps[k+1]}); if (pts.length>=2) shapes.push(mkPoly(pts, /polygon/i.test(m[0]))); } }
  // SVG y is down; flip to CAD y-up using overall height if viewBox present
  const vb = svgText.match(/viewBox="[\d.\- ]*?\s([\d.]+)"/);
  const hM = svgText.match(/height="([\d.]+)/);
  const H = vb ? parseFloat(vb[1]) : (hM ? parseFloat(hM[1]) : null);
  if (H) return shapes.map(s => mirror(s, 'y', H / 2));
  return shapes;
}
function attrs(tag) { const o = {}; const re = /(\w+)="([^"]*)"/g; let m; while ((m = re.exec(tag))) o[m[1]] = m[2]; return o; }

// ---------- DXF entities -> editable shapes (reuses host parseDxf output shape) ----------
function dxfPolysToShapes(dxfPolys) {
  // dxfPolys: [{layer,type,pts,ent}] as produced by the viewer's buildDxfPolysAndLayers
  const out = [];
  for (const p of dxfPolys) {
    if (p.type === 'TEXT' || p.type === 'DIMENSION') continue;
    if (!p.pts || p.pts.length < 2) continue;
    const closed = p.type === 'CIRCLE' || p.type === 'ELLIPSE' || (p.ent && p.ent.closed);
    out.push(mkPoly(p.pts, !!closed, p.layer || '0'));
  }
  return out;
}

// ---------- export ----------
function toDXF(shapes) {
  const L = ['0','SECTION','2','ENTITIES'];
  for (const s of shapes) for (const loop of flatten(s)) {
    L.push('0','LWPOLYLINE','8', s.layer||'0','90', String(loop.pts.length),'70', loop.closed?'1':'0');
    for (const p of loop.pts) { L.push('10', p.x.toFixed(5),'20', p.y.toFixed(5)); }
  }
  L.push('0','ENDSEC','0','EOF');
  return L.join('\r\n');
}
function toSVG(shapes) {
  const b = bboxAll(shapes); const W = (b.maxX-b.minX)||1, H = (b.maxY-b.minY)||1;
  const body = shapes.map(s => flatten(s).map(loop => {
    const d = loop.pts.map((p,i)=>`${i?'L':'M'}${(p.x-b.minX).toFixed(3)},${(H-(p.y-b.minY)).toFixed(3)}`).join(' ') + (loop.closed?' Z':'');
    return `<path d="${d}" fill="none" stroke="black" stroke-width="0.01"/>`;
  }).join('')).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}in" height="${H}in" viewBox="0 0 ${W} ${H}">\n${body}\n</svg>`;
}

// ---------- single-stroke text ----------
function textShapes(t) {
  const font = FONT; const scale = t.h / 14; let pen = t.x; const shapes = [];
  for (const ch of (t.text || '').toUpperCase()) {
    const g = font[ch] || (ch === ' ' ? { w: 8, s: [] } : font['?']);
    for (const stroke of g.s) {
      const pts = stroke.map(([gx, gy]) => ({ x: t.x + (pen - t.x) + gx * scale, y: t.y + gy * scale }));
      const sh = mkPoly(pts.map(p => ({ x: pen + (p.x - t.x - (pen - t.x)), y: p.y })), false, t.layer || '0');
      // simpler: rebuild with pen offset
      sh.pts = stroke.map(([gx, gy]) => ({ x: pen + gx * scale, y: t.y + gy * scale }));
      shapes.push(sh);
    }
    pen += (g.w + 2) * scale;
  }
  return shapes;
}

// compact single-stroke uppercase font on a 0..10 wide, 0..14 tall grid (baseline y=0)
const FONT = (function () {
  const A = (cx, cy, r, d0, d1, ccw) => arcPolyline(cx, cy, r, d0 * Math.PI / 180, d1 * Math.PI / 180, ccw).map(p => [p.x, p.y]);
  const F = {};
  F['A'] = { w: 10, s: [[[0,0],[5,14],[10,0]], [[2,5.6],[8,5.6]]] };
  F['B'] = { w: 9, s: [[[0,0],[0,14],[6,14]], A(6,11,3,90,-90,false).concat([[0,8]]), [[0,8],[6,8]], A(6.5,4,4,90,-90,false), [[6.5,0],[0,0]]] };
  F['C'] = { w: 9, s: [A(5,7,5.2,40,320,true)] };
  F['D'] = { w: 9, s: [[[0,0],[0,14],[4,14]], A(4,7,7,90,-90,false), [[4,0],[0,0]]] };
  F['E'] = { w: 8, s: [[[8,14],[0,14],[0,0],[8,0]], [[0,7],[6,7]]] };
  F['F'] = { w: 8, s: [[[8,14],[0,14],[0,0]], [[0,7],[6,7]]] };
  F['G'] = { w: 9, s: [A(5,7,5.2,40,320,true).concat([[5,7],[9,7]]) , [[9,7],[9,3]]] };
  F['H'] = { w: 9, s: [[[0,14],[0,0]], [[9,14],[9,0]], [[0,7],[9,7]]] };
  F['I'] = { w: 4, s: [[[2,14],[2,0]]] };
  F['J'] = { w: 8, s: [[[7,14],[7,4]], A(3.5,4,3.5,0,200,false)] };
  F['K'] = { w: 9, s: [[[0,14],[0,0]], [[9,14],[0,6]], [[3.5,8.5],[9,0]]] };
  F['L'] = { w: 8, s: [[[0,14],[0,0],[8,0]]] };
  F['M'] = { w: 11, s: [[[0,0],[0,14],[5.5,6],[11,14],[11,0]]] };
  F['N'] = { w: 10, s: [[[0,0],[0,14],[10,0],[10,14]]] };
  F['O'] = { w: 10, s: [A(5,7,5.2,0,360,true)] };
  F['P'] = { w: 9, s: [[[0,0],[0,14],[6,14]], A(6,11,3,90,-90,false), [[6,8],[0,8]]] };
  F['Q'] = { w: 10, s: [A(5,7,5.2,0,360,true), [[6,4],[10,-1]]] };
  F['R'] = { w: 9, s: [[[0,0],[0,14],[6,14]], A(6,11,3,90,-90,false), [[6,8],[0,8]], [[3,8],[9,0]]] };
  F['S'] = { w: 9, s: [A(4.5,10.5,4.2,300,150,true).concat(A(4.5,3.7,4.3,90,-110,true))] };
  F['T'] = { w: 9, s: [[[0,14],[9,14]], [[4.5,14],[4.5,0]]] };
  F['U'] = { w: 9, s: [[[0,14],[0,4]], A(4.5,4,4.5,180,360,true), [[9,4],[9,14]]] };
  F['V'] = { w: 10, s: [[[0,14],[5,0],[10,14]]] };
  F['W'] = { w: 13, s: [[[0,14],[3,0],[6.5,10],[10,0],[13,14]]] };
  F['X'] = { w: 9, s: [[[0,14],[9,0]], [[0,0],[9,14]]] };
  F['Y'] = { w: 9, s: [[[0,14],[4.5,7],[9,14]], [[4.5,7],[4.5,0]]] };
  F['Z'] = { w: 9, s: [[[0,14],[9,14],[0,0],[9,0]]] };
  F['0'] = { w: 9, s: [A(4.5,7,4.6,0,360,true), [[1.5,2],[7.5,12]]] };
  F['1'] = { w: 6, s: [[[1,11],[3,14],[3,0]], [[0,0],[6,0]]] };
  F['2'] = { w: 9, s: [A(4.5,10,4,200,-20,false), [[8.5,8],[0,0],[9,0]]] };
  F['3'] = { w: 9, s: [A(4.5,10.5,3.6,200,-90,false), A(4.5,3.7,4,110,-160,false)] };
  F['4'] = { w: 9, s: [[[6.5,0],[6.5,14],[0,4],[9,4]]] };
  F['5'] = { w: 9, s: [[[8,14],[1,14],[0.5,7.5]], A(4,4,4.2,95,-150,false), [[1,1.2],[1,1.2]]] };
  F['6'] = { w: 9, s: [A(4.5,4,4.5,0,360,true), [[1,5],[7,13]]] };
  F['7'] = { w: 9, s: [[[0,14],[9,14],[3,0]]] };
  F['8'] = { w: 9, s: [A(4.5,10.3,3.7,0,360,true), A(4.5,3.7,4.3,0,360,true)] };
  F['9'] = { w: 9, s: [A(4.5,10,4.5,0,360,true), [[8,9],[2,1]]] };
  F['.'] = { w: 3, s: [[[1,0],[1.6,0],[1.6,0.6],[1,0.6],[1,0]]] };
  F[','] = { w: 3, s: [[[1.6,0.6],[1,-1.5]]] };
  F['-'] = { w: 8, s: [[[1,7],[7,7]]] };
  F['_'] = { w: 9, s: [[[0,-1],[9,-1]]] };
  F['/'] = { w: 7, s: [[[0,0],[7,14]]] };
  F[':'] = { w: 3, s: [[[1,9],[1.6,9]], [[1,4],[1.6,4]]] };
  F["'"] = { w: 3, s: [[[1.3,14],[1.3,11]]] };
  F['!'] = { w: 3, s: [[[1.3,14],[1.3,3]], [[1.3,0.6],[1.3,0]]] };
  F['?'] = { w: 8, s: [A(4,10,3.6,200,-30,false).concat([[4,4],[4,3]]), [[4,0.6],[4,0]]] };
  F['&'] = { w: 11, s: [A(3,11,3,0,360,true), [[6,8],[0,3]], A(3.5,3,3.5,90,300,true), [[5.5,3],[11,0]]] };
  F['('] = { w: 5, s: [A(6,7,7,130,230,true)] };
  F[')'] = { w: 5, s: [A(-1,7,7,-50,50,true)] };
  F['#'] = { w: 10, s: [[[2,0],[3.5,14]], [[6.5,0],[8,14]], [[0,4.5],[10,4.5]], [[0,9.5],[10,9.5]]] };
  F['+'] = { w: 9, s: [[[1,7],[8,7]], [[4.5,10.5],[4.5,3.5]]] };
  F['='] = { w: 9, s: [[[1,9],[8,9]], [[1,5],[8,5]]] };
  F['"'] = { w: 5, s: [[[1.3,14],[1.3,10.5]], [[3.5,14],[3.5,10.5]]] };
  F['°'] = { w: 6, s: [A(2.4,11.6,2.4,0,360,true)] };          // degree sign
  F['Ø'] = { w: 10, s: [A(5,7,5.2,0,360,true), [[1,1.4],[9,12.6]]] };  // diameter sign
  F['±'] = { w: 9, s: [[[1,8],[8,8]], [[4.5,11.5],[4.5,4.5]], [[1,2],[8,2]]] };
  F['×'] = { w: 9, s: [[[1.5,10.5],[7.5,3.5]], [[1.5,3.5],[7.5,10.5]]] };
  return F;
})();

function mkText(x, y, h, text, layer) { return { id: uid(), type: 'text', layer: layer || '0', x, y, h, text }; }

// Advance width of a single-stroke string at cap-height h (same metrics textShapes lays out with).
function measureText(text, h) {
  const scale = h / 14; let w = 0;
  for (const ch of (text || '').toUpperCase()) { const g = FONT[ch] || (ch === ' ' ? { w: 8 } : FONT['?']); w += (g.w + 2) * scale; }
  return Math.max(0, w - 2 * scale);
}

// ---------- dimension annotations (B3) ----------
// A dimension is a non-machinable annotation shape: {type:'dim', annotation:true, prim:{kind:'dim',...}}.
// prim.a/b (and .c for angle) are the *defining* points; every line, arrowhead and text stroke is
// derived on demand by dimensionGeometry() so editing a point or a style re-draws the whole thing.
const DIM_STYLES = ['aligned', 'horizontal', 'vertical', 'radius', 'diameter', 'angle'];
const DIM_DEFAULTS = { style: 'aligned', off: 0.5, textH: 0.18, prec: 3, unit: 'in', arrow: 0.12, ext: 0.09, gap: 0.05, label: '' };

// Format a measurement (stored in inches; degrees for angles) for the dimension label.
function fmtDimValue(v, prec, unit) {
  if (unit === 'deg') return v.toFixed(prec == null ? 1 : prec) + '°';
  if (unit === 'mm') return (v * 25.4).toFixed(prec == null ? 2 : prec) + ' MM';
  if (unit === 'none') return v.toFixed(prec == null ? 3 : prec);
  return v.toFixed(prec == null ? 3 : prec) + '"';
}
// The number a dimension measures: inches for linear/radius/diameter, degrees for angle.
function dimValue(prim) {
  const a = prim.a, b = prim.b;
  switch (prim.style) {
    case 'horizontal': return Math.abs(b.x - a.x);
    case 'vertical': return Math.abs(b.y - a.y);
    case 'radius': return dist(a, b);
    case 'diameter': return 2 * dist(a, b);
    case 'angle': {
      const c = prim.c || b;
      const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - a.y, c.x - a.x);
      let d = a2 - a1; while (d <= -Math.PI) d += TAU; while (d > Math.PI) d -= TAU;
      return Math.abs(d) * 180 / Math.PI;
    }
    default: return dist(a, b);
  }
}
// Solid arrowhead triangle whose point is at `tip`, pointing along (dx,dy).
function _arrowLoop(tip, dx, dy, len, wid) {
  const bx = tip.x - dx * len, by = tip.y - dy * len, nx = -dy, ny = dx;
  return { pts: [{ x: tip.x, y: tip.y }, { x: bx + nx * wid, y: by + ny * wid }, { x: bx - nx * wid, y: by - ny * wid }, { x: tip.x, y: tip.y }], closed: true };
}
// Single-stroke label centred on (cx,cy), rotated by `rot` radians.
function _dimTextLoops(text, cx, cy, h, rot) {
  const w = measureText(text, h), ca = Math.cos(rot || 0), sa = Math.sin(rot || 0);
  return textShapes({ x: -w / 2, y: -h / 2, h: h, text: text }).map(s => ({
    pts: s.pts.map(p => ({ x: cx + p.x * ca - p.y * sa, y: cy + p.x * sa + p.y * ca })), closed: false
  }));
}
function _readable(rot) { return (rot > Math.PI / 2 + 1e-9 || rot < -Math.PI / 2 - 1e-9) ? rot + Math.PI : rot; }

// Build every polyline of a dimension. Returns {loops,value,text,textPos,textH}.
function dimensionGeometry(prim) {
  const p = Object.assign({}, DIM_DEFAULTS, prim);
  const st = DIM_STYLES.indexOf(p.style) >= 0 ? p.style : 'aligned';
  const a = p.a, b = p.b, textH = p.textH, arrow = p.arrow, aw = arrow * 0.34, ext = p.ext, gap = p.gap, off = p.off;
  const value = dimValue(Object.assign({}, p, { style: st }));
  let text = (p.label != null && p.label !== '') ? String(p.label)
    : fmtDimValue(value, p.prec, st === 'angle' ? 'deg' : p.unit);
  if (!p.label) { if (st === 'radius') text = 'R' + text; else if (st === 'diameter') text = 'Ø' + text; }
  const loops = [];

  if (st === 'radius' || st === 'diameter') {
    const L = dist(a, b) || 1, u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const p0 = st === 'diameter' ? { x: a.x - u.x * L, y: a.y - u.y * L } : { x: a.x, y: a.y };
    loops.push({ pts: [p0, { x: b.x, y: b.y }], closed: false });
    loops.push(_arrowLoop(b, u.x, u.y, arrow, aw));
    if (st === 'diameter') loops.push(_arrowLoop(p0, -u.x, -u.y, arrow, aw));
    const rot = _readable(Math.atan2(u.y, u.x));
    const mid = { x: (p0.x + b.x) / 2, y: (p0.y + b.y) / 2 };
    const tc = { x: mid.x - Math.sin(rot) * textH * 0.8, y: mid.y + Math.cos(rot) * textH * 0.8 };
    for (const l of _dimTextLoops(text, tc.x, tc.y, textH, rot)) loops.push(l);
    return { loops, value, text, textPos: { x: tc.x, y: tc.y, rot }, textH };
  }

  if (st === 'angle') {
    const c = p.c || b;
    const r = off > 0 ? off : Math.min(dist(a, b), dist(a, c)) * 0.6 || 1;
    const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - a.y, c.x - a.x);
    let d = a2 - a1; while (d <= -Math.PI) d += TAU; while (d > Math.PI) d -= TAU;
    const ccw = d >= 0, sgn = ccw ? 1 : -1;
    loops.push({ pts: arcPolyline(a.x, a.y, r, a1, a1 + d, ccw, 0.10), closed: false });
    loops.push({ pts: [{ x: a.x, y: a.y }, { x: a.x + Math.cos(a1) * (r + ext), y: a.y + Math.sin(a1) * (r + ext) }], closed: false });
    loops.push({ pts: [{ x: a.x, y: a.y }, { x: a.x + Math.cos(a2) * (r + ext), y: a.y + Math.sin(a2) * (r + ext) }], closed: false });
    const t1 = { x: a.x + Math.cos(a1) * r, y: a.y + Math.sin(a1) * r };
    const te = a1 + d, t2 = { x: a.x + Math.cos(te) * r, y: a.y + Math.sin(te) * r };
    loops.push(_arrowLoop(t1, Math.sin(a1) * sgn, -Math.cos(a1) * sgn, arrow, aw));
    loops.push(_arrowLoop(t2, -Math.sin(te) * sgn, Math.cos(te) * sgn, arrow, aw));
    const am = a1 + d / 2, tr = r + textH * 1.5;   // clear of the arc's bulge under the rotated label
    const tc = { x: a.x + Math.cos(am) * tr, y: a.y + Math.sin(am) * tr };
    const rot = _readable(am + Math.PI / 2);
    for (const l of _dimTextLoops(text, tc.x, tc.y, textH, rot)) loops.push(l);
    return { loops, value, text, textPos: { x: tc.x, y: tc.y, rot }, textH };
  }

  // linear: aligned / horizontal / vertical — dimension line sits `off` beyond the outermost point.
  let u;
  if (st === 'horizontal') u = { x: 1, y: 0 };
  else if (st === 'vertical') u = { x: 0, y: 1 };
  else { const L = dist(a, b) || 1; u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }; }
  const n = { x: -u.y, y: u.x };
  const ta = a.x * n.x + a.y * n.y, tb = b.x * n.x + b.y * n.y;
  const dv = (off >= 0 ? Math.max(ta, tb) : Math.min(ta, tb)) + off;
  const A1 = { x: a.x + n.x * (dv - ta), y: a.y + n.y * (dv - ta) };
  const B1 = { x: b.x + n.x * (dv - tb), y: b.y + n.y * (dv - tb) };
  const sa1 = Math.sign(dv - ta) || 1, sb1 = Math.sign(dv - tb) || 1;
  if (Math.abs(dv - ta) > gap) loops.push({ pts: [{ x: a.x + n.x * gap * sa1, y: a.y + n.y * gap * sa1 }, { x: A1.x + n.x * ext * sa1, y: A1.y + n.y * ext * sa1 }], closed: false });
  if (Math.abs(dv - tb) > gap) loops.push({ pts: [{ x: b.x + n.x * gap * sb1, y: b.y + n.y * gap * sb1 }, { x: B1.x + n.x * ext * sb1, y: B1.y + n.y * ext * sb1 }], closed: false });
  const span = dist(A1, B1);
  const dir = span > 1e-9 ? { x: (B1.x - A1.x) / span, y: (B1.y - A1.y) / span } : { x: u.x, y: u.y };
  const outside = span < arrow * 2 + measureText(text, textH) * 0.55;   // too tight: flip arrows outward
  if (outside) {
    loops.push({ pts: [{ x: A1.x - dir.x * arrow * 2, y: A1.y - dir.y * arrow * 2 }, { x: B1.x + dir.x * arrow * 2, y: B1.y + dir.y * arrow * 2 }], closed: false });
    loops.push(_arrowLoop(A1, dir.x, dir.y, arrow, aw));
    loops.push(_arrowLoop(B1, -dir.x, -dir.y, arrow, aw));
  } else {
    loops.push({ pts: [{ x: A1.x, y: A1.y }, { x: B1.x, y: B1.y }], closed: false });
    loops.push(_arrowLoop(A1, -dir.x, -dir.y, arrow, aw));
    loops.push(_arrowLoop(B1, dir.x, dir.y, arrow, aw));
  }
  const rot = _readable(Math.atan2(dir.y, dir.x));
  const mid = { x: (A1.x + B1.x) / 2, y: (A1.y + B1.y) / 2 };
  const tc = { x: mid.x - Math.sin(rot) * textH * 0.8, y: mid.y + Math.cos(rot) * textH * 0.8 };
  for (const l of _dimTextLoops(text, tc.x, tc.y, textH, rot)) loops.push(l);
  return { loops, value, text, textPos: { x: tc.x, y: tc.y, rot }, textH };
}
// Keep shape.pts (the defining points, used by snapping/handles) in step with prim.
function syncDimension(shape) {
  const pr = shape.prim;
  shape.pts = [pr.a, pr.b].concat(pr.c ? [pr.c] : []).map(p => ({ x: p.x, y: p.y }));
  return shape;
}
function mkDimension(a, b, opts, layer) {
  opts = opts || {};
  const prim = Object.assign({ kind: 'dim' }, DIM_DEFAULTS, opts, { kind: 'dim', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
  if (opts.c) prim.c = { x: opts.c.x, y: opts.c.y }; else delete prim.c;
  if (DIM_STYLES.indexOf(prim.style) < 0) prim.style = 'aligned';
  return syncDimension({ id: uid(), type: 'dim', layer: layer || '0', annotation: true, closed: false, pts: [], prim: prim });
}

// ---------- parametric editing (numeric properties dialog) ----------
// Return the editable parameters for a shape's primitive, or null if it isn't parametric.
function primParams(shape) {
  if (shape.type === 'text') return { kind: 'text', x: shape.x, y: shape.y, h: shape.h, text: shape.text };
  const pr = shape.prim; if (!pr) return null;
  switch (pr.kind) {
    case 'rect': return { kind: 'rect', x: pr.x, y: pr.y, w: pr.w, h: pr.h, rot: pr.rot || 0 };
    case 'roundrect': return { kind: 'roundrect', x: pr.x, y: pr.y, w: pr.w, h: pr.h, r: pr.r, rot: pr.rot || 0 };
    case 'circle': return { kind: 'circle', cx: pr.cx, cy: pr.cy, r: pr.r, rot: pr.rot || 0 };
    case 'ellipse': return { kind: 'ellipse', cx: pr.cx, cy: pr.cy, rx: pr.rx, ry: pr.ry, rot: pr.rot || 0 };
    case 'polygon': return { kind: 'polygon', cx: pr.cx, cy: pr.cy, r: pr.r, n: pr.n, rot: pr.rot || 0 };
    case 'star': return { kind: 'star', cx: pr.cx, cy: pr.cy, rO: pr.rO, rI: pr.rI, n: pr.n, rot: pr.rot || 0 };
    case 'line': return { kind: 'line', x1: shape.pts[0].x, y1: shape.pts[0].y, x2: shape.pts[1].x, y2: shape.pts[1].y };
    case 'arc': return { kind: 'arc', cx: pr.cx, cy: pr.cy, r: pr.r, a0: pr.a0, a1: pr.a1, ccw: pr.ccw };
    case 'dim': return { kind: 'dim', x1: pr.a.x, y1: pr.a.y, x2: pr.b.x, y2: pr.b.y,
      style: pr.style, off: pr.off, textH: pr.textH, prec: pr.prec, unit: pr.unit, label: pr.label || '',
      cx: pr.c ? pr.c.x : null, cy: pr.c ? pr.c.y : null };
    default: return null;
  }
}
// rotate a shape's points about (cx,cy) in place (keeps prim); used to bake rotation into rect/roundrect/circle
function rotPtsAbout(s, cx, cy, rot) {
  if (rot) { const ca = Math.cos(rot), sa = Math.sin(rot);
    s.pts = s.pts.map(p => { const dx = p.x - cx, dy = p.y - cy; return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca }; }); }
  return s;
}
function rotPrim(s, cx, cy, rot) { rotPtsAbout(s, cx, cy, rot || 0); if (s.prim) s.prim.rot = rot || 0; return s; }
// Rebuild a shape from edited parameters, preserving id + layer.
function applyPrimParams(shape, p) {
  const L = shape.layer; let s;
  switch (p.kind) {
    case 'text': s = mkText(p.x, p.y, p.h, p.text, L); break;
    case 'rect': s = mkRect(p.x, p.y, p.w, p.h, L); rotPrim(s, p.x + p.w / 2, p.y + p.h / 2, p.rot); break;
    case 'roundrect': s = mkRoundRect(p.x, p.y, p.w, p.h, p.r, L); rotPrim(s, p.x + p.w / 2, p.y + p.h / 2, p.rot); break;
    case 'circle': s = mkCircle({ x: p.cx, y: p.cy }, p.r, L); rotPrim(s, p.cx, p.cy, p.rot); break;   // rot stored for round-trip (no visible change)
    case 'ellipse': s = mkEllipse({ x: p.cx, y: p.cy }, p.rx, p.ry, p.rot, L); break;
    case 'polygon': s = mkPolygon({ x: p.cx, y: p.cy }, p.r, Math.max(3, Math.round(p.n)), p.rot, L); break;
    case 'star': s = mkStar({ x: p.cx, y: p.cy }, p.rO, p.rI, Math.max(3, Math.round(p.n)), p.rot, L); break;
    // line rotation is a delta about its midpoint, baked into the endpoints (not stored — reopens at 0)
    case 'line': s = mkLine({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }, L); if (p.rot) rotPtsAbout(s, (p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, p.rot); break;
    case 'arc': s = mkArc({ x: p.cx, y: p.cy }, p.r, p.a0, p.a1, p.ccw, L); break;
    case 'dim': s = mkDimension({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 },
      { style: p.style, off: p.off, textH: p.textH, prec: p.prec, unit: p.unit, label: p.label,
        c: (p.cx != null && p.cy != null) ? { x: p.cx, y: p.cy } : null }, L); break;
    default: return shape;
  }
  s.id = shape.id; return s;
}
// Move + scale any shape so its bounding box becomes (x,y, w×h). For non-parametric vectors.
function fitShapeTo(shape, x, y, w, h) {
  const b = bbox(shape); const bw = (b.maxX - b.minX) || 1, bh = (b.maxY - b.minY) || 1;
  const sx = (w != null && w > 0) ? w / bw : 1, sy = (h != null && h > 0) ? h / bh : 1;
  let s = scale(shape, b.minX, b.minY, sx, sy);
  const nb = bbox(s);
  s = translate(s, (x != null ? x : nb.minX) - nb.minX, (y != null ? y : nb.minY) - nb.minY);
  s.id = shape.id; return s;
}
// Resize an UNROTATED parametric prim to a new bbox (x,y,w,h), updating its prim dimensions so it stays editable.
// rect/roundrect -> x,y,w,h (corner radius preserved, clamped); ellipse -> rx,ry; circle -> stays circle if uniform else ellipse.
// Returns null for rotated, polygon/star, line, text, or non-parametric shapes (caller should fall back to scale()).
function fitPrimTo(shape, x, y, w, h, uniform) {
  const pr = shape.prim; if (!pr || pr.rot) return null;
  const aw = Math.abs(w), ah = Math.abs(h); let p;
  switch (pr.kind) {
    case 'rect': case 'roundrect':
      p = { kind: pr.kind, x, y, w: aw, h: ah, rot: 0 };
      if (pr.kind === 'roundrect') p.r = Math.min(pr.r, Math.min(aw, ah) / 2);
      break;
    case 'ellipse': p = { kind: 'ellipse', cx: x + aw / 2, cy: y + ah / 2, rx: aw / 2, ry: ah / 2, rot: 0 }; break;
    case 'circle':
      p = uniform ? { kind: 'circle', cx: x + aw / 2, cy: y + ah / 2, r: aw / 2, rot: 0 }
                  : { kind: 'ellipse', cx: x + aw / 2, cy: y + ah / 2, rx: aw / 2, ry: ah / 2, rot: 0 };
      break;
    default: return null;
  }
  return applyPrimParams(shape, p);
}

// ---------- anchor points (VCarve-style 9-box position reference) ----------
// An anchor names which point of a shape's bounding box the X/Y coordinate refers to:
//   tl tm tr      (upper left / upper middle / upper right)
//   cl c  cr      (center left / center / center right)
//   bl bm br      (lower left / lower middle / lower right)
const ANCHORS = {
  bl: { fx: 0, fy: 0, label: 'lower left' },   bm: { fx: 0.5, fy: 0, label: 'lower middle' },   br: { fx: 1, fy: 0, label: 'lower right' },
  cl: { fx: 0, fy: 0.5, label: 'center left' }, c:  { fx: 0.5, fy: 0.5, label: 'center' },       cr: { fx: 1, fy: 0.5, label: 'center right' },
  tl: { fx: 0, fy: 1, label: 'upper left' },   tm: { fx: 0.5, fy: 1, label: 'upper middle' },   tr: { fx: 1, fy: 1, label: 'upper right' }
};
function anchorFrac(anchor) { return ANCHORS[anchor] || ANCHORS.bl; }
// The anchor point of a bbox {minX,minY,maxX,maxY}.
function bboxAnchor(b, anchor) { const a = anchorFrac(anchor);
  return { x: b.minX + (b.maxX - b.minX) * a.fx, y: b.minY + (b.maxY - b.minY) * a.fy }; }
// World position of a shape's anchor point (on its axis-aligned bbox, as drawn).
function anchorPoint(shape, anchor) { return bboxAnchor(bbox(shape), anchor); }
// Move a shape (any kind, prims kept parametric) so that its anchor point lands at (x,y). Preserves id.
function moveAnchorTo(shape, anchor, x, y) {
  const a = anchorPoint(shape, anchor); const s = translate(shape, x - a.x, y - a.y); s.id = shape.id; return s;
}
// Same for a group of shapes (e.g. outline-text contours): moved together, group bbox anchor -> (x,y).
function moveGroupAnchorTo(shapes, anchor, x, y) {
  if (!shapes.length) return shapes; const a = bboxAnchor(bboxAll(shapes), anchor);
  return shapes.map(s => { const t = translate(s, x - a.x, y - a.y); t.id = s.id; return t; });
}

// ---------- TTF outline text ----------
// Convert an SVG-path-data string (as produced by opentype.js Path.toPathData) into
// closed CAD contours: flip from font y-down to CAD y-up, scale so the overall height
// equals h inches (baseline stays fixed), then place the left/baseline at (x,y).
function outlineTextShapes(pathData, x, y, h, layer) {
  let shapes = svgPathToShapes(pathData, layer);
  if (!shapes.length) return [];
  shapes = shapes.map(s => mirror(s, 'y', 0));            // font y-down -> CAD y-up, baseline at y=0
  const b = bboxAll(shapes); const hh = (b.maxY - b.minY) || 1;
  const sc = (h || 1) / hh;
  shapes = shapes.map(s => scale(s, 0, 0, sc, sc));        // height -> h, baseline fixed at 0
  const b2 = bboxAll(shapes);                              // left edge after scaling
  shapes = shapes.map(s => { const t = translate(s, x - b2.minX, y); t.layer = layer || '0'; t.closed = true; return t; });
  return shapes;
}

// ---------- nesting (sheet layout) ----------
// First-cut bin-packer: shelf / next-fit-decreasing-height, multi-sheet, optional 90° rotation.
// Packs each shape's bounding box onto sheets of (sheetW x sheetH). Returns placements that the
// caller can apply with placeShape(). Coordinates are sheet-local (origin = sheet bottom-left);
// every placement carries a `sheet` index so multi-sheet layouts can be offset by the caller.
function nestShapes(shapes, opts) {
  opts = opts || {};
  const sheetW = opts.sheetW || 48, sheetH = opts.sheetH || 96;
  const margin = opts.margin || 0;          // keep-out border at the sheet edge
  const spacing = opts.spacing || 0;        // gap between parts (kerf/handling)
  const allowRotate = opts.allowRotate !== false;
  const usableW = sheetW - 2 * margin, usableH = sheetH - 2 * margin;

  // measure each part; orient landscape (w >= h) when rotation is allowed for tighter shelves
  const items = shapes.map((s, i) => {
    const b = bbox(s); let w = b.maxX - b.minX, h = b.maxY - b.minY, rot = false;
    if (allowRotate && h > w) { const t = w; w = h; h = t; rot = true; }
    return { idx: i, w, h, rot };
  });
  items.sort((a, b) => b.h - a.h);          // tallest first

  const placements = [], unplaced = [];
  let sheet = 0, x = margin, y = margin, shelfH = 0, any = false;
  for (const it of items) {
    if (it.w > usableW + 1e-9 || it.h > usableH + 1e-9) { unplaced.push(it.idx); continue; }
    if (x + it.w > margin + usableW + 1e-9) { y += shelfH + spacing; x = margin; shelfH = 0; } // wrap shelf
    if (y + it.h > margin + usableH + 1e-9) { sheet++; x = margin; y = margin; shelfH = 0; }   // wrap sheet
    placements.push({ idx: it.idx, sheet, x, y, w: it.w, h: it.h, rot: it.rot });
    x += it.w + spacing;
    if (it.h > shelfH) shelfH = it.h;
    any = true;
  }
  const sheets = any ? sheet + 1 : 0;
  const partArea = placements.reduce((s, p) => s + p.w * p.h, 0);
  const util = sheets ? partArea / (sheets * sheetW * sheetH) : 0;
  return { placements, unplaced, sheets, sheetW, sheetH, utilization: util };
}

// Transform a shape into its nested position. Pass `spread` ({sheetW, gap}) to lay sheets out
// left-to-right (sheet index * (sheetW + gap)) so a multi-sheet result is viewable in one space.
function placeShape(shape, pl, spread) {
  let s = clone(shape);
  if (pl.rot) s = rotate(s, 0, 0, Math.PI / 2);
  const b = bbox(s);
  const ox = spread ? pl.sheet * ((spread.sheetW || 0) + (spread.gap || 0)) : 0;
  return translate(s, pl.x - b.minX + ox, pl.y - b.minY);
}

// ---------- fillet / trim / extend (interactive vector editing) ----------
// Proper segment intersection: returns {x,y,t,u} (t along a→b, u along c→d) within both, or null.
function segInt(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;                 // parallel / collinear
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * rx, y: a.y + t * ry, t: t, u: u };
}
function pathIntersections(A, closedA, B, closedB) {
  const out = [], na = A.length, nb = B.length, sa = closedA ? na : na - 1, sb = closedB ? nb : nb - 1;
  for (let i = 0; i < sa; i++) { const a = A[i], b = A[(i + 1) % na];
    for (let j = 0; j < sb; j++) { const c = B[j], e = B[(j + 1) % nb]; const p = segInt(a, b, c, e); if (p) out.push({ x: p.x, y: p.y, i: i, t: p.t, j: j, u: p.u }); } }
  return out;
}
// Round the corner at vertex `i` with a tangent arc of `radius` (clamped to the shorter adjacent edge).
// Returns a new pts array (arc replaces the vertex), or null if not fillettable (collinear / too short / open endpoint).
function filletPolyCorner(pts, closed, i, radius, segs) {
  const n = pts.length; if (n < 3 || radius <= 0) return null;
  const pi = closed ? (i - 1 + n) % n : i - 1, ni = closed ? (i + 1) % n : i + 1;
  if (pi < 0 || ni >= n) return null;
  const p = pts[i], a = pts[pi], b = pts[ni];
  let u = { x: a.x - p.x, y: a.y - p.y }, v = { x: b.x - p.x, y: b.y - p.y };
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  if (lu < 1e-9 || lv < 1e-9) return null;
  u = { x: u.x / lu, y: u.y / lu }; v = { x: v.x / lv, y: v.y / lv };
  const theta = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return null;   // collinear
  const half = theta / 2;
  let dd = radius / Math.tan(half), R = radius;
  const maxd = Math.min(lu, lv) * 0.999;
  if (dd > maxd) { dd = maxd; R = dd * Math.tan(half); }      // shrink radius to fit the edge
  const T1 = { x: p.x + u.x * dd, y: p.y + u.y * dd }, T2 = { x: p.x + v.x * dd, y: p.y + v.y * dd };
  let bis = { x: u.x + v.x, y: u.y + v.y }; const lb = Math.hypot(bis.x, bis.y);
  if (lb < 1e-9) return null; bis = { x: bis.x / lb, y: bis.y / lb };
  const C = { x: p.x + bis.x * (R / Math.sin(half)), y: p.y + bis.y * (R / Math.sin(half)) };
  const a0 = Math.atan2(T1.y - C.y, T1.x - C.x), a1 = Math.atan2(T2.y - C.y, T2.x - C.x);
  let da = a1 - a0; while (da > Math.PI) da -= TAU; while (da < -Math.PI) da += TAU;
  const arc = arcPolyline(C.x, C.y, R, a0, a1, da > 0, (Math.abs(da) / (segs || 16)) || 0.2);
  const out = [];
  for (let k = 0; k < n; k++) { if (k === i) { for (const q of arc) out.push({ x: q.x, y: q.y }); } else out.push({ x: pts[k].x, y: pts[k].y }); }
  return out;
}
function _nearestParam(pts, closed, p) {
  const n = pts.length; let best = 0, bd = Infinity, seg = closed ? n : n - 1;
  for (let i = 0; i < seg; i++) { const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const qx = a.x + dx * t, qy = a.y + dy * t, d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bd) { bd = d; best = i + t; } }
  return best;
}
// Trim an OPEN polyline back to the nearest crossing with any cutter, removing the piece the pick is on.
function trimPolyline(pts, closed, cutters, pickPt) {
  const n = pts.length; if (n < 2 || closed) return null;
  const xs = [];
  for (let i = 0; i < n - 1; i++) { const a = pts[i], b = pts[i + 1];
    for (const cut of (cutters || [])) { const cn = cut.pts.length, cs = cut.closed ? cn : cn - 1;
      for (let j = 0; j < cs; j++) { const c = cut.pts[j], d = cut.pts[(j + 1) % cn]; const p = segInt(a, b, c, d); if (p) xs.push({ param: i + p.t, x: p.x, y: p.y }); } } }
  if (!xs.length) return null;
  const pk = _nearestParam(pts, false, pickPt);
  let best = xs[0], bd = Math.abs(xs[0].param - pk);
  for (const x of xs) { const dd = Math.abs(x.param - pk); if (dd < bd) { bd = dd; best = x; } }
  const bi = Math.floor(best.param);
  if (pk > best.param) { const keep = []; for (let k = 0; k <= bi; k++) keep.push({ x: pts[k].x, y: pts[k].y }); keep.push({ x: best.x, y: best.y }); return keep.length >= 2 ? keep : null; }
  const keep = [{ x: best.x, y: best.y }]; for (let k = bi + 1; k < n; k++) keep.push({ x: pts[k].x, y: pts[k].y }); return keep.length >= 2 ? keep : null;
}
// Extend an open polyline's endpoint along its last-segment direction to the first crossing with `target`.
function extendPolyline(pts, whichEnd, target) {
  const n = pts.length; if (n < 2) return null;
  const base = whichEnd === 'start' ? pts[1] : pts[n - 2], tip = whichEnd === 'start' ? pts[0] : pts[n - 1];
  const dx = tip.x - base.x, dy = tip.y - base.y, L = Math.hypot(dx, dy); if (L < 1e-9) return null;
  const far = { x: tip.x + dx / L * 1e6, y: tip.y + dy / L * 1e6 };
  let bestT = Infinity, hit = null, cn = target.pts.length, cs = target.closed ? cn : cn - 1;
  for (let j = 0; j < cs; j++) { const c = target.pts[j], e = target.pts[(j + 1) % cn]; const p = segInt(tip, far, c, e); if (p && p.t > 1e-9 && p.t < bestT) { bestT = p.t; hit = { x: p.x, y: p.y }; } }
  if (!hit) return null;
  const out = pts.map(q => ({ x: q.x, y: q.y })); if (whichEnd === 'start') out[0] = hit; else out[n - 1] = hit; return out;
}

// ---------- vector validation (VCarve-style "check vectors") ----------
function _segCross(p1, p2, p3, p4) {   // proper (non-collinear) segment intersection
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y), d2 = d(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = d(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y), d4 = d(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function _selfIntersects(pts, closed) {
  const n = pts.length; if (n < 4) return false;
  const m = closed ? n : n - 1, seg = k => [pts[k], pts[(k + 1) % n]];
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (closed && i === 0 && j === m - 1) continue;   // first & last share a vertex when closed
    const a = seg(i), b = seg(j);
    if (_segCross(a[0], a[1], b[0], b[1])) return true;
  }
  return false;
}
// Returns { open:[id], duplicate:[id], selfIntersect:[id] } — offenders the UI can select.
function validateShapes(shapes) {
  const open = [], duplicate = [], selfIntersect = [], seen = {};
  for (const s of shapes) {
    if (s.type !== 'path') continue;
    const pts = s.pts || [];
    if (pts.length >= 2 && !s.closed) open.push(s.id);
    if (pts.length) {
      const sig = pts.map(p => (Math.round(p.x * 1e4) / 1e4) + ',' + (Math.round(p.y * 1e4) / 1e4)).sort().join(';') + '|' + (!!s.closed);
      if (seen[sig]) duplicate.push(s.id); else seen[sig] = s.id;
    }
    if (s.closed && _selfIntersects(pts, true)) selfIntersect.push(s.id);
  }
  return { open: open, duplicate: duplicate, selfIntersect: selfIntersect };
}

// ---------- doc utils ----------
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function shapesToContoursInput(shapes) {
  // flatten all shapes into {pts,closed} for CAM.assembleContours — annotations (dimensions) never cut
  const out = [];
  for (const s of shapes) { if (s.annotation || s.type === 'dim') continue;
    for (const loop of flatten(s)) out.push({ pts: loop.pts, closed: loop.closed }); }
  return out;
}

// ---------- project save/load (.aqcam) ----------
// Our own versioned JSON project format (NOT Vectric .crv). meta is caller-supplied so the core stays
// pure/deterministic (timestamps injected by the UI, not generated here).
const PROJECT_FORMAT = 'aqcam', PROJECT_VERSION = 1;
function _layersToArray(L) {
  const out = [];
  if (!L) return out;
  if (typeof L.forEach === 'function' && !Array.isArray(L)) {          // Map
    L.forEach((info, name) => out.push({ name: name, visible: !info || info.visible !== false, color: (info && info.color) || '#9fe7ff' }));
  } else if (Array.isArray(L)) {                                       // [[name,info]] or [{name,...}]
    for (const e of L) {
      if (Array.isArray(e)) out.push({ name: e[0], visible: !e[1] || e[1].visible !== false, color: (e[1] && e[1].color) || '#9fe7ff' });
      else out.push({ name: e.name, visible: e.visible !== false, color: e.color || '#9fe7ff' });
    }
  } else {                                                             // plain object
    for (const name in L) { const info = L[name] || {}; out.push({ name: name, visible: info.visible !== false, color: info.color || '#9fe7ff' }); }
  }
  return out;
}
function projectToJSON(doc, job, opsQueue, meta) {
  const obj = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION,
    meta: meta || {},
    job: job ? { w: job.w, h: job.h, thickness: job.thickness, origin: job.origin, show: job.show !== false } : null,
    layers: _layersToArray(doc && doc.layers),
    shapes: (doc && doc.shapes) ? doc.shapes : [],
    ops: opsQueue || []
  };
  return JSON.stringify(obj);
}
function projectFromJSON(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error('Not a valid project file (bad JSON)'); }
  if (!o || typeof o !== 'object' || o.format !== PROJECT_FORMAT) throw new Error('Not an aqcam project file');
  if (typeof o.version !== 'number' || o.version < 1 || o.version > PROJECT_VERSION) throw new Error('Unsupported project version: ' + o.version);
  if (!Array.isArray(o.shapes)) throw new Error('Project has no shapes array');
  const layers = (Array.isArray(o.layers) && o.layers.length)
    ? o.layers.map(l => ({ name: String(l.name), visible: l.visible !== false, color: l.color || '#9fe7ff' }))
    : [{ name: '0', visible: true, color: '#9fe7ff' }];
  const job = o.job
    ? { w: +o.job.w || 24, h: +o.job.h || 18, thickness: +o.job.thickness || 0.5, origin: o.job.origin || 'bl', show: o.job.show !== false }
    : { w: 24, h: 18, thickness: 0.5, origin: 'bl', show: true };
  return { shapes: o.shapes, layers: layers, job: job, opsQueue: Array.isArray(o.ops) ? o.ops : [], meta: o.meta || {} };
}

// ---- export filenames ----------------------------------------------------------------------
// A published Artifact hands the viewer a file through the host, which only accepts a fixed set of
// extensions — and none of this app's are on it (.tap, .dxf, .aqcam, .aqtpl, .aqclip). Rather than
// rename every export for everyone, keep the real name and carry a safe alternative to retry with if
// the host refuses: the file still arrives, and one rename puts it right. Locally, where the plain
// download link works, `alt` is never used.
const SAVE_BASE_EXT = ['gif','png','jpg','jpeg','webp','mp4','webm','txt','json','md'];
function saveFilename(name){
  const s = String(name == null ? '' : name);
  const m = s.match(/\.([A-Za-z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : '';
  if (SAVE_BASE_EXT.indexOf(ext) >= 0) return { name: s, alt: null };
  const isJson = ['aqcam','aqtpl','aqclip'].indexOf(ext) >= 0;
  return { name: s, alt: s + (isJson ? '.json' : '.txt') };
}

return {
  uid, arcPolyline, arcStepFor, dist,
  mkLine, mkPoly, mkRect, mkRoundRect, mkCircle, mkEllipse, mkArc, mkPolygon, mkStar, mkText,
  mkBezier, flattenBezier, reflowBezier, mirrorSmoothHandle,
  segInt, pathIntersections, filletPolyCorner, trimPolyline, extendPolyline,
  flatten, bbox, bboxAll, bboxPts, hitTest, distToSeg, pointInPoly, snapPoints, rectSnapPoints,
  translate, rotate, scale, mirror,
  offsetShapes, booleanOp,
  nestShapes, placeShape,
  svgToShapes, svgPathToShapes, dxfPolysToShapes, toDXF, toSVG, saveFilename,
  textShapes, outlineTextShapes, FONT, measureText, clone, shapesToContoursInput,
  mkDimension, dimensionGeometry, dimValue, fmtDimValue, syncDimension, DIM_STYLES, DIM_DEFAULTS,
  primParams, applyPrimParams, fitShapeTo, fitPrimTo,
  ANCHORS, anchorPoint, bboxAnchor, moveAnchorTo, moveGroupAnchorTo,
  projectToJSON, projectFromJSON, PROJECT_VERSION,
  validateShapes
};
});
