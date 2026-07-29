/* crv3dparse.js - reader for Vectric .crv3d / .crv project files (pure, no DOM).

   A .crv3d is an OLE2 COMPOUND FILE (magic d0cf11e0a1b11ae1) - the old Microsoft
   structured-storage container: a little filesystem of named streams in 512-byte
   sectors, with a FAT, a mini-FAT for streams under 4096 bytes, and a directory.
   Nothing is compressed or encrypted (byte entropy ~5.4 bits).

   Streams observed in Aspire/VCarve exports (lgc-50 boards 1-5):

     VersionData/Version        app + format version
     PreviewData/Preview2D_GIF  thumbnail, a plain GIF
     VectorData/MaterialSize    stock setup
     VectorData/DocumentData
     VectorData/2dDataV2        the DRAWING - true splines, not a flattened export
     ModelObjects/ObjectData
     Toolpaths/ToolpathData     the toolpaths, MFC CArchive (same serialisation as
                                the .tool database - see tooldbparse.js)
     Toolpaths/ToolpathPosData
     Toolpaths/Simulation

   This module reads the CONTAINER completely and decodes the pieces of the payload
   that have been verified against ground truth (the posted .tap for the same job).
   Everything else is exposed as raw bytes so later work can extend it. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.Crv3d = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const FREE = 0xffffffff, ENDOFCHAIN = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;
const isSect = v => v <= 0xfffffffa;

function toBuf(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new Error('expected Uint8Array or ArrayBuffer');
}

/* parseCfb(bytes) -> { entries: [{name, path, type, size}], readStream(path) -> Uint8Array }
   type: 1 storage (directory), 2 stream, 5 root. path is '/'-joined from the root. */
function parseCfb(bytes) {
  const b = toBuf(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0xe011cfd0 || dv.getUint32(4, true) !== 0xe11ab1a1)
    throw new Error('not an OLE2 compound file (bad magic)');
  const secSize = 1 << dv.getUint16(30, true);
  const miniSize = 1 << dv.getUint16(32, true);
  const nFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  const difatStart = dv.getUint32(68, true), nDifat = dv.getUint32(72, true);
  const off = s => (s + 1) * secSize;

  // DIFAT: first 109 FAT sector numbers live in the header, the rest chain through DIFAT sectors
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const v = dv.getUint32(76 + i * 4, true); if (isSect(v)) fatSecs.push(v); }
  let ds = difatStart;
  for (let k = 0; k < nDifat && isSect(ds); k++) {
    const base = off(ds);
    for (let i = 0; i < secSize / 4 - 1; i++) { const v = dv.getUint32(base + i * 4, true); if (isSect(v)) fatSecs.push(v); }
    ds = dv.getUint32(base + secSize - 4, true);
  }
  if (fatSecs.length < nFat) throw new Error('truncated DIFAT');

  const fat = new Uint32Array(fatSecs.length * (secSize / 4));
  fatSecs.forEach((s, k) => { const base = off(s);
    for (let i = 0; i < secSize / 4; i++) fat[k * (secSize / 4) + i] = dv.getUint32(base + i * 4, true); });

  const readChain = (start, size) => {
    const parts = []; let s = start, guard = 0;
    while (isSect(s)) {
      if (guard++ > 1e6) throw new Error('FAT chain loop');
      parts.push(b.subarray(off(s), off(s) + secSize));
      s = fat[s];
    }
    let total = 0; for (const p of parts) total += p.length;
    const all = new Uint8Array(total); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return size != null ? all.subarray(0, size) : all;
  };

  // directory entries: 128 bytes each, UTF-16LE names
  const dirBuf = readChain(dirStart);
  const dvd = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);
  const raw = [];
  for (let i = 0; i * 128 + 128 <= dirBuf.length; i++) {
    const base = i * 128;
    const nameLen = dvd.getUint16(base + 64, true);
    const type = dirBuf[base + 66];
    if (!type) { raw.push(null); continue; }
    let name = '';
    for (let k = 0; k + 2 <= nameLen - 2; k += 2) name += String.fromCharCode(dvd.getUint16(base + k, true));
    raw.push({
      name, type,
      left: dvd.getInt32(base + 68, true), right: dvd.getInt32(base + 72, true), child: dvd.getInt32(base + 76, true),
      start: dvd.getUint32(base + 116, true),
      size: dvd.getUint32(base + 120, true),          // < 2GB always holds for these files
    });
  }

  // resolve paths by walking each storage's red-black child tree (order does not matter to us)
  const entries = [];
  function walk(idx, prefix) {
    if (idx < 0 || idx >= raw.length || !raw[idx]) return;
    const e = raw[idx];
    walk(e.left, prefix);
    const path = prefix ? prefix + '/' + e.name : e.name;
    entries.push({ name: e.name, path, type: e.type, size: e.size, _i: idx });
    if (e.type === 1 || e.type === 5) walk(e.child, e.type === 5 ? '' : path);
    walk(e.right, prefix);
  }
  const rootIdx = raw.findIndex(e => e && e.type === 5);
  if (rootIdx < 0) throw new Error('no root storage');
  entries.push({ name: raw[rootIdx].name, path: '', type: 5, size: raw[rootIdx].size, _i: rootIdx });
  walk(raw[rootIdx].child, '');

  // mini stream: small streams live inside the root entry's own chain
  const rootE = raw[rootIdx];
  const miniData = rootE.size ? readChain(rootE.start, rootE.size) : new Uint8Array(0);
  const miniFatBuf = isSect(miniFatStart) ? readChain(miniFatStart) : new Uint8Array(0);
  const mdv = new DataView(miniFatBuf.buffer, miniFatBuf.byteOffset, miniFatBuf.byteLength);
  const readMini = (start, size) => {
    const parts = []; let s = start, guard = 0;
    while (isSect(s)) {
      if (guard++ > 1e6) throw new Error('miniFAT chain loop');
      parts.push(miniData.subarray(s * miniSize, (s + 1) * miniSize));
      s = mdv.getUint32(s * 4, true);
    }
    let total = 0; for (const p of parts) total += p.length;
    const all = new Uint8Array(total); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all.subarray(0, size);
  };

  function readStream(path) {
    const e = entries.find(x => x.path === path && x.type === 2);
    if (!e) throw new Error('no stream ' + JSON.stringify(path) + ' in file');
    const r = raw[e._i];
    return r.size < miniCutoff ? readMini(r.start, r.size) : readChain(r.start, r.size);
  }

  return { entries: entries.filter(e => e.type !== 5), readStream };
}

