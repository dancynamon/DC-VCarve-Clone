/* DXF parser extracted from viewer */
// --- DXF Parser ---

// ---- BLOCK/INSERT support: affine matrices [a,b,c,d,e,f] mapping (x,y)->(a*x+c*y+e, b*x+d*y+f) ----
const DXF_IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
function dxfMatMul(A, B) {   // A after B: apply(matMul(A,B), p) === apply(A, apply(B, p))
  return {
    a: A.a * B.a + A.c * B.b, b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d, d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e, f: A.b * B.e + A.d * B.f + A.f
  };
}
function dxfApplyMat(M, px, py) { return { x: M.a * px + M.c * py + M.e, y: M.b * px + M.d * py + M.f }; }
function dxfInsertMatrix(ins, base) {   // T(ins.x,ins.y) * R(rot) * S(sx,sy) * T(-base)
  const sx = ins.sx == null ? 1 : ins.sx, sy = ins.sy == null ? (ins.sx == null ? 1 : ins.sx) : ins.sy;
  const rot = (ins.rot || 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
  const bx = base ? base.x || 0 : 0, by = base ? base.y || 0 : 0;
  const Tb = { a: 1, b: 0, c: 0, d: 1, e: -bx, f: -by };
  const S = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
  const R = { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
  const T = { a: 1, b: 0, c: 0, d: 1, e: ins.x || 0, f: ins.y || 0 };
  return dxfMatMul(T, dxfMatMul(R, dxfMatMul(S, Tb)));
}
// clone an entity with its coordinates transformed by matrix M (used to bake INSERT placement into geometry)
function dxfTransformEntity(ent, M) {
  const e = Object.assign({}, ent);
  const sx = Math.hypot(M.a, M.b), sy = Math.hypot(M.c, M.d), rotDeg = Math.atan2(M.b, M.a) * 180 / Math.PI;
  const P = (x, y) => dxfApplyMat(M, x, y), lin = (x, y) => dxfApplyMat({ a: M.a, b: M.b, c: M.c, d: M.d, e: 0, f: 0 }, x, y);
  switch (ent.type) {
    case 'LINE': { const a = P(ent.x1, ent.y1), b = P(ent.x2, ent.y2); e.x1 = a.x; e.y1 = a.y; e.x2 = b.x; e.y2 = b.y; break; }
    case 'CIRCLE': {
      if (Math.abs(sx - sy) > 1e-6) {
        // Non-uniform scale: tessellate in block space then transform each point so the ellipse is correct
        const raw = circlePts(ent.cx, ent.cy, ent.r, 64).slice(0, 64); // drop duplicate closing point
        return { type: 'LWPOLYLINE', layer: ent.layer || '0', closed: true,
                 vertices: raw.map(p => { const q = dxfApplyMat(M, p.x, p.y); return { x: q.x, y: q.y, bulge: 0 }; }) };
      }
      const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; e.r = ent.r * sx; break; }
    case 'ARC': {
      if (Math.abs(sx - sy) > 1e-6) {
        const raw = arcPts(ent.cx, ent.cy, ent.r, ent.startAngle || 0, ent.endAngle || 360);
        return { type: 'LWPOLYLINE', layer: ent.layer || '0', closed: false,
                 vertices: raw.map(p => { const q = dxfApplyMat(M, p.x, p.y); return { x: q.x, y: q.y, bulge: 0 }; }) };
      }
      const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; e.r = ent.r * sx; e.startAngle = (ent.startAngle || 0) + rotDeg; e.endAngle = (ent.endAngle || 0) + rotDeg; break; }
    case 'ELLIPSE': { const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; const m = lin(ent.majorX || 0, ent.majorY || 0); e.majorX = m.x; e.majorY = m.y; e.ratio = ent.ratio; break; }
    case 'LWPOLYLINE': case 'POLYLINE': { e.vertices = (ent.vertices || []).map(v => { const p = P(v.x, v.y); return { x: p.x, y: p.y, bulge: v.bulge || 0 }; }); break; }
    case 'TEXT': case 'MTEXT': { const c = P(ent.x, ent.y); e.x = c.x; e.y = c.y; e.height = (ent.height || 0) * sy; e.rotation = (ent.rotation || 0) + rotDeg; break; }
    case 'SPLINE': { if (ent.controls) e.controls = ent.controls.map(p => { const q = P(p.x, p.y); return { x: q.x, y: q.y }; }); if (ent.fit) e.fit = ent.fit.map(p => { const q = P(p.x, p.y); return { x: q.x, y: q.y }; }); break; }
    case 'DIMENSION': { const c = P(ent.x, ent.y); e.x = c.x; e.y = c.y; break; }
  }
  return e;
}
// apply one (code,value) pair to an entity being parsed — shared by ENTITIES loop and block bodies
function dxfApplyPair(cur, code, v) {
  if (cur._isVertex) {
    if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); else if (code === 42) cur.bulge = parseFloat(v);
    return;
  }
  if (code === 8) cur.layer = v; else if (code === 62) cur.color = parseInt(v, 10);
  switch (cur.type) {
    case 'LINE':
      if (code === 10) cur.x1 = parseFloat(v); else if (code === 20) cur.y1 = parseFloat(v); else if (code === 11) cur.x2 = parseFloat(v); else if (code === 21) cur.y2 = parseFloat(v); break;
    case 'CIRCLE':
      if (code === 10) cur.cx = parseFloat(v); else if (code === 20) cur.cy = parseFloat(v); else if (code === 40) cur.r = parseFloat(v); break;
    case 'ARC':
      if (code === 10) cur.cx = parseFloat(v); else if (code === 20) cur.cy = parseFloat(v); else if (code === 40) cur.r = parseFloat(v); else if (code === 50) cur.startAngle = parseFloat(v); else if (code === 51) cur.endAngle = parseFloat(v); break;
    case 'ELLIPSE':
      if (code === 10) cur.cx = parseFloat(v); else if (code === 20) cur.cy = parseFloat(v); else if (code === 11) cur.majorX = parseFloat(v); else if (code === 21) cur.majorY = parseFloat(v); else if (code === 40) cur.ratio = parseFloat(v); else if (code === 41) cur.startParam = parseFloat(v); else if (code === 42) cur.endParam = parseFloat(v); break;
    case 'LWPOLYLINE':
      if (code === 10) cur.vertices.push({ x: parseFloat(v), y: 0, bulge: 0 });
      else if (code === 20) { if (cur.vertices.length) cur.vertices[cur.vertices.length - 1].y = parseFloat(v); }
      else if (code === 42) { if (cur.vertices.length) cur.vertices[cur.vertices.length - 1].bulge = parseFloat(v); }
      else if (code === 70) cur.closed = (parseInt(v, 10) & 1) === 1; break;
    case 'POLYLINE':
      if (code === 70) cur.closed = (parseInt(v, 10) & 1) === 1; break;
    case 'SPLINE':
      if (code === 71) cur.degree = parseInt(v, 10); else if (code === 72) cur.numKnots = parseInt(v, 10); else if (code === 73) cur.numControl = parseInt(v, 10); else if (code === 74) cur.numFit = parseInt(v, 10); else if (code === 70) cur.flags = parseInt(v, 10);
      else if (code === 40) (cur.knots = cur.knots || []).push(parseFloat(v)); else if (code === 41) (cur.weights = cur.weights || []).push(parseFloat(v));
      else if (code === 10) (cur.controls = cur.controls || []).push({ x: parseFloat(v), y: 0 });
      else if (code === 20) { const cps = cur.controls; if (cps && cps.length) cps[cps.length - 1].y = parseFloat(v); }
      else if (code === 11) (cur.fit = cur.fit || []).push({ x: parseFloat(v), y: 0 });
      else if (code === 21) { const fps = cur.fit; if (fps && fps.length) fps[fps.length - 1].y = parseFloat(v); } break;
    case 'TEXT': case 'MTEXT':
      if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); else if (code === 40) cur.height = parseFloat(v); else if (code === 1) cur.text = (cur.text || '') + v; else if (code === 3) cur.text = (cur.text || '') + v; else if (code === 50) cur.rotation = parseFloat(v); break;
    case 'DIMENSION':
      if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); else if (code === 1) cur.text = v; break;
    case 'INSERT':
      if (code === 2) cur.name = v; else if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); else if (code === 41) cur.sx = parseFloat(v); else if (code === 42) cur.sy = parseFloat(v); else if (code === 50) cur.rot = parseFloat(v); break;
  }
}
// parse the BLOCKS section into { name: {base:{x,y}, entities:[...]} } (entities may include nested INSERTs)
function dxfParseBlocks(pairs) {
  const blocks = {}; const T = s => (s == null ? '' : s).trim();
  let bstart = -1;
  for (let i = 0; i + 2 < pairs.length; i++) {
    if (pairs[i][0] === 0 && T(pairs[i][1]) === 'SECTION' && pairs[i + 1][0] === 2 && T(pairs[i + 1][1]) === 'BLOCKS') { bstart = i + 2; break; }
  }
  if (bstart < 0) return blocks;
  for (let i = bstart; i < pairs.length;) {
    const code = pairs[i][0], v = T(pairs[i][1]);
    if (code === 0 && (v === 'ENDSEC' || v === 'EOF')) break;
    if (code === 0 && v === 'BLOCK') {
      const blk = { base: { x: 0, y: 0 }, entities: [] }; let name = '', cur = null, parentPoly = null;
      const closeB = () => { if (!cur) return; if (cur._isVertex && parentPoly) parentPoly.vertices.push({ x: cur.x || 0, y: cur.y || 0, bulge: cur.bulge || 0 }); else { blk.entities.push(cur); if (cur.type === 'POLYLINE') { cur.vertices = cur.vertices || []; parentPoly = cur; } } cur = null; };
      i++;
      for (; i < pairs.length; i++) {
        const c = pairs[i][0], vv = T(pairs[i][1]);
        if (c === 0) {
          closeB();
          if (vv === 'ENDBLK') { i++; break; }
          if (vv === 'SEQEND') { parentPoly = null; continue; }
          if (vv === 'VERTEX') { cur = { _isVertex: true, x: 0, y: 0, bulge: 0 }; continue; }
          cur = { type: vv, layer: '0' }; if (vv === 'LWPOLYLINE') cur.vertices = [];
          continue;
        }
        if (!cur) { if (c === 2) name = vv; else if (c === 10) blk.base.x = parseFloat(vv); else if (c === 20) blk.base.y = parseFloat(vv); continue; }   // block header
        dxfApplyPair(cur, c, vv);
      }
      closeB();
      if (name) blocks[name] = blk;
      continue;
    }
    i++;
  }
  return blocks;
}
// recursively expand an INSERT into transformed primitive entities (cycle-guarded)
function dxfExpandInsert(ins, parentM, blocks, seen, out) {
  const blk = blocks[ins.name];
  if (!blk || seen.indexOf(ins.name) >= 0) return;   // unknown block or cycle -> skip
  const seen2 = seen.concat([ins.name]);
  const M = dxfMatMul(parentM, dxfInsertMatrix(ins, blk.base));
  for (const be of blk.entities) {
    if (be.type === 'INSERT') dxfExpandInsert(be, M, blocks, seen2, out);
    else out.push(dxfTransformEntity(be, M));
  }
}

