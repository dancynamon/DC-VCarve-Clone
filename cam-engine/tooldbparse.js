/* tooldbparse.js - reader for Vectric .tool databases (pure, no DOM). Node + browser.

   The file is MFC CArchive serialisation: each tool class (mcEndMillTool, mcVBitTool,
   mcDrillTool, ...) is NAMED once on first use and referenced by index afterwards, so the
   class markers cannot be used to find records - they appear exactly once each regardless
   of how many tools there are.

   What IS reliable is the tool name: a 4-byte little-endian length followed by that many
   bytes of ASCII, NUL-terminated. Every numeric field sits at a fixed negative offset from
   the start of the name:

       name-4   int32   name length (including the NUL)
       name-8   int32   tool number
       name-12  int32   spindle speed, rpm
       name-16  int32   (unidentified; 4 on every tool observed)
       name-24  double  plunge rate
       name-32  double  feed rate
       name-40  double  stepover, INCHES (Vectric also shows it as a % of diameter)
       name-48  double  pass depth
       name-56  double  diameter

   Verified against Vectric's own Tool Database dialog for `T5e - Amana 49706 Roundover
   0.380`: diameter 0.38, pass depth 0.75, stepover 0.304 (80%), spindle 20000, feed 100.0,
   plunge 25.0, tool number 5 - all seven read back exactly. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.ToolDb = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const MIN_NAME = 3, MAX_NAME = 120;

function isPrintable(c){ return c >= 0x20 && c < 0x7f; }

/* parseToolDb(bytes) -> { tools:[...], warnings:[...] }
   bytes: Buffer, Uint8Array or ArrayBuffer. */
function parseToolDb(bytes){
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tools = [], warnings = [];
  const seen = new Set();

  for (let p = 60; p + 4 < b.length; p++) {
    const len = dv.getUint32(p, true);
    if (len < MIN_NAME || len > MAX_NAME) continue;
    const start = p + 4, end = start + len;
    if (end > b.length) continue;
    if (b[end - 1] !== 0) continue;                       // must be NUL-terminated
    let ok = true;
    for (let i = start; i < end - 1; i++) if (!isPrintable(b[i])) { ok = false; break; }
    if (!ok) continue;
    let name = ''; for (let i = start; i < end - 1; i++) name += String.fromCharCode(b[i]);
    if (!/[A-Za-z]/.test(name)) continue;                 // skip pure punctuation runs
    if (start - 56 < 0) continue;

    const t = {
      name,
      toolNum: dv.getInt32(start - 8, true),
      rpm:     dv.getInt32(start - 12, true),
      plunge:  dv.getFloat64(start - 24, true),
      feed:    dv.getFloat64(start - 32, true),
      stepover:dv.getFloat64(start - 40, true),
      passDepth:dv.getFloat64(start - 48, true),
      dia:     dv.getFloat64(start - 56, true),
    };
    // plausibility gate - a real tool record has sane geometry and speeds
    if (!(t.dia > 0.001 && t.dia < 12)) continue;
    if (!(t.feed > 0 && t.feed < 10000)) continue;
    if (!(t.plunge > 0 && t.plunge < 10000)) continue;
    if (!(t.rpm >= 0 && t.rpm <= 120000)) continue;
    if (!(t.toolNum >= 0 && t.toolNum < 1000)) continue;
    if (!(t.passDepth >= 0 && t.passDepth < 12)) continue;
    if (!(t.stepover >= 0 && t.stepover < 12)) continue;

    t.stepoverPct = t.dia > 0 ? t.stepover / t.dia : 0;
    const key = name + '|' + t.toolNum + '|' + t.dia.toFixed(4);
    if (seen.has(key)) { warnings.push('duplicate tool in database: ' + name); continue; }
    seen.add(key);
    tools.push(t);
    p = end - 1;                                          // skip past this record's name
  }

  if (!tools.length) warnings.push('no tool records found - is this a Vectric .tool file?');
  return { tools, warnings };
}

// Look a tool up the way a job does: by the number the post writes as T<n>.
function findByNumber(tools, n){ return tools.filter(t => t.toolNum === n); }

/* toolsToLibrary(tools) -> records shaped like CAM.defaultTools()

   Two fields have to be INFERRED from the name rather than read:

   - `op`. The record's class (mcDrillTool, mcVBitTool, ...) is what says whether a tool
     drills or V-carves, but CArchive names each class once and references it by index
     afterwards, so the class cannot be recovered per record. The name is the only signal
     left. Anything unrecognised becomes 'profile', which is the safe default: it cuts a
     contour rather than plunging or carving.
   - `angle`. Only V-bits and drills have one, and only some names state it.

   Both are user-editable in the tool panel once imported, which is the right place to
   correct a bad guess - better than silently posting a V-carve as a profile. */
function opFromName(name){
  const n = name.toLowerCase();
  if (/\bdrill\b|countersink|plunge cutter|straight plunge/.test(n)) return 'drill';
  if (/v-?bit|vcarve|v-?carve|engrav|diamond drag/.test(n)) return 'vcarve';
  if (/pocket|fly cutter|surfac/.test(n)) return 'pocket';
  return 'profile';
}
function angleFromName(name, op){
  const m = name.match(/(\d{2,3})\s*(?:deg|°|')/i);        // "(90 deg 0.5\")", "30 Deg Tip", "20' 0.02"
  if (m) { const a = +m[1]; if (a > 0 && a <= 180) return a; }
  return op === 'drill' ? 118 : 90;                        // 118 is the standard twist-drill point
}
function toolsToLibrary(tools){
  const used = new Set();
  return (tools || []).map(t => {
    const op = opFromName(t.name);
    let id = String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
    // names repeat in a real database (two `T9 - Amana 51504-K` entries at different speeds),
    // and the library keys on id, so a collision would silently drop one of them
    if (used.has(id)) { let n = 2; while (used.has(id + '-' + n)) n++; id = id + '-' + n; }
    used.add(id);
    return {
      id, name: t.name, op,
      toolNum: t.toolNum, dia: t.dia, angle: angleFromName(t.name, op),
      feed: Math.round(t.feed * 100) / 100,
      plunge: Math.round(t.plunge * 100) / 100,
      rpm: t.rpm,
      passDepth: Math.round(t.passDepth * 1e4) / 1e4,
      stepover: Math.round(t.stepover * 1e4) / 1e4,
    };
  });
}

return { parseToolDb, findByNumber, toolsToLibrary, opFromName, angleFromName };
});
