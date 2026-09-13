// crvparse.js checks: CFB container, archive object graph, span geometry, flattening, refusals.
const C = require('./crvparse.js'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } }
function throws(name, fn, re) { try { fn(); ok(name, false, 'did not throw'); } catch (e) { ok(name, re.test(e.message), e.message); } }
const S = f => new Uint8Array(fs.readFileSync(path.join(__dirname, 'samples', f)));

// ---- CFB reader: stream names + sizes recorded from python-olefile on the same files
const expect = {
  'NEMA-Outlet-Covers.crv': { 'PreviewData/Preview2D_GIF': 3532, 'VectorData/2dDataV2': 82763, 'VectorData/MaterialSize': 442, 'VectorData/DocumentData': 3646, 'VersionData/Version': 182, 'Toolpaths/ToolpathData': 61360, 'Toolpaths/Simulation': 66, 'Toolpaths/ToolpathPosData': 53, 'SideData/Sides': 809 },
  'test-ole-file.doc': { 'WordDocument': null, 'CompObj': null, '1Table': null, 'SummaryInformation': null, 'DocumentSummaryInformation': null }
};
for (const f of Object.keys(expect)) {
  const st = C.readCFB(S(f));
  for (const [p, n] of Object.entries(expect[f])) { const s = st.get(p); ok('cfb ' + f + ' has ' + JSON.stringify(p), !!s); if (s && n !== null) ok('cfb ' + p + ' size', s.length === n, s.length); }
  ok('cfb ' + f + ' no extra streams', st.size === Object.keys(expect[f]).length, [...st.keys()]);
}
{ const st = C.readCFB(S('NEMA-Outlet-Covers.crv')); const gif = st.get('PreviewData/Preview2D_GIF');
  ok('gif magic', String.fromCharCode(...gif.subarray(0, 6)) === 'GIF89a');
  ok('2d stream starts v1', new DataView(st.get('VectorData/2dDataV2').buffer).getUint32(0, true) === 1);
  const co = C.readCFB(S('test-ole-file.doc')).get('CompObj');
  ok('mini-stream .doc CompObj readable', co && co.length > 60 && /Word/.test(String.fromCharCode(...co.subarray(0, 120))), co && co.length); }

