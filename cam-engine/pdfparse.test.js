// Shared tests for pdfparse.js — vendored alongside it into aquamentor-cadcam (tools/sync-pdfparse.sh),
// so both repos run the same checks against the same parser. Canonical copy: aquamentor-vector-studio/engine.
//
//   node pdfparse.test.js                    run (exit 1 on failure)
//   node pdfparse.test.js --write-golden     re-pin the fixture digests in pdfparse.golden.json
//   PDFPARSE_IMPL=/path/old.js node ...      run the same checks against another copy (e.g. a pre-merge
//                                            parser) to see which regressions it has; entry points the
//                                            copy lacks are skipped.
//
// Each regression below names the bug it pins and which pre-merge copy had it (cadcam = the old
// cam-engine/pdfparse.js, vs = the old engine/pdfparse.js).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');

const IMPL = process.env.PDFPARSE_IMPL ? path.resolve(process.env.PDFPARSE_IMPL) : path.join(__dirname, 'pdfparse.js');
// Load the way the browser bundles do: one script, globals on a context. Old cadcam copies only define
// globals; old/new VS copies define PDFPARSE.
const G = {}; vm.createContext(G);
vm.runInContext(fs.readFileSync(IMPL, 'utf8') + '\n;this.__P = (typeof PDFPARSE !== "undefined") ? PDFPARSE : null;', G);
const P = G.__P || {};
const parseDoc = P.parsePDFDoc || null;
const parseVec = P.parsePDFVectors || G.parsePDFVectors || null;
const inflate = P.pdfInflate || G.pdfInflate;

let pass = 0, fail = 0, skip = 0;
function ok(cond, name, extra) {
  if (cond) pass++; else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); }
}
function needs(fn) { if (!fn) { skip++; return false; } return true; }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);
const u8 = s => new Uint8Array(Buffer.from(s, 'latin1'));

// PDF from [{num, body}] objects; body may be a Buffer for binary streams.
function pdf(objects, root) {
  const parts = [Buffer.from('%PDF-1.5\n', 'latin1')];
  for (const o of objects) parts.push(Buffer.from(o.num + ' 0 obj\n', 'latin1'), Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, 'latin1'), Buffer.from('\nendobj\n', 'latin1'));
  parts.push(Buffer.from('trailer\n<< /Root ' + (root || 1) + ' 0 R >>\n%%EOF\n', 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
function stream(dict, data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return Buffer.concat([Buffer.from('<< ' + dict + ' /Length ' + b.length + ' >>\nstream\n', 'latin1'), b, Buffer.from('\nendstream', 'latin1')]);
}
function onePage(content, extraDict) {
  return pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>' },
    { num: 4, body: stream(extraDict || '', content) },
  ]);
}
const bbox = pts => pts.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

// ======================= regressions =======================

// [cadcam+vs] `/Length 12 0 R`: the regex backtracked to a direct length of "1", so the stream read as
// one byte and the page imported as nothing.
{
  const body = '72 0 0 72 0 0 cm 0 0 1 1 re f';
  const file = pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>' },
    { num: 4, body: '<< /Length 12 0 R >>\nstream\n' + body + '\nendstream' },
    { num: 12, body: String(body.length) },
  ]);
  if (needs(parseVec)) { const r = parseVec(file); ok(r.length === 1 && near(bbox(r[0].pts).maxX, 1), 'indirect /Length (obj >= 10): vectors read the stream', r.length); }
  if (needs(parseDoc)) ok(parseDoc(file).shapes.length === 1, 'indirect /Length (obj >= 10): doc reads the stream');
}

// [cadcam+vs] A /Contents array is one stream split at token boundaries: the CTM set in part 1 must
// apply in part 2. Both copies interpreted each part with a fresh graphics state.
{
  const file = pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents [4 0 R 5 0 R] >>' },
    { num: 4, body: stream('', 'q 72 0 0 72 0 0 cm 1 0 0 rg') },
    { num: 5, body: stream('', '0 0 2 1 re f Q') },
  ]);
  if (needs(parseVec)) { const r = parseVec(file); ok(r.length === 1 && near(bbox(r[0].pts).maxX, 2), '/Contents array: cm carries into the next part (2" wide)', r.length && JSON.stringify(bbox(r[0].pts))); }
  if (needs(parseDoc)) { const s = parseDoc(file).shapes; ok(s.length === 1 && s[0].fill === '#ff0000' && near(s[0].cmds[1][1], 144), '/Contents array: color + cm carry into the next part', JSON.stringify(s[0] && s[0].cmds[1])); }
}

