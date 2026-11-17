#!/usr/bin/env node
// filesweep.js — open every .tap / .dxf / .crv / .crv3d under one or more folders with the studio's own parsers,
// READ-ONLY, and record what really happened to each file. Reads the engine from
// this repo (ENGINE below) and writes only to --out.
//
//   node filesweep.js --out <dir> [--jobs N] [--timeout 120] [--ext tap,dxf,crv,crv3d] <root> [<root> ...]
//
// Status: ok | partial (opened, something did not come through; reported:true when the parser said so itself,
// reported:false when only this audit noticed) | fail (did not open).
// Audits are independent of the parsers they grade: raw group-code scans for DXF, a separate line interpreter for
// G-code, own NURBS evaluation for splines.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');

const ENGINE = path.join(__dirname, '..', 'cam-engine');
const OLE_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const hasOle = u => OLE_MAGIC.every((b, i) => u[i] === b);

function loadEngine() {
  const ctx = { console, Math, JSON, Date, TextDecoder, TextEncoder };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ENGINE, 'dxfparse.js'), 'utf8') + ';this.parseDxf=parseDxf;this.entityToPolys=entityToPolys;', ctx, { filename: 'dxfparse.js' });
  vm.runInContext(fs.readFileSync(path.join(ENGINE, 'tpdparse.js'), 'utf8'), ctx, { filename: 'tpdparse.js' });
  vm.runInContext(fs.readFileSync(path.join(ENGINE, 'crvparse.js'), 'utf8') + ';this.CRVPARSE=CRVPARSE;this.crvCfbOpen=crvCfbOpen;', ctx, { filename: 'crvparse.js' });
  vm.runInContext(fs.readFileSync(path.join(ENGINE, 'crvtoolpaths.js'), 'utf8'), ctx, { filename: 'crvtoolpaths.js' });
  const TE = require(path.join(ENGINE, 'tapedit.js')), GCSIM = require(path.join(ENGINE, 'gcodesim.js')), CADCORE = require(path.join(ENGINE, 'cadcore.js'));
  let TPD = null; try { TPD = require(path.join(ENGINE, 'tpdparse.js')); } catch (e) { /* absent */ }
  return { ctx, GCSIM, CADCORE, TPD, TE };
}

