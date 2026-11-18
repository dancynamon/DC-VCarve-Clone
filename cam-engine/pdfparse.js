// PDFPARSE — vector-PDF / .ai importer shared by Vector Studio and the CAD/CAM studio.
// CANONICAL COPY: this file lives in aquamentor-vector-studio/engine/pdfparse.js.
// aquamentor-cadcam vendors it byte-for-byte as cam-engine/pdfparse.js (tools/sync-pdfparse.sh
// there copies it and pins its sha256; cadcam's test fails if the copy drifts). Edit it HERE.
//
// One content-stream interpreter, two outputs:
//  - parsePDFDoc (Vector Studio): first page only; cubic beziers PRESERVED as path commands,
//    graphics state tracked (fill/stroke color via rg/RG g/G k/K sc/scn, line width, winding
//    rule), live text emitted as text shapes; document space (points, y-down).
//  - parsePDFVectors (CAD/CAM): every page overlaid; curves flattened to `opts.tol`-inch chords;
//    [{pts, closed}] loops in inches, y-up (PDF device space / 72). Live text is not cuttable,
//    so it is only counted (`.hasLiveText`, `.textShows`) for the UI to say "outline the fonts".
// Modern .ai files are PDF-compatible, so this reads them too. Known gaps: clip regions as
// geometry, inline images, filters other than Flate/ASCII85, objects packed in object streams (ObjStm).
// Pure — no DOM. In node: require; in browser: window.PDFPARSE via build concat. The bare
// globals parsePDFVectors/pdfInflate at the bottom are what cadcam's bundle and vm tests call.
const PDFPARSE = (() => {
  'use strict';

  // ---- byte <-> latin1 string (offsets preserved 1:1) ----
  function u8str(u8, s, e) {
    s = s || 0; e = (e == null ? u8.length : e);
    let out = ''; const CH = 0x8000;
    for (let i = s; i < e; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + CH)));
    return out;
  }

  // ---- DEFLATE / zlib inflate (RFC 1950/1951), synchronous & pure ----
  function pdfInflate(input) {
    let ip = 0;
    if (input.length >= 2) {
      const cmf = input[0], flg = input[1];
      if ((cmf & 0x0f) === 8 && (((cmf << 8) | flg) % 31) === 0) { ip = 2; if (flg & 0x20) ip += 4; }
    }
    let pos = ip, bitBuf = 0, bitCnt = 0;
    const out = [];
    function getbit() {
      if (bitCnt === 0) { if (pos >= input.length) throw new Error('inflate: unexpected end of data'); bitBuf = input[pos++]; bitCnt = 8; }
      const b = bitBuf & 1; bitBuf >>= 1; bitCnt--; return b;
    }
    function getbits(k) { let v = 0; for (let i = 0; i < k; i++) v |= getbit() << i; return v; }
    function buildHuff(lengths, num) {
      const count = new Array(16).fill(0);
      for (let i = 0; i < num; i++) count[lengths[i]]++;
      count[0] = 0;
      const offs = new Array(16).fill(0);
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
      const symbols = new Array(num);
      for (let i = 0; i < num; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
      return { count, symbols };
    }
    function decode(h) {
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
    const fll = new Array(288); for (let i = 0; i < 288; i++) fll[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    const fdl = new Array(30).fill(5);
    const fixedLit = buildHuff(fll, 288), fixedDist = buildHuff(fdl, 30);
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
      if (type === 0) {
        bitCnt = 0;
        const len = input[pos] | (input[pos + 1] << 8); pos += 4;
        if (pos + len > input.length) throw new Error('inflate: unexpected end of data');   // past-the-end reads would loop forever
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

  // ---- ASCII85 (btoa-style base-85, `z` = 4 zero bytes, `~>` terminator) ----
  function ascii85(u8) {
    const out = [];
    let n = 0, cnt = 0, i = 0;
    if (u8[0] === 0x3c && u8[1] === 0x7e) i = 2;           // optional `<~` prefix
    for (; i < u8.length; i++) {
      const c = u8[i];
      if (c === 0x7e) break;                                  // `~>`
      if (c <= 0x20) continue;                                // whitespace
      if (c === 0x7a && cnt === 0) { out.push(0, 0, 0, 0); continue; }
      if (c < 0x21 || c > 0x75) throw new Error('ascii85: bad character');
      n = n * 85 + (c - 33);
      if (++cnt === 5) { out.push(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255); n = 0; cnt = 0; }
    }
    if (cnt) {
      for (let k = cnt; k < 5; k++) n = n * 85 + 84;
      for (let k = 0; k < cnt - 1; k++) out.push(n >>> (24 - 8 * k) & 255);
    }
    return Uint8Array.from(out);
  }

  // Decode raw stream bytes through its /Filter chain (applied in order). Only FlateDecode and
  // ASCII85Decode are supported; any other filter (DCT, LZW, ...) returns null, so image data
  // never reaches the interpreter or the inflater.
  function decodeStream(raw, filter) {
    let data = raw;
    for (const f of (filter || '').match(/[A-Za-z0-9]+/g) || []) {
      if (f === 'FlateDecode' || f === 'Fl') data = pdfInflate(data);
      else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
      else return null;
    }
    return u8str(data, 0, data.length);
  }

  // ---- helpers ----
  // PDF row-vector convention: result applies M first, then C.
  function mat(M, C) {
    return [
      M[0]*C[0] + M[1]*C[2], M[0]*C[1] + M[1]*C[3],
      M[2]*C[0] + M[3]*C[2], M[2]*C[1] + M[3]*C[3],
      M[4]*C[0] + M[5]*C[2] + C[4], M[4]*C[1] + M[5]*C[3] + C[5],
    ];
  }
  function isWS(c) { return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'; }
  function isDelim(c) { return c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%'; }

  function clamp01(v) { return Math.max(0, Math.min(1, +v || 0)); }
  function hx(v) { return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'); }
  function rgbHex(r, g, b) { return '#' + hx(r) + hx(g) + hx(b); }
  function cmykHex(c, m, y, k) {
    return rgbHex((1 - clamp01(c)) * (1 - clamp01(k)), (1 - clamp01(m)) * (1 - clamp01(k)), (1 - clamp01(y)) * (1 - clamp01(k)));
  }
  function scColor(ops) { // sc/scn operand-count heuristic: 4=cmyk, 3=rgb, 1=gray
    const nums = ops.filter(v => typeof v === 'number');
    if (nums.length >= 4) return cmykHex(nums[nums.length-4], nums[nums.length-3], nums[nums.length-2], nums[nums.length-1]);
    if (nums.length === 3) return rgbHex(nums[0], nums[1], nums[2]);
    if (nums.length === 1) return rgbHex(nums[0], nums[0], nums[0]);
    return '#808080'; // pattern / unknown colorspace
  }

  function looksLikeContent(s) {
    const path = /(?:^|\s)(?:m|l|c|re)(?:\s|$)/.test(s);
    const paint = /(?:^|\s)(?:f|f\*|S|s|B|b)(?:\s|$)/.test(s);
    const text = /\bBT\b[\s\S]*\bTj\b/.test(s) || /\bBT\b[\s\S]*\bTJ\b/.test(s);
    return (path && paint) || text;
  }

  // Decode a PDF literal-string body (bytes between parens) to a latin1 string.
  function decodePdfStr(raw) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== '\\') { out += c; continue; }
      const nx = raw[i + 1];
      if (nx === 'n') { out += '\n'; i++; }
      else if (nx === 'r') { out += '\r'; i++; }
      else if (nx === 't') { out += '\t'; i++; }
      else if (nx === 'b') { out += '\b'; i++; }
      else if (nx === 'f') { out += '\f'; i++; }
      else if (nx === '(' || nx === ')' || nx === '\\') { out += nx; i++; }
      else if (nx >= '0' && nx <= '7') {
        let oct = nx; i++;
        for (let k = 0; k < 2 && raw[i + 1] >= '0' && raw[i + 1] <= '7'; k++) { oct += raw[i + 1]; i++; }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else if (nx === '\n') { i++; }                       // line continuation
      else if (nx === '\r') { i++; if (raw[i + 1] === '\n') i++; }
      else if (nx != null) { out += nx; i++; }
    }
    return out;
  }

  // ---- content-stream interpreter ----
  // Emits {cmds (device space, y-up), fill, stroke, fillRule?} into out[].

  // ---- Vector Studio only: color spaces, functions, shadings, images. CAD/CAM never reaches these. ----
  function tokensOf(t) {   // PDF object text -> nested tokens: names keep '/', refs become {ref:n}, arrays are arrays, dicts stay {dict:text}
    let i = 0;
    function val() {
      while (i < t.length && isWS(t[i])) i++;
      if (i >= t.length) return undefined;
      const c = t[i];
      if (c === '[') { i++; const a = []; for (;;) { while (i < t.length && isWS(t[i])) i++; if (i >= t.length || t[i] === ']') { i++; return a; } const v = val(); if (v === undefined) return a; a.push(v); } }
      if (c === '<' && t[i + 1] === '<') { const st = i; let d = 1; i += 2; while (i < t.length && d > 0) { if (t[i] === '<' && t[i + 1] === '<') { d++; i += 2; } else if (t[i] === '>' && t[i + 1] === '>') { d--; i += 2; } else i++; } return { dict: t.slice(st, i) }; }
      if (c === '<') { const st = ++i; while (i < t.length && t[i] !== '>') i++; const h = t.slice(st, i++).replace(/\s/g, ''); let o = ''; for (let k = 0; k < h.length; k += 2) o += String.fromCharCode(parseInt(h.substr(k, 2).padEnd(2, '0'), 16)); return { str: o }; }
      if (c === '(') { const st = ++i; let d = 1, o = ''; while (i < t.length && d > 0) { const ch = t[i++]; if (ch === '\\') { const e = t[i++]; if (/[0-7]/.test(e)) { let oc = e; while (oc.length < 3 && /[0-7]/.test(t[i])) oc += t[i++]; o += String.fromCharCode(parseInt(oc, 8)); } else o += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[e] || e; continue; } if (ch === '(') d++; else if (ch === ')' && --d === 0) break; o += ch; } return { str: o, st }; }
      if (c === '/') { const st = i++; while (i < t.length && !isDelim(t[i]) && !isWS(t[i])) i++; return t.slice(st, i); }
      if (c === ']' || c === '>') { i++; return val(); }
      const st = i; while (i < t.length && !isDelim(t[i]) && !isWS(t[i])) i++;
      const w = t.slice(st, i);
      if (w === '') { i++; return val(); }
      const num = +w;
      if (!isNaN(num)) {
        const m = /^\s+(\d+)\s+R\b/.exec(t.slice(i, i + 24));
        if (m) { i += m[0].length; return { ref: num }; }
        return num;
      }
      return w;
    }
    return val();
  }
  function deref(v, objs) {   // {ref} -> token value of that object
    let guard = 0;
    while (v && v.ref != null && guard++ < 16) { const o = objs[v.ref]; if (!o) return null; v = tokensOf(o.dictStr); if (v && typeof v === 'object' && v.dict != null) v.obj = o; }
    return v;
  }
  function dictGet(d, key, objs) {   // value of /key in a dict token or text (key match is exact), dereferenced once
    const text = typeof d === 'string' ? d : d && d.dict;
    if (!text) return undefined;
    const t = text.replace(/^\s*<</, '').replace(/>>\s*$/, '');
    let i = 0, depth = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '(') { let e = 1; i++; while (i < t.length && e > 0) { if (t[i] === '\\') i++; else if (t[i] === '(') e++; else if (t[i] === ')') e--; i++; } continue; }
      if (c === '[' || (c === '<' && t[i + 1] === '<')) { depth++; i += c === '[' ? 1 : 2; continue; }
      if (c === ']' || (c === '>' && t[i + 1] === '>')) { depth--; i += c === ']' ? 1 : 2; continue; }
      if (c === '/' && depth === 0) {
        const st = ++i; while (i < t.length && !isDelim(t[i]) && !isWS(t[i])) i++;
        if (t.slice(st, i) === key) { return deref(tokensOf(t.slice(i)), objs); }
        // skip this key's value
        while (i < t.length && isWS(t[i])) i++;
        if (t[i] === '/') { i++; while (i < t.length && !isDelim(t[i]) && !isWS(t[i])) i++; }
        continue;
      }
      i++;
    }
    return undefined;
  }
  function resLookup(resDict, cat, name, objs) { const c = resDict && dictGet(resDict, cat, objs); return c && dictGet(c, name, objs); }

  function evalPS(toks, input) {   // Type 4 calculator function
    const st = input.slice();
    function run(prog) {
      for (let i = 0; i < prog.length; i++) {
        const t = prog[i];
        if (typeof t === 'number') { st.push(t); continue; }
        if (Array.isArray(t)) { const n = prog[i + 1]; if (n === 'if') { if (st.pop()) run(t); i++; } else if (Array.isArray(n) && prog[i + 2] === 'ifelse') { run(st.pop() ? t : n); i += 2; } continue; }
        const a = () => st.pop();
        switch (t) {
          case 'dup': st.push(st[st.length - 1]); break; case 'pop': a(); break;
          case 'exch': { const y = a(), x = a(); st.push(y, x); break; }
          case 'index': { const n = a(); st.push(st[st.length - 1 - n]); break; }
          case 'copy': { const n = a(); st.push(...st.slice(st.length - n)); break; }
          case 'roll': { let j = a(); const n = a(); if (n > 0) { const part = st.splice(st.length - n, n); j = ((j % n) + n) % n; st.push(...part.slice(n - j), ...part.slice(0, n - j)); } break; }
          case 'add': { const y = a(); st.push(a() + y); break; } case 'sub': { const y = a(); st.push(a() - y); break; }
          case 'mul': { const y = a(); st.push(a() * y); break; } case 'div': { const y = a(); st.push(y ? a() / y : (a(), 0)); break; }
          case 'neg': st.push(-a()); break; case 'abs': st.push(Math.abs(a())); break; case 'sqrt': st.push(Math.sqrt(a())); break;
          case 'exp': { const y = a(); st.push(Math.pow(a(), y)); break; }
          case 'gt': { const y = a(); st.push(a() > y); break; } case 'lt': { const y = a(); st.push(a() < y); break; }
          case 'ge': { const y = a(); st.push(a() >= y); break; } case 'le': { const y = a(); st.push(a() <= y); break; }
          case 'eq': { const y = a(); st.push(a() === y); break; } case 'ne': { const y = a(); st.push(a() !== y); break; }
          case 'and': { const y = a(); st.push(a() & y); break; } case 'or': { const y = a(); st.push(a() | y); break; }
          case 'not': st.push(!a()); break; case 'true': st.push(true); break; case 'false': st.push(false); break;
          case 'floor': st.push(Math.floor(a())); break; case 'ceiling': st.push(Math.ceil(a())); break;
          case 'round': st.push(Math.round(a())); break; case 'truncate': st.push(Math.trunc(a())); break;
          default: break;
        }
      }
    }
    run(toks);
    return st.map(Number);
  }
  function parsePSProg(s) {   // "{ dup 0.5 mul }" -> nested arrays
    const w = s.replace(/[{}]/g, ' $& ').trim().split(/\s+/);
    let i = 0;
    function block() { const o = []; while (i < w.length) { const t = w[i++]; if (t === '{') o.push(block()); else if (t === '}') return o; else o.push(isNaN(+t) ? t : +t); } return o; }
    const top = block();
    return Array.isArray(top[0]) ? top[0] : top;
  }
  function makeFunction(v, objs, u8) {   // -> f(number[]) -> number[]
    if (Array.isArray(v)) { const fs = v.map(x => makeFunction(deref(x, objs), objs, u8)); return x => [].concat(...fs.map(f => f(x))); }
    v = deref(v, objs);
    if (!v || !v.dict) return null;
    const type = dictGet(v, 'FunctionType', objs);
    const domain = (dictGet(v, 'Domain', objs) || [0, 1]).map(Number);
    const clampIn = x => x.map((val, i) => Math.max(domain[2 * i] != null ? domain[2 * i] : 0, Math.min(domain[2 * i + 1] != null ? domain[2 * i + 1] : 1, val)));
    if (type === 2) {
      const c0 = dictGet(v, 'C0', objs) || [0], c1 = dictGet(v, 'C1', objs) || [1], N = dictGet(v, 'N', objs) || 1;
      return x => { const t = Math.pow(clampIn(x)[0], N); return c0.map((a, i) => a + t * (c1[i] - a)); };
    }
    if (type === 3) {
      const fns = (dictGet(v, 'Functions', objs) || []).map(f => makeFunction(deref(f, objs), objs, u8));
      const bounds = (dictGet(v, 'Bounds', objs) || []).map(Number), enc = (dictGet(v, 'Encode', objs) || []).map(Number);
      return x => {
        const t = clampIn(x)[0];
        let k = 0; while (k < bounds.length && t >= bounds[k]) k++;
        k = Math.min(k, fns.length - 1);
        const lo = k === 0 ? domain[0] : bounds[k - 1], hi = k === bounds.length ? domain[1] : bounds[k];
        const e0 = enc[2 * k], e1 = enc[2 * k + 1];
        return fns[k]([hi === lo ? e0 : e0 + (t - lo) * (e1 - e0) / (hi - lo)]);
      };
    }
    const o = v.obj;
    if (type === 4 && o) {
      const prog = parsePSProg(getStreamContent(o, u8) || '');
      return x => evalPS(prog, clampIn(x));
    }
    if (type === 0 && o) {
      const size = dictGet(v, 'Size', objs), bps = dictGet(v, 'BitsPerSample', objs), range = dictGet(v, 'Range', objs).map(Number);
      const nOut = range.length / 2, nIn = size.length;
      const enc = dictGet(v, 'Encode', objs) || [].concat(...size.map(n => [0, n - 1]));
      const dec = dictGet(v, 'Decode', objs) || range;
      const raw = decodeBytes(u8.subarray(o.dataStart, o.dataEnd), o.filter);
      if (!raw) return null;
      const maxv = Math.pow(2, bps) - 1;
      const sample = idx => { let pos = idx * bps, val = 0; for (let b = 0; b < bps; b += 8 - (pos + b) % 8 > bps - b ? bps - b : 8 - (pos + b) % 8) { const p = pos + b, take = Math.min(8 - p % 8, bps - b); val = val * Math.pow(2, take) + ((raw[p >> 3] >> (8 - p % 8 - take)) & ((1 << take) - 1)); } return val; };
      return x => {
        const inp = clampIn(x);
        let idx0 = 0, mul = 1, frac = 0, step = 0;
        inp.forEach((val, i) => {
          const d0 = domain[2 * i], d1 = domain[2 * i + 1];
          let e = enc[2 * i] + (val - d0) * (enc[2 * i + 1] - enc[2 * i]) / ((d1 - d0) || 1);
          e = Math.max(0, Math.min(size[i] - 1, e));
          const fl = i === 0 ? Math.floor(e) : Math.round(e);
          if (i === 0) { frac = e - fl; step = fl < size[0] - 1 ? nOut : 0; }
          idx0 += fl * mul; mul *= size[i];
        });
        void nIn;
        const out = [];
        for (let j = 0; j < nOut; j++) {
          const a = sample(idx0 * nOut + j), b = step ? sample(idx0 * nOut + j + step) : a;
          out.push(dec[2 * j] + (a + (b - a) * frac) * (dec[2 * j + 1] - dec[2 * j]) / maxv);
        }
        return out;
      };
    }
    return null;
  }
  function labHex(c) {
    const fy = (c[0] + 16) / 116, fx = fy + c[1] / 500, fz = fy - c[2] / 200;
    const g = t => t > 6 / 29 ? t * t * t : 3 * 36 / 841 * (t - 4 / 29);
    const X = 0.9505 * g(fx), Y = g(fy), Z = 1.089 * g(fz);
    const gam = v => { v = Math.max(0, v); return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };
    return rgbHex(gam(3.2406 * X - 1.5372 * Y - 0.4986 * Z), gam(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), gam(0.0557 * X - 0.204 * Y + 1.057 * Z));
  }
  const CS_GRAY = { n: 1, hex: c => rgbHex(c[0], c[0], c[0]), init: [0] };
  const CS_RGB = { n: 3, hex: c => rgbHex(c[0], c[1], c[2]), init: [0, 0, 0] };
  const CS_CMYK = { n: 4, hex: c => cmykHex(c[0], c[1], c[2], c[3]), init: [0, 0, 0, 1] };
  function parseCS(v, objs, u8, res, depth) {
    depth = depth || 0;
    v = deref(v, objs);
    if (depth > 6 || v == null) return CS_GRAY;
    if (typeof v === 'string') {
      switch (v) {
        case '/DeviceGray': case '/G': case '/CalGray': return CS_GRAY;
        case '/DeviceRGB': case '/RGB': case '/CalRGB': return CS_RGB;
        case '/DeviceCMYK': case '/CMYK': return CS_CMYK;
        case '/Pattern': return { n: 0, pattern: true, hex: () => '#808080', init: [] };
        default: { const r = resLookup(res, 'ColorSpace', v.slice(1), objs); return r ? parseCS(r, objs, u8, res, depth + 1) : CS_GRAY; }
      }
    }
    if (!Array.isArray(v)) return CS_GRAY;
    const kind = v[0];
    if (kind === '/ICCBased') {
      const st = deref(v[1], objs);
      const N = st && dictGet(st, 'N', objs);
      if (N === 3 && st.obj) { // the profile says whether these three numbers are RGB or Lab
        const prof = getStreamContent(st.obj, u8);
        if (prof && prof.slice(16, 20) === 'Lab ') return { n: 3, hex: labHex, init: [0, 0, 0], lab: true };
      }
      return N === 4 ? CS_CMYK : N === 1 ? CS_GRAY : CS_RGB;
    }
    if (kind === '/CalRGB') return CS_RGB;
    if (kind === '/CalGray') return CS_GRAY;
    if (kind === '/Lab') return { n: 3, hex: labHex, init: [0, 0, 0], lab: true };
    if (kind === '/Pattern') return { n: 0, pattern: true, base: v[1] ? parseCS(v[1], objs, u8, res, depth + 1) : null, hex: () => '#808080', init: [] };
    if (kind === '/Separation' || kind === '/DeviceN') {
      const names = kind === '/Separation' ? [v[1]] : deref(v[1], objs) || [];
      const alt = parseCS(v[2], objs, u8, res, depth + 1);
      const fn = makeFunction(v[3], objs, u8);
      const n = kind === '/Separation' ? 1 : names.length;
      return { n, init: new Array(n).fill(1), spot: names[0] && String(names[0]).slice(1), hex: c => { const o = fn ? fn(c) : null; return o ? alt.hex(o) : '#808080'; } };
    }
    if (kind === '/Indexed' || kind === '/I') {
      const base = parseCS(v[1], objs, u8, res, depth + 1);
      let tab = deref(v[3], objs), bytes = null;
      if (tab && tab.str != null) { bytes = new Uint8Array(tab.str.length); for (let i = 0; i < tab.str.length; i++) bytes[i] = tab.str.charCodeAt(i) & 255; }
      else if (tab && tab.obj) bytes = decodeBytes(u8.subarray(tab.obj.dataStart, tab.obj.dataEnd), tab.obj.filter);
      return { n: 1, init: [0], indexed: true, base, bytes, hex: c => base.hex(indexedComps(base, bytes, c[0])) };
    }
    return CS_GRAY;
  }
  function indexedComps(base, bytes, i) {
    const out = [];
    for (let k = 0; k < base.n; k++) out.push(bytes ? (bytes[i * base.n + k] || 0) / 255 : 0);
    return out;
  }
  function decodeBytes(raw, filter, stopAtImage) {
    let data = raw;
    for (const f of (filter || '').match(/[A-Za-z0-9]+/g) || []) {
      if (f === 'FlateDecode' || f === 'Fl') data = Uint8Array.from(pdfInflate(data));
      else if (f === 'ASCII85Decode' || f === 'A85') data = Uint8Array.from(ascii85(data));
      else if (f === 'ASCIIHexDecode' || f === 'AHx') { const h = u8str(data).replace(/[^0-9a-fA-F]/g, ''); const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); data = o; }
      else if (f === 'RunLengthDecode' || f === 'RL') { const o = []; for (let i = 0; i < data.length;) { const n = data[i++]; if (n === 128) break; if (n < 128) { for (let k = 0; k <= n; k++) o.push(data[i++]); } else { const b = data[i++]; for (let k = 0; k < 257 - n; k++) o.push(b); } } data = Uint8Array.from(o); }
      else if (stopAtImage && (f === 'DCTDecode' || f === 'DCT')) return { jpeg: data };
      else return null;
    }
    return data;
  }
  function unpredict(d, parms, objs) {
    const pred = parms && dictGet(parms, 'Predictor', objs);
    if (!pred || pred < 10) return d;
    const colors = dictGet(parms, 'Colors', objs) || 1, bpc = dictGet(parms, 'BitsPerComponent', objs) || 8, cols = dictGet(parms, 'Columns', objs) || 1;
    const bpp = Math.max(1, (colors * bpc) >> 3), row = Math.ceil(colors * bpc * cols / 8);
    const rows = Math.floor(d.length / (row + 1)), out = new Uint8Array(rows * row);
    for (let y = 0; y < rows; y++) {
      const t = d[y * (row + 1)], src = y * (row + 1) + 1, dst = y * row;
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - row + x] : 0, c = (x >= bpp && y) ? out[dst - row + x - bpp] : 0;
        let p = 0;
        if (t === 1) p = a; else if (t === 2) p = b; else if (t === 3) p = (a + b) >> 1;
        else if (t === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out[dst + x] = (d[src + x] + p) & 255;
      }
    }
    return out;
  }
  function b64(u8) { let s = ''; const CH = 0x6000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return typeof btoa !== 'undefined' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64'); }
  let CRCT = null;
  function crc(u8) { if (!CRCT) { CRCT = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRCT[n] = c; } } let c = -1; for (let i = 0; i < u8.length; i++) c = CRCT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  function encodePNG(rgba, w, h) {   // stored (uncompressed) PNG: pure and fast; the app recompresses through a canvas
    const rowLen = w * 4 + 1, raw = new Uint8Array(rowLen * h);
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * rowLen + 1);
    const nblocks = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + nblocks * 5 + 4);
    z[0] = 0x78; z[1] = 1;
    let p = 2, a = 1, b = 0;
    for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    for (let k = 0; k < nblocks; k++) { const st = k * 65535, n = Math.min(65535, raw.length - st); z[p++] = k === nblocks - 1 ? 1 : 0; z[p++] = n & 255; z[p++] = n >> 8; z[p++] = ~n & 255; z[p++] = (~n >> 8) & 255; z.set(raw.subarray(st, st + n), p); p += n; }
    z[p++] = b >> 8; z[p++] = b & 255; z[p++] = a >> 8; z[p++] = a & 255;
    const chunk = (type, data) => { const o = new Uint8Array(12 + data.length), L = data.length; o[0] = L >>> 24; o[1] = L >>> 16; o[2] = L >>> 8; o[3] = L; for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i); o.set(data, 8); const c = crc(o.subarray(4, 8 + L)); o[8 + L] = c >>> 24; o[9 + L] = c >>> 16; o[10 + L] = c >>> 8; o[11 + L] = c; return o; };
    const ihdr = new Uint8Array([w >>> 24, w >>> 16, w >>> 8, w, h >>> 24, h >>> 16, h >>> 8, h, 8, 6, 0, 0, 0]);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z.subarray(0, p)), chunk('IEND', new Uint8Array(0))];
    const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let q = 0; for (const x of parts) { all.set(x, q); q += x.length; }
    return 'data:image/png;base64,' + b64(all);
  }
  function maskAlpha(o, objs, u8, tw, th) {   // /SMask or stencil /Mask image -> alpha sampled at tw x th
    if (!o || !o.dictStr) return null;
    const d = '<<' + o.dictStr.replace(/^\s*<</, '').replace(/>>\s*$/, '') + '>>';
    const w = dictGet(d, 'Width', objs), h = dictGet(d, 'Height', objs), bpc = dictGet(d, 'BitsPerComponent', objs) || 1;
    const isStencil = dictGet(d, 'ImageMask', objs) === 'true' || dictGet(d, 'ImageMask', objs) === true;
    const dec = dictGet(d, 'Decode', objs);
    let raw = decodeBytes(u8.subarray(o.dataStart, o.dataEnd), o.filter);
    if (!raw) return null;
    raw = unpredict(raw, dictGet(d, 'DecodeParms', objs), objs);
    const row = Math.ceil(w * bpc / 8), out = new Uint8Array(tw * th);
    let invert = dec && dec[0] > dec[1];
    if (isStencil) invert = !invert; // a stencil's 0 bits paint
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const sx = Math.floor(x * w / tw), sy = Math.floor(y * h / th);
      let v;
      if (bpc === 8) v = raw[sy * row + sx]; else { const bit = sx * bpc; v = ((raw[sy * row + (bit >> 3)] >> (8 - (bit & 7) - bpc)) & ((1 << bpc) - 1)) * 255 / ((1 << bpc) - 1); }
      out[y * tw + x] = invert ? 255 - v : v;
    }
    return out;
  }
  // Image dict + data -> { w, h, dataURL }, or null when it cannot be decoded here.
  function decodeImage(dict, bytes, cs, objs, u8, res, fillHex, o) {
    const w = dictGet(dict, 'Width', objs) || dictGet(dict, 'W', objs), h = dictGet(dict, 'Height', objs) || dictGet(dict, 'H', objs);
    if (!(w > 0 && h > 0) || !bytes) return null;
    const stencilV = dictGet(dict, 'ImageMask', objs) != null ? dictGet(dict, 'ImageMask', objs) : dictGet(dict, 'IM', objs);
    const stencil = stencilV === 'true' || stencilV === true;
    let bpc = dictGet(dict, 'BitsPerComponent', objs) || dictGet(dict, 'BPC', objs) || (stencil ? 1 : 8);
    if (bytes.jpeg) {
      if (!dictGet(dict, 'SMask', objs)) return { w, h, dataURL: 'data:image/jpeg;base64,' + b64(bytes.jpeg) };
      return { w, h, dataURL: 'data:image/jpeg;base64,' + b64(bytes.jpeg), maskOnly: true };
    }
    const parms = dictGet(dict, 'DecodeParms', objs) || dictGet(dict, 'DP', objs);
    const d = unpredict(bytes, parms, objs);
    const rgba = new Uint8Array(w * h * 4);
    const dec = dictGet(dict, 'Decode', objs) || dictGet(dict, 'D', objs);
    if (stencil) {
      const row = (w + 7) >> 3, inv = dec && dec[0] > dec[1];
      const n = parseInt(fillHex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = (d[y * row + (x >> 3)] >> (7 - (x & 7))) & 1, on = inv ? bit === 1 : bit === 0, q = (y * w + x) * 4;
        rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = on ? 255 : 0;
      }
      return { w, h, dataURL: encodePNG(rgba, w, h) };
    }
    const n = cs.n, row = Math.ceil(w * n * bpc / 8), maxv = (1 << bpc) - 1;
    const scale = cs.lab ? null : (i, v) => { const lo = dec ? dec[2 * i] : 0, hi = dec ? dec[2 * i + 1] : 1; return lo + v * (hi - lo) / maxv; };
    const cache = new Map();
    const comps = new Array(n);
    for (let y = 0; y < h; y++) {
      const rowStart = y * row;
      for (let x = 0; x < w; x++) {
        let key = 0;
        for (let i = 0; i < n; i++) {
          let v;
          if (bpc === 8) v = d[rowStart + x * n + i];
          else if (bpc === 16) v = d[rowStart + (x * n + i) * 2];
          else { const bit = (x * n + i) * bpc; v = (d[rowStart + (bit >> 3)] >> (8 - (bit & 7) - bpc)) & maxv; }
          key = key * 256 + (v || 0);
          comps[i] = v || 0;
        }
        let px = cache.get(key);
        if (px === undefined) {
          let hex;
          if (cs.indexed) hex = cs.hex([comps[0]]);
          else if (bpc === 16) hex = cs.hex(comps.map(v => v / 255));
          else if (cs.lab) hex = cs.hex([comps[0] * 100 / 255, comps[1] - 128, comps[2] - 128]);
          else hex = cs.hex(comps.map((v, i) => scale(i, v)));
          px = parseInt(hex.slice(1), 16);
          if (cache.size < 2000000) cache.set(key, px);
        }
        const q = (y * w + x) * 4;
        rgba[q] = px >> 16 & 255; rgba[q + 1] = px >> 8 & 255; rgba[q + 2] = px & 255; rgba[q + 3] = 255;
      }
    }
    if (o) {
      const sm = /\/SMask\s+(\d+)\s+\d+\s+R/.exec(o.dictStr), mk = /\/Mask\s+(\d+)\s+\d+\s+R/.exec(o.dictStr);
      const a = sm ? maskAlpha(objs[+sm[1]], objs, u8, w, h) : mk ? maskAlpha(objs[+mk[1]], objs, u8, w, h) : null;
      if (a) for (let i = 0; i < a.length; i++) rgba[i * 4 + 3] = a[i];
    }
    return { w, h, dataURL: encodePNG(rgba, w, h) };
  }
  // Shading dict -> device-independent gradient (coords still in the shading's space).
  function parseShading(v, objs, u8, res) {
    v = deref(v, objs);
    if (!v || !v.dict) return null;
    const t = dictGet(v, 'ShadingType', objs);
    if (t !== 2 && t !== 3) return null;
    const coords = (dictGet(v, 'Coords', objs) || []).map(Number);
    const fn = makeFunction(dictGet(v, 'Function', objs), objs, u8);
    const cs = parseCS(dictGet(v, 'ColorSpace', objs), objs, u8, res);
    if (!fn) return null;
    const dom = dictGet(v, 'Domain', objs) || [0, 1];
    const stops = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      stops.push([u, cs.hex(fn([dom[0] + u * (dom[1] - dom[0])]))]);
    }
    const g = t === 2
      ? { type: 'linear', x1: coords[0], y1: coords[1], x2: coords[2], y2: coords[3], stops }
      : { type: 'radial', x1: coords[0], y1: coords[1], r1: coords[2], x2: coords[3], y2: coords[4], r2: coords[5], stops };
    return g;
  }
  function xfGrad(g, m) {
    const p1 = [m[0] * g.x1 + m[2] * g.y1 + m[4], m[1] * g.x1 + m[3] * g.y1 + m[5]];
    const p2 = [m[0] * g.x2 + m[2] * g.y2 + m[4], m[1] * g.x2 + m[3] * g.y2 + m[5]];
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const o = { ...g, x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] };
    if (g.type === 'radial') { o.r1 = g.r1 * k; o.r2 = g.r2 * k; }
    return o;
  }

  function interpret(s, out, ctx) {
    ctx = ctx || {};
    const n = s.length;
    let i = 0;
    const xobjMap = ctx.xobjMap || {};
    let gs = {
      ctm: ctx.baseCTM ? ctx.baseCTM.slice() : [1, 0, 0, 1, 0, 0],
      fill: ctx.baseFill || '#000000',
      stroke: ctx.baseStroke || '#000000',
      lw: ctx.baseLW != null ? ctx.baseLW : 1,
      fillA: ctx.baseFillA != null ? ctx.baseFillA : 1, strokeA: ctx.baseStrokeA != null ? ctx.baseStrokeA : 1,
      clips: ctx.baseClips || [], fillCS: ctx.baseFillCS || CS_GRAY, strokeCS: ctx.baseStrokeCS || CS_GRAY, fillGrad: ctx.baseFillGrad || null,
      cap: 0, join: 0, miter: 10, dash: null,
    };
    const studio = !!ctx.studio;
    const res = ctx.resourcesDict || null;
    let pendingClip = null, lastNames = [];
    const mcStack = ctx.baseMC ? ctx.baseMC.slice() : [];
    const gstack = [], ops = [], strs = [];
    let subs = [], sub = null, cur = null, start = null, lastName = null;
    // text state (BT..ET)
    let tm = [1, 0, 0, 1, 0, 0], tlm = tm.slice(), fontSize = 12, leading = 0;
    function emitText(str) {
      if (ctx.stats) ctx.stats.text++;   // every show op is live text, even hex <..> strings we can't decode
      if (str == null || str === '') return;
      out.push({ type: 'text', text: str, size: fontSize, fill: gs.fill, _dev: mat(tm, gs.ctm) });
    }

    const tf = (x, y) => [gs.ctm[0]*x + gs.ctm[2]*y + gs.ctm[4], gs.ctm[1]*x + gs.ctm[3]*y + gs.ctm[5]];
    const scaleF = () => Math.sqrt(Math.abs(gs.ctm[0]*gs.ctm[3] - gs.ctm[1]*gs.ctm[2])) || 1;

    function newsub(x, y) {
      const p = tf(x, y);
      sub = { cmds: [['M', p[0], p[1]]], closed: false };
      subs.push(sub);
      cur = [x, y]; start = [x, y];
    }
    function lineTo(x, y) {
      if (!sub) { newsub(x, y); return; }
      const p = tf(x, y);
      sub.cmds.push(['L', p[0], p[1]]);
      cur = [x, y];
    }
    function curveTo(x1, y1, x2, y2, x3, y3) {
      if (!sub) newsub(cur ? cur[0] : x1, cur ? cur[1] : y1);
      const a = tf(x1, y1), b = tf(x2, y2), c = tf(x3, y3);
      sub.cmds.push(['C', a[0], a[1], b[0], b[1], c[0], c[1]]);
      cur = [x3, y3];
    }
    function rectOp(x, y, w, h) {
      newsub(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h);
      sub.closed = true; cur = [x, y]; sub = null;
    }
    function closepath() { if (sub) { sub.closed = true; if (start) cur = [start[0], start[1]]; } }
    function clearPath() { subs = []; sub = null; cur = null; start = null; }
    function emit(fill, stroke, evenodd, forceClose) {
      const cmds = [];
      for (const sp of subs) {
        if (sp.cmds.length < 2) continue; // lone moveto paints nothing
        cmds.push(...sp.cmds);
        if (sp.closed || forceClose) cmds.push(['Z']);
      }
      if (cmds.length) {
        let w = gs.lw * scaleF();
        if (!isFinite(w) || w <= 0) w = 0.5; // `0 w` = thinnest device line
        const shape = {
          cmds,
          fill: fill ? gs.fill : null,
          stroke: stroke ? { color: gs.stroke, w } : null,
        };
        if (evenodd) shape.fillRule = 'evenodd';
        if (studio) {
          if (fill && stroke ? gs.fillA < 1 : fill ? gs.fillA < 1 : gs.strokeA < 1) shape.opacity = fill ? gs.fillA : gs.strokeA;
          if (fill && gs.fillGrad) shape.grad = gs.fillGrad;
          if (stroke) {
            const st = shape.stroke;
            if (gs.cap) st.cap = gs.cap === 1 ? 'round' : 'square';
            if (gs.join) st.join = gs.join === 1 ? 'round' : 'bevel';
            if (gs.miter !== 10) st.miter = gs.miter;
            if (gs.dash && gs.dash.length) st.dash = gs.dash.map(v => v * scaleF());
          }
          if (gs.clips.length) shape.clip = gs.clips;
          const oc = mcStack.filter(Boolean).pop();
          if (oc) shape.layerName = oc;
        }
        out.push(shape);
      }
      applyPendingClip();
      clearPath();
    }
    function applyPendingClip() {
      if (!studio || !pendingClip) { pendingClip = null; return; }
      const cmds = [];
      for (const sp of subs) { if (sp.cmds.length >= 2) { cmds.push(...sp.cmds); cmds.push(['Z']); } }
      if (cmds.length) gs.clips = gs.clips.concat([{ id: ++ctx.stats.clipId, cmds, rule: pendingClip }]);
      pendingClip = null;
    }
    function paintShading(name) {
      const g = parseShading(resLookup(res, 'Shading', name, ctx.objs), ctx.objs, ctx.u8, res);
      if (!g) { if (ctx.stats) ctx.stats.unsupported = (ctx.stats.unsupported || 0) + 1; return; }
      const top = gs.clips[gs.clips.length - 1];
      if (!top) return;
      const shape = { cmds: top.cmds, fill: g.stops[0][1], stroke: null, grad: xfGrad(g, gs.ctm), clip: gs.clips.slice(0, -1) };
      if (top.rule === 'evenodd') shape.fillRule = 'evenodd';
      if (gs.fillA < 1) shape.opacity = gs.fillA;
      if (!shape.clip.length) delete shape.clip;
      out.push(shape);
    }
    function setPattern(name, stroke) {
      const p = resLookup(res, 'Pattern', name, ctx.objs);
      let g = null;
      if (p && dictGet(p, 'PatternType', ctx.objs) === 2) {
        g = parseShading(dictGet(p, 'Shading', ctx.objs), ctx.objs, ctx.u8, res);
        if (g) { const M = (dictGet(p, 'Matrix', ctx.objs) || [1, 0, 0, 1, 0, 0]).map(Number); g = xfGrad(g, mat(M, ctx.baseCTM || [1, 0, 0, 1, 0, 0])); }
      }
      if (!g) { if (ctx.stats) ctx.stats.unsupported = (ctx.stats.unsupported || 0) + 1; }
      if (stroke) { gs.stroke = g ? g.stops[g.stops.length >> 1][1] : '#808080'; return; }
      gs.fill = g ? g.stops[g.stops.length >> 1][1] : '#808080';
      gs.fillGrad = g;
    }
    function setColor(stroke) {
      const cs = stroke ? gs.strokeCS : gs.fillCS;
      const nums = ops.filter(v => typeof v === 'number');
      if (cs.pattern) { if (lastName) setPattern(lastName, stroke); return; }
      const hex = cs.hex(nums.length >= cs.n ? nums.slice(-cs.n) : nums.concat(new Array(cs.n - nums.length).fill(0)));
      if (stroke) gs.stroke = hex; else { gs.fill = hex; gs.fillGrad = null; }
    }
    function setSpace(stroke) {
      const cs = parseCS('/' + lastName, ctx.objs, ctx.u8, res);
      if (stroke) { gs.strokeCS = cs; gs.stroke = cs.pattern ? gs.stroke : cs.hex(cs.init); }
      else { gs.fillCS = cs; gs.fillGrad = null; if (!cs.pattern) gs.fill = cs.hex(cs.init); }
    }
    function applyExtG(name) {
      const e = resLookup(res, 'ExtGState', name, ctx.objs);
      if (!e) return;
      const ca = dictGet(e, 'ca', ctx.objs), CA = dictGet(e, 'CA', ctx.objs), LW = dictGet(e, 'LW', ctx.objs);
      if (typeof ca === 'number') gs.fillA = ca * (ctx.alphaMul != null ? ctx.alphaMul : 1);
      if (typeof CA === 'number') gs.strokeA = CA * (ctx.alphaMul != null ? ctx.alphaMul : 1);
      if (dictGet(e, 'SMask', ctx.objs) && dictGet(e, 'SMask', ctx.objs) !== '/None') ctx.stats.unsupported = (ctx.stats.unsupported || 0) + 1;
      if (typeof LW === 'number') gs.lw = LW;
    }
    function emitImage(dictObj, o, bytes) {
      const cs = parseCS(dictGet(dictObj, 'ColorSpace', ctx.objs) != null ? dictGet(dictObj, 'ColorSpace', ctx.objs) : dictGet(dictObj, 'CS', ctx.objs), ctx.objs, ctx.u8, res);
      let img = null;
      try { img = decodeImage(dictObj, bytes, cs, ctx.objs, ctx.u8, res, gs.fill, o); } catch (e) { img = null; }
      if (!img) { ctx.stats.imagesSkipped = (ctx.stats.imagesSkipped || 0) + 1; return; }
      const shape = { type: 'image', dataURL: img.dataURL, pxW: img.w, pxH: img.h, _dev: gs.ctm.slice() };
      if (gs.fillA < 1) shape.opacity = gs.fillA;
      if (gs.clips.length) shape.clip = gs.clips;
      const oc = mcStack.filter(Boolean).pop();
      if (oc) shape.layerName = oc;
      out.push(shape);
    }
    function doXObject(name) {
      if (!name || !ctx.objs) return;
      const on = xobjMap[name];
      if (on == null || (ctx.seen && ctx.seen[on])) return;
      const o = ctx.objs[on];
      if (studio && o && /\/Subtype\s*\/Image\b/.test(o.dictStr)) {
        const d = '<<' + o.dictStr.replace(/^\s*<</, '').replace(/>>\s*$/, '') + '>>';
        emitImage(d, o, decodeBytes(ctx.u8.subarray(o.dataStart, o.dataEnd), o.filter, true));
        return;
      }
      if (!o || !/\/Subtype\s*\/Form\b/.test(o.dictStr)) return;
      const content = getStreamContent(o, ctx.u8);
      if (!content) return;
      let M = [1, 0, 0, 1, 0, 0];
      const mm = o.dictStr.match(/\/Matrix\s*\[\s*([-0-9.eE\s]+)\]/);
      if (mm) { const nums = mm[1].trim().split(/\s+/).map(parseFloat); if (nums.length === 6 && nums.every(x => !isNaN(x))) M = nums; }
      const childRes = dictAfter(o.dictStr, 'Resources', ctx.objs) || ctx.resourcesDict || null;
      const seen2 = {}; if (ctx.seen) for (const k in ctx.seen) seen2[k] = true; seen2[on] = true;
      interpret(content, out, {
        objs: ctx.objs, u8: ctx.u8, baseCTM: mat(M, gs.ctm),
        baseFill: gs.fill, baseStroke: gs.stroke, baseLW: gs.lw,
        xobjMap: xobjectMap(childRes, ctx.objs), resourcesDict: childRes, seen: seen2, stats: ctx.stats,
        studio, baseFillA: gs.fillA, baseStrokeA: gs.strokeA, baseClips: gs.clips, baseMC: mcStack, alphaMul: gs.fillA, baseFillCS: gs.fillCS, baseStrokeCS: gs.strokeCS, baseFillGrad: gs.fillGrad,
      });
    }

    function inlineImage(i0) {
      const idAt = s.indexOf('ID', i0);
      const end = skipInlineImage(s, i0);
      if (idAt < 0) return end;
      const dict = '<<' + s.slice(i0, idAt) + '>>';
      let st = idAt + 2; if (isWS(s[st])) st++;
      let en = end - 2; while (en > st && isWS(s[en - 1])) en--;
      const data = new Uint8Array(en - st);
      for (let k = st; k < en; k++) data[k - st] = s.charCodeAt(k) & 255;
      const f = dictGet(dict, 'F', ctx.objs) != null ? dictGet(dict, 'F', ctx.objs) : dictGet(dict, 'Filter', ctx.objs);
      const flt = f == null ? '' : Array.isArray(f) ? f.join(' ') : String(f);
      let bytes = null;
      try { bytes = decodeBytes(data, flt.replace(/\//g, ' '), true); } catch (e) { bytes = null; }
      emitImage(dict, null, bytes);
      return end;
    }

    function dispatch(op) {
      switch (op) {
        case 'q': gstack.push({ ...gs, ctm: gs.ctm.slice() }); break;
        case 'Q': if (gstack.length) gs = gstack.pop(); break;
        case 'cm': { const a = ops.slice(-6); if (a.length === 6) gs.ctm = mat(a, gs.ctm); break; }
        case 'w': gs.lw = +ops[ops.length - 1] || 0; break;
        // color
        case 'rg': { const a = ops.slice(-3); gs.fill = rgbHex(a[0], a[1], a[2]); gs.fillCS = CS_RGB; gs.fillGrad = null; break; }
        case 'RG': { const a = ops.slice(-3); gs.stroke = rgbHex(a[0], a[1], a[2]); gs.strokeCS = CS_RGB; break; }
        case 'g': { const v = ops[ops.length - 1]; gs.fill = rgbHex(v, v, v); gs.fillCS = CS_GRAY; gs.fillGrad = null; break; }
        case 'G': { const v = ops[ops.length - 1]; gs.stroke = rgbHex(v, v, v); gs.strokeCS = CS_GRAY; break; }
        case 'k': { const a = ops.slice(-4); gs.fill = cmykHex(a[0], a[1], a[2], a[3]); gs.fillCS = CS_CMYK; gs.fillGrad = null; break; }
        case 'K': { const a = ops.slice(-4); gs.stroke = cmykHex(a[0], a[1], a[2], a[3]); gs.strokeCS = CS_CMYK; break; }
        case 'sc': case 'scn': if (studio) setColor(false); else gs.fill = scColor(ops); break;
        case 'SC': case 'SCN': if (studio) setColor(true); else gs.stroke = scColor(ops); break;
        case 'cs': if (studio) setSpace(false); break;
        case 'CS': if (studio) setSpace(true); break;
        case 'gs': if (studio && lastName) applyExtG(lastName); break;
        case 'sh': if (studio && lastName) paintShading(lastName); break;
        case 'W': if (studio) pendingClip = 'nonzero'; break;
        case 'W*': if (studio) pendingClip = 'evenodd'; break;
        case 'J': gs.cap = +ops[ops.length - 1] || 0; break;
        case 'j': gs.join = +ops[ops.length - 1] || 0; break;
        case 'M': gs.miter = +ops[ops.length - 1] || 10; break;
        case 'd': if (studio) gs.dash = ctx.lastDash || null; break;
        case 'BDC': if (studio) { const p = lastName && resLookup(res, 'Properties', lastName, ctx.objs); const nm = p && dictGet(p, 'Type', ctx.objs) === '/OCG' ? dictGet(p, 'Name', ctx.objs) : null; mcStack.push(nm && nm.str != null ? nm.str : null); } break;
        case 'BMC': if (studio) mcStack.push(null); break;
        case 'EMC': if (studio) mcStack.pop(); break;
        // path construction
        case 'm': { const a = ops.slice(-2); newsub(a[0], a[1]); break; }
        case 'l': { const a = ops.slice(-2); lineTo(a[0], a[1]); break; }
        case 'c': { const a = ops.slice(-6); curveTo(a[0], a[1], a[2], a[3], a[4], a[5]); break; }
        case 'v': { const a = ops.slice(-4); if (cur) curveTo(cur[0], cur[1], a[0], a[1], a[2], a[3]); break; }
        case 'y': { const a = ops.slice(-4); curveTo(a[0], a[1], a[2], a[3], a[2], a[3]); break; }
        case 're': { const a = ops.slice(-4); rectOp(a[0], a[1], a[2], a[3]); break; }
        case 'h': closepath(); break;
        // painting
        case 'S': emit(false, true, false, false); break;
        case 's': closepath(); emit(false, true, false, false); break;
        case 'f': case 'F': emit(true, false, false, true); break;
        case 'f*': emit(true, false, true, true); break;
        case 'B': emit(true, true, false, true); break;
        case 'B*': emit(true, true, true, true); break;
        case 'b': closepath(); emit(true, true, false, true); break;
        case 'b*': closepath(); emit(true, true, true, true); break;
        case 'n': applyPendingClip(); clearPath(); break;
        case 'Do': doXObject(lastName); break;
        // text
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
        case 'ET': break;
        case 'Tf': fontSize = ops.length ? (ops[ops.length - 1] || fontSize) : fontSize; break;
        case 'TL': leading = ops[ops.length - 1] || 0; break;
        case 'Td': { const a = ops.slice(-2); tlm = mat([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice(); break; }
        case 'TD': { const a = ops.slice(-2); leading = -a[1]; tlm = mat([1, 0, 0, 1, a[0], a[1]], tlm); tm = tlm.slice(); break; }
        case 'Tm': { const a = ops.slice(-6); if (a.length === 6) { tlm = a.slice(); tm = a.slice(); } break; }
        case 'T*': tlm = mat([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
        case 'Tj': emitText(strs[strs.length - 1]); break;
        case 'TJ': emitText(strs[strs.length - 1]); break;
        case "'": tlm = mat([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); emitText(strs[strs.length - 1]); break;
        case '"': tlm = mat([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); emitText(strs[strs.length - 1]); break;
        case 'BI': if (studio) i = inlineImage(i); else i = skipInlineImage(s, i); break;
        default: break;
      }
      ops.length = 0; strs.length = 0; lastName = null;
    }

    while (i < n) {
      const ch = s[i];
      if (isWS(ch)) { i++; continue; }
      if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (ch === '(') { const st = i + 1; let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } strs.push(decodePdfStr(s.slice(st, i - 1))); ops.push(0); continue; }
      if (ch === '<') {
        if (s[i + 1] === '<') { let d = 1; i += 2; while (i < n && d > 0) { if (s[i] === '<' && s[i + 1] === '<') { d++; i += 2; } else if (s[i] === '>' && s[i + 1] === '>') { d--; i += 2; } else i++; } continue; }
        i++; while (i < n && s[i] !== '>') i++; i++; ops.push(0); continue;
      }
      if (ch === '[') {
        const arrStart = i;
        i++; let combined = '';
        while (i < n && s[i] !== ']') {
          if (s[i] === '(') { const st = i + 1; let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } combined += decodePdfStr(s.slice(st, i - 1)); }
          else i++;
        }
        if (studio) { const nums = s.slice(arrStart + 1, i).trim().split(/\s+/).map(Number).filter(v => !isNaN(v)); ctx.lastDash = nums; }
        i++; strs.push(combined); ops.push(0); continue;
      }
      if (ch === ']' || ch === '{' || ch === '}' || ch === ')') { i++; continue; }
      if (ch === '/') { const st = i + 1; i = st; while (i < n && !isDelim(s[i]) && !isWS(s[i])) i++; lastName = s.slice(st, i); continue; }
      if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) {
        let j = i + 1; while (j < n) { const c = s[j]; if ((c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+' || c === 'e' || c === 'E') j++; else break; }
        const num = parseFloat(s.slice(i, j)); ops.push(isNaN(num) ? 0 : num); i = j; continue;
      }
      let j = i; while (j < n && !isDelim(s[j]) && !isWS(s[j])) j++;
      const op = s.slice(i, j); i = j;
      dispatch(op);
    }
  }

  function skipInlineImage(s, i) {
    const id = s.indexOf('ID', i);
    if (id < 0) return s.length;
    let k = id + 2;
    while (k < s.length - 1) {
      if (s[k] === 'E' && s[k + 1] === 'I' && (k + 2 >= s.length || isWS(s[k + 2])) && isWS(s[k - 1])) return k + 2;
      k++;
    }
    return s.length;
  }

  // ---- object map + resources ----
  function getStreamContent(o, u8) {
    if (!o || !o.hasStream) return null;
    try { return decodeStream(u8.subarray(o.dataStart, o.dataEnd), o.filter); } catch (e) { return null; }
  }

  function scanObjects(whole, u8) {
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
        const lm = dictStr.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/);   // \b: `/Length 12 0 R` must not read as 1
        if (lm) { const L = parseInt(lm[1], 10); if (ds + L <= u8.length) de = ds + L; }
        dataStart = ds; dataEnd = de;
        const fm = dictStr.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/);
        filter = fm ? fm[1] : '';
        if (es >= 0) re.lastIndex = es + 9;
      } else dictStr = whole.slice(objStart, boundary);
      objs[num] = { num, dictStr, hasStream, dataStart, dataEnd, filter };
    }
    return objs;
  }

  function dictAfter(str, key, objs) {
    const m = new RegExp('\\/' + key + '\\s*').exec(str);
    if (!m) return null;
    let i = m.index + m[0].length;
    while (i < str.length && isWS(str[i])) i++;
    if (str[i] === '<' && str[i + 1] === '<') {
      let depth = 1, j = i + 2;
      while (j < str.length && depth > 0) { if (str[j] === '<' && str[j + 1] === '<') { depth++; j += 2; } else if (str[j] === '>' && str[j + 1] === '>') { depth--; j += 2; } else j++; }
      return str.slice(i, j);
    }
    const rm = /^(\d+)\s+\d+\s+R/.exec(str.slice(i));
    if (rm && objs) { const o = objs[parseInt(rm[1], 10)]; if (o) return o.dictStr; }
    return null;
  }

  function xobjectMap(resDict, objs) {
    const map = {};
    if (!resDict) return map;
    const xo = dictAfter(resDict, 'XObject', objs);
    if (!xo) return map;
    const re = /\/([A-Za-z0-9.\-_]+)\s+(\d+)\s+\d+\s+R/g; let m;
    while ((m = re.exec(xo))) map[m[1]] = parseInt(m[2], 10);
    return map;
  }

  // A /Contents array is one content stream split at token boundaries (graphics state set in
  // one part carries into the next), so the parts are joined and interpreted together.
  function pageContents(pg, objs, u8) {
    const out = [];
    let refs = [];
    const arrM = pg.dictStr.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arrM) { const rm = arrM[1].match(/(\d+)\s+\d+\s+R/g) || []; refs = rm.map(x => parseInt(x, 10)); }
    else { const r = pg.dictStr.match(/\/Contents\s+(\d+)\s+\d+\s+R/); if (r) refs = [parseInt(r[1], 10)]; }
    for (const rn of refs) { const c = getStreamContent(objs[rn], u8); if (c) out.push(c); }
    return out.join('\n');
  }

  // Pages in document order: walk /Root -> /Pages -> /Kids. Object numbers say nothing about page
  // order, so the object-number scan is only the fallback (no reachable tree, e.g. pages in an ObjStm).
  function isPage(o) { return /\/Type\s*\/Page\b/.test(o.dictStr) && !/\/Type\s*\/Pages\b/.test(o.dictStr); }
  function pageList(objs, whole) {
    const tree = [], seen = {};
    const ref = (str, key) => { const m = str.match(new RegExp('\\/' + key + '\\s+(\\d+)\\s+\\d+\\s+R')); return m ? parseInt(m[1], 10) : null; };
    function walk(num, depth) {
      const o = objs[num];
      if (!o || seen[num] || depth > 64) return;
      seen[num] = true;
      if (isPage(o)) { tree.push(o); return; }
      if (/\/Type\s*\/Catalog\b/.test(o.dictStr)) { const p = ref(o.dictStr, 'Pages'); if (p != null) walk(p, depth + 1); return; }
      const km = o.dictStr.match(/\/Kids\s*\[([^\]]*)\]/);
      if (km) for (const r of km[1].match(/(\d+)\s+\d+\s+R/g) || []) walk(parseInt(r, 10), depth + 1);
    }
    const roots = whole.match(/\/Root\s+\d+\s+\d+\s+R/g) || [];
    if (roots.length) walk(parseInt(roots[roots.length - 1].replace(/\/Root\s+/, ''), 10), 0);   // last trailer = newest revision
    if (tree.length) return tree;
    const all = [];
    for (const k in objs) if (isPage(objs[k])) all.push(objs[k]);
    return all;
  }

  function heuristicScan(whole, u8, out, stats) {
    let idx = 0;
    for (;;) {
      const si = whole.indexOf('stream', idx);
      if (si < 0) break;
      if (whole.substr(si - 3, 3) === 'end') { idx = si + 6; continue; }
      let ds = si + 6; if (whole[ds] === '\r') ds++; if (whole[ds] === '\n') ds++;
      const ei = whole.indexOf('endstream', ds);
      if (ei < 0) { idx = si + 6; continue; }
      const dict = whole.slice(Math.max(0, si - 4000), si);
      let dend = ei; if (whole[dend - 1] === '\n') dend--; if (whole[dend - 1] === '\r') dend--;
      const lenM = dict && dict.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/g);
      if (lenM) { const L = parseInt(lenM[lenM.length - 1].replace(/\/Length\s+/, ''), 10); if (ds + L <= u8.length) dend = ds + L; }
      const filM = dict && dict.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/g);
      const filter = filM ? filM[filM.length - 1].replace(/^\/Filter\s*/, '') : '';
      let content = null;
      try { content = decodeStream(u8.subarray(ds, dend), filter); } catch (e) { content = null; }
      if (content && looksLikeContent(content)) { try { interpret(content, out, { stats }); } catch (e) {} }
      idx = ei + 9;
    }
  }

  function mediaBoxOf(pg, objs, whole) {
    const probe = (str) => {
      const m = str && str.match(/\/MediaBox\s*\[\s*([-0-9.eE\s]+)\]/);
      if (!m) return null;
      const nums = m[1].trim().split(/\s+/).map(parseFloat);
      if (nums.length === 4 && nums.every(v => isFinite(v))) return nums;
      return null;
    };
    let mb = pg && probe(pg.dictStr);
    if (!mb && pg) { // inherited: check the /Parent chain
      let cur = pg, hops = 0;
      while (!mb && cur && hops++ < 8) {
        const pm = cur.dictStr.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
        cur = pm ? objs[parseInt(pm[1], 10)] : null;
        mb = cur && probe(cur.dictStr);
      }
    }
    if (!mb) mb = probe(whole);
    return mb || [0, 0, 612, 792];
  }

  // Interpret `pages` into raw device-space shapes (y-up, points). Falls back to the
  // filter-agnostic stream scan when the pages yield nothing (e.g. pages packed in an ObjStm).
  function interpretPages(whole, objs, u8, pages, raw, stats, studio) {
    for (const pg of pages) {
      const resDict = dictAfter(pg.dictStr, 'Resources', objs);
      const xmap = xobjectMap(resDict, objs);
      const cs = pageContents(pg, objs, u8);
      if (cs) { try { interpret(cs, raw, { objs, u8, resourcesDict: resDict, xobjMap: xmap, seen: {}, stats, studio }); } catch (e) { if (studio) stats.error = e.message; } }
    }
    if (raw.length === 0 && stats.text === 0) heuristicScan(whole, u8, raw, stats);   // text-only pages did parse: don't rescan (double count)
  }

  // ---- Vector Studio entry: Uint8Array -> {w, h, shapes, pageCount, hasLiveText, textShows} ----
  // First page only. Shapes are in document points, y-down, origin at page top-left.
  // opts.studio: full graphics state (clips, spot colors, gradients, images, layers); opts.page picks a page (0-based).
  function parsePDFDoc(u8, opts) {
    opts = opts || {};
    const whole = u8str(u8);
    const objs = scanObjects(whole, u8);
    const raw = [];
    const stats = { text: 0, clipId: 0 };
    const pages = pageList(objs, whole);
    const pg = pages[opts.page || 0] || null;
    const mb = mediaBoxOf(pg, objs, whole);
    const W = mb[2] - mb[0], H = mb[3] - mb[1];
    interpretPages(whole, objs, u8, pg ? [pg] : [], raw, stats, !!opts.studio);
    // device space (y-up, MediaBox origin) -> doc space (y-down, top-left origin)
    const flip = [1, 0, 0, -1, -mb[0], H + mb[1]];       // device -> doc
    const negY = [1, 0, 0, -1, 0, 0];                    // fillText local (y-up glyphs) fix
    const shapes = raw.map(s => {
      if (s.type === 'text') {
        // matrix (local text -> doc) = flip . dev . negY, keeping glyphs upright
        const matrix = mat(negY, mat(s._dev, flip)); // apply negY, then dev, then flip
        return { type: 'text', text: s.text, size: s.size, font: 'Helvetica', fill: s.fill,
          stroke: null, opacity: 1, matrix, w: null };
      }
      if (s.type === 'image') {
        const { _dev, ...rest } = s;
        // unit square (y-down, row 0 on top) -> doc
        return { ...rest, matrix: mat([1, 0, 0, -1, 0, 1], mat(_dev, flip)), clip: flipClips(s.clip) };
      }
      const o = { ...s, cmds: flipCmds(s.cmds) };
      if (o.grad) o.grad = xfGrad(o.grad, flip);
      if (o.clip) o.clip = flipClips(o.clip);
      return o;
    });
    function flipCmds(cmds) {
      return cmds.map(c => {
        if (c[0] === 'Z') return ['Z'];
        const o = [c[0]];
        for (let i = 1; i + 1 <= c.length; i += 2) o.push(c[i] - mb[0], H - (c[i + 1] - mb[1]));
        return o;
      });
    }
    function flipClips(list) {
      if (!list) return undefined;
      return list.map(c => { if (!c._doc) c._doc = { id: c.id, rule: c.rule, cmds: flipCmds(c.cmds) }; return c._doc; });
    }
    return { w: W, h: H, shapes, pageCount: pages.length, hasLiveText: stats.text > 0, textShows: stats.text,
      imagesSkipped: stats.imagesSkipped || 0, unsupported: stats.unsupported || 0 };
  }

  // ---- CAD/CAM entry: Uint8Array -> Array of {pts, closed} loops (inches, y-up) ----
  // Every page is overlaid. Curves are flattened to chords of ~opts.tol inch (6..80 segments).
  // The array carries `.hasLiveText` / `.textShows` (live text is counted, never cut).
  function parsePDFVectors(u8, opts) {
    const tol = (opts && opts.tol) || 0.008;
    const whole = u8str(u8);
    const objs = scanObjects(whole, u8);
    const raw = [];
    const stats = { text: 0 };
    interpretPages(whole, objs, u8, pageList(objs, whole), raw, stats);
    const out = [];
    const pt = (x, y) => ({ x: x / 72, y: y / 72 });
    for (const s of raw) {
      if (s.type === 'text') continue;
      let loop = null, cx = 0, cy = 0;
      for (const c of s.cmds) {
        if (c[0] === 'M') { loop = { pts: [pt(c[1], c[2])], closed: false }; out.push(loop); cx = c[1]; cy = c[2]; }
        else if (c[0] === 'L') { loop.pts.push(pt(c[1], c[2])); cx = c[1]; cy = c[2]; }
        else if (c[0] === 'C') {
          const [, x1, y1, x2, y2, x3, y3] = c;
          const est = (Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) / 72;
          const segs = Math.max(6, Math.min(80, Math.round(est / tol) || 6));
          for (let k = 1; k <= segs; k++) {
            const t = k / segs, mt = 1 - t;
            loop.pts.push(pt(mt*mt*mt*cx + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x3,
                             mt*mt*mt*cy + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y3));
          }
          cx = x3; cy = y3;
        } else if (c[0] === 'Z') loop.closed = true;
      }
    }
    out.hasLiveText = stats.text > 0;
    out.textShows = stats.text;
    return out;
  }

  return { parsePDFDoc, parsePDFVectors, pdfInflate, rgbHex, cmykHex };
})();
// Bare globals for the CAD/CAM bundle and its vm-context tests (function declarations land on the global object).
function parsePDFVectors(u8, opts) { return PDFPARSE.parsePDFVectors(u8, opts); }
function pdfInflate(input) { return PDFPARSE.pdfInflate(input); }
if (typeof module !== 'undefined') module.exports = PDFPARSE;
if (typeof window !== 'undefined') window.PDFPARSE = PDFPARSE;