// [cadcam+vs] `/Filter [/ASCII85Decode /FlateDecode]` passed the loose /FlateDecode/ test, so ASCII85 text
// went into the inflater, which read past the end of input forever (frozen tab). Now: the chain is decoded.
{
  const z = zlib.deflateSync(Buffer.from('72 0 0 72 0 0 cm 0 0 3 1 re f', 'latin1'));
  let a85 = '';
  for (let i = 0; i < z.length; i += 4) {
    const m = Math.min(4, z.length - i), c = [0, 1, 2, 3].map(k => (i + k < z.length ? z[i + k] : 0));
    let n = c[0] * 16777216 + c[1] * 65536 + c[2] * 256 + c[3];
    if (n === 0 && m === 4) { a85 += 'z'; continue; }
    const d = []; for (let k = 0; k < 5; k++) { d.unshift(String.fromCharCode(33 + n % 85)); n = Math.floor(n / 85); }
    a85 += d.join('').slice(0, m + 1);
  }
  const file = onePage(a85 + '~>', '/Filter [/ASCII85Decode /FlateDecode]');
  if (needs(parseVec)) { const r = parseVec(file); ok(r.length === 1 && near(bbox(r[0].pts).maxX, 3), 'ASCII85+Flate filter chain decodes', r.length); }
  if (needs(parseDoc)) ok(parseDoc(file).shapes.length === 1, 'ASCII85+Flate filter chain decodes (doc)');
  // Unsupported filters are skipped, never inflated.
  const dct = onePage('0 0 10 10 re f', '/Filter /DCTDecode');
  if (needs(parseVec)) ok(parseVec(dct).length === 0, 'unsupported filter is skipped');
}

// [cadcam+vs] Truncated / non-zlib input must throw, not spin (the inflater read zeros past the end forever).
{
  const z = zlib.deflateSync(Buffer.from('0 0 100 100 re f\n'.repeat(50), 'latin1'));
  let threw = false;
  try { inflate(new Uint8Array(z.subarray(0, z.length >> 1))); } catch (e) { threw = true; }
  ok(threw, 'inflate: truncated input throws');
  threw = false;
  try { inflate(u8('<~9jqo^BlbD-BleB1DJ+*+F(f,q~>')); } catch (e) { threw = true; }
  ok(threw, 'inflate: ASCII85 text throws instead of looping');
}

// [vs] Hex-string text (`<0048> Tj`, Illustrator's CID fonts) was not counted as live text, so a PDF of
// un-outlined type imported with no warning. cadcam counted it.
{
  const file = onePage('BT /F1 12 Tf 100 700 Td <00480065> Tj [<006C>-20<006F>] TJ ET');
  if (needs(parseDoc)) { const d = parseDoc(file); ok(d.hasLiveText === true && d.textShows === 2, 'hex-string Tj/TJ count as live text (doc)', d.textShows); }
  if (needs(parseVec)) { const r = parseVec(file); ok(r.hasLiveText === true && r.textShows === 2, 'hex-string Tj/TJ count as live text (vectors)', r.textShows); }
}

// [vs] parsePDFDoc imported the page with the lowest OBJECT NUMBER, not page 1 of the page tree.
// [cadcam] parsePDFVectors emitted pages in object-number order (same geometry, wrong order).
{
  const file = pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [7 0 R 3 0 R] /Count 2 /MediaBox [0 0 612 792] >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    { num: 4, body: stream('', '0 0 10 10 re f') },              // page 2: 10pt square
    { num: 7, body: '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>' },
    { num: 8, body: stream('', '0 0 72 72 re f') },              // page 1: 1" square
  ]);
  if (needs(parseDoc)) { const d = parseDoc(file); ok(d.pageCount === 2 && d.shapes.length === 1 && near(d.shapes[0].cmds[1][1], 72), 'doc imports page 1 of the page tree', JSON.stringify(d.shapes[0] && d.shapes[0].cmds)); }
  if (needs(parseVec)) { const r = parseVec(file); ok(r.length === 2 && near(bbox(r[0].pts).maxX, 1), 'vectors: all pages, page-tree order', r.length); }
}

// [cadcam] A path built but never painted was emitted at end of stream as cut geometry. Unpainted
// paths are invisible in every PDF viewer (and Vector Studio never imported them).
{
  const file = onePage('72 0 0 72 0 0 cm 0 0 1 1 re f 2 0 m 3 0 l 3 1 l');
  if (needs(parseVec)) ok(parseVec(file).length === 1, 'unpainted trailing path is not cut geometry');
}

// [cadcam] No reachable page tree + text-only stream: the fallback scan ignored text-only streams,
// so hasLiveText stayed false. Vector Studio's scan already looked for BT..Tj.
{
  const file = pdf([{ num: 4, body: stream('', 'BT /F1 12 Tf 100 700 Td (Hello) Tj ET') }]);
  if (needs(parseVec)) ok(parseVec(file).hasLiveText === true, 'fallback scan flags text-only streams (vectors)');
  if (needs(parseDoc)) ok(parseDoc(file).hasLiveText === true, 'fallback scan flags text-only streams (doc)');
}