function refInterpret(text) {
  const L = text.split(/\r\n|\n|\r/);
  let x = 0, y = 0, z = null, f = 0, mode = 0, abs = true, unit = 1, t = 0;
  const ends = new Map(), issues = {}; const tools = new Set();
  const note = (k, n, raw) => { const e = issues[k] = issues[k] || { n: 0, first: null }; e.n++; if (!e.first) e.first = (n + 1) + ': ' + raw.slice(0, 70); };
  let arcs = 0, motion = 0;
  let cutMin = [Infinity, Infinity, Infinity], cutMax = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < L.length; n++) {
    const raw = L[n]; let c = raw;
    if (/\[[^\]]*$/.test(c)) note('UNCLOSED_BRACKET', n, raw);
    c = c.replace(/\[[^\]]*(\]|$)/g, ' ').replace(/\([^)]*(\)|$)/g, ' ').replace(/;.*$/, ' ').toUpperCase();
    if (!c.trim() || c.trim()[0] === '%') continue;
    const words = []; const rest = c.replace(/([A-Z])\s*([-+]?\d*\.?\d*)/g, (a, l, v) => { if (v === '' || v === '.' || v === '-' || v === '+') { words.push([l, null]); return ' '; } words.push([l, +v]); return ' '; });
    const hasBareBad = words.some(([l, v]) => v == null) && !words.some(([l, v]) => l === 'G' && v === 53);
    if (rest.trim() || hasBareBad) { note('GARBAGE_TEXT', n, raw); for (const [l, v] of words) if (v == null && l !== 'G') note('BARE_WORD_' + l, n, raw); continue; }
    const W = {}; const G = [], M = [];
    for (const [l, v] of words) { if (l === 'G') G.push(v); else if (l === 'M') M.push(v); else if (v != null) W[l] = v; else note('BARE_WORD_' + l, n, raw); }
    if (G.indexOf(53) >= 0) { note('G53', n, raw); continue; }
    for (const g of G) if (![0, 1, 2, 3, 4, 20, 21, 90, 91].includes(g)) note('G' + g, n, raw);
    if (G.indexOf(4) >= 0) { if (W.X == null && W.P == null) note('INFO_OPERATOR_PAUSE_G4', n, raw); continue; }
    for (const k of Object.keys(W)) if (!'XYZIJFST'.includes(k) && !(k === 'C' && M.length)) note('WORD_' + k, n, raw);
    if (G.indexOf(21) >= 0) unit = 1 / 25.4; if (G.indexOf(20) >= 0) unit = 1;
    if (G.indexOf(90) >= 0) abs = true; if (G.indexOf(91) >= 0) { abs = false; note('G91', n, raw); }
    if (W.T != null) { t = Math.round(W.T); tools.add(t); }
    if (W.F != null) f = W.F * unit;
    for (const g of G) if (g <= 3 && g >= 0 && Number.isInteger(g)) mode = g;
    if (W.X == null && W.Y == null && W.Z == null && !(mode >= 2 && (W.I != null || W.J != null))) continue;
    const pos = (a, cur, def) => a == null ? (cur == null ? def : cur) : (abs ? a * unit : (cur == null ? 0 : cur) + a * unit);
    const nx = pos(W.X, x, 0), ny = pos(W.Y, y, 0), nz = pos(W.Z, z, 0);
    const haveZ = z != null;
    if (mode === 2 || mode === 3) {
      if (W.I == null && W.J == null && W.R == null) note('ARC_WITHOUT_CENTER', n, raw);
      else if (W.R != null) note('ARC_R_FORMAT', n, raw);
      else { arcs++; const cx = x + (W.I || 0) * unit, cy = y + (W.J || 0) * unit, r0 = Math.hypot(x - cx, y - cy), r1 = Math.hypot(nx - cx, ny - cy);
        if (Math.abs(r0 - r1) > 0.002) note('ARC_RADIUS_MISMATCH', n, raw); }
    }
    motion++;
    if (haveZ && nz < 0) for (const [i, v] of [[0, nx], [1, ny], [2, nz]]) { if (v < cutMin[i]) cutMin[i] = v; if (v > cutMax[i]) cutMax[i] = v; }
    x = nx; y = ny; z = nz; ends.set(n + 1, { x, y, z, f, t });
  }
  return { ends, issues, tools: [...tools], motion, arcs, cutMin, cutMax };
}

