/* Vector-PDF importer — extracts cuttable path geometry from PDF content streams.
   Pure (no DOM/Node deps); concatenated into the studio bundle as browser globals and
   loaded in a vm context for tests, exactly like dxfparse.js.

   Scope (v1): vector path construction + painting operators (m l c v y re h S s f F f* B b n),
   graphics-state transforms (q Q cm) with correct 1/72"→inch scaling. PDF user space is y-up
   (same as our CAD space) so no y-flip is needed. Locates content streams by a filter-agnostic
   stream/endstream scan, so it works with both classic xref tables and modern xref-stream PDFs.
   Form XObjects (the Do operator) are resolved with their /Matrix, recursively and cycle-guarded.
   Live text (Tj/TJ) is counted, not cut — the result array carries a `hasLiveText` flag so the UI can
   tell the user to outline the fonts. Known gaps: clip regions as geometry, inline images, non-Flate
   stream filters. Returns an Array of {pts,closed} with extra props `.hasLiveText` and `.textShows`. */

// ---- byte <-> latin1 string (offsets preserved 1:1) ----
function _pdfU8ToStr(u8, s, e) {
  s = s || 0; e = (e == null ? u8.length : e);
  let out = ''; const CH = 0x8000;
  for (let i = s; i < e; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + CH)));
  return out;
}