// ======================= one interpreter, two outputs =======================
// Same file through both entry points: straight segments land on the same points (doc is y-down pt,
// vectors are y-up inch), closed flags agree, and curves stay curves in doc / flatten in vectors.
if (parseDoc && parseVec) {
  const file = onePage('q 2 0 0 2 36 18 cm 0 0 m 36 0 l 36 36 l h S 0 72 m 0 108 36 108 36 72 c f Q');
  const d = parseDoc(file), r = parseVec(file);
  ok(d.shapes.length === 2 && r.length === 2, 'both entry points see two paths', d.shapes.length + '/' + r.length);
  if (d.shapes.length === 2 && r.length === 2) {
    const tri = d.shapes[0].cmds.filter(c => c[0] !== 'Z');
    ok(tri.length === r[0].pts.length && tri.every((c, k) => near(c[1] / 72, r[0].pts[k].x) && near((792 - c[2]) / 72, r[0].pts[k].y)), 'line points agree across entry points');
    ok(r[0].closed === true && d.shapes[0].cmds[d.shapes[0].cmds.length - 1][0] === 'Z', 'closepath agrees');
    ok(d.shapes[1].cmds[1][0] === 'C' && r[1].pts.length > 6 && r[1].closed === true, 'curve kept as C in doc, flattened + fill-closed in vectors');
    const end = d.shapes[1].cmds[1], last = r[1].pts[r[1].pts.length - 1];
    ok(near(end[5] / 72, last.x) && near((792 - end[6]) / 72, last.y), 'curve end point agrees');
  }
}

// ======================= real fixtures vs pinned digests =======================
// Digests were pinned from the pre-merge parsers' output (old cadcam parsePDFVectors, old VS parsePDFDoc)
// except where a regression above changed it — those entries carry a `why`. Fixtures that are not in
// this repo are skipped (cadcam has the sample-*.pdf set, Vector Studio has tests/fixtures).
const GOLDEN = path.join(__dirname, 'pdfparse.golden.json');
const FIXTURE_DIRS = [path.join(__dirname, '..', 'tests', 'fixtures'), __dirname];
// FNV-1a over values quantized to 1e-6. The 1/pi offset keeps the rounding boundary off k+0.5: PDF
// decimals divided by 72 land exactly on it, and then 1e-16 float noise between equivalent paths flips it.
function digest(nums) {
  let h = 0x811c9dc5;
  const mix = c => { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; };
  for (const v of nums) { const s = String(Math.round(v * 1e6 + 0.3183098861837907)); for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(44); }
  return h.toString(16).padStart(8, '0');
}
function summarizeVec(r) {
  const nums = []; let pts = 0, closed = 0;
  for (const l of r) { pts += l.pts.length; if (l.closed) closed++; nums.push(l.closed ? 1 : 0, l.pts.length); for (const p of l.pts) nums.push(p.x, p.y); }
  return { loops: r.length, closed, pts, text: r.textShows, digest: digest(nums) };
}
function summarizeDoc(d) {
  const nums = [d.w, d.h, d.pageCount], colors = new Set();
  for (const s of d.shapes) {
    if (s.type === 'text') { nums.push(-1, s.size, ...s.matrix); for (const ch of s.text) nums.push(ch.charCodeAt(0)); colors.add(s.fill); continue; }
    nums.push(s.cmds.length, s.fillRule === 'evenodd' ? 1 : 0, s.stroke ? s.stroke.w : -1);
    for (const c of s.cmds) nums.push(...c.slice(1));
    if (s.fill) colors.add(s.fill);
    if (s.stroke) colors.add(s.stroke.color);
  }
  return { shapes: d.shapes.length, w: d.w, h: d.h, text: d.textShows, colors: colors.size, digest: digest(nums) };
}
{
  const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
  const write = process.argv.includes('--write-golden');
  let seen = 0;
  for (const dir of FIXTURE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => /\.(pdf|ai)$/i.test(f)).sort()) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
      const got = {};
      if (parseVec) got.vectors = summarizeVec(parseVec(bytes));
      if (parseDoc) got.doc = summarizeDoc(parseDoc(bytes));
      seen++;
      if (write) {
        golden[f] = golden[f] || {};
        for (const k of Object.keys(got)) golden[f][k] = Object.assign(got[k], golden[f][k] && golden[f][k].why ? { why: golden[f][k].why } : {});
        continue;
      }
      const want = golden[f];
      if (!want) { ok(false, 'fixture has a pinned digest: ' + f + ' (run --write-golden)'); continue; }
      for (const k of Object.keys(got)) {
        const w = Object.assign({}, want[k]); delete w.why;
        ok(JSON.stringify(got[k]) === JSON.stringify(w), 'fixture ' + f + ' ' + k + ' matches pinned digest', '\n    want ' + JSON.stringify(w) + '\n    got  ' + JSON.stringify(got[k]));
      }
    }
  }
  ok(seen > 0, 'found at least one PDF fixture');
  if (write) { fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + '\n'); console.log('wrote', GOLDEN, Object.keys(golden).length, 'fixtures'); }
}

console.log(`pdfparse.test: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (entry point missing in ${path.basename(IMPL)})` : ''}`);
if (fail) process.exitCode = 1;
