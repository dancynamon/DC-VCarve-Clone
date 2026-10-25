// Regression guard for the Vectric .crv/.crv3d import path: parse the committed sample files with
// the studio's own parser, then run CAM on the result. No DOM.
//
// Every expected number below was cross-checked, point for point, against the validated Python
// reference parser (crvlib.py, FORMAT.md spec v3) over 83 real files spanning the whole archive —
// 2.28 M flattened points, max |JS - Python| = 1.4e-14 in, i.e. agreement at the last bit.
//
// The nine fixtures are chosen to cover the paths that a small file cannot reach:
//   sample.crv          VCarve 7, MFC-object spans, arcs + beziers
//   sample.crv3d        Aspire 8.5, inline spans
//   sample-tabs.crv3d   machining tabs, tab-line spans (code 7), lead-in/out arcs (11/12),
//                       a discarded toolpath preview, three layers
//   sample-points.crv3d point spans (code 5 — the 48-byte body with no trailing flag)
//   sample-text.crv     vector text: txtBlock/Line/Word/Char/BaseCurve + utParameter
//   sample-v10.crv3d    stream version 2 (24-byte trailer) and object version 10
//   sample-bitmap.crv3d an embedded bitmap whose placement frame must NOT be imported
//   sample-model.crv3d  a 3D model preview whose outline MUST be imported
//   sample-big.crv      203 MFC 32-bit big-object tag escapes
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

// crvparse.js is a browser-concatenated script (no module.exports), so run it in a vm context to
// grab the same parseCrv the studio's importCRV uses.
let parseCrv;
try {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'crvparse.js'), 'utf8'), ctx);
  parseCrv = ctx.parseCrv;
} catch (e) { /* leave undefined -> check below fails clearly */ }
ok('crvparse exposes parseCrv', typeof parseCrv === 'function');