// ---- DEFLATE / zlib inflate (RFC 1950/1951), synchronous & pure ----
function pdfInflate(input) {
  let ip = 0;
  if (input.length >= 2) {               // zlib header? CM=8 (deflate) and (CMF<<8|FLG)%31==0
    const cmf = input[0], flg = input[1];
    if ((cmf & 0x0f) === 8 && (((cmf << 8) | flg) % 31) === 0) { ip = 2; if (flg & 0x20) ip += 4; }
  }
  let pos = ip, bitBuf = 0, bitCnt = 0;
  const out = [];
  function getbit() { if (bitCnt === 0) { bitBuf = input[pos++]; bitCnt = 8; } const b = bitBuf & 1; bitBuf >>= 1; bitCnt--; return b; }
  function getbits(k) { let v = 0; for (let i = 0; i < k; i++) v |= getbit() << i; return v; }
  function buildHuff(lengths, num) {     // canonical-Huffman "puff" tables: count[len] + symbols[]
    const count = new Array(16).fill(0);
    for (let i = 0; i < num; i++) count[lengths[i]]++;
    count[0] = 0;
    const offs = new Array(16).fill(0);
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    const symbols = new Array(num);
    for (let i = 0; i < num; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { count: count, symbols: symbols };
  }
  function decode(h) {                    // O(15) canonical decode, MSB-first code assembly
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= getbit();
      const cnt = h.count[len];
      if (code - first < cnt) return h.symbols[index + (code - first)];
      index += cnt; first += cnt; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  }
  const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const fixedLitLen = new Array(288); for (let i = 0; i < 288; i++) fixedLitLen[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  const fixedDistLen = new Array(30).fill(5);
  const fixedLit = buildHuff(fixedLitLen, 288), fixedDist = buildHuff(fixedDistLen, 30);
  function block(litH, distH) {
    for (;;) {
      const sym = decode(litH);
      if (sym === 256) break;
      if (sym < 256) { out.push(sym); continue; }
      const s = sym - 257, length = LB[s] + getbits(LE[s]);
      const ds = decode(distH), dist = DB[ds] + getbits(DE[ds]);
      let start = out.length - dist;
      for (let i = 0; i < length; i++) out.push(out[start + i]);
    }
  }
  let last;
  do {
    last = getbit();
    const type = getbits(2);
    if (type === 0) {                    // stored
      bitCnt = 0;                        // byte-align
      const len = input[pos] | (input[pos + 1] << 8); pos += 4;   // len + ~len
      for (let i = 0; i < len; i++) out.push(input[pos++]);
    } else if (type === 1) {
      block(fixedLit, fixedDist);
    } else if (type === 2) {
      const hlit = getbits(5) + 257, hdist = getbits(5) + 1, hclen = getbits(4) + 4;
      const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
      const cll = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cll[order[i]] = getbits(3);
      const clH = buildHuff(cll, 19);
      const lens = new Array(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decode(clH);
        if (sym < 16) lens[i++] = sym;
        else if (sym === 16) { const r = getbits(2) + 3, p = lens[i - 1]; for (let j = 0; j < r; j++) lens[i++] = p; }
        else if (sym === 17) { const r = getbits(3) + 3; for (let j = 0; j < r; j++) lens[i++] = 0; }
        else { const r = getbits(7) + 11; for (let j = 0; j < r; j++) lens[i++] = 0; }
      }
      block(buildHuff(lens.slice(0, hlit), hlit), buildHuff(lens.slice(hlit), hdist));
    } else throw new Error('inflate: bad block type');
  } while (!last);
  return Uint8Array.from(out);
}

// ---- affine compose (PDF row-vector convention: x'=a*x+c*y+e, y'=b*x+d*y+f) ----
// Returns matrix applying M first, then C (used for `cm` concatenation onto the CTM).
function _pdfMat(M, C) {
  return [
    M[0]*C[0] + M[1]*C[2],
    M[0]*C[1] + M[1]*C[3],
    M[2]*C[0] + M[3]*C[2],
    M[2]*C[1] + M[3]*C[3],
    M[4]*C[0] + M[5]*C[2] + C[4],
    M[4]*C[1] + M[5]*C[3] + C[5]
  ];
}

function _pdfIsWS(c) { return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'; }
function _pdfIsDelim(c) { return c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%'; }

// Does an inflated stream look like a page content stream (path construction + a paint op)?
function _pdfLooksLikeContent(s) {
  const path = /(?:^|\s)(?:m|l|c|re)(?:\s|$)/.test(s);
  const paint = /(?:^|\s)(?:f|f\*|S|s|B|b)(?:\s|$)/.test(s);
  return path && paint;
}

// Interpret one content stream, appending {pts,closed} loops (inches, CAD y-up) to `out`.
function _pdfInterpretContent(s, out, opts, ctx) {
  ctx = ctx || {};
  const tol = (opts && opts.tol) || 0.008;   // curve flattening chord (inches)
  const n = s.length;
  let i = 0, ctm = ctx.baseCTM ? ctx.baseCTM.slice() : [1,0,0,1,0,0];
  const xobjMap = ctx.xobjMap || {};
  const stack = [], ops = [];
  let path = [], sub = null, cur = null, start = null, lastName = null;

  function tf(x, y) { return { x: (ctm[0]*x + ctm[2]*y + ctm[4]) / 72, y: (ctm[1]*x + ctm[3]*y + ctm[5]) / 72 }; }
  function scaleF() { const a = ctm[0], b = ctm[1], c = ctm[2], d = ctm[3]; return Math.sqrt(Math.abs(a*d - b*c)) / 72; }
  function newsub(x, y) { sub = { pts: [tf(x, y)], closed: false }; path.push(sub); cur = [x, y]; start = [x, y]; }
  function lineTo(x, y) { if (!sub) newsub(x, y); else { sub.pts.push(tf(x, y)); cur = [x, y]; } }
  function curveTo(x1, y1, x2, y2, x3, y3) {
    if (!sub) newsub(cur ? cur[0] : x1, cur ? cur[1] : y1);
    const x0 = cur[0], y0 = cur[1];
    const est = (Math.hypot(x1-x0, y1-y0) + Math.hypot(x2-x1, y2-y1) + Math.hypot(x3-x2, y3-y2)) * scaleF();
    const segs = Math.max(6, Math.min(80, Math.round(est / tol) || 6));
    for (let k = 1; k <= segs; k++) {
      const t = k / segs, mt = 1 - t;
      const bx = mt*mt*mt*x0 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x3;
      const by = mt*mt*mt*y0 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y3;
      sub.pts.push(tf(bx, by));
    }
    cur = [x3, y3];
  }
  function rect(x, y, w, h) { newsub(x, y); sub.pts.push(tf(x+w, y)); sub.pts.push(tf(x+w, y+h)); sub.pts.push(tf(x, y+h)); sub.closed = true; cur = [x, y]; start = [x, y]; sub = null; }
  function closepath() { if (sub) { sub.closed = true; if (start) cur = [start[0], start[1]]; } }
  function flush(forceClosed) { for (const sp of path) if (sp.pts.length >= 2) { if (forceClosed) sp.closed = true; out.push(sp); } path = []; sub = null; cur = null; start = null; }
  function _doXObject(name) {                 // resolve `/Name Do` -> Form XObject, apply /Matrix, recurse
    if (!name || !ctx.objs) return;
    const on = xobjMap[name];
    if (on == null || (ctx.seen && ctx.seen[on])) return;           // unknown or cycle
    const o = ctx.objs[on];
    if (!o || !/\/Subtype\s*\/Form\b/.test(o.dictStr)) return;       // Form XObjects only (skip images)
    const content = _pdfGetStreamContent(o, ctx.u8);
    if (!content) return;
    let M = [1, 0, 0, 1, 0, 0];
    const mm = o.dictStr.match(/\/Matrix\s*\[\s*([-0-9.eE\s]+)\]/);
    if (mm) { const nums = mm[1].trim().split(/\s+/).map(parseFloat); if (nums.length === 6 && nums.every(x => !isNaN(x))) M = nums; }
    const childRes = _pdfDictAfter(o.dictStr, 'Resources', ctx.objs) || ctx.resourcesDict || null;
    const seen2 = {}; if (ctx.seen) for (const k in ctx.seen) seen2[k] = true; seen2[on] = true;
    _pdfInterpretContent(content, out, opts, {
      objs: ctx.objs, u8: ctx.u8, baseCTM: _pdfMat(M, ctm),
      xobjMap: _pdfXObjectMap(childRes, ctx.objs), resourcesDict: childRes, seen: seen2, stats: ctx.stats
    });
  }

  function dispatch(op) {
    switch (op) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': { const a = ops.slice(-6); if (a.length === 6) ctm = _pdfMat(a, ctm); break; }
      case 'm': { const a = ops.slice(-2); newsub(a[0], a[1]); break; }
      case 'l': { const a = ops.slice(-2); lineTo(a[0], a[1]); break; }
      case 'c': { const a = ops.slice(-6); curveTo(a[0], a[1], a[2], a[3], a[4], a[5]); break; }
      case 'v': { const a = ops.slice(-4); if (cur) curveTo(cur[0], cur[1], a[0], a[1], a[2], a[3]); break; }
      case 'y': { const a = ops.slice(-4); curveTo(a[0], a[1], a[2], a[3], a[2], a[3]); break; }
      case 're': { const a = ops.slice(-4); rect(a[0], a[1], a[2], a[3]); break; }
      case 'h': closepath(); break;
      case 'S': flush(false); break;
      case 's': closepath(); flush(false); break;
      case 'f': case 'F': case 'f*': flush(true); break;
      case 'B': case 'B*': flush(true); break;
      case 'b': case 'b*': closepath(); flush(true); break;
      case 'n': path = []; sub = null; cur = null; start = null; break;   // clip/no-op: discard, don't emit
      case 'Do': _doXObject(lastName); break;                             // Form XObject: recurse into its content
      case 'Tj': case 'TJ': case "'": case '"': if (ctx.stats) ctx.stats.text++; break;  // live text shown (not outlined) -> flag it
      case 'BI': i = _pdfSkipInlineImage(s, i); break;
      default: break;
    }
    ops.length = 0; lastName = null;
  }

  while (i < n) {
    const ch = s[i];
    if (_pdfIsWS(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (ch === '(') { let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } ops.push(0); continue; }
    if (ch === '<') {
      if (s[i + 1] === '<') { let d = 1; i += 2; while (i < n && d > 0) { if (s[i] === '<' && s[i + 1] === '<') { d++; i += 2; } else if (s[i] === '>' && s[i + 1] === '>') { d--; i += 2; } else i++; } continue; }
      i++; while (i < n && s[i] !== '>') i++; i++; ops.push(0); continue;
    }
    if (ch === '[') { i++; while (i < n && s[i] !== ']') { if (s[i] === '(') { let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } } else i++; } i++; continue; }
    if (ch === ']' || ch === '{' || ch === '}' || ch === ')') { i++; continue; }
    if (ch === '/') { const st = i + 1; i = st; while (i < n && !_pdfIsDelim(s[i]) && !_pdfIsWS(s[i])) i++; lastName = s.slice(st, i); continue; }
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) {
      let j = i + 1; while (j < n) { const c = s[j]; if ((c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+' || c === 'e' || c === 'E') j++; else break; }
      const num = parseFloat(s.slice(i, j)); ops.push(isNaN(num) ? 0 : num); i = j; continue;
    }
    let j = i; while (j < n && !_pdfIsDelim(s[j]) && !_pdfIsWS(s[j])) j++;
    const op = s.slice(i, j); i = j;
    dispatch(op);
  }
  flush(false);
}

// Skip an inline image (BI ... ID <binary> EI). `i` points just past 'BI'. Returns index past 'EI'.
function _pdfSkipInlineImage(s, i) {
  const id = s.indexOf('ID', i);
  if (id < 0) return s.length;
  let k = id + 2;
  while (k < s.length - 1) {
    if (s[k] === 'E' && s[k + 1] === 'I' && (k + 2 >= s.length || _pdfIsWS(s[k + 2])) && _pdfIsWS(s[k - 1])) return k + 2;
    k++;
  }
  return s.length;
}

// ---- object map + resource resolution (needed to follow `Do` into Form XObjects) ----

// Inflate/read a stream object's decoded content, or null (non-Flate filters skipped).
function _pdfGetStreamContent(o, u8) {
  if (!o || !o.hasStream) return null;
  const raw = u8.subarray(o.dataStart, o.dataEnd);
  if (/FlateDecode/.test(o.filter || '')) { try { const inf = pdfInflate(raw); return _pdfU8ToStr(inf, 0, inf.length); } catch (e) { return null; } }
  if (!o.filter) return _pdfU8ToStr(raw, 0, raw.length);
  return null;
}

// Brute-force scan every `N G obj … endobj` (works regardless of xref style). Returns { num: {dictStr,hasStream,dataStart,dataEnd,filter} }.
function _pdfScanObjects(whole, u8) {
  const objs = {};
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(whole))) {
    const num = parseInt(m[1], 10);
    const objStart = m.index + m[0].length;
    const endobj = whole.indexOf('endobj', objStart);
    const boundary = endobj < 0 ? whole.length : endobj;
    const streamKw = whole.indexOf('stream', objStart);
    let hasStream = false, dataStart = -1, dataEnd = -1, filter = '', dictStr;
    if (streamKw >= 0 && streamKw < boundary) {
      dictStr = whole.slice(objStart, streamKw);
      hasStream = true;
      let ds = streamKw + 6; if (whole[ds] === '\r') ds++; if (whole[ds] === '\n') ds++;
      const es = whole.indexOf('endstream', ds);
      let de = es < 0 ? boundary : es;
      if (whole[de - 1] === '\n') de--; if (whole[de - 1] === '\r') de--;
      const lm = dictStr.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (lm) { const L = parseInt(lm[1], 10); if (ds + L <= u8.length) de = ds + L; }
      dataStart = ds; dataEnd = de;
      const fm = dictStr.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/);
      filter = fm ? fm[1] : '';
      if (es >= 0) re.lastIndex = es + 9;                 // skip binary body so it can't spawn false objects
    } else dictStr = whole.slice(objStart, boundary);
    objs[num] = { num: num, dictStr: dictStr, hasStream: hasStream, dataStart: dataStart, dataEnd: dataEnd, filter: filter };
  }
  return objs;
}

// Value of /Key that is a dict: inline `<< … >>` (balanced) or an indirect `N 0 R` resolved via objs. Returns the dict string or null.
function _pdfDictAfter(str, key, objs) {
  const m = new RegExp('\\/' + key + '\\s*').exec(str);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < str.length && _pdfIsWS(str[i])) i++;
  if (str[i] === '<' && str[i + 1] === '<') {
    let depth = 1, j = i + 2;
    while (j < str.length && depth > 0) { if (str[j] === '<' && str[j + 1] === '<') { depth++; j += 2; } else if (str[j] === '>' && str[j + 1] === '>') { depth--; j += 2; } else j++; }
    return str.slice(i, j);
  }
  const rm = /^(\d+)\s+\d+\s+R/.exec(str.slice(i));
  if (rm && objs) { const o = objs[parseInt(rm[1], 10)]; if (o) return o.dictStr; }
  return null;
}

// Map of XObject resource name -> object number, from a /Resources dict.
function _pdfXObjectMap(resDict, objs) {
  const map = {};
  if (!resDict) return map;
  const xo = _pdfDictAfter(resDict, 'XObject', objs);
  if (!xo) return map;
  const re = /\/([A-Za-z0-9.\-_]+)\s+(\d+)\s+\d+\s+R/g; let m;
  while ((m = re.exec(xo))) map[m[1]] = parseInt(m[2], 10);
  return map;
}

// Decoded content string(s) a page's /Contents points to (single ref or array of refs).
function _pdfPageContents(pg, objs, u8) {
  const out = [];
  let refs = [];
  const arrM = pg.dictStr.match(/\/Contents\s*\[([^\]]*)\]/);
  if (arrM) { const rm = arrM[1].match(/(\d+)\s+\d+\s+R/g) || []; refs = rm.map(x => parseInt(x, 10)); }
  else { const r = pg.dictStr.match(/\/Contents\s+(\d+)\s+\d+\s+R/); if (r) refs = [parseInt(r[1], 10)]; }
  for (const rn of refs) { const c = _pdfGetStreamContent(objs[rn], u8); if (c) out.push(c); }
  return out;
}

