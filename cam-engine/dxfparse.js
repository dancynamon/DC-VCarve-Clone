/* DXF parser extracted from viewer */
// --- DXF Parser ---

// ---- BLOCK/INSERT support: affine matrices [a,b,c,d,e,f] mapping (x,y)->(a*x+c*y+e, b*x+d*y+f) ----
const DXF_IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const DXF_MIRROR_X = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };   // extrusion (0,0,-1): drawn on the back of the XY plane
function dxfMatMul(A, B) {   // A after B: apply(matMul(A,B), p) === apply(A, apply(B, p))
  return {
    a: A.a * B.a + A.c * B.b, b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d, d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e, f: A.b * B.e + A.d * B.f + A.f
  };
}
function dxfApplyMat(M, px, py) { return { x: M.a * px + M.c * py + M.e, y: M.b * px + M.d * py + M.f }; }
function dxfInsertMatrix(ins, base) {   // T(ins.x,ins.y) * R(rot) * S(sx,sy) * T(-base)
  const sx = ins.sx == null ? 1 : ins.sx, sy = ins.sy == null ? 1 : ins.sy;
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
  const det = M.a * M.d - M.b * M.c, mirrored = det < 0;
  const similar = Math.abs(sx - sy) <= 1e-6 * Math.max(1, sx) && Math.abs(M.a * M.c + M.b * M.d) <= 1e-6 * Math.max(1, sx * sy);
  const P = (x, y) => dxfApplyMat(M, x, y), lin = (x, y) => dxfApplyMat({ a: M.a, b: M.b, c: M.c, d: M.d, e: 0, f: 0 }, x, y);
  const asPoly = (raw, closed) => ({ type: 'LWPOLYLINE', layer: ent.layer || '0', color: ent.color, closed: closed,
    vertices: raw.map(p => { const q = dxfApplyMat(M, p.x, p.y); return { x: q.x, y: q.y, bulge: 0 }; }) });
  switch (ent.type) {
    case 'LINE': { const a = P(ent.x1, ent.y1), b = P(ent.x2, ent.y2); e.x1 = a.x; e.y1 = a.y; e.x2 = b.x; e.y2 = b.y; break; }
    case 'POINT': { const c = P(ent.x, ent.y); e.x = c.x; e.y = c.y; break; }
    case 'CIRCLE': {
      if (!similar) { const raw = circlePts(ent.cx, ent.cy, ent.r); raw.pop(); return asPoly(raw, true); }   // an ellipse: tessellate in block space
      const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; e.r = ent.r * sx; break; }
    case 'ARC': {
      if (!similar) return asPoly(arcPts(ent.cx, ent.cy, ent.r, ent.startAngle || 0, ent.endAngle || 360), false);
      const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; e.r = ent.r * sx;
      const pt = d => { const r = d * Math.PI / 180, q = lin(Math.cos(r), Math.sin(r)); return Math.atan2(q.y, q.x) * 180 / Math.PI; };
      // a mirror turns a counter-clockwise arc clockwise, so its two ends swap roles
      const s0 = pt(ent.startAngle || 0), s1 = pt(ent.endAngle == null ? 360 : ent.endAngle);
      e.startAngle = mirrored ? s1 : s0; e.endAngle = mirrored ? s0 : s1;
      break; }
    case 'ELLIPSE': {
      if (!similar || mirrored) {
        const raw = ellipsePts(ent), full = Math.abs(raw[0].x - raw[raw.length - 1].x) < 1e-9 && Math.abs(raw[0].y - raw[raw.length - 1].y) < 1e-9;
        if (full) raw.pop();
        return asPoly(raw, full);
      }
      const c = P(ent.cx, ent.cy); e.cx = c.x; e.cy = c.y; const m = lin(ent.majorX || 0, ent.majorY || 0); e.majorX = m.x; e.majorY = m.y; e.ratio = ent.ratio; break; }
    case 'LWPOLYLINE': case 'POLYLINE': {
      if (!similar && (ent.vertices || []).some(v => v.bulge)) {   // bulges do not survive a non-uniform scale: flatten first
        const raw = dxfPolyVerticesToPts(ent);
        if (ent.closed && raw.length > 1) raw.pop();
        return asPoly(raw, !!ent.closed);
      }
      e.vertices = (ent.vertices || []).map(v => { const p = P(v.x, v.y); return { x: p.x, y: p.y, bulge: (mirrored ? -1 : 1) * (v.bulge || 0) }; }); break; }
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
  else if (code === 67) cur.space = parseInt(v, 10);
  else if (code === 210) cur.ex = parseFloat(v); else if (code === 220) cur.ey = parseFloat(v); else if (code === 230) cur.ez = parseFloat(v);
  switch (cur.type) {
    case 'POINT': if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); break;
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
      if (code === 70) { const f = parseInt(v, 10); cur.closed = (f & 1) === 1; cur.flags = f; } break;
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
      if (code === 2) cur.name = v; else if (code === 10) cur.x = parseFloat(v); else if (code === 20) cur.y = parseFloat(v); else if (code === 41) cur.sx = parseFloat(v); else if (code === 42) cur.sy = parseFloat(v); else if (code === 50) cur.rot = parseFloat(v);
      else if (code === 70) cur.cols = parseInt(v, 10); else if (code === 71) cur.rows = parseInt(v, 10); else if (code === 44) cur.colSp = parseFloat(v); else if (code === 45) cur.rowSp = parseFloat(v); break;
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
// Entity types that make cut geometry here, and what we do with the rest.
const DXF_HANDLED = { LINE: 1, ARC: 1, CIRCLE: 1, ELLIPSE: 1, LWPOLYLINE: 1, POLYLINE: 1, SPLINE: 1 };
const DXF_UNITS = { 1: ['inches', 1], 2: ['feet', 12], 3: ['miles', 63360], 4: ['millimetres', 1 / 25.4], 5: ['centimetres', 1 / 2.54], 6: ['metres', 1000 / 25.4], 7: ['kilometres', 1e6 / 25.4], 8: ['microinches', 1e-6], 9: ['mils', 1e-3], 10: ['yards', 36] };
function dxfReporter() {
  const m = new Map();
  const add = (code, level, msg, n, detail) => { const e = m.get(code); if (e) { e.count += n || 1; if (detail && e.items.length < 8 && e.items.indexOf(detail) < 0) e.items.push(detail); } else m.set(code, { code, level, msg, count: n || 1, items: detail ? [detail] : [] }); };
  return { add, list: () => [...m.values()] };
}
function dxfEntityVerdict(ent, rep, where) {   // true = keep. Everything dropped says so.
  if (ent.space === 1) { if (ent.type !== 'VIEWPORT') rep.add('PAPER_SPACE', 'warn', 'on the paper-space layout were not imported (model space only)', 1); return false; }
  if (ent.ex != null || ent.ey != null || ent.ez != null) {
    const ex = ent.ex || 0, ey = ent.ey || 0, ez = ent.ez == null ? 1 : ent.ez;
    if (Math.abs(ex) > 1e-9 || Math.abs(ey) > 1e-9) { rep.add('TILTED', 'loss', 'lie on a tilted plane and were not imported', 1); return false; }
    if (ez < 0) ent._flipOCS = true;
  }
  if (ent.type === 'POLYLINE' && ent.flags != null && (ent.flags & (16 | 64))) { rep.add('POLYLINE_MESH', 'loss', 'POLYLINE 3D meshes were not imported', 1); return false; }
  if (DXF_HANDLED[ent.type]) return true;
  if (ent.type === 'INSERT') return true;
  if (ent.type === 'VIEWPORT') return false;
  if (ent.type === 'TEXT' || ent.type === 'MTEXT') { rep.add('DROPPED_TEXT', 'loss', 'text entities were not imported (use a font tool or convert the text to outlines)', 1, (ent.text || '').trim().slice(0, 40)); return false; }
  if (ent.type === 'DIMENSION') { rep.add('DROPPED_DIMENSION', 'loss', 'dimensions were not imported', 1); return false; }
  rep.add('DROPPED_' + ent.type, 'loss', ent.type + ' entities were not imported', 1, where);
  return false;
}
// OCS with extrusion (0,0,-1): the entity is drawn on the back of the XY plane, i.e. mirrored in X. LINE, ELLIPSE and SPLINE
// are stored in world coordinates so they need no transform; an ELLIPSE's parameter direction still flips with its normal.
function dxfApplyOCS(ent) {
  if (!ent._flipOCS) return ent;
  if (ent.type === 'ELLIPSE') { ent.flipMinor = true; delete ent._flipOCS; return ent; }
  if (ent.type === 'LINE' || ent.type === 'SPLINE') { delete ent._flipOCS; return ent; }
  const out = dxfTransformEntity(ent, DXF_MIRROR_X); delete out._flipOCS; return out;
}
// recursively expand an INSERT into transformed primitive entities (cycle-guarded). rep is optional so the old call shape still works.
function dxfExpandInsert(ins, parentM, blocks, seen, out, rep) {
  const blk = blocks[ins.name];
  if (!blk) { if (rep) rep.add('MISSING_BLOCK', 'loss', 'INSERTs name a block that is not in the file and were not imported', 1, ins.name); return; }
  if (seen.indexOf(ins.name) >= 0) { if (rep) rep.add('BLOCK_CYCLE', 'loss', 'INSERTs refer to themselves and were skipped', 1, ins.name); return; }
  const seen2 = seen.concat([ins.name]);
  const cols = Math.max(1, ins.cols || 1), rows = Math.max(1, ins.rows || 1);
  const rot = (ins.rot || 0) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const ox = i * (ins.colSp || 0), oy = j * (ins.rowSp || 0);    // MINSERT: the array runs along the block's own rotated axes
    const M = dxfMatMul(parentM, dxfInsertMatrix(Object.assign({}, ins, { x: (ins.x || 0) + ox * c - oy * s, y: (ins.y || 0) + ox * s + oy * c }), blk.base));
    for (const raw of blk.entities) {
      if (!dxfEntityVerdict(raw, rep || dxfReporter(), 'in block ' + ins.name)) continue;
      if (raw.type === 'INSERT') { dxfExpandInsert(raw, raw._flipOCS ? dxfMatMul(M, DXF_MIRROR_X) : M, blocks, seen2, out, rep); continue; }
      out.push(dxfTransformEntity(dxfApplyOCS(Object.assign({}, raw)), M));
    }
  }
}

// DXF files are pairs of (group_code, value) on alternating lines.
// Returns the entity array with extras: .report [{code,level:'info'|'warn'|'loss',msg,count,items}], .warnings (strings),
// .units {name,factor,source}, .layerTable {name:{color,off,frozen}}. Coordinates come back in INCHES. Throws on a file
// that cannot be a DXF at all, with a message fit to show the user.
// opts.units 'inch' or 'mm' overrides what the file states; the default 'auto' honours $INSUNITS.
function parseDxf(text, opts) {
  if (text == null || !String(text).length) throw new Error('This DXF is empty (0 bytes), so there is nothing to open. Re-export it from the drawing program.');
  text = String(text);
  if (text.slice(0, 18) === 'AutoCAD Binary DXF') throw new Error('This is a binary DXF, which this importer does not read. Save it from AutoCAD as an ASCII DXF.');
  const lines = text.split(/\r\n|\n|\r/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = (lines[i] || '').trim();
    if (!codeStr) { i--; continue; }       // skip blank lines, re-align
    const code = parseInt(codeStr, 10);
    if (Number.isNaN(code)) continue;
    pairs.push([code, lines[i + 1] !== undefined ? lines[i + 1] : '']);
  }

  const rep = dxfReporter();
  const T = s => (s == null ? '' : s).trim();
  // HEADER variables and the LAYER table, so units and layer colours are not guessed
  const header = {}, layerTable = {};
  for (let i = 0; i + 2 < pairs.length; i++) if (pairs[i][0] === 0 && T(pairs[i][1]) === 'SECTION' && pairs[i + 1][0] === 2 && T(pairs[i + 1][1]) === 'HEADER') {
    let cur = null;
    for (let k = i + 2; k < pairs.length; k++) { if (pairs[k][0] === 0 && T(pairs[k][1]) === 'ENDSEC') break; if (pairs[k][0] === 9) cur = T(pairs[k][1]); else if (cur) (header[cur] = header[cur] || {})[pairs[k][0]] = T(pairs[k][1]); }
    break;
  }
  for (let i = 0; i < pairs.length; i++) if (pairs[i][0] === 0 && T(pairs[i][1]) === 'LAYER' && (!pairs[i - 1] || pairs[i - 1][0] !== 2)) {
    const L = {}; let name = null;
    for (let k = i + 1; k < pairs.length && pairs[k][0] !== 0; k++) { const c = pairs[k][0], v = T(pairs[k][1]); if (c === 2) name = v; else if (c === 62) L.color = parseInt(v, 10); else if (c === 70) L.flags = parseInt(v, 10); }
    if (name != null) layerTable[name] = { color: Math.abs(L.color == null ? 7 : L.color), off: (L.color || 0) < 0, frozen: !!(L.flags & 1) };
  }

  const blocks = dxfParseBlocks(pairs);   // {} when there is no BLOCKS section -> ENTITIES parsing unchanged

  // Locate ENTITIES section (handle files with no clear section markers too)
  let start = 0, sawEntities = false;
  for (let i = 0; i + 2 < pairs.length; i++) {
    if (pairs[i][0] === 0 && (pairs[i][1] || '').trim() === 'SECTION' &&
        pairs[i+1][0] === 2 && (pairs[i+1][1] || '').trim() === 'ENTITIES') {
      start = i + 2; sawEntities = true;
      break;
    }
  }
  if (!sawEntities && !pairs.length) throw new Error('This file is not a DXF (it does not contain group-code pairs).');

  const ents = [];
  let cur = null;
  let parentPoly = null;          // last POLYLINE we encountered (for VERTEX entities)

  function closeCurrent() {
    if (!cur) return;
    if (cur._isVertex) {
      if (parentPoly) parentPoly.vertices.push({ x: cur.x || 0, y: cur.y || 0, bulge: cur.bulge || 0 });
      cur = null; return;
    }
    const keep = dxfEntityVerdict(cur, rep, 'at top level');
    if (cur.type === 'POLYLINE') cur.vertices = cur.vertices || [];
    if (keep) {
      if (cur.type === 'INSERT') dxfExpandInsert(cur, cur._flipOCS ? DXF_MIRROR_X : DXF_IDENTITY, blocks, [], ents, rep);
      else ents.push(cur);    // OCS is applied below, once a POLYLINE has its vertices
    }
    parentPoly = cur.type === 'POLYLINE' ? cur : parentPoly;
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
    dxfApplyPair(cur, code, v);
  }
  closeCurrent();

  // entities that carry an OCS flip (POLYLINE waits for its vertices)
  for (let i = 0; i < ents.length; i++) if (ents[i]._flipOCS) ents[i] = dxfApplyOCS(ents[i]);

  // ---- units ----
  const wantUnits = (opts && opts.units === 'inch') ? 'inch' : (opts && opts.units === 'mm') ? 'mm' : 'auto';
  const iu = header.$INSUNITS ? parseInt(header.$INSUNITS[70], 10) : null;
  let units = { name: 'inches', factor: 1, source: 'assumed: file does not say' };
  if (iu != null && iu !== 0) {
    if (DXF_UNITS[iu]) units = { name: DXF_UNITS[iu][0], factor: DXF_UNITS[iu][1], source: '$INSUNITS=' + iu };
    else if (wantUnits === 'auto') rep.add('UNKNOWN_UNITS', 'warn', '$INSUNITS=' + iu + ' is not a unit this importer knows; the file was read as inches', 1);
  }
  if (wantUnits !== 'auto') {
    const chosen = wantUnits === 'mm' ? { name: 'millimetres', factor: 1 / 25.4, source: 'setting' } : { name: 'inches', factor: 1, source: 'setting' };
    rep.add('UNITS_CHOSEN', chosen.name === units.name ? 'info' : 'warn', 'This file was read as ' + chosen.name + ' because the units were set by hand. ' + (units.source.indexOf('assumed') === 0 ? 'The file does not state its units.' : 'The file says it is in ' + units.name + '.') + ' Check the size before cutting.', 1);
    units = chosen;
  }
  if (units.factor !== 1) {
    if (units.source !== 'setting') rep.add('UNITS_SCALED', 'warn', 'The file is drawn in ' + units.name + ' ($INSUNITS=' + iu + '); it was scaled to inches', 1);
    const M = { a: units.factor, b: 0, c: 0, d: units.factor, e: 0, f: 0 };
    for (let i = 0; i < ents.length; i++) ents[i] = dxfTransformEntity(ents[i], M);
  } else if (units.source.indexOf('assumed') === 0) {
    rep.add('UNITS_ASSUMED', 'info', 'The file does not state its units; it was read as inches', 1);
  }

  // ---- what the curves could and could not honour ----
  for (const e of ents) if (e.type === 'SPLINE') {
    e.closed = !!(e.flags & 1);
    if (!dxfSplineUsable(e) && !(e.fit && e.fit.length >= 2)) rep.add('SPLINE_UNREADABLE', 'loss', 'SPLINE entities have no usable control or fit points and were not imported', 1);
    else if (!dxfSplineUsable(e)) rep.add('SPLINE_FIT_ONLY', 'warn', 'SPLINE entities only give fit points, so the curve between them is an approximation', 1);
  }
  ents.report = rep.list();
  ents.warnings = ents.report.map(r => r.count + ' ' + r.msg);
  ents.units = units;
  ents.layerTable = layerTable;
  return ents;
}

// --- DXF geometry helpers ---
// Adaptive tessellation: pick the angular step so the chord never departs from the true arc by more
// than DXF_CHORD_H. A fixed step (the old `PI/16` / `PI/32` / `64 steps`) makes the error scale with
// radius — a 2.875" round end came in 0.0138" flat-sided and a 12" one 0.058". Mirrors cadcore's
// arcStepFor; duplicated here because dxfparse.js is concatenated into the browser build standalone.
const DXF_CHORD_H = 0.004;
function dxfArcStep(r) {
  if (!(r > 0)) return 0.20;
  const c = 1 - DXF_CHORD_H / r;
  if (c <= -1 || c >= 1) return 0.20;
  return Math.max(0.015, Math.min(0.20, 2 * Math.acos(c)));
}
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
  steps = steps || Math.max(8, Math.min(512, Math.ceil(a / dxfArcStep(r))));
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
  steps = steps || Math.max(12, Math.ceil(span / dxfArcStep(r)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = sa + span * (i / steps);
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function circlePts(cx, cy, r, steps) {
  steps = steps || Math.max(64, Math.ceil(2 * Math.PI / dxfArcStep(r)));
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
  steps = steps || Math.max(32, Math.ceil(span / dxfArcStep(major)));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = sa + span * (i / steps);
    // Local ellipse point
    const lx = major * Math.cos(t);
    const ly = (ent.flipMinor ? -1 : 1) * minor * Math.sin(t);
    // Rotate by ellipse orientation
    const px = cx + lx * Math.cos(rot) - ly * Math.sin(rot);
    const py = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
    pts.push({ x: px, y: py });
  }
  return pts;
}

// A spline's control net is only usable when its knot vector matches: n knots = n controls + degree + 1.
function dxfSplineUsable(ent) {
  const p = ent.degree == null ? 3 : ent.degree, c = ent.controls, k = ent.knots;
  return !!(c && c.length >= p + 1 && k && k.length === c.length + p + 1 && p >= 1);
}
// Point on the (rational) B-spline at parameter u: de Boor. Knots are not assumed to start at 0 or be clamped.
function dxfDeBoor(p, U, P, W, u) {
  const n = P.length - 1;
  let k = p; while (k < n && !(u >= U[k] && u < U[k + 1])) k++;
  const d = []; for (let j = 0; j <= p; j++) { const i = k - p + j, w = W ? W[i] : 1; d.push([P[i].x * w, P[i].y * w, w]); }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = k - p + j, den = U[i + p - r + 1] - U[i], a = den > 0 ? (u - U[i]) / den : 0;
    for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
  }
  return { x: d[p][0] / d[p][2], y: d[p][1] / d[p][2] };
}
// True curve, flattened adaptively to within DXF_SPLINE_TOL (per knot span, so a cusp at a knot is kept).
const DXF_SPLINE_TOL = 0.002;
function dxfSplineTrue(ent) {
  const p = ent.degree == null ? 3 : ent.degree, U = ent.knots, P = ent.controls;
  const W = ent.weights && ent.weights.length === P.length ? ent.weights : null;
  const lo = U[p], hi = U[P.length], out = [];
  if (!(hi > lo)) return null;
  const ev = u => dxfDeBoor(p, U, P, W, u === hi ? hi - (hi - lo) * 1e-12 : u);
  const emit = (u0, q0, u1, q1, depth) => {
    const um = (u0 + u1) / 2, qm = ev(um), dx = q1.x - q0.x, dy = q1.y - q0.y, L = Math.hypot(dx, dy);
    const err = L > 1e-12 ? Math.abs((qm.x - q0.x) * dy - (qm.y - q0.y) * dx) / L : Math.hypot(qm.x - q0.x, qm.y - q0.y);
    if (depth >= 14 || (depth >= 3 && err <= DXF_SPLINE_TOL)) { out.push(q1); return; }
    emit(u0, q0, um, qm, depth + 1); emit(um, qm, u1, q1, depth + 1);
  };
  const kts = []; for (let i = p; i <= P.length; i++) if (!kts.length || U[i] > kts[kts.length - 1] + 1e-12) kts.push(U[i]);
  let prev = ev(kts[0]); out.push(prev);
  for (let i = 0; i + 1 < kts.length; i++) { const q = ev(kts[i + 1]); emit(kts[i], prev, kts[i + 1], q, 0); prev = q; }
  return out;
}
function splinePts(ent) {
  if (dxfSplineUsable(ent)) { const t = dxfSplineTrue(ent); if (t && t.length >= 2) return t; }
  // Only fit points exist: interpolate them (reported as an approximation by parseDxf).
  const pts = ent.fit && ent.fit.length >= 2 ? ent.fit : [];
  if (pts.length < 2) return pts;
  if (pts.length === 2) return pts;
  const out = [], n = pts.length, samples = 16;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[n - 1]);
  return out;
}

function dxfPolyVerticesToPts(ent) {
  const verts = ent.vertices || [], pts = [];
  if (verts.length < 2) return pts;
  for (let i = 0; i < verts.length - 1; i++) {
    const seg = bulgeArcPts(verts[i], verts[i + 1], verts[i].bulge || 0);
    if (i === 0) pts.push(seg[0]);
    for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
  }
  if (ent.closed) {
    const seg = bulgeArcPts(verts[verts.length - 1], verts[0], verts[verts.length - 1].bulge || 0);
    for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
  }
  return pts;
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
    case 'ELLIPSE': {
      const e0 = ent.startParam == null ? 0 : ent.startParam, e1 = ent.endParam == null ? 2 * Math.PI : ent.endParam;
      let span = e1 - e0; if (span <= 0) span += 2 * Math.PI;
      push(ellipsePts(ent), 'ELLIPSE', { closed: span >= 2 * Math.PI - 1e-6 });   // a partial ellipse is an open vector
      break; }
    case 'LWPOLYLINE':
    case 'POLYLINE':
      push(dxfPolyVerticesToPts(ent), ent.type);
      break;
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