// ---- full parse of the fixture
const bytes = S('NEMA-Outlet-Covers.crv');
const doc = C.parse(bytes);
ok('version string', /Aspire/.test(doc.version) && /9\.508/.test(doc.version), doc.version);
ok('job from MaterialSize', doc.job && doc.job.w === 15.75 && doc.job.h === 5 && Math.abs(doc.job.thickness - 0.09) < 1e-12, doc.job);
ok('sheet agrees with MaterialSize', doc.job && !doc.job.sheetMismatch, doc.job && doc.job.sheetMismatch);
ok('4 layers', doc.layers.length === 4, doc.layers.length);
ok('layer names', doc.layers.map(l => l.name).join('|') === 'Toolpath Previews|Device Layout|Templates|Dimensions', doc.layers.map(l => l.name));
ok('layer colours (COLORREF -> #rrggbb)', doc.layers[1].color === '#99cc00' && doc.layers[2].color === '#ff0000' && doc.layers[3].color === '#999999', doc.layers.map(l => l.color));
ok('toolpath previews discarded', doc.layers[0].objects.length === 0);
const count = L => { let n = 0, sp = 0, t = 0; const w = o => { if (o.type === 'text') t++; if (o.contours) { n += o.contours.length; o.contours.forEach(c => sp += c.spans.length); } if (o.children) o.children.forEach(w); }; L.objects.forEach(w); return { n, sp, t }; };
ok('Device Layout: 7 contours / 36 spans', JSON.stringify(count(doc.layers[1])) === '{"n":7,"sp":36,"t":0}', count(doc.layers[1]));
ok('Templates: 24 contours + 8 text objects', (() => { const c = count(doc.layers[2]); return c.n === 24 && c.t === 8; })(), count(doc.layers[2]));
ok('object types', doc.layers[1].objects.map(o => o.type).join() === 'polyline,group,group');
const texts = doc.layers[2].objects.filter(o => o.type === 'text');
ok('text strings', texts.map(t => t.text).join('|') === 'Toggle|Decora|Outlet|Box Blank|15/20A\r\n1.414"|30A\r\n1.604"|1.664"|1.729"', texts.map(t => t.text));
ok('text glyph chars', texts[0].chars.length === 6 && texts[3].chars.length === 9 && texts[3].chars[3].glyph.length === 0, texts.map(t => t.chars.length));
ok('text transform', texts[2].M[2] < -3.35 && texts[2].M[2] > -3.36 && texts[0].M.join() === '1,0,0,0,1,0,0,0,1', texts[2].M);
// span statistics: lines / arcs / beziers, every contour chains, closure detected geometrically
let lines = 0, arcs = 0, bez = 0, closed = 0, open = 0;
const walkC = o => { if (o.contours) for (const c of o.contours) { (c.closed ? closed++ : open++); for (const s of c.spans) { if (s.bulge !== undefined) arcs++; else if (s.c1x !== undefined) bez++; else lines++; } } if (o.children) o.children.forEach(walkC); if (o.chars) o.chars.forEach(ch => ch.glyph.forEach(g => walkC({ contours: [g] }))); };
doc.layers.forEach(L => L.objects.forEach(walkC));
ok('span mix (incl. glyphs)', lines === 189 && arcs === 104 && bez === 109, { lines, arcs, bez });
ok('closed/open (incl. glyphs)', closed === 41 && open === 59, { closed, open });
// the 4-arc circle on the Device Layout: radius from bulge geometry
const circ = doc.layers[1].objects[1].children[0].children[0].contours[0];
ok('circle contour is 4 arcs of bulge ±tan(22.5°)', circ.spans.length === 4 && circ.spans.every(s => Math.abs(Math.abs(s.bulge) - (Math.SQRT2 - 1)) < 1e-9), circ.spans.map(s => s.bulge));
const fc = C.flattenContour(circ, 0.0005);
{ const cx = fc.pts.reduce((a, p) => a + p.x, 0) / fc.pts.length, cy = fc.pts.reduce((a, p) => a + p.y, 0) / fc.pts.length;
  const rs = fc.pts.map(p => Math.hypot(p.x - cx, p.y - cy)); const rmin = Math.min(...rs), rmax = Math.max(...rs);
  ok('flattened circle radius constant', rmax - rmin < 1e-6 && Math.abs(rmin - 0.09375) < 1e-6, [rmin, rmax]);
  ok('flattened circle closed without duplicate end', fc.closed && Math.hypot(fc.pts[0].x - fc.pts[fc.pts.length - 1].x, fc.pts[0].y - fc.pts[fc.pts.length - 1].y) > 1e-6); }
// bezier flattening stays within the control-point box and ends on the endpoint
{ let b; const w = o => { if (b) return; if (o.contours) for (const c of o.contours) for (const s of c.spans) if (s.c1x !== undefined) { b = s; return; } if (o.children) o.children.forEach(w); }; doc.layers.forEach(L => L.objects.forEach(w));
  const pts = C.flattenContour({ spans: [b], closed: false }, 0.001).pts;
  const xs = [b.x0, b.c1x, b.c2x, b.x1], ys = [b.y0, b.c1y, b.c2y, b.y1];
  ok('bezier hull', pts.every(p => p.x >= Math.min(...xs) - 1e-9 && p.x <= Math.max(...xs) + 1e-9 && p.y >= Math.min(...ys) - 1e-9 && p.y <= Math.max(...ys) + 1e-9));
  ok('bezier endpoints', pts[0].x === b.x0 && pts[pts.length - 1].x === b.x1 && pts.length > 6, pts.length); }

