// crvparse.js — native importer for Vectric VCarve / Aspire .crv and .crv3d files.
//
// Browser-flat script (concatenated by build.js): no module.exports, no IIFE.
// Every global here is prefixed `crv…` so it cannot collide with dxfparse/pdfparse.
//
// Entry point:  parseCrv(u8 /*Uint8Array*/, opts) -> polys
//   polys is the SAME array shape entityToPolys() in dxfparse.js produces —
//   [{layer, type, pts:[{x,y},…], ent}] — so CADCORE.dxfPolysToShapes(polys)
//   consumes it unchanged.  Extra properties on the array:
//     polys.jobSize     {w,h,thickness}   material size, in INCHES
//     polys.units       'inch'            units the returned coordinates are in
//     polys.sourceUnits 'inch' | 'mm'     units the file itself was drawn in
//     polys.unitsSource provenance of that decision (see below)
//     polys.scale       factor applied to the file's raw coordinates
//     polys.dialect     'crv-mfc' | 'crv3d-inline' | 'empty'
//     polys.checks      decode self-checks (tabs, previews discarded, text blocks…)
//     polys.warnings    non-fatal oddities worth telling the user about
//     polys.app / polys.appVersion        writing application, when present
//   opts: {units:'inch'|'mm'|'auto' (default 'auto'), tol: flattening tolerance
//          in inches (default 0.002)}
//
// The .crv container is an OLE2/CFB compound file; the 2D geometry lives in the
// stream "VectorData/2dDataV2" as an MFC CArchive object graph — little-endian
// and BYTE-PACKED (doubles start at unaligned offsets).
//
// Ported from the validated Python reference parser (crvlib.py) against
// FORMAT.md **specification v3**, which parses all 5,977 files of Dan's
// production archive with zero failures.  What that costs in code is the
// framing around the geometry: an MFC property bag hanging off every object
// header, four object versions, machining tabs, toolpath previews, vector
// text, embedded bitmaps and the MFC 32-bit tag escape.  Almost none of it is
// drawing geometry — but there is NO length prefix anywhere in the stream, so
// a record that cannot be decoded exactly cannot be skipped either, and one
// wrong byte desynchronises everything after it.
//
// DESIGN RULE, inherited from the reference parser: this code RAISES rather
// than guessing.  An unknown class, an unexpected structure version, an
// unknown span type, or a contour whose spans do not chain to within 1e-6 all
// throw.  Wrong CNC geometry destroys material; a hard failure is cheaper.
// There is NO resynchronisation anywhere: nothing scans ahead for a tag.

const CRV_CHAIN_TOL = 1e-6;      // max allowed gap between consecutive spans
const CRV_DEFAULT_TOL = 0.002;   // default flattening tolerance, inches
const CRV_MM_PER_IN = 25.4;

function crvFail(msg) { throw new Error('CRV: ' + msg); }
// A file that is not a compound document at all (the archive holds posted
// G-code saved with a .crv3d extension) is a mis-named file, not a corrupt
// one — flagged so the UI can say so instead of crying corruption.
function crvFailNotCrv(msg) { const e = new Error('CRV: ' + msg); e.notCrvFile = true; throw e; }

// ===========================================================================
// 1.  Minimal read-only MS Compound File Binary (CFB / OLE2) reader
// ===========================================================================
const CRV_MAXREGSECT = 0xFFFFFFFA;
const CRV_ENDOFCHAIN = 0xFFFFFFFE;
const CRV_FREESECT = 0xFFFFFFFF;
const CRV_NOSTREAM = 0xFFFFFFFF;

function crvCfbOpen(u8) {
  // Duck-typed rather than `instanceof`: a Uint8Array built in another realm
  // (node's vm sandbox, an iframe) is still a byte view.
  if (!u8 || !ArrayBuffer.isView(u8) || u8.BYTES_PER_ELEMENT !== 1)
    crvFail('expected a Uint8Array of file bytes');
  if (u8.length < 512) crvFail('too short to be a compound file (' + u8.length + ' bytes)');
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) {
    const head = Array.from(u8.subarray(0, 16));
    const ascii = head.every(b => (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13);
    crvFailNotCrv('not a Vectric compound file (' + (ascii ? 'looks like text — posted G-code saved as .crv3d?' : 'unknown binary') + ')');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const cf = { u8, dv };

  const byteOrder = dv.getUint16(28, true);
  const sectShift = dv.getUint16(30, true);
  const miniShift = dv.getUint16(32, true);
  cf.majorVer = dv.getUint16(26, true);
  if (byteOrder !== 0xFFFE) crvFail('unsupported byte order 0x' + byteOrder.toString(16));
  if (sectShift !== 9 && sectShift !== 12) crvFail('unsupported sector shift ' + sectShift);
  if (miniShift !== 6) crvFail('unsupported mini sector shift ' + miniShift);
  cf.sectorSize = 1 << sectShift;
  cf.miniSectorSize = 1 << miniShift;
  cf.nFatSectors = dv.getUint32(44, true);
  cf.firstDirSector = dv.getUint32(48, true);
  cf.miniCutoff = dv.getUint32(56, true);
  cf.firstMinifatSector = dv.getUint32(60, true);
  cf.firstDifatSector = dv.getUint32(68, true);
  if (cf.miniCutoff !== 4096) crvFail('unexpected mini-stream cutoff ' + cf.miniCutoff);

  cf.sector = function (sect) {
    if (sect > CRV_MAXREGSECT) crvFail('special sector id 0x' + sect.toString(16) + ' used as data');
    const off = (sect + 1) * cf.sectorSize;
    if (off + cf.sectorSize > u8.length) crvFail('sector ' + sect + ' past end of file');
    return u8.subarray(off, off + cf.sectorSize);
  };

  // --- FAT / DIFAT ---
  const per = cf.sectorSize / 4;
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(76 + 4 * i, true);
    if (v === CRV_FREESECT || v === CRV_ENDOFCHAIN) break;
    fatSectors.push(v);
  }
  let sect = cf.firstDifatSector;
  const seenDifat = new Set();
  while (sect !== CRV_ENDOFCHAIN && sect !== CRV_FREESECT && sect <= CRV_MAXREGSECT) {
    if (seenDifat.has(sect)) crvFail('DIFAT chain loops at ' + sect);
    seenDifat.add(sect);
    const blk = cf.sector(sect);
    const bdv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
    for (let i = 0; i < per - 1; i++) {
      const v = bdv.getUint32(4 * i, true);
      if (v === CRV_FREESECT || v === CRV_ENDOFCHAIN) continue;
      fatSectors.push(v);
    }
    sect = bdv.getUint32(4 * (per - 1), true);
  }
  let fs = fatSectors;
  if (cf.nFatSectors && fs.length > cf.nFatSectors) fs = fs.slice(0, cf.nFatSectors);
  const fat = [];
  for (const s of fs) {
    const blk = cf.sector(s);
    const bdv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
    for (let i = 0; i < per; i++) fat.push(bdv.getUint32(4 * i, true));
  }
  cf.fat = fat;

  cf.chain = function (start) {
    const out = [];
    let s = start;
    const seen = new Set();
    while (s !== CRV_ENDOFCHAIN && s !== CRV_FREESECT) {
      if (s > CRV_MAXREGSECT) crvFail('bad sector id 0x' + s.toString(16) + ' in chain');
      if (seen.has(s)) crvFail('FAT chain loops at sector ' + s);
      seen.add(s);
      out.push(s);
      if (s >= fat.length) crvFail('sector ' + s + ' outside FAT (' + fat.length + ' entries)');
      s = fat[s];
    }
    return out;
  };
  cf.readChain = function (start, size) {
    const out = new Uint8Array(size);
    let got = 0;
    for (const s of cf.chain(start)) {
      const blk = cf.sector(s);
      const n = Math.min(cf.sectorSize, size - got);
      out.set(blk.subarray(0, n), got);
      got += n;
      if (got >= size) break;
    }
    return out;
  };

  // --- directory ---
  const dirChain = cf.chain(cf.firstDirSector);
  const rawDir = new Uint8Array(dirChain.length * cf.sectorSize);
  dirChain.forEach((s, i) => rawDir.set(cf.sector(s), i * cf.sectorSize));
  const rdv = new DataView(rawDir.buffer, rawDir.byteOffset, rawDir.byteLength);
  const entries = [];
  for (let i = 0; i < rawDir.length / 128; i++) {
    const b = 128 * i;
    const nlen = rdv.getUint16(b + 64, true);
    let name = '';
    if (nlen >= 2 && nlen <= 64) {
      const cu = [];
      for (let k = 0; k < (nlen - 2) / 2; k++) cu.push(rdv.getUint16(b + 2 * k, true));
      name = String.fromCharCode.apply(null, cu);
    }
    const lo = rdv.getUint32(b + 120, true), hi = rdv.getUint32(b + 124, true);
    entries.push({
      name: name, type: rawDir[b + 66],
      left: rdv.getUint32(b + 68, true), right: rdv.getUint32(b + 72, true),
      child: rdv.getUint32(b + 76, true), start: rdv.getUint32(b + 116, true),
      size: cf.majorVer < 4 ? lo : lo + hi * 4294967296
    });
  }
  if (!entries.length || entries[0].type !== 5) crvFail('missing root directory entry');
  const root = entries[0];
  const paths = {};
  (function walk(idx, prefix, depth) {
    if (idx === CRV_NOSTREAM || idx >= entries.length) return;
    if (depth > 128) crvFail('directory tree too deep');
    const e = entries[idx];
    if (e.type === 0) return;
    const path = prefix + e.name;
    if (e.type === 1 || e.type === 5 || e.type === 2) paths[path] = e;
    if (e.type === 1 || e.type === 5) walk(e.child, path + '/', depth + 1);
    walk(e.left, prefix, depth + 1);
    walk(e.right, prefix, depth + 1);
  })(root.child, '', 0);

  let miniStream = null, minifat = null;
  function loadMini() {
    if (miniStream) return;
    miniStream = cf.readChain(root.start, root.size);
    minifat = [];
    for (const s of cf.chain(cf.firstMinifatSector)) {
      const blk = cf.sector(s);
      const bdv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
      for (let i = 0; i < per; i++) minifat.push(bdv.getUint32(4 * i, true));
    }
  }

  cf.names = function () { return Object.keys(paths).sort(); };
  cf.exists = function (p) { return Object.prototype.hasOwnProperty.call(paths, p); };
  cf.stream = function (p) {
    const e = paths[p];
    if (!e) crvFail('no stream "' + p + '" (have: ' + cf.names().slice(0, 12).join(', ') + ')');
    if (e.type !== 2) crvFail('"' + p + '" is a storage, not a stream');
    if (e.size === 0) return new Uint8Array(0);
    if (e.size >= cf.miniCutoff) return cf.readChain(e.start, e.size);
    loadMini();
    const out = new Uint8Array(e.size);
    let s = e.start, got = 0;
    const seen = new Set();
    while (s !== CRV_ENDOFCHAIN && got < e.size) {
      if (s > CRV_MAXREGSECT || s >= minifat.length) crvFail('bad mini sector ' + s);
      if (seen.has(s)) crvFail('mini-FAT chain loops');
      seen.add(s);
      const off = s * cf.miniSectorSize;
      const n = Math.min(cf.miniSectorSize, e.size - got);
      out.set(miniStream.subarray(off, off + n), got);
      got += n;
      s = minifat[s];
    }
    return out;
  };
  return cf;
}