/* ---- 2dDataV2: the drawing -------------------------------------------------------------
   Coordinates are f64. Verified so far (board 4, the T5 stabiliser contour): the true
   curve is stored as CUBIC BEZIER SPANS, serialised anchors-first:

       f64 P0x, P0y      span start anchor        3.50109260957, 72.2094225215
       8 bytes           separator/flags
       f64 P3x, P3y      span end anchor          2.50108150344, 72.8643746272
       ...               then the two control points
       f64 C1x, C1y                               3.31824087197, 72.5949875878
       f64 C2x, C2y                               2.91091551888, 72.8643746272

   which places the TRUE endpoint tangent at 115.372 deg where the DXF's 0.02" flattening
   reads 115.90 deg. No general 2dDataV2 decoder is claimed yet - the record framing around
   spans (entity headers, span counts) has not been mapped. What is above was located by
   searching for the DXF's known endpoint coordinates and is kept as the anchor for that
   future work. See fixtures/parity/CRV3D.md.

   ---- Toolpaths/ToolpathData: fully decoded enough to be useful -------------------------
   MFC CArchive, the same serialisation as the .tool database. Three things are readable:

   1. CLASS MARKERS (ff ff, u16 schema, u16 len, name): mcDrillingToolpath,
      mcProfileToolpath, mcCompositeToolpath, mcContourGroupToolpath, tool classes,
      utParameter, veEntityGroup. Each appears once, at its class's first use.

   2. TOOL RECORDS: identical field layout to the .tool database, one PER TOOLPATH in
      toolpath order, with any per-toolpath overrides BAKED IN (board 3/4 carry T3 at
      feed 60 where the database tool says 80 - exactly the override the operator made).
      tooldbparse.parseToolDb() reads them from this stream unchanged.

   3. TOOLPATH GEOMETRY: the computed toolpaths themselves, fully tessellated, as
      32-byte LINE SEGMENT records:

          u32 tag = 32           (only line segments observed; arcs arrive pre-flattened,
          u32 dim = 3             consistent with the NURBS finding in ARC-FITTING.md)
          f32 x1, y1, z1         segment start
          f32 x2, y2, z2         segment end (repeated as the next record's start)

      Runs of contiguous records form one continuous cut at one depth. Coordinates are in
      machine space and match the posted .tap: board 3's T9 finishing pass is a 100-segment
      run starting at exactly (0.7117, 87.0545) - the start point the .tap alone could not
      explain - and board 4's T5 run starts at (3.6712, 72.2940). A file may carry runs for
      toolpaths that were NOT posted for this board (the LGC project keeps sibling boards'
      toolpaths around, offset on the sheet), so callers must select runs by geometry, not
      assume every run is in the .tap. */