// ---- toShapes
const sh = C.toShapes(bytes);
ok('toShapes units heuristic', sh.units === 'in' && sh.unitsSource === 'heuristic:job<=300');
ok('toShapes job', sh.job && sh.job.w === 15.75 && sh.job.h === 5);
ok('toShapes skips empty preview layer', sh.layers.map(l => l.name).join('|') === 'Device Layout|Templates|Dimensions');
ok('toShapes contour counts', sh.layers.map(l => l.contours.length).join() === '7,24,0');
ok('toShapes text skipped + reported', sh.skippedText.length === 8 && sh.skippedText[0].text === 'Toggle' && sh.skippedText[0].x === 1.5);
ok('toShapes point counts sane', sh.layers[0].contours.reduce((a, c) => a + c.pts.length, 0) > 200 && sh.layers[1].contours.reduce((a, c) => a + c.pts.length, 0) > 400, sh.layers.map(l => l.contours.reduce((a, c) => a + c.pts.length, 0)));
// bbox of the Device Layout plate = the double-gang cover in the embedded preview (≈4.4 × 4.5)
{ const pts = sh.layers[0].contours.flatMap(c => c.pts); const bx = [Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x))], by = [Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y))];
  ok('plate bbox', bx[1] - bx[0] > 4.3 && bx[1] - bx[0] < 4.7 && by[1] - by[0] > 4.4 && by[1] - by[0] < 4.7, [bx, by]); }
const sht = C.toShapes(bytes, { text: true, tol: 0.001 });
ok('toShapes with text places glyphs', sht.layers[1].contours.length === 93 && sht.skippedText.length === 0, [sht.layers[1].contours.length, sht.skippedText.length]);
{ const g = sht.layers[1].contours.filter(c => c.text); const pts = g.flatMap(c => c.pts);
  ok('placed text sits above the templates near y≈10.9', Math.min(...pts.map(p => p.y)) > 10.2 && Math.max(...pts.map(p => p.y)) < 11.4, [Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y))]);
  const tog = g.slice(0, 7).flatMap(c => c.pts); const cx = (Math.min(...tog.map(p => p.x)) + Math.max(...tog.map(p => p.x))) / 2;
  ok('"Toggle" centred on its anchor x=1.5', Math.abs(cx - 1.5) < 0.03, cx); }
ok('tol changes point count', C.toShapes(bytes, { tol: 0.02 }).layers[0].contours.reduce((a, c) => a + c.pts.length, 0) < sh.layers[0].contours.reduce((a, c) => a + c.pts.length, 0));

// ---- refusals: the parser must throw, never emit guessed geometry
throws('G-code text named .crv', () => C.parse(new TextEncoder().encode('%\nG90 G20\nT1 M6\nG0 Z0.25\n')), /not a CRV/);
throws('random bytes', () => C.parse(new Uint8Array(600)), /CFB signature/);
{ const s2 = C.readCFB(bytes).get('VectorData/2dDataV2').slice(); s2[12 + 6 + 3] = 0x58;   // "vcCadLayer" -> "vcCXdLayer"
  const r = new C._Ar(s2); r.u32(); r.u32(); r.u32(); const t = r.tag();
  ok('mutated class name is not vcCadLayer', t.name === 'vcCXdLayer'); }
{ const s2 = C.readCFB(bytes).get('VectorData/2dDataV2').slice(0, 40000); const r = new C._Ar(s2);
  throws('truncated stream refused', () => { r.skip(39990); r.u32(); r.u32(); r.u32(); }, /read past end/); }
{ const s2 = C.readCFB(bytes).get('VectorData/2dDataV2').slice(); const dv = new DataView(s2.buffer);
  dv.setFloat64(369 + 1 + 8 + 24, 99, true);   // first span's end x of the first preview contour -> chain breaks
  const r = new C._Ar(s2); r.p = 324; r.tag();   // the vdContour tag at 324 (fresh table: 'new' class)
  throws('chain gap refused', () => C._readVdContour(r), /chain gap/); }
{ const s2 = C.readCFB(bytes).get('VectorData/2dDataV2').slice(); s2[324 + 2 + 4 + 9 + 4 + 4 + 8 + 1 + 8 + 1 + 4 + 1 + 4] = 0x0D;   // first span typeCode 0 -> 13
  const r = new C._Ar(s2); r.p = 324; r.tag();
  throws('unknown span type refused', () => C._readVdContour(r), /unknown span type/); }
{ const s2 = C.readCFB(bytes).get('VectorData/2dDataV2').slice(); s2[324 + 2 + 4 + 9] = 6;   // vdContour version 7 -> 6
  const r = new C._Ar(s2); r.p = 324; r.tag();
  throws('unknown vdContour version refused', () => C._readVdContour(r), /vdContour version 6/); }

console.log(`\n${pass}/${pass + fail} crv checks passed`);
process.exit(fail ? 1 : 0);