// ===========================================================================
// 2.  byte reader — everything little-endian and byte-packed
// ===========================================================================
function crvReader(u8, name) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    d: u8, dv: dv, p: 0, name: name || '<stream>',
    need(n) { if (this.p + n > u8.length) crvFail(this.name + ': read of ' + n + ' bytes past end of stream at ' + this.p + '/' + u8.length); },
    u8() { this.need(1); return u8[this.p++]; },
    u16() { this.need(2); const v = dv.getUint16(this.p, true); this.p += 2; return v; },
    u32() { this.need(4); const v = dv.getUint32(this.p, true); this.p += 4; return v; },
    i32() { this.need(4); const v = dv.getInt32(this.p, true); this.p += 4; return v; },
    f64() { this.need(8); const v = dv.getFloat64(this.p, true); this.p += 8; return v; },
    raw(n) { this.need(n); const v = u8.subarray(this.p, this.p + n); this.p += n; return v; },
    // u32-length-prefixed ASCII — used ONLY by the v>=8 provenance stamp;
    // every other string in this stream is an MFC wide string.
    astr() {
      const at = this.p;
      const n = this.u32();
      if (n > 256) crvFail(this.name + ': implausible ascii string length ' + n + ' at ' + at);
      return String.fromCharCode.apply(null, Array.from(this.raw(n)));
    },
    hex(n) { let s = ''; for (const b of this.raw(n)) s += (b < 16 ? '0' : '') + b.toString(16); return s; },
    guid() { return this.hex(16); },
    // MFC CStringW: FF FE FF <u8 len> <len UTF-16LE code units>, no terminator.
    wstr() {
      this.need(3);
      if (u8[this.p] !== 0xFF || u8[this.p + 1] !== 0xFE || u8[this.p + 2] !== 0xFF)
        crvFail(this.name + ': bad wide-string marker at ' + this.p);
      this.p += 3;
      let n = this.u8();
      if (n === 0xFF) { n = this.u16(); if (n === 0xFFFF) n = this.u32(); }
      this.need(2 * n);
      const cu = [];
      for (let k = 0; k < n; k++) cu.push(dv.getUint16(this.p + 2 * k, true));
      this.p += 2 * n;
      return String.fromCharCode.apply(null, cu);
    }
  };
}

// ===========================================================================
// 3.  geometry: spans, flattening, chaining
// ===========================================================================
// A span is {k:'span', type, x0,y0,z0, x1,y1,z1, bulge, c1x,c1y,c2x,c2y, tab}.
// `type` is the geometric primitive; `code` is the raw two-axis type code.

// Arc reconstruction from the DXF bulge convention: bulge = tan(sweep/4),
// positive = counter-clockwise.  The SIGN of h is what makes sweeps > 180°
// fall out correctly; getting it wrong bulges every corner outward.
function crvArcGeom(s) {
  if (s.type !== 'arc' || s.bulge === 0) return null;
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const chord = Math.hypot(dx, dy);
  if (chord === 0) return null;
  const sweep = 4 * Math.atan(s.bulge);
  const half = sweep / 2;
  const sn = Math.sin(half);
  if (sn === 0) return null;
  const r = Math.abs(chord / (2 * sn));
  const h = (chord / 2) / Math.tan(half);
  const cx = (s.x0 + s.x1) / 2 + h * (-dy / chord);
  const cy = (s.y0 + s.y1) / 2 + h * (dx / chord);
  return { cx, cy, r, a0: Math.atan2(s.y0 - cy, s.x0 - cx), sweep };
}

function crvSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L < 1e-15) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / L;
}

// Adaptive de Casteljau subdivision; appends the points AFTER p0.
function crvFlattenBezier(p0, p1, p2, p3, tol, depth, out) {
  if (depth <= 0 || (crvSegDist(p1[0], p1[1], p0[0], p0[1], p3[0], p3[1]) <= tol &&
                     crvSegDist(p2[0], p2[1], p0[0], p0[1], p3[0], p3[1]) <= tol)) {
    out.push(p3);
    return;
  }
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3);
  const p012 = m(p01, p12), p123 = m(p12, p23);
  const mid = m(p012, p123);
  crvFlattenBezier(p0, p01, p012, mid, tol, depth - 1, out);
  crvFlattenBezier(mid, p123, p23, p3, tol, depth - 1, out);
}

// Flattened points for one span, EXCLUDING its start point (chain friendly).
// `tol` is the chord deviation, in the file's own job units.
function crvSpanPoints(s, tol) {
  const end = [s.x1, s.y1];
  // A tab line is a straight 3-D segment (its XY projection is an ordinary
  // line: a lift or drop projects to zero length); a point span is degenerate.
  if (s.type === 'line' || s.type === 'tabline' || s.type === 'point') return [end];
  if (s.type === 'arc') {
    const a = crvArcGeom(s);
    if (!a || a.r <= 0) return [end];
    let step;
    if (tol <= 0 || tol >= a.r) step = Math.PI / 8;
    else { step = 2 * Math.acos(1 - tol / a.r); if (step <= 1e-12) step = Math.PI / 8; }
    let n = Math.ceil(Math.abs(a.sweep) / step);
    if (n < 2) n = 2;
    if (n > 100000) n = 100000;
    const out = [];
    for (let i = 1; i <= n; i++) {
      const ang = a.a0 + a.sweep * i / n;
      out.push([a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang)]);
    }
    out[out.length - 1] = end;
    return out;
  }
  if (s.type === 'bezier') {
    const out = [];
    crvFlattenBezier([s.x0, s.y0], [s.c1x, s.c1y], [s.c2x, s.c2y], end, tol, 20, out);
    out[out.length - 1] = end;
    return out;
  }
  crvFail('cannot flatten span type "' + s.type + '"');
}