// DXF files are pairs of (group_code, value) on alternating lines.
function parseDxf(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = (lines[i] || '').trim();
    if (!codeStr) { i--; continue; }       // skip blank lines, re-align
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1] !== undefined ? lines[i + 1] : '']);
  }

  const blocks = dxfParseBlocks(pairs);   // {} when there is no BLOCKS section -> ENTITIES parsing unchanged

  // Locate ENTITIES section (handle files with no clear section markers too)
  let start = 0;
  for (let i = 0; i + 2 < pairs.length; i++) {
    if (pairs[i][0] === 0 && (pairs[i][1] || '').trim() === 'SECTION' &&
        pairs[i+1][0] === 2 && (pairs[i+1][1] || '').trim() === 'ENTITIES') {
      start = i + 2;
      break;
    }
  }

  const ents = [];
  let cur = null;
  let parentPoly = null;          // last POLYLINE we encountered (for VERTEX entities)

  function closeCurrent() {
    if (!cur) return;
    if (cur._isVertex && parentPoly) {
      parentPoly.vertices.push({ x: cur.x || 0, y: cur.y || 0, bulge: cur.bulge || 0 });
    } else if (cur.type === 'INSERT') {
      dxfExpandInsert(cur, DXF_IDENTITY, blocks, [], ents);   // bake block geometry into ents
    } else {
      ents.push(cur);
      if (cur.type === 'POLYLINE') { cur.vertices = cur.vertices || []; parentPoly = cur; }
    }
    cur = null;
  }

  for (let i = start; i < pairs.length; i++) {
    const [code, rawVal] = pairs[i];
    const v = (rawVal == null ? '' : rawVal).trim();
    if (code === 0) {
      closeCurrent();
      if (v === 'ENDSEC' || v === 'EOF') break;
      if (v === 'SEQEND') { parentPoly = null; continue; }
      if (v === 'VERTEX') { cur = { _isVertex: true, x: 0, y: 0, bulge: 0 }; continue; }
      cur = { type: v, layer: '0' };
      if (v === 'LWPOLYLINE') cur.vertices = [];
      continue;
    }
    if (!cur) continue;

    // VERTEX (sub-entity of POLYLINE)
    if (cur._isVertex) {
      if (code === 10) cur.x = parseFloat(v);
      else if (code === 20) cur.y = parseFloat(v);
      else if (code === 42) cur.bulge = parseFloat(v);
      continue;
    }

    if (code === 8) cur.layer = v;
    else if (code === 62) cur.color = parseInt(v, 10);

    switch (cur.type) {
      case 'LINE':
        if (code === 10) cur.x1 = parseFloat(v);
        else if (code === 20) cur.y1 = parseFloat(v);
        else if (code === 11) cur.x2 = parseFloat(v);
        else if (code === 21) cur.y2 = parseFloat(v);
        break;
      case 'CIRCLE':
        if (code === 10) cur.cx = parseFloat(v);
        else if (code === 20) cur.cy = parseFloat(v);
        else if (code === 40) cur.r = parseFloat(v);
        break;
      case 'ARC':
        if (code === 10) cur.cx = parseFloat(v);
        else if (code === 20) cur.cy = parseFloat(v);
        else if (code === 40) cur.r = parseFloat(v);
        else if (code === 50) cur.startAngle = parseFloat(v);
        else if (code === 51) cur.endAngle = parseFloat(v);
        break;
      case 'ELLIPSE':
        if (code === 10) cur.cx = parseFloat(v);
        else if (code === 20) cur.cy = parseFloat(v);
        else if (code === 11) cur.majorX = parseFloat(v);
        else if (code === 21) cur.majorY = parseFloat(v);
        else if (code === 40) cur.ratio = parseFloat(v);
        else if (code === 41) cur.startParam = parseFloat(v);
        else if (code === 42) cur.endParam = parseFloat(v);
        break;
      case 'LWPOLYLINE':
        if (code === 10) cur.vertices.push({ x: parseFloat(v), y: 0, bulge: 0 });
        else if (code === 20) {
          if (cur.vertices.length) cur.vertices[cur.vertices.length-1].y = parseFloat(v);
        } else if (code === 42) {
          if (cur.vertices.length) cur.vertices[cur.vertices.length-1].bulge = parseFloat(v);
        } else if (code === 70) cur.closed = (parseInt(v, 10) & 1) === 1;
        break;
      case 'POLYLINE':
        if (code === 70) cur.closed = (parseInt(v, 10) & 1) === 1;
        break;
      case 'SPLINE':
        if (code === 71) cur.degree = parseInt(v, 10);
        else if (code === 72) cur.numKnots = parseInt(v, 10);
        else if (code === 73) cur.numControl = parseInt(v, 10);
        else if (code === 74) cur.numFit = parseInt(v, 10);
        else if (code === 70) cur.flags = parseInt(v, 10);
        else if (code === 40) (cur.knots = cur.knots || []).push(parseFloat(v));
        else if (code === 41) (cur.weights = cur.weights || []).push(parseFloat(v));
        else if (code === 10) (cur.controls = cur.controls || []).push({ x: parseFloat(v), y: 0 });
        else if (code === 20) {
          const cps = cur.controls; if (cps && cps.length) cps[cps.length-1].y = parseFloat(v);
        } else if (code === 11) (cur.fit = cur.fit || []).push({ x: parseFloat(v), y: 0 });
        else if (code === 21) {
          const fps = cur.fit; if (fps && fps.length) fps[fps.length-1].y = parseFloat(v);
        }
        break;
      case 'TEXT':
      case 'MTEXT':
        if (code === 10) cur.x = parseFloat(v);
        else if (code === 20) cur.y = parseFloat(v);
        else if (code === 40) cur.height = parseFloat(v);
        else if (code === 1) cur.text = (cur.text || '') + v;
        else if (code === 3) cur.text = (cur.text || '') + v; // MTEXT continuation
        else if (code === 50) cur.rotation = parseFloat(v);
        break;
      case 'DIMENSION':
        if (code === 10) cur.x = parseFloat(v);
        else if (code === 20) cur.y = parseFloat(v);
        else if (code === 1) cur.text = v;
        break;
      case 'INSERT':
        if (code === 2) cur.name = v;
        else if (code === 10) cur.x = parseFloat(v);
        else if (code === 20) cur.y = parseFloat(v);
        else if (code === 41) cur.sx = parseFloat(v);
        else if (code === 42) cur.sy = parseFloat(v);
        else if (code === 50) cur.rot = parseFloat(v);
        break;
    }
  }
  closeCurrent();
  return ents;
}

