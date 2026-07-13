// Vector-PDF import tests. pdfparse.js is a browser-concatenated script (no module.exports),
// so run it in a vm context to grab parsePDFVectors + pdfInflate, like importtest does for dxfparse.
const fs = require('fs'), path = require('path'), vm = require('vm'), zlib = require('zlib');
const C = require('./cadcore.js');
const CAM = require('./camcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }
const close = (a, b, t) => Math.abs(a - b) <= (t || 1e-3);

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'pdfparse.js'), 'utf8'), ctx);
const parsePDFVectors = ctx.parsePDFVectors, pdfInflate = ctx.pdfInflate;
ok('pdfparse exposes parsePDFVectors + pdfInflate', typeof parsePDFVectors === 'function' && typeof pdfInflate === 'function');

// ---- inflate: validate the pure DEFLATE decoder against real zlib output ----
function inflateEquals(str) {
  const z = zlib.deflateSync(Buffer.from(str, 'latin1'));           // zlib (dynamic/fixed huffman)
  const got = Buffer.from(pdfInflate(new Uint8Array(z))).toString('latin1');
  return got === str;
}
ok('inflate: short string (fixed huffman)', inflateEquals('hi'));
ok('inflate: repetitive (back-references)', inflateEquals('ABCABCABC '.repeat(200)));
ok('inflate: mixed content', inflateEquals('0 0 100 100 re f\n50 50 m 200 200 l S\n'.repeat(80)));
{
  const z = zlib.deflateSync(Buffer.from('X'.repeat(500)), { level: 0 });   // stored blocks
  const got = Buffer.from(pdfInflate(new Uint8Array(z))).toString('latin1');
  ok('inflate: stored blocks', got === 'X'.repeat(500));
}