const bytes = f => new Uint8Array(fs.readFileSync(path.join(__dirname, f)));
const load = (f, o) => parseCrv(bytes(f), o || {});
const nPts = p => p.reduce((n, q) => n + q.pts.length, 0);
const bboxOf = polys => polys.reduce((b, p) => {
  for (const q of p.pts) { b.minX = Math.min(b.minX, q.x); b.minY = Math.min(b.minY, q.y); b.maxX = Math.max(b.maxX, q.x); b.maxY = Math.max(b.maxY, q.y); }
  return b;
}, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

// --- sample.crv (VCarve Pro 7.012, crv-mfc dialect: spans are full MFC objects; arcs + beziers) ---
const polys = load('sample.crv');
ok('crv: 2 contours', polys.length === 2, polys.length);
ok('crv: dialect crv-mfc', polys.dialect === 'crv-mfc', polys.dialect);
ok('crv: layer name carried through', polys.every(p => p.layer === 'Layer 1'), JSON.stringify(polys.map(p => p.layer)));
ok('crv: units normalised to inches', polys.units === 'inch' && polys.sourceUnits === 'inch', polys.units + '/' + polys.sourceUnits);
ok('crv: units provenance recorded', polys.unitsSource === 'assumed:no-flag-in-format', polys.unitsSource);
ok('crv: jobSize 4.5 x 1.5 x 1.5', near(polys.jobSize.w, 4.5) && near(polys.jobSize.h, 1.5) && near(polys.jobSize.thickness, 1.5), JSON.stringify(polys.jobSize));
ok('crv: both contours closed', polys.every(p => p.ent.closed === true), JSON.stringify(polys.map(p => p.ent.closed)));
ok('crv: 106 flattened points @ 0.002 in', nPts(polys) === 106, nPts(polys));
// An oval of exactly 4.5 x 1.5: the bezier control points and the arc bulge sign both have to be
// right for this box to land. A wrong-signed bulge inflates it by one radius in every direction.
const b = bboxOf(polys);
ok('crv: bbox is exactly 0,0 .. 4.5,1.5', near(b.minX, 0) && near(b.minY, 0) && near(b.maxX, 4.5) && near(b.maxY, 1.5), JSON.stringify(b));

// --- sample.crv3d (Aspire 8.505, crv3d-inline dialect: u8 discriminator + inline span bodies) ---
if (!fs.existsSync(path.join(__dirname, 'sample.crv3d'))) console.log('  SKIP sample.crv3d block: fixture not in repo (lives in the CRV Format project)');
else {
var p3 = load('sample.crv3d');
ok('crv3d: 5 contours', p3.length === 5, p3.length);
ok('crv3d: dialect crv3d-inline', p3.dialect === 'crv3d-inline', p3.dialect);
ok('crv3d: all contours closed', p3.every(p => p.ent.closed === true), JSON.stringify(p3.map(p => p.ent.closed)));
ok('crv3d: jobSize 29 x 6.75 x 1.5', near(p3.jobSize.w, 29) && near(p3.jobSize.h, 6.75) && near(p3.jobSize.thickness, 1.5), JSON.stringify(p3.jobSize));
ok('crv3d: 271 flattened points @ 0.002 in', nPts(p3) === 271, nPts(p3));
const b3 = bboxOf(p3);
ok('crv3d: bbox 0.5,0.5 .. 28.5,6.25', near(b3.minX, 0.5) && near(b3.minY, 0.5) && near(b3.maxX, 28.5) && near(b3.maxY, 6.25), JSON.stringify(b3));
}

// --- machining tabs + toolpath preview -------------------------------------------------------
// The tab count and the preview are what pin the record boundaries: the u32 that looks like a
// constant 0 inside vdContour is really the owning curve object's tab count, and a toolpath
// preview must be consumed byte-exactly (there is no length prefix) and then thrown away.
const tabs = load('sample-tabs.crv3d');
ok('tabs: 5 drawing contours (preview NOT imported)', tabs.length === 5, tabs.length);
ok('tabs: 175 points', nPts(tabs) === 175, nPts(tabs));
ok('tabs: 4 machining tabs decoded', tabs.checks.toolpathTabs === 4, tabs.checks.toolpathTabs);
ok('tabs: 1 preview object discarded', /^1 objects/.test(tabs.checks.discardedPreviews), tabs.checks.discardedPreviews);
ok('tabs: vcToolpathTab + preview classes seen', tabs.checks.classes.indexOf('vcToolpathTab') >= 0 && tabs.checks.classes.indexOf('vcCadToolpathPreview') >= 0, JSON.stringify(tabs.checks.classes));
ok('tabs: three layers, custom name carried', JSON.stringify(tabs.layerNames) === JSON.stringify(['Toolpath Previews', 'Layer 1', 'old style']), JSON.stringify(tabs.layerNames));
ok('tabs: no contour lands on the preview layer', tabs.every(p => p.layer !== 'Toolpath Previews'), JSON.stringify(tabs.map(p => p.layer)));
const bt = bboxOf(tabs);
ok('tabs: bbox 0.5,0.5 .. 10.5,4.5', near(bt.minX, 0.5) && near(bt.minY, 0.5) && near(bt.maxX, 10.5) && near(bt.maxY, 4.5), JSON.stringify(bt));

// --- point spans (type code 5): the ONE span with no trailing u32 flag ------------------------
const pts5 = load('sample-points.crv3d');
ok('points: 4 contours', pts5.length === 4, pts5.length);
ok('points: 124 points', nPts(pts5) === 124, nPts(pts5));
ok('points: 2 preview objects / 9 contours discarded', pts5.checks.discardedPreviews === '2 objects / 9 contours', pts5.checks.discardedPreviews);
const bp = bboxOf(pts5);
ok('points: bbox 0.25,0.25 .. 8.25,8.25', near(bp.minX, 0.25) && near(bp.maxX, 8.25) && near(bp.maxY, 8.25), JSON.stringify(bp));

// --- vector text: the glyph outlines ARE the only copy of the geometry ------------------------
const txt = load('sample-text.crv');
ok('text: 15 contours', txt.length === 15, txt.length);
ok('text: 1 text block', txt.checks.textBlocks === 1, txt.checks.textBlocks);
ok('text: txt* classes decoded', ['txtBlock', 'txtLine', 'txtWord', 'txtChar', 'txtBaseCurve'].every(c => txt.checks.classes.indexOf(c) >= 0), JSON.stringify(txt.checks.classes));
ok('text: utParameter property bag decoded', txt.checks.classes.indexOf('utParameter') >= 0);
ok('text: 304 points', nPts(txt) === 304, nPts(txt));
ok('text: 10 of 15 contours closed (glyph loops)', txt.filter(p => p.ent.closed).length === 10, txt.filter(p => p.ent.closed).length);
const bx = bboxOf(txt);
ok('text: glyphs placed at 0,0 .. 22.75,7.8187', near(bx.minX, 0) && near(bx.minY, 0) && near(bx.maxX, 22.75) && near(bx.maxY, 7.818687, 1e-6), JSON.stringify(bx));
ok('text: some contours come from a glyph outline', txt.some(p => p.ent.origin === 'text-glyph'), JSON.stringify(txt.map(p => p.ent.origin)));

// --- stream version 2 (24-byte document trailer) + object version 10 --------------------------
const v10 = load('sample-v10.crv3d');
ok('v10: stream version 2 accepted', v10.checks.streamVersion === 2, v10.checks.streamVersion);
ok('v10: 1 contour, 5 points', v10.length === 1 && nPts(v10) === 5, v10.length + '/' + nPts(v10));
const bv = bboxOf(v10);
ok('v10: bbox 4,4 .. 44,44', near(bv.minX, 4) && near(bv.maxX, 44) && near(bv.maxY, 44), JSON.stringify(bv));

// --- an imported bitmap: decoded exactly, but its placement FRAME is not user geometry --------
const bmp = load('sample-bitmap.crv3d');
ok('bitmap: vcCadBitmap decoded', bmp.checks.classes.indexOf('vcCadBitmap') >= 0, JSON.stringify(bmp.checks.classes));
ok('bitmap: 28 placement frames decoded and dropped', bmp.checks.skippedFrames === 28, bmp.checks.skippedFrames);
ok('bitmap: 23 real contours imported', bmp.length === 23, bmp.length);
ok('bitmap: no bitmap-frame reaches the drawing', bmp.every(p => p.ent.origin !== 'bitmap-frame'));
ok('bitmap: 1201 points', nPts(bmp) === 1201, nPts(bmp));

// --- a 3D model preview: its region outline IS real 2D geometry and is kept -------------------
const mdl = load('sample-model.crv3d');
ok('model: vcCadModelPreview decoded', mdl.checks.classes.indexOf('vcCadModelPreview') >= 0, JSON.stringify(mdl.checks.classes));
ok('model: 3 contours imported', mdl.length === 3, mdl.length);
ok('model: the model outline is kept', mdl.some(p => p.ent.origin === 'model-preview'), JSON.stringify(mdl.map(p => p.ent.origin)));

// --- the MFC 32-bit big-object tag escape (only very large drawings reach it) ------------------
const big = load('sample-big.crv');
ok('big: 203 MFC big-object tag escapes consumed', big.checks.mfcBigTags === 203, big.checks.mfcBigTags);
ok('big: 23 contours', big.length === 23, big.length);
ok('big: 4137 points', nPts(big) === 4137, nPts(big));
ok('big: five layers', big.layerNames.length === 5, JSON.stringify(big.layerNames));
ok('big: 4 preview objects / 59 contours discarded', big.checks.discardedPreviews === '4 objects / 59 contours', big.checks.discardedPreviews);
ok('big: every contour closed', big.every(p => p.ent.closed), big.filter(p => !p.ent.closed).length + ' open');

// --- units: an explicit opts.units='mm' rescales to inches and says so ---
const pmm = load('sample.crv', { units: 'mm' });
ok('units mm: caller override recorded', pmm.sourceUnits === 'mm' && pmm.unitsSource === 'caller', pmm.sourceUnits + '/' + pmm.unitsSource);
ok('units mm: coordinates scaled by 1/25.4', near(pmm.jobSize.w, 4.5 / 25.4), pmm.jobSize.w);

// --- tolerance: a coarser tolerance yields fewer points, a finer one more ---
const coarse = nPts(load('sample.crv', { tol: 0.05 })), fine = nPts(load('sample.crv', { tol: 0.0002 }));
ok('tolerance drives tessellation density', coarse < 106 && fine > 106, coarse + ' < 106 < ' + fine);

// --- refusals: the parser raises rather than emitting geometry it is unsure of ---
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
ok('rejects a non-compound file', throws(() => parseCrv(new Uint8Array(1024), {})));
let notCrv = false;
try { parseCrv(new Uint8Array(1024), {}); } catch (e) { notCrv = e.notCrvFile === true; }
ok('a non-Vectric file is flagged as mis-named, not corrupt', notCrv);
ok('rejects a truncated container', throws(() => parseCrv(bytes('sample.crv').slice(0, 600), {})));
ok('rejects a corrupted container', throws(() => { const u = bytes('sample.crv'); u.fill(0x5A, 2048, 3072); parseCrv(u, {}); }));
ok('rejects an unknown opts.units', throws(() => parseCrv(bytes('sample.crv'), { units: 'furlongs' })));
// Span type codes 2, 3, 4, 10 and >= 13 have never been observed anywhere in a 5,977-file archive.
// Patch a known line span (code 1) to code 3 and the parser must refuse rather than invent a payload.
ok('rejects an unobserved span type code', throws(() => {
  // sample.crv3d is inline-encoded: find a span body (u32 version = 2, u32 code = 1) and
  // corrupt its type code to 3.
  const u = bytes('sample.crv3d');
  for (let i = 0; i + 8 < u.length; i++) {
    if (u[i] === 2 && u[i + 1] === 0 && u[i + 2] === 0 && u[i + 3] === 0 &&
        u[i + 4] === 1 && u[i + 5] === 0 && u[i + 6] === 0 && u[i + 7] === 0) { u[i + 4] = 3; break; }
  }
  parseCrv(u, {});
}));

// --- the whole point: these polys drop straight into the DXF import pipeline ---
const shapes = C.dxfPolysToShapes(polys);
ok('dxfPolysToShapes accepts crv polys', shapes.length === 2, shapes.length);
ok('shapes keep the Vectric layer name', shapes.every(s => s.layer === 'Layer 1'), JSON.stringify(shapes.map(s => s.layer)));
ok('shapes are closed', shapes.every(s => s.closed), JSON.stringify(shapes.map(s => s.closed)));
const HAVE_P3 = typeof p3 !== 'undefined';
const shapes3 = C.dxfPolysToShapes(HAVE_P3 ? p3 : load('sample-tabs.crv3d'));
if (HAVE_P3) ok('crv3d: dxfPolysToShapes yields 5 shapes', shapes3.length === 5, shapes3.length);
const shapesT = C.dxfPolysToShapes(txt);
ok('text: dxfPolysToShapes yields 15 shapes', shapesT.length === 15, shapesT.length);

// --- CAM round trip: import -> contours -> profile -> post ---
const contours = CAM.assembleContours(C.shapesToContoursInput(shapes3));
const res = CAM.profileOp(contours, { side: 'outside', toolDia: 0.25, cutDepth: 0.25, passDepth: 0.5 });
ok('profileOp on imported crv shapes has passes', res.ops[0].passes.length > 0, res.ops[0].passes.length);
const g = CAM.postProcess({ name: 'crvimport', units: 'inch', ops: res.ops }, CAM.POSTS.shopsabre);
ok('postProcess produces g-code', g.length > 0 && /G90/.test(g), g.length);
// …and the same round trip on the text glyphs, which is what a customer's engraved sign is.
const gT = CAM.postProcess({ name: 'crvtext', units: 'inch',
  ops: CAM.profileOp(CAM.assembleContours(C.shapesToContoursInput(shapesT)),
    { side: 'outside', toolDia: 0.125, cutDepth: 0.1, passDepth: 0.5 }).ops }, CAM.POSTS.shopsabre);
ok('text: postProcess produces g-code', gT.length > 0 && /G90/.test(gT), gT.length);

// ===========================================================================
// end to end: parse -> dxfPolysToShapes -> doc.layers -> Layers panel
// ===========================================================================
// A shape carrying a .layer string is NOT the finish line. doc.layers is what the Layers panel
// lists, what gives a layer its colour and what the visibility checkboxes toggle, so an import that
// never registers the name leaves the panel showing only "0" and every vector drawn in the default
// ink — which is exactly what "the drawing came in with no layers" looks like on screen. These
// checks drive the studio's own importCRV / importText headlessly (studio_app.js in a vm with a
// stub DOM, the same way importtest.js drives dxfparse) over a fixture with TWO populated layers:
// sample-bitmap.crv3d holds 7 contours on "Layer 1" and 16 on "outlines".
function studioContext() {
  const mkEl = tag => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [],
      value: '', checked: false, textContent: '', _html: '', width: 800, height: 600, scrollTop: 0,
      // innerHTML='' is how the panels clear themselves before a rebuild — mirror that on children
      // so a row count means "rows the panel is showing now", not "rows ever appended".
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; if (v === '') this.children.length = 0; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
      removeChild() {}, remove() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      setAttribute() {}, getAttribute() { return null; }, focus() {}, click() {}, closest() { return null; },
      contains() { return false; }, querySelector() { return mkEl('input'); }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
      getContext() {
        return new Proxy({ canvas: { width: 800, height: 600 } }, { get: (t, k) => {
          if (k in t) return t[k];
          if (k === 'measureText') return () => ({ width: 10 });
          if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
          if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
          return () => {};
        }, set: () => true });
      }
    };
    el.parentElement = { getBoundingClientRect: el.getBoundingClientRect };
    return el;
  };
  const byId = {};
  const document = {
    createElement: mkEl, createElementNS: mkEl, createTextNode: t => ({ t }),
    getElementById(id) { return byId[id] || (byId[id] = mkEl('div')); },
    querySelector() { return mkEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html'), activeElement: { tagName: 'BODY' }
  };
  const ctx = {
    document, console, Math, JSON, Date, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, TextDecoder, TextEncoder, parseFloat, parseInt, isNaN, isFinite,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node' }, location: { href: 'file:///studio' }, performance: { now: () => Date.now() },
    Blob: function () {}, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} }, FileReader: function () {},
    Image: function () {}, alert() {}, prompt: () => null, confirm: () => true,
    matchMedia: () => ({ matches: false, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const order = ['package/clipper.js', 'package/opentype.js', 'camcore.js', 'cadcore.js', 'dxfparse.js',
                 'pdfparse.js', 'crvparse.js', 'bitmaptrace.js', 'clipart.js', 'studio_app.js'];
  for (const f of order) vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const eIn = (c, expr) => vm.runInContext(expr, c);
const layerKeys = c => JSON.parse(eIn(c, 'JSON.stringify([...doc.layers.keys()])'));
const shapeLayers = c => JSON.parse(eIn(c, '(()=>{const o={};for(const s of doc.shapes)o[s.layer]=(o[s.layer]||0)+1;return JSON.stringify(o)})()'));
const panelRows = c => eIn(c, '(()=>{const el=document.getElementById("layerList");return el&&el.children?el.children.length:-1})()');
const panelText = c => eIn(c, '(()=>{const el=document.getElementById("layerList");return el&&el.children?el.children.map(r=>r.innerHTML).join("|"):""})()');

let studio = null;
try { studio = studioContext(); } catch (e) { console.log('  studio load failed:', e.message); }
ok('studio loads headlessly with importCRV + importText', !!studio &&
   eIn(studio, 'typeof importCRV') === 'function' && eIn(studio, 'typeof importText') === 'function');

if (studio) {
  const crvBuf = fs.readFileSync(path.join(__dirname, 'sample-bitmap.crv3d'));
  const ab = crvBuf.buffer.slice(crvBuf.byteOffset, crvBuf.byteOffset + crvBuf.byteLength);

  // ---- the .crv3d import path (file picker and drag-drop both call importCRV) ----
  studio.__ab = ab;
  eIn(studio, 'importCRV("sample-bitmap.crv3d", __ab)');
  const kCrv = layerKeys(studio);
  ok('crv import registers both Vectric layers in doc.layers',
     kCrv.indexOf('Layer 1') >= 0 && kCrv.indexOf('outlines') >= 0, JSON.stringify(kCrv));
  ok('crv import never registers the discarded preview layer',
     kCrv.indexOf('Toolpath Previews') < 0, JSON.stringify(kCrv));
  ok('crv import: shapes sit on their own Vectric layers',
     JSON.stringify(shapeLayers(studio)) === JSON.stringify({ 'Layer 1': 7, outlines: 16 }),
     JSON.stringify(shapeLayers(studio)));
  ok('crv import: the Layers panel lists every layer, by name',
     panelRows(studio) === kCrv.length && /Layer 1/.test(panelText(studio)) && /outlines/.test(panelText(studio)),
     panelRows(studio) + ' rows vs ' + kCrv.length + ' layers · ' + panelText(studio));
  const colours = JSON.parse(eIn(studio, 'JSON.stringify([...doc.layers.values()].map(v=>v.color))'));
  ok('crv import: each layer gets its own colour', new Set(colours).size === colours.length, JSON.stringify(colours));

  // ---- the DXF import path carries layer names in its "8" tags and must register them too ----
  eIn(studio, 'doc.shapes=[]; doc.layers=new Map([["0",{visible:true,color:"#1b2b3f"}]]); activeLayer="0";');
  studio.__dxf = eIn(studio, 'CADCORE.toDXF(CADCORE.dxfPolysToShapes(parseCrv(new Uint8Array(__ab),{})))');
  ok('round-trip DXF still carries the layer names', /outlines/.test(studio.__dxf));
  eIn(studio, 'importText("roundtrip.dxf", __dxf)');
  const kDxf = layerKeys(studio);
  ok('dxf import registers its layers in doc.layers',
     kDxf.indexOf('Layer 1') >= 0 && kDxf.indexOf('outlines') >= 0, JSON.stringify(kDxf));
  ok('dxf import: shapes sit on their own layers',
     JSON.stringify(shapeLayers(studio)) === JSON.stringify({ 'Layer 1': 7, outlines: 16 }),
     JSON.stringify(shapeLayers(studio)));
  ok('dxf import: the Layers panel lists every layer, by name',
     panelRows(studio) === kDxf.length && /Layer 1/.test(panelText(studio)) && /outlines/.test(panelText(studio)),
     panelRows(studio) + ' rows vs ' + kDxf.length + ' layers · ' + panelText(studio));
}

console.log(`\n${pass}/${pass + fail} crv checks passed`);
process.exit(fail ? 1 : 0);