// --- DXF geometry helpers ---
function bulgeArcPts(p1, p2, bulge, steps) {
  if (Math.abs(bulge) < 1e-9) return [p1, p2];
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return [p1, p2];
  const a = 4 * Math.atan(Math.abs(bulge));      // included angle
  const r = L / (2 * Math.sin(a / 2));
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const nx = -dy / L, ny = dx / L;               // perpendicular (left of P1→P2)
  const dist = r * Math.cos(a / 2);
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx + sign * nx * dist, cy = my + sign * ny * dist;
  let sa = Math.atan2(p1.y - cy, p1.x - cx);
  let ea = Math.atan2(p2.y - cy, p2.x - cx);
  if (bulge > 0) { if (ea < sa) ea += 2 * Math.PI; }
  else { if (ea > sa) ea -= 2 * Math.PI; }
  steps = steps || Math.max(8, Math.min(64, Math.ceil(a / (Math.PI / 16))));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ang = sa + (ea - sa) * t;
    pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
  }
  return pts;
}

function arcPts(cx, cy, r, sDeg, eDeg, steps) {
  let sa = sDeg * Math.PI / 180, ea = eDeg * Math.PI / 180;
  if (ea < sa) ea += 2 * Math.PI;
  const span = ea - sa;
  steps = steps || Math.max(12, Math.ceil(span / (Math.PI / 32)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = sa + span * (i / steps);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function circlePts(cx, cy, r, steps) {
  steps = steps || 64;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function ellipsePts(ent, steps) {
  // Center + endpoint of major axis vector + ratio
  const cx = ent.cx, cy = ent.cy;
  const mx = ent.majorX || 1, my = ent.majorY || 0;
  const ratio = ent.ratio == null ? 1 : ent.ratio;
  const major = Math.hypot(mx, my);
  const minor = major * ratio;
  const rot = Math.atan2(my, mx);
  const sa = ent.startParam == null ? 0 : ent.startParam;
  const ea = ent.endParam == null ? 2 * Math.PI : ent.endParam;
  let span = ea - sa;
  if (span <= 0) span += 2 * Math.PI;
  steps = steps || Math.max(32, Math.ceil(span / (Math.PI / 32)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = sa + span * (i / steps);
    // Local ellipse point
    const lx = major * Math.cos(t);
    const ly = minor * Math.sin(t);
    // Rotate by ellipse orientation
    const px = cx + lx * Math.cos(rot) - ly * Math.sin(rot);
    const py = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
    pts.push({ x: px, y: py });
  }
  return pts;
}

// Approximate B-spline by interpolating fit points if present, otherwise
// using Catmull-Rom over control points (visual approximation, not exact).
function splinePts(ent) {
  const pts = ent.fit && ent.fit.length >= 2 ? ent.fit
            : ent.controls && ent.controls.length >= 2 ? ent.controls
            : [];
  if (pts.length < 2) return pts;
  if (pts.length === 2) return pts;
  // Catmull-Rom interpolation
  const out = [];
  const n = pts.length;
  const samples = 16;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[n - 1]);
  return out;
}

function entityToPolys(ent) {
  // Returns array of polylines; each polyline = array of {x,y}
  const out = [];
  const layer = ent.layer || '0';
  const push = (pts, kind, extra) => {
    if (pts && pts.length >= 2) out.push({ layer, type: kind, pts, ent, ...extra });
    else if (pts && pts.length === 1 && (kind === 'TEXT' || kind === 'DIMENSION'))
      out.push({ layer, type: kind, pts, ent, ...extra });
  };
  switch (ent.type) {
    case 'LINE':
      push([{ x: ent.x1, y: ent.y1 }, { x: ent.x2, y: ent.y2 }], 'LINE');
      break;
    case 'CIRCLE':
      push(circlePts(ent.cx, ent.cy, ent.r), 'CIRCLE');
      break;
    case 'ARC':
      push(arcPts(ent.cx, ent.cy, ent.r, ent.startAngle, ent.endAngle), 'ARC');
      break;
    case 'ELLIPSE':
      push(ellipsePts(ent), 'ELLIPSE');
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE': {
      const verts = ent.vertices || [];
      if (verts.length < 2) break;
      const pts = [];
      for (let i = 0; i < verts.length - 1; i++) {
        const seg = bulgeArcPts(verts[i], verts[i+1], verts[i].bulge || 0);
        if (i === 0) pts.push(seg[0]);
        for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
      }
      if (ent.closed) {
        const seg = bulgeArcPts(verts[verts.length-1], verts[0], verts[verts.length-1].bulge || 0);
        for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
      }
      push(pts, ent.type);
      break;
    }
    case 'SPLINE':
      push(splinePts(ent), 'SPLINE');
      break;
    case 'TEXT':
    case 'MTEXT':
      if (ent.x != null && ent.y != null) {
        push([{ x: ent.x, y: ent.y }], 'TEXT', { text: ent.text || '', height: ent.height || 0.25 });
      }
      break;
    case 'DIMENSION':
      if (ent.x != null && ent.y != null) {
        push([{ x: ent.x, y: ent.y }], 'DIMENSION', { text: ent.text || '<dim>' });
      }
      break;
  }
  return out;
}

// Layer color palette — distinct from tool colors for clarity
const LAYER_COLORS = [
  '#22cc66','#3399ff','#ff9933','#cc44ff','#ff5577','#00cccc',
  '#ffff44','#ff66aa','#aaff33','#ff6633','#66ddff','#dd99ff',
  '#ffcc66','#88ee88','#ff88dd','#bbbbbb',
];