// ---- helpers to assemble minimal PDFs around a content stream ----
function bytes(str) { return new Uint8Array(Buffer.from(str, 'latin1')); }
function uncompressedPDF(content) {
  return '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] /Contents 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
}
function flatePDF(content) {
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = Buffer.from('%PDF-1.5\n2 0 obj\n<< /Length ' + z.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  return new Uint8Array(Buffer.concat([head, z, tail]));
}

// ---- unit square scaled by 72 -> 1"x1" rectangle at origin ----
const sq = parsePDFVectors(bytes(uncompressedPDF('q 72 0 0 72 0 0 cm 0 0 1 1 re f Q')));
ok('re: one loop', sq.length === 1, sq.length);
ok('re: closed', sq.length && sq[0].closed);
{
  const b = C.bboxPts(sq[0].pts);
  ok('re: 1x1 inch at origin', close(b.minX, 0) && close(b.minY, 0) && close(b.maxX, 1) && close(b.maxY, 1), JSON.stringify(b));
}

// ---- cm translate lands art at (2,3) inches ----
const tr = parsePDFVectors(bytes(uncompressedPDF('q 72 0 0 72 144 216 cm 0 0 1 1 re f Q')));
{
  const b = C.bboxPts(tr[0].pts);
  ok('cm translate to (2,3) inch', close(b.minX, 2) && close(b.minY, 3) && close(b.maxX, 3) && close(b.maxY, 4), JSON.stringify(b));
}

// ---- triangle via m/l/l/h then stroke -> closed loop ----
const tri = parsePDFVectors(bytes(uncompressedPDF('72 0 0 72 0 0 cm 0 0 m 1 0 l 0.5 1 l h S')));
ok('triangle: one loop', tri.length === 1, tri.length);
ok('triangle: closed by h', tri.length && tri[0].closed);
ok('triangle: >=3 pts', tri.length && tri[0].pts.length >= 3, tri.length && tri[0].pts.length);

// ---- cubic bezier flattens to many points ----
const bez = parsePDFVectors(bytes(uncompressedPDF('72 0 0 72 0 0 cm 0 0 m 0 1 1 1 1 0 c S')));
ok('bezier: flattened to many pts', bez.length === 1 && bez[0].pts.length > 6, bez.length && bez[0].pts.length);

// ---- two independent subpaths in one paint -> two loops ----
const two = parsePDFVectors(bytes(uncompressedPDF('72 0 0 72 0 0 cm 0 0 1 1 re 2 0 1 1 re f')));
ok('two rects -> two loops', two.length === 2, two.length);

// ---- q/Q isolates a transform: inner rect scaled, outer unaffected ----
const qq = parsePDFVectors(bytes(uncompressedPDF('72 0 0 72 0 0 cm 0 0 1 1 re f q 2 0 0 2 0 0 cm 2 0 1 1 re f Q S')));
ok('q/Q: two loops', qq.length === 2, qq.length);
{
  // second rect: user (2,0)-(3,1) under extra 2x -> (4,0)-(6,2) user * base 72/72 inch = 4..6 x 0..2
  const b = C.bboxPts(qq[1].pts);
  ok('q/Q inner rect scaled 2x', close(b.minX, 4) && close(b.maxX, 6) && close(b.maxY, 2), JSON.stringify(b));
}

// ---- FlateDecode end-to-end (compression + brute-force stream scan) ----
const fl = parsePDFVectors(flatePDF('q 36 0 0 36 0 0 cm 0 0 2 2 re f Q'));
ok('flate: one loop', fl.length === 1, fl.length);
{
  const b = C.bboxPts(fl[0].pts);   // 2x2 user * 36/72 = 1"x1"
  ok('flate: 1x1 inch', close(b.maxX, 1) && close(b.maxY, 1), JSON.stringify(b));
}

// ---- Form XObjects: `Do` resolves the form, applies /Matrix, recurses ----
function multiObjPDF(objects) {   // objects: [{num, body}] -> full PDF string
  let s = '%PDF-1.5\n';
  for (const o of objects) s += o.num + ' 0 obj\n' + o.body + '\nendobj\n';
  return s + 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
}
function streamObj(dict, content) { return '<< ' + dict + ' /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'; }

// page content is ONLY `/Fm0 Do`; the form draws a 100x100 rect under /Matrix [1.44 0 0 0.72 72 144]
const formPDF = multiObjPDF([
  { num: 1, body: '<< /Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Fm0 5 0 R >> >> >>' },
  { num: 4, body: streamObj('', '/Fm0 Do') },
  { num: 5, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1.44 0 0 0.72 72 144]', '0 0 100 100 re f') }
]);
const fx = parsePDFVectors(bytes(formPDF));
ok('Do: form geometry comes through', fx.length === 1, fx.length);
{
  const b = C.bboxPts(fx[0].pts);   // 100x100 * (1.44,0.72) + (72,144) pts, /72 inch -> (1,2)-(3,3)
  ok('Do: /Matrix scale+translate applied', close(b.minX, 1) && close(b.minY, 2) && close(b.maxX, 3) && close(b.maxY, 3), JSON.stringify(b));
}

// self-referencing form must terminate (cycle guard) and emit its rect exactly once
const cyclePDF = multiObjPDF([
  { num: 1, body: '<< /Type /Page /Contents 4 0 R /Resources << /XObject << /FmA 5 0 R >> >> >>' },
  { num: 4, body: streamObj('', '/FmA Do') },
  { num: 5, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 72 72] /Resources << /XObject << /FmA 5 0 R >> >>', '0 0 72 72 re f\n/FmA Do') }
]);
const cy = parsePDFVectors(bytes(cyclePDF));
ok('Do: cycle guard -> one loop, no hang', cy.length === 1, cy.length);

// nested forms: A draws a rect and invokes B (translated); expect two loops
const nestPDF = multiObjPDF([
  { num: 1, body: '<< /Type /Page /Contents 4 0 R /Resources << /XObject << /FmA 5 0 R >> >> >>' },
  { num: 4, body: streamObj('', '/FmA Do') },
  { num: 5, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /XObject << /FmB 6 0 R >> >>', '0 0 36 36 re f\n/FmB Do') },
  { num: 6, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 36 36] /Matrix [1 0 0 1 72 0]', '0 0 36 36 re f') }
]);
const ne = parsePDFVectors(bytes(nestPDF));
ok('Do: nested form -> two loops', ne.length === 2, ne.length);
{
  const bs = ne.map(l => C.bboxPts(l.pts)).sort((a, b) => a.minX - b.minX);
  ok('Do: nested B translated by 1"', close(bs[0].minX, 0) && close(bs[1].minX, 1), JSON.stringify(bs.map(b => b.minX)));
}

// ---- text-only content yields no vector paths ----
const txt = parsePDFVectors(bytes(uncompressedPDF('BT /F1 12 Tf 100 700 Td (Hello) Tj ET')));
ok('text-only -> no paths', txt.length === 0, txt.length);
ok('text-only -> hasLiveText flag set', txt.hasLiveText === true, txt.textShows);
ok('pure vector -> no live-text flag', !sq.hasLiveText, sq.textShows);
// mixed: text + a real rectangle -> imports the rect AND flags the live text
const mix = parsePDFVectors(bytes(uncompressedPDF('72 0 0 72 0 0 cm 0 0 1 1 re f BT /F1 12 Tf 100 700 Td (Label) Tj ET')));
ok('mixed: rect still imported', mix.length === 1, mix.length);
ok('mixed: live-text flagged alongside geometry', mix.hasLiveText === true, mix.textShows);
// TJ (array show) also counts as live text
const tjarr = parsePDFVectors(bytes(uncompressedPDF('BT /F1 12 Tf 100 700 Td [(Hel) -20 (lo)] TJ ET')));
ok('TJ array counts as live text', tjarr.hasLiveText === true && tjarr.length === 0, tjarr.textShows);

// ---- imported PDF paths flow into CAM ----
const shapes = sq.map(l => C.mkPoly(l.pts, l.closed, '0'));
const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
const res = CAM.profileOp(contours, { side: 'outside', toolDia: 0.125, cutDepth: 0.25, passDepth: 0.5 });
ok('PDF path -> CAM profile passes', res.ops[0].passes.length > 0, res.ops[0].passes.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