function scanToolpathClasses(bytes) {
  const b = toBuf(bytes);
  const out = [];
  for (let p = 0; p + 6 < b.length; p++) {
    if (b[p] !== 0xff || b[p + 1] !== 0xff) continue;
    const len = b[p + 4] | (b[p + 5] << 8);
    if (len < 4 || len > 64 || p + 6 + len > b.length) continue;
    let s = '', ok = true;
    for (let i = 0; i < len; i++) { const c = b[p + 6 + i]; if (c < 0x20 || c >= 0x7f) { ok = false; break; } s += String.fromCharCode(c); }
    if (!ok || !/^(mc|ve|ut)[A-Za-z]+$/.test(s)) continue;
    out.push({ name: s, offset: p });
    p += 5 + len;
  }
  return out;
}

/* toolpathGeometry(bytes) -> [{offset, points:[{x,y,z}...]}] - each run is one continuous
   cut at (mostly) one depth; consecutive segments share endpoints, so a run of n segments
   yields n+1 points. Plausibility gate: all six floats within [-5, 120] inches, which spans
   any job this shop runs while rejecting the float garbage that surrounds the records. */
function toolpathGeometry(bytes) {
  const b = toBuf(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const plaus = v => v > -5 && v < 120;
  const isRec = p => {
    if (p + 32 > b.length) return false;
    if (dv.getUint32(p, true) !== 32 || dv.getUint32(p + 4, true) !== 3) return false;
    for (let k = 0; k < 6; k++) if (!plaus(dv.getFloat32(p + 8 + k * 4, true))) return false;
    return true;
  };
  const runs = [];
  for (let p = 0; p + 32 <= b.length; p++) {
    if (!isRec(p)) continue;
    const pts = [{ x: dv.getFloat32(p + 8, true), y: dv.getFloat32(p + 12, true), z: dv.getFloat32(p + 16, true) }];
    let q = p;
    while (isRec(q)) {
      pts.push({ x: dv.getFloat32(q + 20, true), y: dv.getFloat32(q + 24, true), z: dv.getFloat32(q + 28, true) });
      q += 32;
    }
    runs.push({ offset: p, points: pts });
    p = q;
  }
  return runs;
}

/* parseCrv3d(bytes) -> everything we can currently stand behind:
     streams            [{path, type, size}]
     readStream(path)   raw bytes of any stream
     toolpathClasses    class markers, in file order
     tools              per-toolpath tool records (tooldbparse layout), in toolpath order
     geometry           tessellated toolpath runs (see toolpathGeometry)
     previewGif         the 2D preview thumbnail, a plain GIF */
function parseCrv3d(bytes, deps) {
  const cfb = parseCfb(bytes);
  const has = p => cfb.entries.some(e => e.path === p && e.type === 2);
  const res = { streams: cfb.entries.map(e => ({ path: e.path, type: e.type, size: e.size })), readStream: cfb.readStream };
  if (has('Toolpaths/ToolpathData')) {
    const tp = cfb.readStream('Toolpaths/ToolpathData');
    res.toolpathClasses = scanToolpathClasses(tp);
    res.geometry = toolpathGeometry(tp);
    // tool records use the .tool database layout; reuse that parser when it is available
    const TDB = deps && deps.ToolDb ? deps.ToolDb
      : (typeof module !== 'undefined' && typeof require === 'function' ? require('./tooldbparse.js')
        : (typeof self !== 'undefined' ? self.ToolDb : this && this.ToolDb));
    if (TDB) res.tools = TDB.parseToolDb(tp).tools;
  }
  if (has('PreviewData/Preview2D_GIF')) res.previewGif = cfb.readStream('PreviewData/Preview2D_GIF');
  return res;
}

return { parseCfb, parseCrv3d, scanToolpathClasses, toolpathGeometry };
});