// Head-to-tail continuity is an invariant of the format (observed gap 0.0
// over 31.5 M spans).  A gap means we mis-framed the stream, so refuse.
function crvCheckChain(c) {
  const sp = c.spans;
  if (!sp.length) { c.closed = false; c.chainGap = 0; return; }
  let worst = 0;
  for (let i = 0; i + 1 < sp.length; i++) {
    const a = sp[i], b = sp[i + 1];
    let g = Math.hypot(a.x1 - b.x0, a.y1 - b.y0);
    g = Math.max(g, Math.abs(a.z1 - b.z0));
    if (g > worst) worst = g;
  }
  if (worst > CRV_CHAIN_TOL)
    crvFail('contour spans do not chain: max gap ' + worst + ' > ' + CRV_CHAIN_TOL +
            ' (refusing to emit unsafe geometry)');
  c.chainGap = worst;
  // There is no stored "closed" flag: closedness is geometric.
  c.closeGap = Math.hypot(sp[sp.length - 1].x1 - sp[0].x0, sp[sp.length - 1].y1 - sp[0].y0);
  c.closed = c.closeGap <= CRV_CHAIN_TOL;
}

function crvContourPolyline(c, tol) {
  if (!c.spans.length) return [];
  const pts = [[c.spans[0].x0, c.spans[0].y0]];
  for (const s of c.spans) for (const p of crvSpanPoints(s, tol)) pts.push(p);
  return pts;
}

function crvContourBBox(c, tol) {
  const p = crvContourPolyline(c, tol);
  if (!p.length) return null;
  let b = [p[0][0], p[0][1], p[0][0], p[0][1]];
  for (const q of p) {
    if (q[0] < b[0]) b[0] = q[0];
    if (q[1] < b[1]) b[1] = q[1];
    if (q[0] > b[2]) b[2] = q[0];
    if (q[1] > b[3]) b[3] = q[1];
  }
  return b;
}

function crvNewContour() {
  return { k: 'contour', version: 0, spans: [], closed: false, chainGap: 0,
           tolerance: 0, sourceGuid: null, linkGuids: [], origin: null };
}

// ===========================================================================
// 4.  MFC CArchive object graph
// ===========================================================================
// CArchive keeps a 1-based load array whose counter increments for EVERY class
// AND EVERY object, in the order they appear.  Counting only objects (or only
// classes) desynchronises every back-reference later in the stream.
const CRV_KNOWN_CLASSES = [
  'vcCadLayer', 'vcCadPolyline', 'vcCadContour', 'vcCadObjectGroup',
  'vcCadSheet', 'vdContour', 'vdLineSpan', 'vdArcSpan', 'vdBezierSpan',
  'vdTabLineSpan', 'vdSpan',
  'utParameterList', 'utParameter', 'vcToolpathTab', 'vdContourGroup',
  'vcCadToolpathPreview', 'vcCadModelPreview', 'vcCadBitmap',
  'txtBlock', 'txtLine', 'txtWord', 'txtChar', 'txtBaseCurve'
];
const CRV_LAYER_VERSIONS = [4];
const CRV_CADOBJ_VERSIONS = [5, 7, 8, 10];
const CRV_CONTOUR_VERSIONS = [3, 6, 7];
const CRV_CONTOURGROUP_VERSIONS = [3];
const CRV_STREAM_VERSIONS = [1, 2];
const CRV_MATERIAL_VERSIONS = [5, 7, 8];
const CRV_SPAN_VERSION = 2;
const CRV_PARAMLIST_VERSION = 1;
const CRV_PARAM_VERSION = 2;
const CRV_TAB_VERSION = 1;
const CRV_TXTLINE_VERSION = 1;
const CRV_TXTWORD_VERSION = 1;
const CRV_TXTCHAR_VERSION = 3;
const CRV_TXTBASE_VERSION = 1;
// _txtAL_text_justify values whose line-origin rule has been validated against
// the files' own preview rasters. A census of every txtBlock in all 5,977
// archive files finds only 0 and 2; anything else raises, because a wrong
// origin silently moves real cutting geometry.
const CRV_JUSTIFY_VALIDATED = [0, 2];
// The span type code inside the body is TWO enums at once: a geometric
// primitive family and the span's toolpath ROLE.  Every code is a line, an
// arc, a cubic or a degenerate point — there is no new geometry — and codes
// 5, 7, 8, 9, 11, 12 occur only inside a vcCadToolpathPreview, which is
// consumed and discarded.  Codes 2, 3, 4, 10 and >= 13 have never been seen
// anywhere and raise.
const CRV_SPAN_TYPE_BY_CODE = { 0: 'arc', 1: 'line', 5: 'point', 6: 'bezier',
                                7: 'tabline', 8: 'line', 9: 'line',
                                11: 'arc', 12: 'arc' };
const CRV_SPAN_ROLE_BY_CODE = { 0: 'cut', 1: 'cut', 5: 'plunge point', 6: 'cut',
                                7: 'tab ramp', 8: 'lead-in', 9: 'lead-out',
                                11: 'lead-in', 12: 'lead-out' };
// The 1-byte inline discriminator (and, in the .crv dialect, the MFC class
// name) names only the FAMILY, so it is coarser than the body code and must
// be checked as SET MEMBERSHIP, never for equality.
const CRV_INLINE_TYPE_BY_CODE = { 0: 'line', 1: 'arc', 2: 'bezier', 3: 'tabline' };
const CRV_SPAN_FAMILY_KINDS = { line: ['line', 'point'], arc: ['arc'],
                                bezier: ['bezier'], tabline: ['tabline'] };
// vdTabLineSpan's leading u32: constant 2 in all 294,091 observed tab spans.
// It is NOT a count (three doubles follow either way), so a different value
// would make the record's width unknowable — refuse it.
const CRV_TABLINE_MODE = 2;
const CRV_DBL_MAX = 1.7976931348623157e308;
const CRV_NULL_GUID = '00000000000000000000000000000000';
// The cached anchor is compared against a bbox flattened FINELY: both sides
// approximate a curve's extremum, and at the drawing tolerance a cubic's
// bbox falls short of the true one by more than 1e-6.
const CRV_ANCHOR_FLATTEN_TOL = 1e-7;
const CRV_ANCHOR_TOL = 1e-5;

// MFC tag constants. THE TRAP: `~wClassTag` masks off bit 15, so the ordinary
// new-class tag 0xFFFF decodes to 0x80007FFF — the sentinel AFTER decoding is
// 0x7FFF, not 0xFFFF, and it is the same constant as the 32-bit escape tag.
const CRV_W_BIG_OBJECT = 0x7FFF;      // escape: a u32 tag follows
const CRV_W_CLASS_TAG = 0x8000;
const CRV_NEW_CLASS_IDX = 0x7FFF;     // decoded index meaning "new class descriptor"
const CRV_DW_BIG_CLASS = 0x80000000;