function auditTap(u, E) {
  if (!u.length) return { status: 'fail', err: 'EMPTY_FILE' };
  if (hasOle(u)) return { status: 'fail', err: 'NOT_GCODE_OLE_CONTAINER', note: 'a Vectric/OLE file renamed .tap', reported: !E.TE.readBytes(u, 'x').ok };
  if (u.slice(0, 4096).includes(0)) return { status: 'fail', err: 'NOT_GCODE_BINARY' };
  const text = Buffer.from(u.buffer, u.byteOffset, u.length).toString('latin1');
  const ref = refInterpret(text);
  let sim;
  try { sim = E.GCSIM.parseGcode(text); } catch (e) { return { status: 'fail', err: 'SIM_THROW', msg: e.message }; }
  if (sim.n === 0 && ref.motion === 0) return { status: 'fail', err: 'NO_MOTION' };
  const simEnd = new Map();
  for (let i = 0; i < sim.n; i++) simEnd.set(sim.line[i], i);
  let posBad = 0, fBad = 0, tBad = 0, firstBad = null, extraLines = 0;
  for (const [ln, r] of ref.ends) {
    const i = simEnd.get(ln); if (i == null) continue;
    if (Math.abs(sim.x1[i] - r.x) > 1e-3 || Math.abs(sim.y1[i] - r.y) > 1e-3 || Math.abs(sim.z1[i] - r.z) > 1e-3) { posBad++; if (!firstBad) firstBad = ln; }
    if (Math.abs(sim.feed[i] - r.f) > 1e-3) { fBad++; if (!firstBad) firstBad = ln; }
    if (sim.tool[i] !== r.t) { tBad++; if (!firstBad) firstBad = ln; }
  }
  for (const ln of simEnd.keys()) if (!ref.ends.has(ln)) { extraLines++; if (!firstBad) firstBad = ln; }
  const out = { moves: sim.n, motionLines: ref.motion, arcs: ref.arcs, tools: sim.tools, warnings: (sim.warnings || []).slice(0, 8) };
  const b = sim.bounds;
  out.bounds = sim.n ? [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].map(v => +v.toFixed(4)) : null;
  out.cut = isFinite(ref.cutMin[0]) ? ref.cutMin.concat(ref.cutMax).map(v => +v.toFixed(4)) : null;
  const reasons = [];
  if (posBad) reasons.push('SIM_WRONG_POSITION'); if (fBad) reasons.push('SIM_WRONG_FEED'); if (tBad) reasons.push('SIM_WRONG_TOOL');
  if (extraLines) reasons.push('SIM_EXECUTED_COMMENT_OR_JUNK');
  out.simGrade = { posBad, fBad, tBad, extraLines, firstBadLine: firstBad };
  for (const k of Object.keys(ref.issues).filter(k => !k.startsWith('INFO_'))) reasons.push(k);
  out.issues = ref.issues;
  if (!ref.motion) reasons.push('NO_MOTION_LINES');
  out.status = reasons.length ? 'partial' : 'ok';
  out.reported = reasons.length ? (((sim.issues || []).length > 0 || sim.warnings.length > 0) && !posBad && !fBad && !tBad && !extraLines) : undefined;
  out.reasons = reasons;
  return out;
}

function dxfRawScan(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const types = {}, msTypes = {}; let section = null, psCount = 0, ocsFlip = 0;
  const hdr = {}; let curVar = null;
  const inserts = new Set(), blocks = new Set(); let pendingBlock = false, pendingInsert = false;
  const splines = []; let curSpl = null; let cur = null, curPS = false; let mirrored = 0;
  const closeEnt = () => { if (cur && section === 'ENTITIES' && curPS) psCount++; else if (cur && section === 'ENTITIES') msTypes[cur] = (msTypes[cur] || 0) + 1; cur = null; curPS = false; curSpl = null; };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10), v = (lines[i + 1] || '').trim();
    if (Number.isNaN(code)) { i--; continue; }
    if (code === 0 && v === 'SECTION') { closeEnt(); section = (lines[i + 3] || '').trim(); continue; }
    if (code === 0 && v === 'ENDSEC') { closeEnt(); section = null; continue; }
    if (section === 'HEADER') { if (code === 9) curVar = v; else if (curVar) (hdr[curVar] = hdr[curVar] || {})[code] = v; continue; }
    if (section === 'BLOCKS' && code === 0 && v === 'BLOCK') pendingBlock = true; else if (section === 'BLOCKS' && pendingBlock && code === 2) { blocks.add(v); pendingBlock = false; }
    if (section === 'ENTITIES' || section === 'BLOCKS') {
      if (code === 0) { closeEnt(); if (['VERTEX', 'SEQEND', 'ENDBLK', 'BLOCK', 'ATTRIB'].includes(v)) continue;
        if (section === 'ENTITIES') { types[v] = (types[v] || 0) + 1; cur = v; }
        if (v === 'INSERT') pendingInsert = true;
        if (v === 'SPLINE' && section === 'ENTITIES') { curSpl = { d: 3, k: [], w: [], c: [], fit: 0 }; splines.push(curSpl); }
      } else if (cur || section === 'BLOCKS') {
        if (code === 67 && +v === 1) curPS = true;
        if (code === 230 && +v < 0) ocsFlip++;
        if (cur === 'INSERT' && (code === 41 || code === 42) && +v < 0) mirrored++;
        if (pendingInsert && code === 2) { inserts.add(v); pendingInsert = false; }
        if (curSpl) { if (code === 71) curSpl.d = +v; else if (code === 40) curSpl.k.push(+v); else if (code === 41) curSpl.w.push(+v); else if (code === 10) curSpl.c.push([+v, 0]); else if (code === 20 && curSpl.c.length) curSpl.c[curSpl.c.length - 1][1] = +v; else if (code === 11) curSpl.fit++; }
      }
    }
  }
  closeEnt();
  return { types, msTypes, psCount, ocsFlip, mirrored, hdr, inserts: [...inserts], blocks: [...blocks], splines };
}
function refNurbs(s, u) {
  const p = s.d, U = s.k, P = s.c, W = s.w.length === P.length ? s.w : P.map(() => 1), n = P.length - 1;
  let k = p; while (k < n && !(u >= U[k] && u < U[k + 1])) k++;
  const d = []; for (let j = 0; j <= p; j++) { const i = k - p + j, w = W[i]; d.push([P[i][0] * w, P[i][1] * w, w]); }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = k - p + j, den = U[i + p - r + 1] - U[i], a = den > 0 ? (u - U[i]) / den : 0;
    for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
  }
  return [d[p][0] / d[p][2], d[p][1] / d[p][2]];
}
function segDist(px, py, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / L)) : 0; return Math.hypot(px - a.x - t * dx, py - a.y - t * dy); }