// Fallback: filter-agnostic stream scan for PDFs whose page tree isn't reachable (e.g. pages in an ObjStm).
function _pdfDictBefore(whole, si) { return whole.slice(Math.max(0, si - 4000), si); }
function _pdfHeuristicScan(whole, u8, out, opts, stats) {
  let idx = 0;
  for (;;) {
    const si = whole.indexOf('stream', idx);
    if (si < 0) break;
    if (whole.substr(si - 3, 3) === 'end') { idx = si + 6; continue; }
    let ds = si + 6; if (whole[ds] === '\r') ds++; if (whole[ds] === '\n') ds++;
    const ei = whole.indexOf('endstream', ds);
    if (ei < 0) { idx = si + 6; continue; }
    const dict = _pdfDictBefore(whole, si);
    let dend = ei; if (whole[dend - 1] === '\n') dend--; if (whole[dend - 1] === '\r') dend--;
    const lenM = dict && dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/g);
    if (lenM) { const L = parseInt(lenM[lenM.length - 1].replace(/\/Length\s+/, ''), 10); if (ds + L <= u8.length) dend = ds + L; }
    const filM = dict && dict.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/g);
    const filter = filM ? filM[filM.length - 1] : '';
    let content = null; const raw = u8.subarray(ds, dend);
    if (/FlateDecode/.test(filter)) { try { const inf = pdfInflate(raw); content = _pdfU8ToStr(inf, 0, inf.length); } catch (e) { content = null; } }
    else if (!filter) content = _pdfU8ToStr(raw, 0, raw.length);
    if (content && _pdfLooksLikeContent(content)) { try { _pdfInterpretContent(content, out, opts, { stats: stats }); } catch (e) {} }
    idx = ei + 9;
  }
}