function crvArchive(u8) {
  const ar = { r: crvReader(u8, '2dDataV2'), slots: [null], classesSeen: [], bigTags: 0 };
  ar.add = function (kind, val) { ar.slots.push([kind, val]); return ar.slots.length - 1; };
  ar.resolveClass = function (idx, where) {
    if (idx < 1 || idx >= ar.slots.length)
      crvFail('bad class back-reference ' + idx + ' at ' + where + ' (map has ' + (ar.slots.length - 1) + ')');
    const e = ar.slots[idx];
    if (e[0] !== 'class') crvFail('back-reference ' + idx + ' at ' + where + ' is an object, expected a class');
    return e[1];
  };
  // CArchive::ReadObject / ReadClass, transcribed from MFC arccore.cpp.
  ar.readTag = function () {
    const r = ar.r;
    const tag = r.u16();
    if (tag === CRV_W_BIG_OBJECT) { ar.bigTags++; return r.u32(); }
    return ((tag & CRV_W_CLASS_TAG) * 65536) + (tag & ~CRV_W_CLASS_TAG);
  };
  // Class name of the next object tag, without consuming anything.
  ar.peekClassName = function () {
    const save = ar.r.p, saveBig = ar.bigTags;
    try {
      const obtag = ar.readTag();
      if (!(obtag & CRV_DW_BIG_CLASS)) return null;
      const idx = obtag & ~CRV_DW_BIG_CLASS;
      if (idx === CRV_NEW_CLASS_IDX) {
        ar.r.u16();
        const n = ar.r.u16();
        return String.fromCharCode.apply(null, Array.from(ar.r.raw(n)));
      }
      return ar.resolveClass(idx, ar.r.p - 2)[0];
    } catch (e) { return null; } finally { ar.r.p = save; ar.bigTags = saveBig; }
  };
  ar.readObject = function (expect) {
    const r = ar.r;
    const at = r.p;
    const obtag = ar.readTag();
    if (!(obtag & CRV_DW_BIG_CLASS)) {
      if (obtag === 0) return null;                        // NULL pointer
      if (obtag >= ar.slots.length) crvFail('bad object back-reference ' + obtag + ' at ' + at);
      const e = ar.slots[obtag];
      if (e[0] !== 'obj') crvFail('object back-reference ' + obtag + ' at ' + at + ' points at a class');
      return e[1];
    }
    const idx = obtag & ~CRV_DW_BIG_CLASS;
    let name;
    if (idx === CRV_NEW_CLASS_IDX) {                        // new class descriptor
      r.u16();                                              // schema, always 1
      const nlen = r.u16();
      if (nlen === 0 || nlen > 128) crvFail('implausible class-name length ' + nlen + ' at ' + (r.p - 2));
      name = String.fromCharCode.apply(null, Array.from(r.raw(nlen)));
      if (CRV_KNOWN_CLASSES.indexOf(name) < 0)
        crvFail('unknown serialised class "' + name + '" at offset ' + at +
                ' — refusing to guess its layout (there is no length prefix to skip it by)');
      ar.add('class', [name, 1]);
      ar.classesSeen.push(name);
    } else {
      name = ar.resolveClass(idx, at)[0];
    }
    const obj = crvClassReaders[name](ar);
    if (expect && name !== expect) crvFail('expected a ' + expect + ' at ' + at + ', found ' + name);
    return obj;
  };
  return ar;
}