function auditDxf(u, E) {
  if (!u.length) return { status: 'fail', err: 'EMPTY_FILE' };
  const head = Buffer.from(u.buffer, u.byteOffset, Math.min(22, u.length)).toString('latin1');
  if (head.startsWith('AutoCAD Binary DXF')) return { status: 'fail', err: 'BINARY_DXF' };
  const text = Buffer.from(u.buffer, u.byteOffset, u.length).toString('latin1');
  const raw = dxfRawScan(text);
  if (!Object.keys(raw.types).length && !/ENTITIES/.test(text)) return { status: 'fail', err: 'NO_ENTITIES_SECTION' };
  let ents, polys = [];
  try { ents = E.ctx.parseDxf(text); for (const e of ents) for (const p of E.ctx.entityToPolys(e)) polys.push(p); }
  catch (e) { return { status: 'fail', err: 'PARSE_THROW', msg: e.message }; }
  const shapes = E.CADCORE.dxfPolysToShapes(polys);
  const repCodes = new Set((ents.report || []).map(r => r.code)); const unitF = (ents.units && ents.units.factor) || 1;
  const out = { entities: raw.types, shapes: shapes.length, version: (raw.hdr.$ACADVER || {})[1] || null,
    insunits: raw.hdr.$INSUNITS ? +raw.hdr.$INSUNITS[70] : null, layers: new Set(polys.map(p => p.layer)).size, mirroredInserts: raw.mirrored };
  let b = null;
  for (const s of shapes) for (const p of s.pts) { b = b || [p.x, p.y, p.x, p.y]; b[0] = Math.min(b[0], p.x); b[1] = Math.min(b[1], p.y); b[2] = Math.max(b[2], p.x); b[3] = Math.max(b[3], p.y); }
  out.bounds = b ? b.map(v => +v.toFixed(4)) : null;
  const reasons = [];
  const HANDLED = { LINE: 1, ARC: 1, CIRCLE: 1, ELLIPSE: 1, LWPOLYLINE: 1, POLYLINE: 1, SPLINE: 1, INSERT: 1 };
  for (const t of Object.keys(raw.types)) if (!HANDLED[t]) reasons.push('DROPPED_' + t);
  if (raw.psCount) reasons.push('PAPERSPACE_IMPORTED_AS_MODEL');
  if (raw.ocsFlip) reasons.push('OCS_FLIP_IGNORED');
  if (raw.mirrored) reasons.push('MIRRORED_INSERT');
  const missing = raw.inserts.filter(n => raw.blocks.indexOf(n) < 0); if (missing.length) { reasons.push('MISSING_BLOCK'); out.missingBlocks = missing.slice(0, 5); }
  if (raw.hdr.$INSUNITS && +raw.hdr.$INSUNITS[70] !== 1 && +raw.hdr.$INSUNITS[70] !== 0 && unitF === 1) reasons.push('NON_INCH_UNITS_NOT_SCALED_' + raw.hdr.$INSUNITS[70]);
  let splWorst = 0, splFitOnly = 0;
  const splPolys = polys.filter(p => p.type === 'SPLINE');
  raw.splines.forEach((s, i) => {
    if (!s.c.length || s.k.length !== s.c.length + s.d + 1) { splFitOnly++; return; }
    if (s.closedFlag && 0) return;
    const lo = s.k[s.d], hi = s.k[s.c.length]; const pl = splPolys[i]; if (!pl) { splWorst = Infinity; return; }
    for (let j = 1; j < 40; j++) { const q = refNurbs(s, lo + (hi - lo) * j / 40); let best = Infinity; for (let m = 1; m < pl.pts.length; m++) best = Math.min(best, segDist(q[0] * unitF, q[1] * unitF, pl.pts[m - 1], pl.pts[m])); splWorst = Math.max(splWorst, best); }
  });
  if (raw.splines.length) out.splineWorstDev = isFinite(splWorst) ? +splWorst.toFixed(5) : 'missing';
  if (splWorst > 0.01) reasons.push('SPLINE_OFF_TRUE_CURVE');
  if (splFitOnly && !repCodes.has('SPLINE_FIT_ONLY')) reasons.push('SPLINE_FIT_ONLY_APPROX');
  const ex = raw.hdr.$EXTMIN, ey = raw.hdr.$EXTMAX;
  if (ex && ey && b) { const e = [+ex[10], +ex[20], +ey[10], +ey[20]];
    for (let i = 0; i < 4; i++) e[i] *= unitF;
    if (e.every(v => Math.abs(v) < 1e6) && e[2] > e[0]) { out.headerExt = e.map(v => +v.toFixed(4)); const tol = Math.max(0.05, 0.002 * Math.hypot(e[2] - e[0], e[3] - e[1]));
      if (Math.abs(b[0] - e[0]) > tol || Math.abs(b[1] - e[1]) > tol || Math.abs(b[2] - e[2]) > tol || Math.abs(b[3] - e[3]) > tol) reasons.push('BOUNDS_DIFFER_FROM_HEADER'); } }
  const UNREPORTED = reasons.filter(r => !repCodes.has(r) && !(r === 'PAPERSPACE_IMPORTED_AS_MODEL' && repCodes.has('PAPER_SPACE')));
  for (const c of (ents.report || [])) if (c.level !== 'info' && reasons.indexOf(c.code) < 0) reasons.push(c.code);
  out.report = (ents.report || []).map(r => r.code + (r.count > 1 ? ' x' + r.count : ''));
  out.status = shapes.length && !reasons.length ? 'ok' : (shapes.length ? 'partial' : 'fail');
  if (out.status === 'fail') out.err = reasons[0] || 'NO_GEOMETRY';
  if (reasons.length) { out.reasons = reasons; out.reported = UNREPORTED.length === 0; if (UNREPORTED.length) out.unreported = UNREPORTED; }
  return out;
}