// Main entry: Uint8Array of a PDF -> array of {pts,closed} loops in inches (CAD y-up).
function parsePDFVectors(u8, opts) {
  const whole = _pdfU8ToStr(u8, 0, u8.length);
  const objs = _pdfScanObjects(whole, u8);
  const out = [];
  const stats = { text: 0 };
  const pages = [];
  for (const k in objs) { const o = objs[k]; if (/\/Type\s*\/Page\b/.test(o.dictStr) && !/\/Type\s*\/Pages\b/.test(o.dictStr)) pages.push(o); }
  for (const pg of pages) {
    const resDict = _pdfDictAfter(pg.dictStr, 'Resources', objs);
    const xmap = _pdfXObjectMap(resDict, objs);
    for (const cs of _pdfPageContents(pg, objs, u8)) {
      try { _pdfInterpretContent(cs, out, opts, { objs: objs, u8: u8, resourcesDict: resDict, xobjMap: xmap, seen: {}, stats: stats }); } catch (e) {}
    }
  }
  if (out.length === 0) _pdfHeuristicScan(whole, u8, out, opts, stats);   // page tree unreachable -> best-effort scan
  out.hasLiveText = stats.text > 0;   // live text was shown but can't be cut (fonts not outlined)
  out.textShows = stats.text;
  return out;
}