// --- vcCadLayer ------------------------------------------------------------
function crvReadLayer(ar) {
  const r = ar.r;
  const L = { k: 'layer', name: '', guid: null, version: 0, roots: [], objects: [], discarded: [] };
  ar.add('obj', L);
  L.version = r.u32();
  if (CRV_LAYER_VERSIONS.indexOf(L.version) < 0)
    crvFail('vcCadLayer version ' + L.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  L.guid = r.guid();
  L.name = r.wstr();
  r.raw(10);                                    // UNKNOWN, 00×9 01 in every sample
  const n = r.u32();
  if (n > 1000000) crvFail('implausible object count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) {
    const o = ar.readObject();
    if (o === null) crvFail('NULL object inside layer "' + L.name + '"');
    if (o.k !== 'cadobj') crvFail('layer "' + L.name + '" holds a ' + o.k + ', expected a drawing object');
    L.roots.push(o);
  }
  r.raw(3);                                     // UNKNOWN visibility/lock trailer
  (function flat(list) {
    for (const o of list) {
      // Machine-generated geometry (toolpath previews) was parsed byte-exactly
      // — the only way the stream stays in sync — but is NOT drawing geometry.
      if (o.discard) { L.discarded.push(o); continue; }
      if (o.cls === 'vcCadObjectGroup' || o.cls === 'vcCadModelPreview' || o.cls === 'vcCadBitmap') {
        flat(o.children);
        continue;
      }
      L.objects.push(o);
    }
  })(L.roots);
  return L;
}

// --- the "Vectric__Version" provenance block of object version >= 8 --------
// 64 bytes: u32 len=16, "Vectric__Version", u32 = 1, u32 len=36, 36-char UUID.
// The key is checked: a different property here would mean a different layout.
function crvReadStamp(r) {
  const at = r.p;
  const key = r.astr();
  if (key !== 'Vectric__Version')
    crvFail('expected the Vectric__Version provenance block at ' + at + ', found "' + key +
            '" — not reverse-engineered');
  const mid = r.u32();
  return [key, mid, r.astr()];
}

// --- common vcCad* object header -------------------------------------------
// The field after the `i32 -1` is an MFC object POINTER to a utParameterList,
// not a fixed u32 + u16. A NULL pointer is the two bytes 00 00, which is why
// the wrong split summed to the right size in every file that never stored a
// per-object parameter — and why it broke 470 real files that did.
function crvReadCadObjHead(ar, cls) {
  const r = ar.r;
  const o = { k: 'cadobj', cls: cls, version: 0, guid: null, layerGuid: null,
              ownerGuid: null, contours: [], children: [], anchor: null, ordinal: 0,
              params: null, stamp: null, tabs: [], discard: false,
              discardedContours: [], text: null, objKind: 0, unknown: {} };
  ar.add('obj', o);
  o.version = r.u32();
  if (CRV_CADOBJ_VERSIONS.indexOf(o.version) < 0)
    crvFail(cls + ' version ' + o.version + ' at ' + (r.p - 4) +
            ' is not reverse-engineered (refusing to guess its layout)');
  o.guid = r.guid();
  o.layerGuid = r.guid();                 // the layer this object BELONGS to
  o.unknown.a0 = r.u32();                 // 0 on drawing objects; 0x9696C8 on a
                                          // toolpath preview (Vectric's preview pink)
  r.u32();                                // UNKNOWN 0
  r.u32(); r.u32();                       // UNKNOWN 0x82, 0x2A — colour/style?
  o.ordinal = r.u32();                    // z-order or creation ordinal?
  r.i32();                                // UNKNOWN -1
  const at = r.p;
  o.params = ar.readObject();             // utParameterList pointer, may be NULL
  if (o.params !== null && o.params.k !== 'paramlist')
    crvFail(cls + ': header pointer at ' + at + ' resolves to a ' + o.params.k +
            ', expected a utParameterList');
  if (o.version < 6) {
    r.u32();                              // UNKNOWN 0
  } else {
    if (o.version < 10) r.u32();          // UNKNOWN 0 — versions 6..8 only
    r.u32();                              // UNKNOWN 0 or 1
    const ax = r.f64(), ay = r.f64();
    o.anchor = (ax === CRV_DBL_MAX || ay === CRV_DBL_MAX) ? null : [ax, ay];
    if (o.version >= 8) {
      o.stamp = crvReadStamp(r);          // replaces the v6/v7 u32
      if (o.version >= 10) {
        r.u32();                          // UNKNOWN 1
        for (let i = 0; i < 4; i++) r.f64();   // bounding box, ±DBL_MAX when unset
        for (let i = 0; i < 9; i++) r.f64();   // 3×3 matrix, identity in both samples
        crvReadStamp(r);                  // a second provenance block
      }
    } else {
      r.u32();                            // UNKNOWN 0 — v6/v7 only
    }
  }
  o.objKind = r.u32();  // 1 group, 2 curve, 4 text/toolpath preview, 5 model preview
  return o;
}

// Trailer of vcCadContour / vcCadPolyline, ALL versions: the machining-tab
// list. Contours nested in a vdContourGroup (glyph outlines, toolpath
// previews) have no owning curve object and so carry no tab count at all.
function crvReadCurveTail(ar, o) {
  const r = ar.r;
  const n = r.u32();
  if (n > 10000) crvFail('implausible toolpath-tab count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) o.tabs.push(ar.readObject('vcToolpathTab'));
  if (o.cls === 'vcCadPolyline') r.u32();   // the sole structural difference
}

function crvReadCurveObj(ar, cls) {
  const o = crvReadCadObjHead(ar, cls);
  if (o.objKind !== 2) crvFail(cls + ' with kind ' + o.objKind + ' (expected 2)');
  const c = ar.readObject('vdContour');   // exactly ONE contour per curve object
  if (c) { c.origin = 'drawing'; o.contours.push(c); }
  crvReadCurveTail(ar, o);
  return o;
}

function crvReadGroup(ar) {
  const r = ar.r;
  const o = crvReadCadObjHead(ar, 'vcCadObjectGroup');
  if (o.objKind !== 1) crvFail('vcCadObjectGroup with kind ' + o.objKind + ' (expected 1)');
  const n = r.u32();
  if (n > 1000000) crvFail('implausible group child count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) {
    const c = ar.readObject();
    if (c === null) crvFail('NULL child in vcCadObjectGroup');
    o.children.push(c);
  }
  return o;                                // groups have no trailer
}

// --- the span record -------------------------------------------------------
// Identical body in both dialects; only the framing differs (an MFC tag in
// .crv, a 1-byte discriminator in .crv3d).
function crvSpanBody(ar, family) {
  const r = ar.r;
  const at = r.p;
  const ver = r.u32();
  if (ver !== CRV_SPAN_VERSION) crvFail('span version ' + ver + ' at ' + at + ' (expected ' + CRV_SPAN_VERSION + ')');
  const code = r.u32();
  const type = CRV_SPAN_TYPE_BY_CODE[code];
  if (!type) crvFail('unknown span type code ' + code + ' at ' + (r.p - 4) + ' — refusing to guess its payload');
  if (family && CRV_SPAN_FAMILY_KINDS[family].indexOf(type) < 0)
    crvFail('span framing says ' + family + ' but body type code ' + code + ' says ' + type + ' at ' + at);
  const s = { k: 'span', type: type, code: code, role: CRV_SPAN_ROLE_BY_CODE[code],
              bulge: 0, c1x: 0, c1y: 0, c2x: 0, c2y: 0, tab: null };
  s.x0 = r.f64(); s.y0 = r.f64(); s.z0 = r.f64();
  s.x1 = r.f64(); s.y1 = r.f64(); s.z1 = r.f64();
  // Code 5 is the ONLY span with no trailing u32 flag: its body is 48 bytes,
  // pinned by the vdContour tail that starts immediately after it.
  if (code !== 5) r.u32();
  if (type === 'tabline') {
    const mode = r.u32();
    if (mode !== CRV_TABLINE_MODE)
      crvFail('vdTabLineSpan leading u32 = ' + mode + ' (expected ' + CRV_TABLINE_MODE + ') at ' +
              (r.p - 4) + ' — refusing to guess the record width');
    s.tab = [mode, r.f64(), r.f64(), r.f64()];   // (2, tabZ, 1.0, 1.0)
  } else if (type === 'arc') {
    s.bulge = r.f64();                            // DXF bulge = tan(sweep/4)
  } else if (type === 'bezier') {
    s.c1x = r.f64(); s.c1y = r.f64(); s.c2x = r.f64(); s.c2y = r.f64();
  }
  return s;
}

// A span written as a full MFC object (.crv dialect). The class name names the
// primitive FAMILY exactly as the inline discriminator does — vdLineSpan
// carries body codes 1, 8 and 9 — so it is cross-checked the same way. The
// span claims its index slot BEFORE its body is read.
function crvReadSpanObject(ar, family) {
  const slot = ar.add('obj', null);
  const s = crvSpanBody(ar, family);
  ar.slots[slot] = ['obj', s];
  return s;
}

function crvReadVdContour(ar) {
  const r = ar.r;
  const c = crvNewContour();
  ar.add('obj', c);
  c.version = r.u32();
  if (CRV_CONTOUR_VERSIONS.indexOf(c.version) < 0)
    crvFail('vdContour version ' + c.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  r.u32();                 // UNKNOWN 0xFFFFFFFF, sometimes 0
  c.tolerance = r.f64();
  r.raw(10);               // UNKNOWN
  const n = r.u32();
  if (n > 5000000) crvFail('implausible span count ' + n + ' at ' + (r.p - 4));
  if (c.version >= 6) {
    for (let i = 0; i < n; i++) {
      const disc = r.u8();
      const family = CRV_INLINE_TYPE_BY_CODE[disc];
      if (!family) crvFail('unknown inline span discriminator ' + disc + ' at ' + (r.p - 1));
      c.spans.push(crvSpanBody(ar, family));
    }
  } else {
    for (let i = 0; i < n; i++) {
      const s = ar.readObject();
      if (!s || s.k !== 'span') crvFail('vdContour holds a ' + (s && s.k) + ' where a span was expected');
      c.spans.push(s);
    }
  }
  c.sourceGuid = r.guid();
  r.u32();                 // UNKNOWN 0xFFFFFFFF, or 0
  if (c.version >= 6) {
    // A count of link GUIDs, not a constant 0. The u32 an earlier reading took
    // from here is the tab count and belongs to the owning curve object.
    const nlk = r.u16();
    if (nlk > 4096) crvFail('implausible vdContour link-guid count ' + nlk + ' at ' + (r.p - 2));
    for (let i = 0; i < nlk; i++) c.linkGuids.push(r.guid());
  }
  crvCheckChain(c);
  return c;
}

// vcCadSheet is the last record and carries no vector geometry; reaching its
// tag is the end-of-stream check, so its body is deliberately not decoded.
function crvReadSheet(ar) {
  const o = { k: 'cadobj', cls: 'vcCadSheet', contours: [], children: [], version: 0,
              tabs: [], discard: false, discardedContours: [], params: null, unknown: {} };
  ar.add('obj', o);
  return o;
}

// --- the per-object property bag -------------------------------------------
function crvReadParamList(ar) {
  const r = ar.r;
  const pl = { k: 'paramlist', version: 0, params: [], map: {} };
  ar.add('obj', pl);
  pl.version = r.u32();
  if (pl.version !== CRV_PARAMLIST_VERSION)
    crvFail('utParameterList version ' + pl.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  const n = r.u32();
  if (n > 100000) crvFail('implausible parameter count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) {
    const p = ar.readObject('utParameter');
    pl.params.push(p);
    pl.map[p.name] = p.value;
  }
  return pl;
}

function crvReadParam(ar) {
  const r = ar.r;
  const p = { k: 'param', version: 0, name: null, type: 0, value: null };
  ar.add('obj', p);
  p.version = r.u32();
  if (p.version !== CRV_PARAM_VERSION)
    crvFail('utParameter version ' + p.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  p.name = r.wstr();
  const at = r.p;
  p.type = r.u32();
  if (p.type === 0) p.value = r.f64();
  else if (p.type === 1) p.value = r.i32();
  else if (p.type === 2) p.value = !!r.u8();
  else if (p.type === 3) p.value = r.wstr();
  else if (p.type === 4) p.value = r.guid();   // raw Windows GUID (_template_uuid)
  else crvFail('utParameter "' + p.name + '" payload type ' + p.type + ' at ' + at +
               ' — refusing to guess its width');
  return p;
}

// --- machining tabs (bridges) ----------------------------------------------
function crvReadTab(ar) {
  const r = ar.r;
  const t = { k: 'tab', version: 0, spanIndex: 0, t: 0 };
  ar.add('obj', t);
  t.version = r.u32();
  if (t.version !== CRV_TAB_VERSION)
    crvFail('vcToolpathTab version ' + t.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  t.spanIndex = r.u32();
  t.t = r.f64();
  r.u32();                 // UNKNOWN 1 in every observed tab
  return t;
}

// --- vdContourGroup: a bare list of contours with no object identity -------
function crvReadContourGroup(ar) {
  const r = ar.r;
  const g = { k: 'contourgroup', version: 0, contours: [] };
  ar.add('obj', g);
  g.version = r.u32();
  if (CRV_CONTOURGROUP_VERSIONS.indexOf(g.version) < 0)
    crvFail('vdContourGroup version ' + g.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  const n = r.u32();
  if (n > 100000) crvFail('implausible contour count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) g.contours.push(ar.readObject('vdContour'));
  r.u8();                  // UNKNOWN 1
  r.guid();                // UNKNOWN GUID, all zero in every sample
  return g;
}

// --- vcCadToolpathPreview: consume exactly, then discard --------------------
// Machine-generated preview geometry of a calculated toolpath, on the
// auto-created "Toolpath Previews" layer — about 78% of files contain one. It
// is never drawing content, but there is no length prefix, so parsing it
// byte-exactly is the only way the stream stays in sync.
function crvReadToolpathPreview(ar) {
  const r = ar.r;
  const o = crvReadCadObjHead(ar, 'vcCadToolpathPreview');
  if (o.objKind !== 4) crvFail('vcCadToolpathPreview with kind ' + o.objKind + ' (expected 4)');
  r.guid();                                    // UNKNOWN toolpath GUID
  const g = ar.readObject('vdContourGroup');
  r.raw(15);                                   // UNKNOWN trailer: f64 + 7 bytes
  o.discard = true;
  for (const c of g.contours) c.origin = 'toolpath-preview';
  o.discardedContours = g.contours.slice();
  return o;
}

// --- vcCadModelPreview / vcCadBitmap: LZMA1-compressed 8-bit BMP -----------
// The two records are byte-for-byte identical except that vcCadBitmap ends 20
// bytes earlier. The raster is skipped; the nested outline is decoded, kept
// and tagged by role so a consumer can filter it.
function crvReadModelPreview(ar, cls) {
  const r = ar.r;
  const o = crvReadCadObjHead(ar, cls);
  if (o.objKind !== 5) crvFail(cls + ' with kind ' + o.objKind + ' (expected 5)');
  r.u8();                                      // UNKNOWN 1 / 0
  const at = r.p;
  const child = ar.readObject();
  if (child === null || child.k !== 'cadobj') crvFail(cls + ': expected a drawing object at ' + at);
  o.children.push(child);
  const role = cls === 'vcCadBitmap' ? 'bitmap-frame' : 'model-preview';
  for (const c of child.contours) c.origin = role;
  r.u8(); r.u32(); r.u32();                    // UNKNOWN 1, 1, 0
  r.u32();                                     // uncompressed BMP size
  let n = r.u32();
  if (n > 64) crvFail('implausible LZMA property length ' + n + ' at ' + (r.p - 4));
  r.raw(n);                                    // LZMA properties
  n = r.u32();
  if (n > r.d.length) crvFail('implausible LZMA payload length ' + n + ' at ' + (r.p - 4));
  r.raw(n);                                    // LZMA1 stream (skipped)
  r.raw(1024);                                 // 256-entry RGBA palette
  r.u32(); r.u32(); r.wstr(); r.u32(); r.u8(); // UNKNOWN scalars
  if (cls !== 'vcCadBitmap') { r.u32(); r.guid(); }   // 20 further bytes
  return o;
}

// ===========================================================================
// 4b.  vector text
// ===========================================================================
function crvReadTxtChar(ar) {
  const r = ar.r;
  const ch = { k: 'txtchar', version: 0, code: 0, advance: 0, group: null };
  ar.add('obj', ch);
  ch.version = r.u32();
  if (ch.version !== CRV_TXTCHAR_VERSION)
    crvFail('txtChar version ' + ch.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  ch.code = r.u32();
  r.wstr();                                    // serialised LOGFONT + metrics
  ch.advance = r.f64();
  ch.group = ar.readObject('vdContourGroup');  // THE GLYPH OUTLINES
  for (let i = 0; i < 7; i++) r.f64();         // UNKNOWN beyond [0]
  for (const c of ch.group.contours) c.origin = 'text-glyph';
  return ch;
}

// txtWord has NO trailer: the f64 + wstr + doubles belong to txtLine, and the
// u32 = 0xFFFFFFFF belongs to the block. Both readings sum to the same total
// when there is exactly one word on one line, which is why a single-word
// corpus could not tell them apart.
function crvReadTxtWord(ar) {
  const r = ar.r;
  const w = { k: 'txtword', version: 0, chars: [] };
  ar.add('obj', w);
  w.version = r.u32();
  if (w.version !== CRV_TXTWORD_VERSION)
    crvFail('txtWord version ' + w.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  const n = r.u32();
  if (n > 100000) crvFail('implausible character count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) w.chars.push(ar.readObject('txtChar'));
  return w;
}

function crvReadTxtLine(ar) {
  const r = ar.r;
  const ln = { k: 'txtline', version: 0, words: [], pitch: 0 };
  ar.add('obj', ln);
  ln.version = r.u32();
  if (ln.version !== CRV_TXTLINE_VERSION)
    crvFail('txtLine version ' + ln.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  const n = r.u32();
  if (n > 100000) crvFail('implausible word count ' + n + ' at ' + (r.p - 4));
  for (let i = 0; i < n; i++) ln.words.push(ar.readObject('txtWord'));
  // The line PITCH, measured from the PREVIOUS line's baseline (0.0 on the
  // first line) — a running sum, not an absolute drop.
  ln.pitch = r.f64();
  r.wstr();                                    // font descriptor (duplicate)
  for (let i = 0; i < 4; i++) r.f64();         // UNKNOWN, all four equal
  return ln;
}

function crvReadTxtBaseCurve(ar) {
  const r = ar.r;
  const b = { k: 'txtbase', version: 0, contour: null, f: [] };
  ar.add('obj', b);
  b.version = r.u32();
  if (b.version !== CRV_TXTBASE_VERSION)
    crvFail('txtBaseCurve version ' + b.version + ' at ' + (r.p - 4) + ' is not reverse-engineered');
  b.contour = ar.readObject('vdContour');
  b.contour.origin = 'text-baseline';
  r.u32(); r.u32(); r.u8();                    // UNKNOWN 2, 1, 1
  for (let i = 0; i < 19; i++) b.f.push(r.f64());
  return b;
}

function crvMatMul(A, B) {
  const out = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[3 * i + k] * B[3 * k + j];
    out.push(s);
  }
  return out;
}

// (M, bx, by) mapping a glyph point into drawing coordinates:
//   world = M · (glyphPoint + (glyphOffset, lineBaseline) + baselineMidPoint)
// f[0:9] is the row-major matrix, f[9:18] its stored inverse; the product is
// checked against the identity, a free consistency test on the whole reading.
function crvTxtFrame(base) {
  const M = base.f.slice(0, 9), INV = base.f.slice(9, 18);
  const prod = crvMatMul(M, INV);
  const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let err = 0;
  for (let i = 0; i < 9; i++) err = Math.max(err, Math.abs(prod[i] - ident[i]));
  if (err > 1e-6)
    crvFail('txtBaseCurve matrix and its stored inverse do not multiply to the identity ' +
            '(max error ' + err + ') — refusing to place glyphs');
  const sp = base.contour.spans;
  if (!sp.length) crvFail('txtBaseCurve has an empty baseline contour');
  return { M: M, bx: (sp[0].x0 + sp[sp.length - 1].x1) / 2, by: (sp[0].y0 + sp[sp.length - 1].y1) / 2 };
}

// Affine image of a glyph contour in drawing coordinates.
function crvXfContour(c, M, dx, bx, by, dy) {
  const a = M[0], b = M[1], cc = M[3], d = M[4];
  const det = a * d - b * cc;
  const sim = (Math.abs(a - d) <= 1e-9 * Math.max(1, Math.abs(a)) &&
               Math.abs(b + cc) <= 1e-9 * Math.max(1, Math.abs(b))) ||
              (Math.abs(a + d) <= 1e-9 * Math.max(1, Math.abs(a)) &&
               Math.abs(b - cc) <= 1e-9 * Math.max(1, Math.abs(b)));
  const pt = (x, y) => {
    const X = x + dx + bx, Y = y + dy + by;
    return [M[0] * X + M[1] * Y + M[2], M[3] * X + M[4] * Y + M[5]];
  };
  const out = crvNewContour();
  out.version = c.version;
  out.tolerance = c.tolerance;
  out.origin = 'text-glyph';
  for (const sp of c.spans) {
    const p0 = pt(sp.x0, sp.y0), p1 = pt(sp.x1, sp.y1);
    const ns = { k: 'span', type: sp.type, code: sp.code, role: sp.role,
                 x0: p0[0], y0: p0[1], z0: sp.z0, x1: p1[0], y1: p1[1], z1: sp.z1,
                 bulge: 0, c1x: 0, c1y: 0, c2x: 0, c2y: 0, tab: sp.tab };
    if (sp.type === 'bezier') {
      const q1 = pt(sp.c1x, sp.c1y), q2 = pt(sp.c2x, sp.c2y);
      ns.c1x = q1[0]; ns.c1y = q1[1]; ns.c2x = q2[0]; ns.c2y = q2[1];
    } else if (sp.type === 'arc') {
      // A bulge only survives a similarity transform. Every glyph outline in
      // the corpus is lines + cubics, so this path has never been exercised —
      // refuse rather than emit an ellipse as a circle.
      if (!sim) crvFail('text glyph carries an arc span under a non-similarity matrix — ' +
                        'refusing to guess its image');
      ns.bulge = det < 0 ? -sp.bulge : sp.bulge;
    }
    out.spans.push(ns);
  }
  crvCheckChain(out);
  return out;
}

// Pen x of the first glyph cell of a line, in the block's local frame.
function crvLineOrigin(total, just, leftX) {
  if (just === 0) return leftX;                // left: the baseline's START point
  if (just === 2) return -total / 2;           // centre: about the baseline midpoint
  crvFail('text justification ' + JSON.stringify(just) + ' is not reverse-engineered ' +
          '(only ' + CRV_JUSTIFY_VALIDATED.join(' and ') + ' occur in the whole archive) ' +
          '— refusing to place glyphs');
}

// txtBlock — engraved/vector text. It carries the REAL glyph outlines, one
// vdContour per closed loop, in a local frame: there is no sibling contour
// object, so this is the only copy of the vector text and it is emitted.
function crvReadTxtBlock(ar) {
  const r = ar.r;
  const o = crvReadCadObjHead(ar, 'txtBlock');
  if (o.objKind !== 4) crvFail('txtBlock with kind ' + o.objKind + ' (expected 4)');
  const n = r.u32();
  if (n > 100000) crvFail('implausible line count ' + n + ' at ' + (r.p - 4));
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(ar.readObject('txtLine'));
  r.f64(); r.f64(); r.u32();                   // the BLOCK's trailer, not the last line's
  const base = ar.readObject('txtBaseCurve');
  const fr = crvTxtFrame(base);
  const leftX = base.contour.spans[0].x0 - fr.bx;
  const pm = o.params ? o.params.map : {};
  const just = pm._txtAL_text_justify;
  o.text = { text: pm._txtAL_Text, font: pm._txtAL_font_name, height: pm._txtAL_height,
             justify: just, lines: lines.length, chars: 0 };
  // A LINE is one pen run. A space is its own single-character txtWord with a
  // real advance and an EMPTY outline, so the words simply concatenate and
  // inter-word spacing needs no rule of its own. Each glyph is stored centred
  // on its own origin, at the centre of its advance cell.
  let baselineY = 0;
  for (const ln of lines) {
    const chars = [];
    for (const w of ln.words) for (const ch of w.chars) chars.push(ch);
    let total = 0;
    for (const ch of chars) total += ch.advance;
    baselineY -= ln.pitch;                     // pitch is cumulative
    let pen = crvLineOrigin(total, just, leftX);
    for (const ch of chars) {
      const dx = pen + ch.advance / 2;
      pen += ch.advance;
      for (const c of ch.group.contours) o.contours.push(crvXfContour(c, fr.M, dx, fr.bx, fr.by, baselineY));
      o.text.chars++;
    }
  }
  return o;
}

const crvClassReaders = {
  vcCadLayer: crvReadLayer,
  vcCadContour: (ar) => crvReadCurveObj(ar, 'vcCadContour'),
  vcCadPolyline: (ar) => crvReadCurveObj(ar, 'vcCadPolyline'),
  vcCadObjectGroup: crvReadGroup,
  vdContour: crvReadVdContour,
  vdContourGroup: crvReadContourGroup,
  vdLineSpan: (ar) => crvReadSpanObject(ar, 'line'),
  vdArcSpan: (ar) => crvReadSpanObject(ar, 'arc'),
  vdBezierSpan: (ar) => crvReadSpanObject(ar, 'bezier'),
  vdTabLineSpan: (ar) => crvReadSpanObject(ar, 'tabline'),
  vdSpan: (ar) => crvReadSpanObject(ar, 'line'),
  vcCadSheet: crvReadSheet,
  utParameterList: crvReadParamList,
  utParameter: crvReadParam,
  vcToolpathTab: crvReadTab,
  vcCadToolpathPreview: crvReadToolpathPreview,
  vcCadModelPreview: (ar) => crvReadModelPreview(ar, 'vcCadModelPreview'),
  vcCadBitmap: (ar) => crvReadModelPreview(ar, 'vcCadBitmap'),
  txtBlock: crvReadTxtBlock,
  txtLine: crvReadTxtLine,
  txtWord: crvReadTxtWord,
  txtChar: crvReadTxtChar,
  txtBaseCurve: crvReadTxtBaseCurve
};

// ===========================================================================
// 5.  stream level
// ===========================================================================
function crvParse2dData(u8) {
  const ar = crvArchive(u8);
  const r = ar.r;
  const streamVersion = r.u32();
  r.u32();                                   // UNKNOWN 3, 4 or 5 — tracks the app
  const nLayers = r.u32();
  if (CRV_STREAM_VERSIONS.indexOf(streamVersion) < 0)
    crvFail('2dDataV2 stream version ' + streamVersion + ' (expected one of ' + CRV_STREAM_VERSIONS.join(', ') + ')');
  if (nLayers > 100000) crvFail('implausible layer count ' + nLayers);
  const layers = [];
  for (let i = 0; i < nLayers; i++) {
    const L = ar.readObject('vcCadLayer');
    if (L === null) crvFail('NULL layer in 2dDataV2');
    layers.push(L);
  }
  let bbox = null;
  if (streamVersion >= 2) {
    // Stream version 2 uses a 24-byte document trailer, not the 120-byte one.
    r.guid(); r.u32(); r.u32();
  } else {
    r.u32();                                 // UNKNOWN 1
    bbox = [r.f64(), r.f64(), r.f64(), r.f64()];   // drawing extents
    r.u32(); r.u32();                        // UNKNOWN
    for (let i = 0; i < 9; i++) r.f64();     // 3×3 view matrix
    r.u32();                                 // UNKNOWN 1
  }
  // End-to-end check: the next tag must be the vcCadSheet record. If the
  // document trailer were mis-sized this would land on garbage.
  const nm = ar.peekClassName();
  if (nm !== 'vcCadSheet')
    crvFail('stream did not land on vcCadSheet after the document tail (found ' +
            JSON.stringify(nm) + ' at offset ' + r.p + ') — layout mismatch');
  return { layers: layers, streamVersion: streamVersion, bbox: bbox, bigTags: ar.bigTags,
           classes: ar.classesSeen };
}

// Version 5 is exactly 62 bytes; versions 7 and 8 append 298 / 372 bytes whose
// layout is UNKNOWN and deliberately not decoded — nothing after the job size
// is needed for geometry.
function crvParseMaterial(u8) {
  const r = crvReader(u8, 'MaterialSize');
  const ver = r.u32();
  if (CRV_MATERIAL_VERSIONS.indexOf(ver) < 0)
    crvFail('MaterialSize version ' + ver + ' (expected one of ' + CRV_MATERIAL_VERSIONS.join(', ') + ')');
  r.u8(); r.u8();
  const d = [];
  for (let i = 0; i < 7; i++) d.push(r.f64());
  return { thickness: Math.abs(d[2]), width: d[3], height: d[4] };
}

function crvParseVersionStream(u8) {
  try {
    const r = crvReader(u8, 'Version');
    r.u32();
    return { app: r.wstr().trim(), version: r.wstr().trim() };
  } catch (e) { return { app: null, version: null }; }
}

// ===========================================================================
// 6.  public entry point
// ===========================================================================
// Contour roles that are decoded but must NOT reach the drawing. A
// 'bitmap-frame' is an imported image's placement rectangle: VCarve draws the
// raster inside it and never strokes the frame, so importing it would add a
// rectangle the user never drew. ('model-preview' outlines ARE emitted, and
// toolpath previews never reach here at all.)
const CRV_SKIP_ORIGINS = ['bitmap-frame'];

// parseCrv(u8, opts) -> [{layer, type, pts:[{x,y},…], ent}] with jobSize/units.
function parseCrv(u8, opts) {
  opts = opts || {};
  const cfb = crvCfbOpen(u8);
  if (!cfb.exists('VectorData/2dDataV2'))
    crvFail('no VectorData/2dDataV2 stream — not a Vectric 2D drawing (streams: ' + cfb.names().join(', ') + ')');
  const doc = crvParse2dData(cfb.stream('VectorData/2dDataV2'));
  const layers = doc.layers;

  let job = { w: null, h: null, thickness: null };
  if (cfb.exists('VectorData/MaterialSize')) {
    const m = crvParseMaterial(cfb.stream('VectorData/MaterialSize'));
    job = { w: m.width, h: m.height, thickness: m.thickness };
  }
  const vinfo = cfb.exists('VersionData/Version')
    ? crvParseVersionStream(cfb.stream('VersionData/Version')) : { app: null, version: null };

  // ---- units. NO units flag exists anywhere in the container: verified by
  // diffing an inch file and a millimetre file written by the SAME Aspire
  // build (every stream but the geometry is byte identical). The downstream
  // pipeline is inches, so normalise here and record the provenance so the
  // caller can warn when the answer was a guess.
  let sourceUnits, unitsSource;
  const want = (opts.units || 'auto').toLowerCase();
  if (want === 'inch' || want === 'in') { sourceUnits = 'inch'; unitsSource = 'caller'; }
  else if (want === 'mm') { sourceUnits = 'mm'; unitsSource = 'caller'; }
  else if (want !== 'auto') crvFail('opts.units must be "inch", "mm" or "auto" (got ' + JSON.stringify(opts.units) + ')');
  else if (job.w && job.h && Math.max(job.w, job.h) > 300) { sourceUnits = 'mm'; unitsSource = 'heuristic:job>300'; }
  else { sourceUnits = 'inch'; unitsSource = 'assumed:no-flag-in-format'; }
  const k = sourceUnits === 'mm' ? 1 / CRV_MM_PER_IN : 1;

  // The flattening tolerance is given in inches; convert it to the file's own
  // job units so the chord deviation is the same physical distance either way.
  const tolIn = (opts.tol != null) ? opts.tol : CRV_DEFAULT_TOL;
  const tolJob = tolIn / k;

  // ---- layer membership. An object's layer_guid says which layer it BELONGS
  // to; the vcCadLayer record it is nested in says only where it is STORED. A
  // group stored under one layer legitimately holds children owned by another
  // — grouping in VCarve does not move a vector off its layer — so colouring
  // or filtering must follow the owner, never the storage layer.
  const layerByGuid = {};
  for (const L of layers) layerByGuid[L.guid] = L;
  let crossLayer = 0, staleRefs = 0, nullOwners = 0;
  for (const L of layers) {
    for (const o of L.objects) {
      o.ownerGuid = o.layerGuid;
      if (o.layerGuid === CRV_NULL_GUID) {
        // "No layer of its own" (the outline inside a vcCadModelPreview
        // carries one) — membership falls back to the storage layer.
        o.ownerGuid = L.guid; nullOwners++;
      } else if (o.layerGuid !== L.guid) {
        if (!layerByGuid[o.layerGuid]) { o.ownerGuid = L.guid; staleRefs++; }  // layer since deleted
        else crossLayer++;
      }
    }
  }

  const polys = [];
  const warnings = [];
  const contourVersions = {};
  let anchorOk = 0, anchorN = 0, anchorWorst = 0;
  let nTabs = 0, nText = 0, nPreviewObjs = 0, nPreviewContours = 0, nSkipped = 0;
  for (const L of layers) {
    nPreviewObjs += L.discarded.length;
    for (const o of L.discarded) nPreviewContours += o.discardedContours.length;
    for (const o of L.objects) {
      nTabs += o.tabs.length;
      if (o.cls === 'txtBlock') nText++;
      // The cached anchor equals the object's bbox centre; checking it is a
      // joint test of the header layout AND the span decode.
      if (o.anchor && o.cls !== 'txtBlock') {
        let b = null;
        for (const c of o.contours) {
          const cb = crvContourBBox(c, CRV_ANCHOR_FLATTEN_TOL);
          if (!cb) continue;
          b = b ? [Math.min(b[0], cb[0]), Math.min(b[1], cb[1]), Math.max(b[2], cb[2]), Math.max(b[3], cb[3])] : cb;
        }
        if (b) {
          anchorN++;
          const e = Math.max(Math.abs(o.anchor[0] - (b[0] + b[2]) / 2), Math.abs(o.anchor[1] - (b[1] + b[3]) / 2));
          if (e < CRV_ANCHOR_TOL) anchorOk++;
          else anchorWorst = Math.max(anchorWorst, e);
        }
      }
      const layerName = (layerByGuid[o.ownerGuid] || L).name;
      for (const c of o.contours) {
        contourVersions[c.version] = 1;
        if (CRV_SKIP_ORIGINS.indexOf(c.origin) >= 0) { nSkipped++; continue; }
        const raw = crvContourPolyline(c, tolJob);
        if (raw.length < 2) continue;
        const pts = raw.map(p => ({ x: p[0] * k, y: p[1] * k }));
        const ent = { type: 'LWPOLYLINE', layer: layerName, closed: c.closed,
                      source: 'crv', cls: o.cls, guid: o.guid, origin: c.origin || 'drawing',
                      contourVersion: c.version, spans: c.spans.length, chainGap: c.chainGap };
        ent.spanEnds = c.spans.map(s => ({ x: s.x1 * k, y: s.y1 * k, type: s.type })); ent.start = c.spans.length ? { x: (c.spans[0].x0 != null ? c.spans[0].x0 : pts[0].x / k) * k, y: (c.spans[0].y0 != null ? c.spans[0].y0 : pts[0].y / k) * k } : null;
        polys.push({ layer: layerName, type: 'LWPOLYLINE', pts: pts, ent: ent });
      }
    }
  }
  // A stale cached anchor is a known property of the files themselves (VCarve
  // does not always refresh it), so a single mismatch is a warning. A
  // SYSTEMATIC disagreement is a decode error — it misplaces a whole class of
  // objects at once — and still fails.
  if (anchorN >= 4 && anchorOk === 0)
    crvFail('every one of the ' + anchorN + ' cached object anchors disagrees with the decoded ' +
            'geometry (worst ' + anchorWorst + ') — the header layout or the span decode is wrong');
  if (anchorN > anchorOk)
    warnings.push((anchorN - anchorOk) + ' of ' + anchorN + ' objects carry a stale cached anchor ' +
                  '(worst ' + anchorWorst.toFixed(4) + ') — geometry is unaffected');
  if (staleRefs) warnings.push(staleRefs + ' object(s) name a layer that no longer exists; using the layer they are stored under');

  polys.jobSize = { w: job.w == null ? null : job.w * k, h: job.h == null ? null : job.h * k,
                    thickness: job.thickness == null ? null : job.thickness * k };
  polys.units = 'inch';               // units the returned coordinates are in
  polys.sourceUnits = sourceUnits;    // units the file itself was drawn in
  polys.unitsSource = unitsSource;
  polys.scale = k;
  polys.dialect = contourVersions[6] || contourVersions[7] ? 'crv3d-inline'
                : (contourVersions[3] ? 'crv-mfc' : 'empty');
  polys.app = vinfo.app;
  polys.appVersion = vinfo.version;
  polys.layerNames = layers.map(L => L.name);
  polys.warnings = warnings;
  polys.checks = {
    streamVersion: doc.streamVersion, mfcBigTags: doc.bigTags,
    toolpathTabs: nTabs, textBlocks: nText,
    discardedPreviews: nPreviewObjs + ' objects / ' + nPreviewContours + ' contours',
    skippedFrames: nSkipped, crossLayerChildren: crossLayer, nullLayerObjects: nullOwners,
    staleLayerRefs: staleRefs, anchorMatchesBBoxCentre: anchorOk + '/' + anchorN,
    classes: doc.classes.filter((v, i, a) => a.indexOf(v) === i).sort()
  };
  return polys;
}

// Studio entry point (importCRV): parseCrv's flat poly list regrouped into layers of contours.
const CRVPARSE = {
  parse: parseCrv,
  toShapes(u8, opts) {
    const polys = parseCrv(u8, opts);
    const byName = new Map();
    for (const n of polys.layerNames) byName.set(n, { name: n, contours: [] });
    for (const p of polys) {
      if (!byName.has(p.layer)) byName.set(p.layer, { name: p.layer, contours: [] });
      byName.get(p.layer).contours.push({ pts: p.pts, closed: !!p.ent.closed });
    }
    const js = polys.jobSize;
    return { job: js && js.w > 0 && js.h > 0 ? { w: js.w, h: js.h, thickness: js.thickness } : null,
             units: 'in', unitsSource: polys.unitsSource, empty: polys.length === 0,
             layers: [...byName.values()].filter(L => L.contours.length), warnings: polys.warnings };
  }
};
