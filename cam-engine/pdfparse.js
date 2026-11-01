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
    };
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
        out.push(shape);
      }
      clearPath();
    }
    function doXObject(name) {
      if (!name || !ctx.objs) return;
      const on = xobjMap[name];
      if (on == null || (ctx.seen && ctx.seen[on])) return;
      const o = ctx.objs[on];
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
      });
    }

    function dispatch(op) {
      switch (op) {
        case 'q': gstack.push({ ctm: gs.ctm.slice(), fill: gs.fill, stroke: gs.stroke, lw: gs.lw }); break;
        case 'Q': if (gstack.length) gs = gstack.pop(); break;
        case 'cm': { const a = ops.slice(-6); if (a.length === 6) gs.ctm = mat(a, gs.ctm); break; }
        case 'w': gs.lw = +ops[ops.length - 1] || 0; break;
        // color
        case 'rg': { const a = ops.slice(-3); gs.fill = rgbHex(a[0], a[1], a[2]); break; }
        case 'RG': { const a = ops.slice(-3); gs.stroke = rgbHex(a[0], a[1], a[2]); break; }
        case 'g': { const v = ops[ops.length - 1]; gs.fill = rgbHex(v, v, v); break; }
        case 'G': { const v = ops[ops.length - 1]; gs.stroke = rgbHex(v, v, v); break; }
        case 'k': { const a = ops.slice(-4); gs.fill = cmykHex(a[0], a[1], a[2], a[3]); break; }
        case 'K': { const a = ops.slice(-4); gs.stroke = cmykHex(a[0], a[1], a[2], a[3]); break; }
        case 'sc': case 'scn': gs.fill = scColor(ops); break;
        case 'SC': case 'SCN': gs.stroke = scColor(ops); break;
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
        case 'n': clearPath(); break;
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
        case 'BI': i = skipInlineImage(s, i); break;
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
        i++; let combined = '';
        while (i < n && s[i] !== ']') {
          if (s[i] === '(') { const st = i + 1; let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } combined += decodePdfStr(s.slice(st, i - 1)); }
          else i++;
        }
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
  function interpretPages(whole, objs, u8, pages, raw, stats) {
    for (const pg of pages) {
      const resDict = dictAfter(pg.dictStr, 'Resources', objs);
      const xmap = xobjectMap(resDict, objs);
      const cs = pageContents(pg, objs, u8);
      if (cs) { try { interpret(cs, raw, { objs, u8, resourcesDict: resDict, xobjMap: xmap, seen: {}, stats }); } catch (e) {} }
    }
    if (raw.length === 0 && stats.text === 0) heuristicScan(whole, u8, raw, stats);   // text-only pages did parse: don't rescan (double count)
  }

  // ---- Vector Studio entry: Uint8Array -> {w, h, shapes, pageCount, hasLiveText, textShows} ----
  // First page only. Shapes are in document points, y-down, origin at page top-left.
  function parsePDFDoc(u8) {
    const whole = u8str(u8);
    const objs = scanObjects(whole, u8);
    const raw = [];
    const stats = { text: 0 };
    const pages = pageList(objs, whole);
    const pg = pages[0] || null;
    const mb = mediaBoxOf(pg, objs, whole);
    const W = mb[2] - mb[0], H = mb[3] - mb[1];
    interpretPages(whole, objs, u8, pg ? [pg] : [], raw, stats);
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
      return {
        ...s,
        cmds: s.cmds.map(c => {
          if (c[0] === 'Z') return ['Z'];
          const o = [c[0]];
          for (let i = 1; i + 1 <= c.length; i += 2) o.push(c[i] - mb[0], H - (c[i + 1] - mb[1]));
          return o;
        }),
      };
    });
    return { w: W, h: H, shapes, pageCount: pages.length, hasLiveText: stats.text > 0, textShows: stats.text };
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