function crvErrClass(m) {
  const r = [[/no VectorData/i, 'NO_VECTOR_STREAM'], [/truncat/i, 'TRUNCATED'], [/span type/i, 'UNKNOWN_SPAN_TYPE'], [/version/i, 'UNKNOWN_VERSION'], [/class/i, 'UNKNOWN_CLASS'], [/anchor/i, 'ANCHOR_MISMATCH'], [/chain|gap/i, 'CHAIN_GAP'], [/sector|FAT|directory|stream|compound/i, 'CONTAINER']];
  for (const [re, c] of r) if (re.test(m)) return c;
  return 'OTHER:' + m.replace(/[-0-9.]+/g, '#').slice(0, 48);
}
function auditCrv(u, E) {
  if (!u.length) return { status: 'fail', err: 'EMPTY_FILE' };
  let polys;
  try { polys = E.ctx.CRVPARSE.parse(u, { tol: 0.002 }); }
  catch (e) { return { status: 'fail', err: (e.notCrvFile ? 'NOT_A_CRV_FILE' : crvErrClass(e.message)), msg: e.message.slice(0, 220) }; }
  const out = { contours: polys.length, points: polys.reduce((n, p) => n + p.pts.length, 0), layers: (polys.layerNames || []).length, app: polys.app, job: polys.jobSize, dialect: polys.dialect,
    bitmaps: (polys.checks && polys.checks.skippedFrames) || 0, classes: polys.checks && polys.checks.classes, warnings: (polys.warnings || []).slice(0, 8), units: polys.sourceUnits };
  let b = null;
  for (const p of polys) for (const q of p.pts) { b = b || [q.x, q.y, q.x, q.y]; b[0] = Math.min(b[0], q.x); b[1] = Math.min(b[1], q.y); b[2] = Math.max(b[2], q.x); b[3] = Math.max(b[3], q.y); }
  out.bounds = b ? b.map(v => +v.toFixed(4)) : null;
  const reasons = [];
  let cfb = null; try { cfb = E.ctx.crvCfbOpen(u); } catch (e) { /* parse succeeded */ }
  let tpN = 0, tools = [], tpErr = null, imported = 0, tpRep = [];
  if (cfb && cfb.exists('Toolpaths/ToolpathData') && E.TPD) {
    try { const tpd = polys.toolpathData || E.TPD.parseToolpathData(new Uint8Array(cfb.stream('Toolpaths/ToolpathData')), new Set(polys.map(p => p.ent.guid)));
      tpN = tpd.toolpaths.length; tools = [...new Set(tpd.toolpaths.flatMap(t => (t.tools || []).map(x => x.toolNum)))];
      out.tpTypes = [...new Set(tpd.toolpaths.map(t => t.type))];
      const r = E.ctx.CRVTP.toStudioOps(tpd, { guids: [...new Set(polys.map(p => p.ent.guid))], openGuids: polys.filter(p => !p.ent.closed).map(p => p.ent.guid), safeZ: polys.safeZ }); imported = r.ops.length; tpRep = r.report; out.tpImported = imported; out.tpLost = tpN - imported;
    } catch (e) { tpErr = e.message.slice(0, 160); }
  }
  out.toolpaths = tpN; out.tools = tools;
  if (tpErr) { out.tpError = tpErr; reasons.push('TOOLPATH_STREAM_UNREADABLE'); }
  for (const r of tpRep) if (r.level !== 'info') reasons.push(r.code);
  if (tpN && !imported && !tpRep.length) reasons.push('TOOLPATHS_NOT_IMPORTED_BY_APP');
  for (const r of (polys.report || [])) if (r.level !== 'info') reasons.push(r.code);
  out.status = reasons.length ? 'partial' : 'ok';
  if (reasons.length) { out.reasons = [...new Set(reasons)]; out.reported = !!polys.report; }
  return out;
}

