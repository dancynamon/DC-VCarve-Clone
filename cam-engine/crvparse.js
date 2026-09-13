// crvparse.js — Vectric VCarve (.crv) / Aspire (.crv3d) reader. No dependencies; runs in the browser and in node.
//
// The file is an OLE2 / MS Compound File. The 2D vectors live in the stream VectorData/2dDataV2, which is an MFC
// CArchive object graph: vcCadLayer -> vcCadPolyline / vcCadContour / vcCadObjectGroup / txtBlock -> vdContour -> spans.
// The job sheet is VectorData/MaterialSize. Every layout below was measured byte by byte on real files; there is no
// public spec. The reader REFUSES (throws) on anything it has not seen — an unknown class, an unexpected version, an
// unknown span type, a contour that does not chain end-to-start, or a stream that does not end exactly on the
// terminal vcCadSheet object — because guessed geometry on a CNC router destroys material. Report the error, never
// patch around it.
//
// Units: the format carries no units flag (verified by Dan by byte-diffing a metric and an inch save of the same
// drawing — only the coordinates differ). Nothing here scales; `unitsSource` says how `units` was decided.
//
// API:  CRVPARSE.parse(bytes)              -> { job, layers:[{name,color,visible,objects:[...]}], version, empty }
//       CRVPARSE.toShapes(bytes, {tol,text}) -> { job:{w,h,thickness}|null, units, unitsSource, empty,
//                                              layers:[{name,color,contours:[{pts:[{x,y}],closed}]}],
//                                              skippedText:[{layer,text,x,y}] }   (text objects are skipped unless
//                                              opts.text — their placement is inferred, not yet verified)
//       CRVPARSE.readCFB(bytes)            -> Map(path -> Uint8Array)   (exposed for tests)
const CRVPARSE = (function () {
  'use strict';

  // ---------------------------------------------------------------- OLE2 / Compound File Binary
  function readCFB(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
    if (bytes.length < 512 || u32(0) !== 0xE011CFD0 || u32(4) !== 0xE11AB1A1) throw new Error('not an OLE2 compound file (no CFB signature)');
    const secShift = u16(0x1E), miniShift = u16(0x20);
    const secSize = 1 << secShift, miniSize = 1 << miniShift;
    const nFat = u32(0x2C), dirStart = u32(0x30), miniCutoff = u32(0x38), miniFatStart = u32(0x3C), nMiniFat = u32(0x40);
    const difatStart = u32(0x44), nDifat = u32(0x48);
    const ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;
    const secOff = s => (s + 1) * secSize;
    // DIFAT: 109 entries in the header, then chained DIFAT sectors
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = u32(0x4C + 4 * i); if (s !== FREESECT) fatSecs.push(s); }
    let ds = difatStart, guard = 0;
    while (ds !== ENDOFCHAIN && ds !== FREESECT && guard++ < nDifat + 1) {
      const base = secOff(ds), per = secSize / 4 - 1;
      for (let i = 0; i < per && fatSecs.length < nFat; i++) { const s = u32(base + 4 * i); if (s !== FREESECT) fatSecs.push(s); }
      ds = u32(base + 4 * per);
    }
    const fat = new Uint32Array(fatSecs.length * (secSize / 4));
    fatSecs.forEach((s, k) => { const base = secOff(s); for (let i = 0; i < secSize / 4; i++) fat[k * (secSize / 4) + i] = u32(base + 4 * i); });
    const chain = (start, table) => { const out = []; let s = start, n = 0; while (s !== ENDOFCHAIN && s !== FREESECT && s < 0xFFFFFFFA) { if (n++ > table.length + 1) throw new Error('CFB: sector chain loop'); out.push(s); s = table[s]; if (s === undefined) throw new Error('CFB: sector chain runs off the FAT'); } return out; };
    const readChain = (start, size) => { const secs = chain(start, fat); const out = new Uint8Array(size); let p = 0; for (const s of secs) { if (p >= size) break; const n = Math.min(secSize, size - p); out.set(bytes.subarray(secOff(s), secOff(s) + n), p); p += n; } return out; };
    // directory
    const dirSecs = chain(dirStart, fat); const entries = [];
    for (const s of dirSecs) for (let i = 0; i < secSize / 128; i++) {
      const o = secOff(s) + i * 128, nl = u16(o + 64), type = bytes[o + 66];
      if (type === 0) { entries.push(null); continue; }
      let name = ''; for (let k = 0; k + 1 < nl; k += 2) { const c = u16(o + k); if (c) name += String.fromCharCode(c); }
      entries.push({ name, type, left: u32(o + 68), right: u32(o + 72), child: u32(o + 76), start: u32(o + 116), size: u32(o + 120) });
    }
    const root = entries[0]; if (!root || root.type !== 5) throw new Error('CFB: missing root entry');
    // mini stream + mini FAT
    let miniFat = new Uint32Array(0), miniStream = new Uint8Array(0);
    if (nMiniFat && root.size) {
      const mfSecs = chain(miniFatStart, fat); miniFat = new Uint32Array(mfSecs.length * (secSize / 4));
      mfSecs.forEach((s, k) => { const base = secOff(s); for (let i = 0; i < secSize / 4; i++) miniFat[k * (secSize / 4) + i] = u32(base + 4 * i); });
      miniStream = readChain(root.start, root.size);
    }
    const readMini = (start, size) => { const secs = chain(start, miniFat); const out = new Uint8Array(size); let p = 0; for (const s of secs) { if (p >= size) break; const n = Math.min(miniSize, size - p); out.set(miniStream.subarray(s * miniSize, s * miniSize + n), p); p += n; } return out; };
    // walk the red-black tree from the root's child, building full paths
    const streams = new Map();
    const walk = (idx, prefix, depth) => {
      if (idx === FREESECT || idx >= entries.length || depth > 64) return; const e = entries[idx]; if (!e) return;
      walk(e.left, prefix, depth + 1); walk(e.right, prefix, depth + 1);
      const path = prefix ? prefix + '/' + e.name : e.name;
      if (e.type === 1) walk(e.child, path, depth + 1);
      else if (e.type === 2) streams.set(path, e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
    };
    walk(root.child, '', 0);
    return streams;
  }

  // ---------------------------------------------------------------- MFC CArchive reader
  class Ar {
    constructor(bytes) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; this.tab = [null]; }   // load array, index 0 = NULL
    need(n) { if (this.p + n > this.b.length) throw new Error('CRV: read past end of stream at ' + this.p); }
    u8() { this.need(1); return this.b[this.p++]; }
    u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
    u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
    i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
    f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
    skip(n) { this.need(n); this.p += n; }
    guid() { this.need(16); let s = ''; for (let i = 0; i < 16; i++) s += (this.b[this.p + i] < 16 ? '0' : '') + this.b[this.p + i].toString(16); this.p += 16; return s; }
    // MFC CString: u8 len | 0xFF u16 | 0xFF 0xFFFF u32; unicode prefix 0xFF 0xFFFE then the length again
    cstr() {
      let n = this.u8(), uni = false;
      if (n === 0xFF) { n = this.u16(); if (n === 0xFFFE) { uni = true; n = this.u8(); if (n === 0xFF) n = this.u16(); } if (n === 0xFFFF) n = this.u32(); }
      let s = '';
      if (uni) { this.need(2 * n); for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint16(this.p + 2 * i, true)); this.p += 2 * n; }
      else { this.need(n); for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; }
      return s;
    }
    lstr() { const n = this.u32(); this.need(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; return s; }
    // CArchive::ReadObject tag. Returns null (NULL pointer), {kind:'new'|'ref', name} or {kind:'obj', name}.
    // The load array gets one slot per class on first sight and one per object, in stream order (MFC semantics).
    tag() {
      let w = this.u16(), big = false;
      if (w === 0x7FFF) { w = this.u32(); big = true; }
      if (w === 0) return null;
      if (!big && w === 0xFFFF) {
        this.u16(); const ln = this.u16(); this.need(ln); let nm = ''; for (let i = 0; i < ln; i++) nm += String.fromCharCode(this.b[this.p + i]); this.p += ln;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) throw new Error('CRV: bad class name at ' + this.p);
        this.tab.push({ cls: nm }); this.tab.push({ obj: nm }); return { kind: 'new', name: nm };
      }
      const isClass = big ? (w & 0x80000000) !== 0 : (w & 0x8000) !== 0, idx = big ? (w & 0x7FFFFFFF) : (w & 0x7FFF);
      const e = this.tab[idx]; if (!e) throw new Error('CRV: dangling archive reference ' + idx + ' at ' + this.p);
      if (isClass) { if (!e.cls) throw new Error('CRV: class reference to a non-class slot at ' + this.p); this.tab.push({ obj: e.cls }); return { kind: 'ref', name: e.cls }; }
      if (!e.obj) throw new Error('CRV: object reference to a non-object slot at ' + this.p);
      return { kind: 'obj', name: e.obj };
    }
    expect(name) { const t = this.tag(); if (!t || t.name !== name) throw new Error('CRV: expected ' + name + ' at ' + this.p + (t ? ', found ' + t.name : ', found NULL')); return t; }
  }

  // ---------------------------------------------------------------- span / contour
  // typeCode = primitive family + toolpath role: 1/8/9 line (8 lead-in, 9 lead-out), 0/11/12 arc (11/12 leads),
  // 5 zero-length point, 7 line over a machining tab, 6 cubic bezier. The inline u8 discriminator names the family.
  const LINE = new Set([1, 7, 8, 9]), ARC = new Set([0, 11, 12]), BEZ = new Set([6]), POINT = new Set([5]);
  function readSpan(r) {
    const disc = r.u8(), ver = r.u32();
    if (ver !== 2) throw new Error('CRV: span version ' + ver + ' at ' + r.p + ' (expected 2)');
    const t = r.u32();
    const x0 = r.f64(), y0 = r.f64(), z0 = r.f64(), x1 = r.f64(), y1 = r.f64(), z1 = r.f64();
    if (!POINT.has(t)) r.u32();   // flag, always 1, absent on the point span
    const sp = { t, x0, y0, z0, x1, y1, z1 };
    if (ARC.has(t)) { if (disc !== 1) throw new Error('CRV: arc span with discriminator ' + disc + ' at ' + r.p); sp.bulge = r.f64(); }
    else if (BEZ.has(t)) { if (disc !== 2) throw new Error('CRV: bezier span with discriminator ' + disc + ' at ' + r.p); sp.c1x = r.f64(); sp.c1y = r.f64(); sp.c2x = r.f64(); sp.c2y = r.f64(); }
    else if (LINE.has(t) || POINT.has(t)) { if (disc !== 0) throw new Error('CRV: line span with discriminator ' + disc + ' at ' + r.p); }
    else throw new Error('CRV: unknown span type ' + t + ' at ' + r.p);
    return sp;
  }
  // vdContour v7: u32 ver, i32 (cache flag), f64 tolerance, u8, f64 signed area (cache), u8, u32 n, spans, GUID source, i32 -1, u16
  function readVdContour(r) {
    const ver = r.u32();
    if (ver !== 7) throw new Error('CRV: vdContour version ' + ver + ' at ' + r.p + ' (only v7 is known)');
    r.i32(); r.f64(); r.u8(); r.f64(); r.u8();
    const n = r.u32(); if (n > 5e6) throw new Error('CRV: implausible span count ' + n + ' at ' + r.p);
    const spans = []; for (let i = 0; i < n; i++) spans.push(readSpan(r));
    const src = r.guid(); r.i32(); r.u16();
    for (let i = 1; i < spans.length; i++) {
      const a = spans[i - 1], b = spans[i];
      if (Math.abs(a.x1 - b.x0) > 1e-7 || Math.abs(a.y1 - b.y0) > 1e-7) throw new Error('CRV: contour chain gap between spans ' + (i - 1) + ' and ' + i + ' (' + a.x1 + ',' + a.y1 + ' -> ' + b.x0 + ',' + b.y0 + ')');
    }
    const closed = spans.length > 0 && Math.abs(spans[spans.length - 1].x1 - spans[0].x0) < 1e-7 && Math.abs(spans[spans.length - 1].y1 - spans[0].y0) < 1e-7;
    return { spans, closed, src };
  }
  function readContourObj(r) { r.expect('vdContour'); return readVdContour(r); }
  function readContourGroup(r) {
    r.expect('vdContourGroup'); const ver = r.u32();
    if (ver !== 3) throw new Error('CRV: vdContourGroup version ' + ver);
    const n = r.u32(); const out = []; for (let i = 0; i < n; i++) out.push(readContourObj(r)); return out;
  }

  // ---------------------------------------------------------------- utParameter (text settings)
  function readParamList(r) {
    r.expect('utParameterList'); const ver = r.u32(); if (ver !== 1) throw new Error('CRV: utParameterList version ' + ver);
    const n = r.u32(), out = {};
    for (let i = 0; i < n; i++) {
      r.expect('utParameter'); const pv = r.u32(); if (pv !== 2) throw new Error('CRV: utParameter version ' + pv);
      const name = r.cstr(), t = r.u32(); let v;
      if (t === 0) v = r.f64(); else if (t === 1) v = r.i32(); else if (t === 2) v = r.u8() !== 0; else if (t === 3) v = r.cstr();
      else throw new Error('CRV: utParameter type ' + t + ' (' + name + ') at ' + r.p);
      out[name] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- vcCadObject common prefix (v8)
  // u32 ver=8, GUID id, GUID parent, u32 colour, u32, u32 0x82, u32 0x2a, u32, i32 -1, [object: utParameterList or NULL],
  // u32, u32, f64 x, f64 y, lstr "Vectric__Version", u32 1, lstr side-uuid
  function readBase(r) {
    const ver = r.u32(); if (ver !== 8) throw new Error('CRV: vcCadObject version ' + ver + ' at ' + r.p + ' (only v8 is known)');
    const id = r.guid(), parent = r.guid(), color = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.i32();
    const t = r.tag(); let params = null;
    if (t) { if (t.name !== 'utParameterList') throw new Error('CRV: unexpected ' + t.name + ' in object header at ' + r.p); rewindTag(r, t); params = readParamList(r); }
    r.u32(); r.u32(); r.f64(); r.f64();
    const vv = r.lstr(); if (vv !== 'Vectric__Version') throw new Error('CRV: object header out of step at ' + r.p + ' (got "' + vv.slice(0, 20) + '")');
    r.u32(); r.lstr();
    return { id, parent, color, params };
  }
  // readBase peeked a tag to decide; give it back so readParamList can consume it (the load array must not double-count)
  function rewindTag(r, t) { if (t.kind === 'new') { r.p -= 6 + t.name.length; r.tab.pop(); r.tab.pop(); } else if (t.kind === 'ref') { r.p -= 2; r.tab.pop(); } else throw new Error('CRV: shared object reference at ' + r.p); }

  const READERS = {
    // Machine-generated preview of a toolpath on the "Toolpath Previews" layer: parsed exactly, then discarded.
    vcCadToolpathPreview(r) { readBase(r); const k = r.u32(); if (k !== 4) throw new Error('CRV: vcCadToolpathPreview v' + k); r.guid(); readContourGroup(r); r.skip(32); return null; },
    vcCadPolyline(r) { const b = readBase(r); const k = r.u32(); if (k !== 2) throw new Error('CRV: vcCadPolyline v' + k); const c = readContourObj(r); r.u32(); r.u32(); return { type: 'polyline', id: b.id, contours: [c] }; },
    vcCadContour(r) { const b = readBase(r); const k = r.u32(); if (k !== 2) throw new Error('CRV: vcCadContour v' + k); const c = readContourObj(r); r.u32(); return { type: 'contour', id: b.id, contours: [c] }; },
    vcCadObjectGroup(r) {
      const b = readBase(r); const k = r.u32(); if (k !== 1) throw new Error('CRV: vcCadObjectGroup v' + k);
      const n = r.u32(), kids = []; for (let i = 0; i < n; i++) { const o = readObject(r); if (o) kids.push(o); }
      return { type: 'group', id: b.id, children: kids };
    },
    // Text: the glyph outlines are stored per character, already in world coordinates.
    txtBlock(r) {
      const b = readBase(r); const k = r.u32(); if (k !== 4) throw new Error('CRV: txtBlock v' + k);
      const nl = r.u32(), chars = [];
      for (let i = 0; i < nl; i++) {
        r.expect('txtLine'); const lv = r.u32(); if (lv !== 1) throw new Error('CRV: txtLine v' + lv);
        const nw = r.u32();
        for (let j = 0; j < nw; j++) {
          r.expect('txtWord'); const wv = r.u32(); if (wv !== 1) throw new Error('CRV: txtWord v' + wv);
          const nc = r.u32();
          for (let q = 0; q < nc; q++) {
            r.expect('txtChar'); const cv = r.u32(); if (cv !== 4) throw new Error('CRV: txtChar v' + cv);
            const code = r.u32(); r.cstr(); const adv = r.f64();
            const glyph = readContourGroup(r);
            r.u32(); r.f64(); r.skip(5); const cx = r.f64(), kern = r.f64(); r.skip(6 * 8);   // 81-byte tail: centre offset, kerning, 3x height, ink width, 1, 0
            chars.push({ code, adv, cx, kern, glyph });
          }
        }
        r.skip(8); r.cstr(); r.f64(); r.f64(); r.f64(); r.f64();   // per line: font key + 4 margins
      }
      r.skip(20);
      r.expect('txtBaseCurve'); const bv = r.u32(); if (bv !== 1) throw new Error('CRV: txtBaseCurve v' + bv);
      const base = readContourObj(r); r.u32(); r.u32(); r.u8();
      const M = []; for (let i = 0; i < 9; i++) M.push(r.f64()); r.skip(10 * 8);   // 3x3 placement transform, then its inverse and one spare f64
      const text = b.params && b.params._txtAL_Text;
      const p = b.params || {};
      // Glyph outlines are glyph-local (centred on x=0, baseline y=0, already scaled to the text height). Their placement
      // along the base curve is INFERRED (pen model: advance + kerning) and has no oracle yet — see toShapes({text}).
      return { type: 'text', id: b.id, text: typeof text === 'string' ? text : '', chars, base, M, params: p,
        anchor: { x: +p._txtAL_text_anchor_x || 0, y: +p._txtAL_text_anchor_y || 0 }, height: +p._txtAL_height || 0, contours: [] };
    }
  };
  function readObject(r) {
    const t = r.tag(); if (!t) throw new Error('CRV: NULL object where a drawing object was expected at ' + r.p);
    if (t.kind === 'obj') throw new Error('CRV: shared object reference (' + t.name + ') at ' + r.p);
    const fn = READERS[t.name]; if (!fn) throw new Error('CRV: unknown class "' + t.name + '" at ' + r.p);
    return fn(r);
  }
  function readLayer(r) {
    const t = r.tag(); if (!t || t.name !== 'vcCadLayer') throw new Error('CRV: expected vcCadLayer at ' + r.p);
    const ver = r.u32(); if (ver !== 4) throw new Error('CRV: vcCadLayer version ' + ver);
    const id = r.guid(), name = r.cstr(), color = r.u32(); r.u32(); r.u8(); const visible = r.u8() !== 0;
    const n = r.u32(), objects = [];
    for (let i = 0; i < n; i++) { const o = readObject(r); if (o) objects.push(o); }
    r.skip(3);
    return { id, name, color: colorref(color), visible, objects };
  }
  function colorref(c) { const h = v => (v < 16 ? '0' : '') + v.toString(16); return '#' + h(c & 255) + h((c >> 8) & 255) + h((c >> 16) & 255); }   // COLORREF is 0x00BBGGRR

  function parse2d(bytes) {
    const r = new Ar(bytes);
    const v = r.u32(); if (v !== 1) throw new Error('CRV: 2dDataV2 stream version ' + v);
    r.u32(); const nl = r.u32(); if (nl > 10000) throw new Error('CRV: implausible layer count ' + nl);
    const layers = []; for (let i = 0; i < nl; i++) layers.push(readLayer(r));
    // post-layer block (120 bytes): u32 1, f64 x0, f64 y0, f64 width, f64 height, f64 0, 3x3 identity, u32 1
    r.u32(); const x0 = r.f64(), y0 = r.f64(), w = r.f64(), h = r.f64(); r.f64(); for (let i = 0; i < 9; i++) r.f64(); r.u32();
    // terminal marker: the sheet object must start exactly here
    const t = r.tag(); if (!t || t.name !== 'vcCadSheet') throw new Error('CRV: layers did not end on vcCadSheet (at ' + r.p + (t ? ', found ' + t.name : '') + ')');
    return { layers, sheet: { x0, y0, w, h } };
  }
  // VectorData/MaterialSize v8: ver, u8, u32, u32, u8, f64, f64 thickness (signed: Z zero side), f64 width, f64 height, f64×3
  function parseMaterial(bytes) {
    if (!bytes || bytes.length < 70) return null;
    const r = new Ar(bytes); const ver = r.u32();
    if (ver !== 8) return { unknownVersion: ver };
    r.u8(); r.u32(); r.u32(); r.u8(); r.f64();
    const th = r.f64(), w = r.f64(), h = r.f64();
    return { w, h, thickness: Math.abs(th) };
  }
  function parseVersion(bytes) {
    if (!bytes) return null; const r = new Ar(bytes); const out = [];
    try { r.u32(); for (let i = 0; i < 6; i++) out.push(r.cstr()); } catch (e) { /* best effort */ }
    return out.map(s => s.trim()).filter(Boolean).join(' · ');
  }

  function parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length >= 2 && (bytes[0] === 0x25 || bytes[0] === 0x28 || bytes[0] === 0x47 || bytes[0] === 0x4E || bytes[0] === 0x54)) {
      // "%", "(", "G", "N", "T": a G-code text file mis-named .crv
      let ascii = true; for (let i = 0; i < Math.min(512, bytes.length); i++) if (bytes[i] > 126 || (bytes[i] < 32 && bytes[i] !== 9 && bytes[i] !== 10 && bytes[i] !== 13)) { ascii = false; break; }
      if (ascii) throw new Error('not a CRV: this is a text (G-code?) file');
    }
    const streams = readCFB(bytes);
    const s2d = streams.get('VectorData/2dDataV2');
    if (!s2d) throw new Error('CRV: no VectorData/2dDataV2 stream — not a VCarve/Aspire drawing');
    const { layers, sheet } = parse2d(s2d);
    let job = parseMaterial(streams.get('VectorData/MaterialSize'));
    if (!job || !(job.w > 0)) job = sheet.w > 0 ? { w: sheet.w, h: sheet.h, thickness: 0, source: '2dDataV2' } : null;
    else if (Math.abs(job.w - sheet.w) > 1e-6 || Math.abs(job.h - sheet.h) > 1e-6) job.sheetMismatch = { w: sheet.w, h: sheet.h };
    const version = parseVersion(streams.get('VersionData/Version'));
    let count = 0, texts = 0; const walk = o => { if (o.contours) count += o.contours.length; if (o.type === 'text') texts++; if (o.children) o.children.forEach(walk); };
    layers.forEach(l => l.objects.forEach(walk));
    return { layers, job, version, empty: count === 0 && texts === 0, texts };
  }

  // ---------------------------------------------------------------- flatten to polylines
  function flattenSpan(sp, tol, out) {
    if (sp.bulge !== undefined) {
      const b = sp.bulge, dx = sp.x1 - sp.x0, dy = sp.y1 - sp.y0, chord = Math.hypot(dx, dy);
      if (chord < 1e-12 || Math.abs(b) < 1e-12) { out.push({ x: sp.x1, y: sp.y1 }); return; }
      const theta = 4 * Math.atan(b);                          // DXF bulge convention, +ve CCW
      const rad = chord / (2 * Math.sin(theta / 2));
      const mx = (sp.x0 + sp.x1) / 2, my = (sp.y0 + sp.y1) / 2, d = rad * Math.cos(theta / 2);
      const cx = mx - d * dy / chord, cy = my + d * dx / chord;
      const a0 = Math.atan2(sp.y0 - cy, sp.x0 - cx);
      const R = Math.abs(rad), n = Math.max(2, Math.ceil(Math.abs(theta) / (2 * Math.acos(Math.max(0, 1 - tol / R)) || 0.2)));
      for (let i = 1; i < n; i++) { const a = a0 + theta * i / n; out.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }); }
      out.push({ x: sp.x1, y: sp.y1 });
    } else if (sp.c1x !== undefined) {
      const L = Math.hypot(sp.c1x - sp.x0, sp.c1y - sp.y0) + Math.hypot(sp.c2x - sp.c1x, sp.c2y - sp.c1y) + Math.hypot(sp.x1 - sp.c2x, sp.y1 - sp.c2y);
      const n = Math.max(4, Math.min(400, Math.ceil(Math.sqrt(L / tol) * 1.5)));
      for (let i = 1; i < n; i++) { const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, dd = t * t * t;
        out.push({ x: a * sp.x0 + b * sp.c1x + c * sp.c2x + dd * sp.x1, y: a * sp.y0 + b * sp.c1y + c * sp.c2y + dd * sp.y1 }); }
      out.push({ x: sp.x1, y: sp.y1 });
    } else out.push({ x: sp.x1, y: sp.y1 });
  }
  function flattenContour(c, tol) {
    if (!c.spans.length) return null;
    const pts = [{ x: c.spans[0].x0, y: c.spans[0].y0 }];
    for (const sp of c.spans) flattenSpan(sp, tol, pts);
    if (c.closed && pts.length > 2) pts.pop();   // the last point repeats the first
    return { pts, closed: c.closed };
  }
  // Text placement (opt-in, unverified against a preview): each line is laid out with a pen model (glyph centred at
  // pen + cx + kern, pen advances by adv + kern), justified on the base curve (0 left, 1 right, 2 centre), lines stacked
  // downwards by 1.5 x the text height, then the block's 3x3 placement transform M is applied. The base line and the
  // transform are read from the file; the line step and the justification mapping are inferred.
  function placeText(o, tol) {
    if (!o.base || !o.base.spans.length) return null;
    const s0 = o.base.spans[0], bx0 = s0.x0, bx1 = s0.x1, by = s0.y0, M = o.M || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const just = o.params && typeof o.params._txtAL_text_justify === 'number' ? o.params._txtAL_text_justify : 2;
    const lineStep = (o.height || 0.25) * 1.5;
    const lines = []; let cur = []; lines.push(cur);
    const txt = o.text || ''; let ci = 0;
    for (let i = 0; i < txt.length; i++) { const c = txt.charCodeAt(i); if (c === 13) continue; if (c === 10) { cur = []; lines.push(cur); continue; } if (ci < o.chars.length) cur.push(o.chars[ci++]); }
    while (ci < o.chars.length) cur.push(o.chars[ci++]);
    const out = [];
    lines.forEach((chars, li) => {
      const width = chars.reduce((a, ch) => a + ch.adv + ch.kern, 0);
      let pen = just === 0 ? bx0 : just === 1 ? bx1 - width : (bx0 + bx1) / 2 - width / 2;
      const y = by - li * lineStep;
      for (const ch of chars) {
        const x = pen + ch.cx + ch.kern;
        for (const c of ch.glyph) { const f = flattenContour(c, tol); if (f && f.pts.length >= 2) {
          f.pts = f.pts.map(p => { const px = p.x + x, py = p.y + y; return { x: M[0] * px + M[1] * py + M[2], y: M[3] * px + M[4] * py + M[5] }; }); out.push(f); } }
        pen += ch.adv + ch.kern;
      }
    });
    return out;
  }
  function toShapes(bytes, opts) {
    opts = opts || {}; const tol = opts.tol > 0 ? opts.tol : 0.002;
    const doc = parse(bytes);
    const layers = [], skippedText = [];
    for (const L of doc.layers) {
      if (L.name === 'Toolpath Previews' && !L.objects.length) continue;
      const contours = [];
      const walk = o => {
        if (o.type === 'text') {
          const placed = opts.text ? placeText(o, tol) : null;
          if (placed) placed.forEach(f => { f.text = true; contours.push(f); });
          else skippedText.push({ layer: L.name, text: o.text, x: o.anchor.x, y: o.anchor.y });
          return;
        }
        if (o.contours) for (const c of o.contours) { const f = flattenContour(c, tol); if (f && f.pts.length >= 2) contours.push(f); }
        if (o.children) o.children.forEach(walk);
      };
      L.objects.forEach(walk);
      layers.push({ name: L.name, color: L.color, visible: L.visible, contours });
    }
    let units = null, unitsSource = 'assumed:no-flag-in-format';
    if (opts.units === 'in' || opts.units === 'mm') { units = opts.units; unitsSource = 'caller'; }
    else if (doc.job && doc.job.w > 300) { units = 'mm'; unitsSource = 'heuristic:job>300'; }
    else if (doc.job && doc.job.w > 0) { units = 'in'; unitsSource = 'heuristic:job<=300'; }
    const job = doc.job && doc.job.w > 0 ? { w: doc.job.w, h: doc.job.h, thickness: doc.job.thickness } : null;
    return { job, units, unitsSource, empty: doc.empty, version: doc.version, layers, skippedText };
  }

  return { readCFB, parse, toShapes, flattenContour, _Ar: Ar, _readVdContour: readVdContour };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CRVPARSE;
