// tpdparse.js — read the TOOLPATH DEFINITIONS VCarve saves inside a .crv/.crv3d (stream Toolpaths/ToolpathData),
// so a job's recipe comes from the CRV itself instead of from a Vectric-posted .tap.
//
// What the stream holds, per toolpath (reverse-engineered 2026-10-03 against Fish 36x24.crv3d and checked
// against its posted .tap):
//   header      <class tag | class ref> u32 version(5) GUID16 CString name
//   tool record <mcEndMillTool | mcVBitTool | mcDrillTool | ...> fields at fixed offsets from the record body:
//               +21 f64 diameter, +29 f64 pass depth, +37 f64 stepover (absolute), +45 f64 feed, +53 f64 plunge,
//               +61 u32 rate units(4), +65 u32 spindle rpm, +69 u32 tool number, +73 u32 name length, +77 ASCII tool name
//   selection   veEntityGroup: u32 ver, u32 0, u32 count, count x GUID16 = vector objects in 2dDataV2
//   parameters  utParameter list, self-describing: CString name, u32 type, value
//               (type 0 = f64 after 4 pad bytes, 1 = i32, 2 = bool u8, 3 = CString)
//   It ALSO holds Vectric's computed path (point lists). We never read that: the recipe only.
// Everything is anchored on structure we can verify; anything that does not parse is reported, not guessed.

function u32(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) >>> 0; }
function f64(b, o) { return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true); }
function i32(b, o) { return new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0, true); }
function hex(b, o, n) { let s = ''; for (let i = 0; i < n; i++) s += (b[o + i] < 16 ? '0' : '') + b[o + i].toString(16); return s; }
function cstr(b, o) {   // MFC CStringW at o: FF FE FF <u8 len> UTF-16LE
  if (!(b[o] === 0xff && b[o + 1] === 0xfe && b[o + 2] === 0xff)) return null;
  const n = b[o + 3]; let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + 4 + 2 * i] | (b[o + 5 + 2 * i] << 8));
  return { s, end: o + 4 + 2 * n };
}
function allCStrings(b) {
  const out = [];
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xfe && b[i + 2] === 0xff) { const c = cstr(b, i); out.push({ o: i, s: c.s, end: c.end }); i = c.end - 1; }
  return out;
}
const round6 = v => Math.round(v * 1e6) / 1e6;

function parseParams(b, strs) {
  const out = [];
  for (const c of strs) {
    if (!/^[_A-Za-z]\w*$/.test(c.s)) continue;
    const e = c.end; if (e + 5 > b.length) continue;
    const t = u32(b, e);
    let v, ok = true;
    if (t === 0) v = round6(f64(b, e + 4));
    else if (t === 1) v = i32(b, e + 4);
    else if (t === 2) v = !!b[e + 4];
    else if (t === 3) { const s = cstr(b, e + 4); v = s ? s.s : null; ok = !!s; }
    else ok = false;
    if (ok) out.push({ o: c.o, name: c.s, value: v });
  }
  return out;
}
// tool records: find "<u32 rpm><u32 toolnum><u32 len><ascii name>" and read the fixed fields before it
function parseTools(b) {
  const out = [];
  for (let n = 77; n + 8 < b.length; n++) {
    const len = u32(b, n); if (len < 4 || len > 64) continue;
    let ok = true; for (let k = 0; k < len; k++) { const ch = b[n + 4 + k]; if ((ch < 32 || ch > 126) && !(ch === 0 && k === len - 1)) { ok = false; break; } }   // NUL-terminated, NUL counted
    if (!ok) continue;
    const j = n - 73, rpm = u32(b, j + 65), num = u32(b, j + 69), dia = f64(b, j + 21);
    if (!(rpm >= 1000 && rpm <= 40000 && num >= 0 && num <= 99 && dia > 0.001 && dia < 4)) continue;
    let name = ''; for (let k = 0; k < len; k++) if (b[n + 4 + k]) name += String.fromCharCode(b[n + 4 + k]);
    out.push({ o: j, name, toolNum: num, rpm, dia: round6(dia), passDepth: round6(f64(b, j + 29)), stepover: round6(f64(b, j + 37)),
               feed: round6(f64(b, j + 45)), plunge: round6(f64(b, j + 53)) });
    n += 4 + len;
  }
  return out;
}
// selections: runs of GUIDs that name vector objects in 2dDataV2, preceded by their u32 count. Matching
// against the CRV's own object GUIDs makes this independent of MFC class-ref numbering.
function parseSelections(b, vectorGuids) {
  const out = []; if (!vectorGuids || !vectorGuids.size) return out;
  for (let i = 4; i + 16 <= b.length; i++) {
    if (!vectorGuids.has(hex(b, i, 16))) continue;
    const cnt = u32(b, i - 4); const g = [];
    for (let k = 0; k < cnt && i + 16 * (k + 1) <= b.length; k++) { const h = hex(b, i + 16 * k, 16); if (!vectorGuids.has(h)) break; g.push(h); }
    if (g.length === cnt && cnt > 0) { out.push({ o: i - 4, guids: g }); i += 16 * cnt - 1; }
  }
  return out;
}

function parseToolpathData(b, vectorGuids) {
  const strs = allCStrings(b), params = parseParams(b, strs), tools = parseTools(b);
  const tpNames = new Set(params.filter(p => /ToolpathName$/.test(p.name)).map(p => p.value));
  // headers: a toolpath name CString preceded by u32 version + GUID16 (not a parameter value)
  const headers = strs.filter(c => tpNames.has(c.s) && u32(b, c.o - 20) === 5 && !(params.some(p => p.o < c.o && /ToolpathName$/.test(p.name) && c.o - p.o < 80)))
                      .map(c => ({ o: c.o, name: c.s, guid: hex(b, c.o - 16, 16) }));
  // selections: veEntityGroup by name, plus class-ref'd groups found as "u32 ver(2) u32 0 u32 n GUIDs" right after a header's tool/params
  const sels = parseSelections(b, vectorGuids);
  const tps = [];
  headers.forEach((h, k) => {
    const end = k + 1 < headers.length ? headers[k + 1].o : b.length;
    const P = {}; for (const p of params) if (p.o > h.o && p.o < end) P[p.name] = p.value;
    const T = []; for (const t of tools.filter(t => t.o > h.o && t.o < end)) if (!T.some(x => x.toolNum === t.toolNum && x.dia === t.dia && x.feed === t.feed)) T.push(t);
    const S = sels.filter(s => s.o > h.o && s.o < end);
    tps.push({ name: h.name, guid: h.guid, o: h.o, end, type: P.ToolpathType || null, params: P, tools: T, selection: S.length ? S[0].guids : null });
  });
  // composite toolpaths repeat their name on a child header: fold the child into the parent
  const merged = [];
  for (const t of tps) {
    const prev = merged[merged.length - 1];
    if (prev && prev.name === t.name) {
      Object.assign(prev.params, t.params);
      for (const x of t.tools) if (!prev.tools.some(y => y.toolNum === x.toolNum && y.dia === x.dia && y.feed === x.feed)) prev.tools.push(x);
      if (t.selection) prev.selection = [...new Set([...(prev.selection || []), ...t.selection])];
      prev.end = t.end; prev.children = (prev.children || 1) + 1;
    }
    else merged.push(t);
  }
  return { toolpaths: merged, counts: { params: params.length, tools: tools.length, headers: headers.length, selections: sels.length } };
}

if (typeof module !== 'undefined') module.exports = { parseToolpathData, parseParams, parseTools, allCStrings };