function auditFile(f, E) {
  const u = new Uint8Array(fs.readFileSync(f));
  const ext = path.extname(f).slice(1).toLowerCase();
  const t0 = Date.now();
  const r = ext === 'tap' ? auditTap(u, E) : ext === 'dxf' ? auditDxf(u, E) : auditCrv(u, E);
  r.ms = Date.now() - t0; r.size = u.length;
  return r;
}

if (process.argv[2] === '--worker') {
  const E = loadEngine();
  process.on('message', ({ i, f }) => {
    let r; try { r = auditFile(f, E); } catch (e) { r = { status: 'fail', err: 'AUDIT_THROW', msg: String(e && e.message).slice(0, 200) }; }
    process.send({ i, r });
  });
  process.send({ ready: true });
  return;
}

function walk(root, exts, out) {
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) { if (e.name.startsWith('.')) continue; const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, exts, out); else if (exts.has(path.extname(e.name).slice(1).toLowerCase())) out.push(p); }
}
function main() {
  const av = process.argv.slice(2), roots = []; let outDir = null, jobs = Math.max(2, os.cpus().length - 2), timeout = 120, exts = 'tap,dxf,crv,crv3d', tag = '';
  for (let i = 0; i < av.length; i++) { if (av[i] === '--out') outDir = av[++i]; else if (av[i] === '--jobs') jobs = +av[++i]; else if (av[i] === '--timeout') timeout = +av[++i]; else if (av[i] === '--ext') exts = av[++i]; else if (av[i] === '--tag') tag = av[++i]; else roots.push(av[i]); }
  if (!outDir || !roots.length) { console.error('usage: filesweep.js --out <dir> <root>...'); process.exit(2); }
  const absOut = path.resolve(outDir);
  for (const r of roots) { const a = path.resolve(r); if (absOut === a || absOut.startsWith(a + path.sep)) { console.error('refusing: output folder is inside a scanned root (' + r + ')'); process.exit(2); } }
  fs.mkdirSync(absOut, { recursive: true });
  const files = []; const extSet = new Set(exts.split(',')); for (const r of roots) walk(path.resolve(r), extSet, files);
  files.sort();
  console.error(`sweep: ${files.length} files, ${jobs} workers`);
  const out = fs.createWriteStream(path.join(absOut, 'sweep.jsonl'));
  const rows = new Array(files.length);
  let next = 0, done = 0; const t0 = Date.now();
  const start = () => {
    const w = cp.fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'] });
    let timer = null, cur = -1;
    const give = () => { if (next >= files.length) { w.kill(); return; } cur = next++; w.send({ i: cur, f: files[cur] }); clearTimeout(timer); timer = setTimeout(() => { record(cur, { status: 'fail', err: 'TIMEOUT', msg: `> ${timeout}s` }); cur = -1; w.kill('SIGKILL'); start(); }, timeout * 1000); };
    w.on('message', m => { if (m.ready) return give(); clearTimeout(timer); record(m.i, m.r); cur = -1; give(); });
    w.on('exit', (code) => { clearTimeout(timer); if (cur >= 0) { record(cur, { status: 'fail', err: 'WORKER_CRASH', msg: 'exit ' + code }); start(); } });
  };
  function record(i, r) {
    if (rows[i]) return; const f = files[i];
    r.file = f; r.ext = path.extname(f).slice(1).toLowerCase(); rows[i] = r; out.write(JSON.stringify(r) + '\n');
    if (++done % 500 === 0) console.error(`  ${done}/${files.length} ${(Date.now() - t0) / 1000 | 0}s`);
    if (done === files.length) { out.end(); groundTruth(rows); summarize(rows, absOut, roots, (Date.now() - t0) / 1000, tag); console.error('done'); process.exit(0); }
  }
  for (let j = 0; j < Math.min(jobs, files.length); j++) start();
}
function groundTruth(rows) {
  const stemKey = f => path.join(path.dirname(f), path.basename(f, path.extname(f))).toLowerCase();
  const byKey = new Map(); for (const r of rows) { if (r.status === 'fail') continue; const k = stemKey(r.file); if (!byKey.has(k)) byKey.set(k, {}); byKey.get(k)[r.ext] = r; }
  const crvsInDir = new Map(); for (const r of rows) if (r.status !== 'fail' && (r.ext === 'crv' || r.ext === 'crv3d')) { const d = path.dirname(r.file); if (!crvsInDir.has(d)) crvsInDir.set(d, []); crvsInDir.get(d).push(r); }
  for (const r of rows) {
    if (r.ext !== 'tap' || r.status === 'fail' || !r.cut) continue;
    const k = stemKey(r.file), sib = byKey.get(k) || {};
    const gt = {}; let crv = sib.crv3d || sib.crv, how = 'same-stem';
    if (!crv) { const inDir = crvsInDir.get(path.dirname(r.file)) || []; if (inDir.length === 1) { crv = inDir[0]; how = 'only-crv-in-folder'; } }
    if (crv && crv.job && crv.job.w) {
      const w = r.cut[3] - r.cut[0], h = r.cut[4] - r.cut[1];
      gt.crv = { how, jobW: crv.job.w, jobH: crv.job.h, cutW: +w.toFixed(3), cutH: +h.toFixed(3), fits: w <= crv.job.w + 1.5 && h <= crv.job.h + 1.5 };
      if (crv.tools && crv.tools.length) { const extra = r.tools.filter(t => crv.tools.indexOf(t) < 0); gt.crv.toolsOk = extra.length === 0; if (extra.length) gt.crv.extraTools = extra; }
    }
    if (sib.dxf && sib.dxf.bounds) { const b = sib.dxf.bounds, tol = 1.0; gt.dxf = { fits: r.cut[0] >= b[0] - tol && r.cut[1] >= b[1] - tol && r.cut[3] <= b[2] + tol && r.cut[4] <= b[3] + tol }; }
    const aq = byKey.get(k + '-aq');
    if (aq && aq.tap && aq.tap.cut) { const d = [0, 1, 3, 4].map(i => Math.abs(r.cut[i] - aq.tap.cut[i])); gt.aq = { maxDelta: +Math.max(...d).toFixed(4), agrees: Math.max(...d) < 0.03 }; }
    if (Object.keys(gt).length) r.gt = gt;
  }
}
function summarize(rows, outDir, roots, secs, tag) {
  const S = {}, rc = {};
  for (const r of rows) { const e = r.ext; const s = S[e] = S[e] || { total: 0, ok: 0, partial: 0, partialReported: 0, partialSilent: 0, fail: 0 }; s.total++; s[r.status]++;
    if (r.status === 'partial') r.reported ? s.partialReported++ : s.partialSilent++;
    for (const c of (r.status === 'fail' ? [r.err] : (r.reasons || []))) { const k = e + ' ' + r.status + ' ' + c; (rc[k] = rc[k] || { n: 0, ex: [] }).n++; if (rc[k].ex.length < 3) rc[k].ex.push(path.relative(roots[0], r.file) + (r.simGrade && r.simGrade.firstBadLine ? ':' + r.simGrade.firstBadLine : '') + (r.msg ? ' - ' + r.msg.slice(0, 120) : '')); } }
  const ranked = Object.entries(rc).sort((a, b) => b[1].n - a[1].n);
  const gt = { crvPairs: 0, crvFits: 0, crvToolsChecked: 0, crvToolsOk: 0, dxfPairs: 0, dxfFits: 0, aqPairs: 0, aqAgree: 0 };
  for (const r of rows) if (r.gt) { const g = r.gt; if (g.crv) { gt.crvPairs++; if (g.crv.fits) gt.crvFits++; if (g.crv.toolsOk != null) { gt.crvToolsChecked++; if (g.crv.toolsOk) gt.crvToolsOk++; } } if (g.dxf) { gt.dxfPairs++; if (g.dxf.fits) gt.dxfFits++; } if (g.aq) { gt.aqPairs++; if (g.aq.agrees) gt.aqAgree++; } }
  fs.writeFileSync(path.join(outDir, 'groundtruth.json'), JSON.stringify(rows.filter(r => r.gt).map(r => ({ file: r.file, gt: r.gt }))));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ tag, roots, secs, byExt: S, ranked: ranked.map(([k, v]) => ({ cls: k, n: v.n, ex: v.ex })), groundTruth: gt }, null, 1));
  let md = `# Sweep ${tag}\n\nRoots: ${roots.join(', ')} - ${rows.length} files in ${secs | 0}s\n\n| ext | total | ok | partial (reported) | partial (silent) | fail |\n|---|---|---|---|---|---|\n`;
  for (const [e, s] of Object.entries(S)) md += `| ${e} | ${s.total} | ${s.ok} | ${s.partialReported} | ${s.partialSilent} | ${s.fail} |\n`;
  md += `\nGround truth: ${JSON.stringify(gt)}\n\n## Classes, most common first\n\n`;
  for (const [k, v] of ranked.slice(0, 80)) md += `- **${k}** - ${v.n} files. e.g. ${v.ex.join(' ; ')}\n`;
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  console.log(md.slice(0, 7000));
}
main();
