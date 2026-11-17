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
      contains() { return false; }, querySelector() { return mkEl('input'); }, querySelectorAll() { return [mkEl('button'), mkEl('button'), mkEl('button')]; },
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
    // studio_app.js wraps every length field's native `value` property, so the stub needs the real thing's shape.
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    HTMLInputElement: (() => { function H() {} Object.defineProperty(H.prototype, 'value', { get() { return this._v === undefined ? '' : this._v; }, set(v) { this._v = v; }, configurable: true }); return H; })(),
    navigator: { userAgent: 'node' }, location: { href: 'file:///studio' }, performance: { now: () => Date.now() },
    Blob: function () {}, URL: { createObjectURL: () => 'blob:', revokeObjectURL() {} }, FileReader: function () {},
    Image: function () {}, alert() {}, prompt: () => null, confirm: () => true,
    matchMedia: () => ({ matches: false, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  const order = ['package/clipper.js', 'package/opentype.js', 'camcore.js', 'cadcore.js', 'cutprep.js', 'dxfparse.js',
                 'pdfparse.js', 'tpdparse.js', 'crvparse.js', 'crvtoolpaths.js', 'bitmaptrace.js', 'clipart.js', 'gcodesim.js', 'tapedit.js', 'assembly.js', 'studio_app.js'];
  for (const f of order) vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const eIn = (c, expr) => vm.runInContext(expr, c);
const layerKeys = c => JSON.parse(eIn(c, 'JSON.stringify([...doc.layers.keys()])'));
const shapeLayers = c => JSON.parse(eIn(c, '(()=>{const o={};for(const s of doc.shapes)o[s.layer]=(o[s.layer]||0)+1;return JSON.stringify(o)})()'));
// a layer row, as distinct from the "+ Add layer" button and the other controls the panel appends after the rows
const panelRows = c => eIn(c, '(()=>{const el=document.getElementById("layerList");return el&&el.children?el.children.filter(r=>/^lyr/.test(r.className||"")).length:-1})()');
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

// --- reliability: the report channel, toolpaths, thickness and units evidence ---
const ctxTP = {}; vm.createContext(ctxTP);
for (const f of ['tpdparse.js', 'crvparse.js', 'crvtoolpaths.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctxTP, { filename: f });
const tp2 = vm.runInContext('CRVPARSE', ctxTP).toShapes(bytes('sample-tabs.crv3d'), { tol: 0.002 });
const tr = vm.runInContext('CRVTP', ctxTP).toStudioOps(tp2.toolpathData, { guids: tp2.layers.flatMap(L => L.contours.map(c => c.guid)), safeZ: tp2.safeZ });
ok('toolpaths: the saved Profile comes through', tr.ops.length === 1 && tr.ops[0].name === 'Profile 2' && tr.ops[0].p.op === 'profile', JSON.stringify(tr.ops.map(o => o.name)));
ok('toolpaths: tool and depth are the file\'s', tr.ops[0].p.toolNum === 7 && tr.ops[0].p.cutDepth > 0 && tr.ops[0].guids.length === 1, JSON.stringify(tr.ops[0].p).slice(0, 200));
ok('toShapes carries job thickness', tp2.job && tp2.job.thickness > 0, JSON.stringify(tp2.job));
ok('toShapes names the contour guids', tp2.layers[0].contours[0].guid && tp2.layers[0].contours[0].guid.length === 32, tp2.layers[0].contours[0].guid);
const tr3 = vm.runInContext('CRVTP', ctxTP).toStudioOps({ toolpaths: [{ name: 'X', type: 'Fancy', params: {}, tools: [{ toolNum: 1, dia: 0.25, passDepth: 0.1, stepover: 0.1, feed: 10, plunge: 5, rpm: 1000 }], selection: ['aa'] }, { name: 'Y', type: 'Drill', params: { _dpdCutDepth: 0.5 }, tools: [{ toolNum: 1, dia: 0.25, passDepth: 0.1, stepover: 0.1, feed: 10, plunge: 5, rpm: 1000 }], selection: ['missing'] }] }, { guids: ['aa'] });
ok('toolpaths: an unsupported kind is named as lost', tr3.ops.length === 0 && tr3.report.some(r => r.code === 'TOOLPATH_NOT_CONVERTED' && r.level === 'loss' && r.items[0].indexOf('X') === 0), JSON.stringify(tr3.report));
ok('toolpaths: a selection with no vectors is named as lost', tr3.report.some(r => r.code === 'TOOLPATH_NO_VECTORS' && r.items[0] === 'Y'), JSON.stringify(tr3.report));
const op4 = g => ({ name: 'P', type: 'Profile Outside', params: { _ppdCutDepth: 0.5, _mctddDepthValues: '0.25;0.5' }, tools: [{ toolNum: 1, dia: 0.25, passDepth: 0.1, stepover: 0.1, feed: 10, plunge: 5, rpm: 1000 }], selection: g });
const trO = vm.runInContext('CRVTP', ctxTP).toStudioOps({ toolpaths: [op4(['a', 'b'])] }, { guids: ['a', 'b'], openGuids: ['b'] });
ok('toolpaths: an open vector is not cut on the line by an outside profile', trO.ops.length === 1 && trO.ops[0].guids.join() === 'a' && trO.report.some(r => r.code === 'TOOLPATH_OPEN_VECTORS' && r.level === 'loss'), JSON.stringify(trO));
const trO2 = vm.runInContext('CRVTP', ctxTP).toStudioOps({ toolpaths: [op4(['b'])] }, { guids: ['a', 'b'], openGuids: ['b'] });
ok('toolpaths: all-open is not imported at all', trO2.ops.length === 0 && trO2.report[0].code === 'TOOLPATH_OPEN_VECTORS', JSON.stringify(trO2));
const clean = parseCrv(bytes('sample.crv'), {});
ok('a clean file has an empty report', Array.isArray(clean.report) && clean.report.filter(r => r.level !== 'info').length === 0, JSON.stringify(clean.report));
ok('a bitmap is reported as not imported', parseCrv(bytes('sample-bitmap.crv3d'), {}).report.some(r => r.code === 'BITMAP_NOT_IMPORTED' && r.level === 'loss'));
ok('a 3D model is reported as not imported', parseCrv(bytes('sample-model.crv3d'), {}).report.some(r => r.code === 'MODEL_3D_NOT_IMPORTED' && r.level === 'loss'));
if (studio) {
  const buf2 = fs.readFileSync(path.join(__dirname, 'sample-tabs.crv3d')); studio.__ab2 = buf2.buffer.slice(buf2.byteOffset, buf2.byteOffset + buf2.byteLength);
  eIn(studio, 'doc.shapes=[];opsQueue=[];doc.layers=new Map([["0",{visible:true,color:"#1b2b3f"}]]);');
  eIn(studio, 'importCRV("sample-tabs.crv3d", __ab2)');
  ok('studio: the toolpath lands in the list', eIn(studio, 'opsQueue.length') === 1 && eIn(studio, 'opsQueue[0].ids.length') === 1);
  ok('studio: material thickness is applied', Math.abs(eIn(studio, 'job.thickness') - tp2.job.thickness) < 1e-9);
  const seg = JSON.parse(eIn(studio, 'JSON.stringify(toolpathSegs("[G0 X9 Y9]\\nG0 X1 Y0\\nG1 X2 F10 [X50]\\n"))'));
  ok('2D backplot honours WinCNC [comments]', seg.length === 2 && Math.max(...seg.map(s => s.x1)) === 2, JSON.stringify(seg));
  const fc = JSON.parse(eIn(studio, 'JSON.stringify(toolpathSegs("g0x1.5y0\\ng2i2f300\\n"))'));
  ok('2D backplot draws an I-only full circle', fc.length >= 24 && fc.some(s => s.x1 > 5.4), fc.length);
  ok('studio: the toolpath selection is real shape ids', eIn(studio, 'doc.shapes.some(s=>s.id===opsQueue[0].ids[0])'));
}

// --- Settings: units chosen by hand and the anchor check ---
{
  const inchRead = parseCrv(bytes('sample-tabs.crv3d'), { units: 'inch' }), mmRead = parseCrv(bytes('sample-tabs.crv3d'), { units: 'mm' });
  const xOf = r => r.reduce((m, p) => Math.max(m, ...p.pts.map(q => q.x)), -Infinity);
  ok('units: choosing mm divides the drawing by 25.4', Math.abs(xOf(mmRead) * 25.4 - xOf(inchRead)) < 1e-6, xOf(mmRead) + ' vs ' + xOf(inchRead));
  ok('units: a choice against the automatic reading is flagged', mmRead.report.some(r => r.code === 'UNITS_CHOSEN' && r.level === 'warn'), JSON.stringify(mmRead.report));
  ok('units: a choice that agrees is only a note', inchRead.report.some(r => r.code === 'UNITS_CHOSEN' && r.level === 'info'), JSON.stringify(inchRead.report));
  ok('units: automatic adds no choice note', !parseCrv(bytes('sample-tabs.crv3d'), {}).report.some(r => r.code === 'UNITS_CHOSEN'));
}
// A fixture with every saved anchor moved 5" off its drawing: each anchor is found by its value and overwritten in place.
function staleAnchors(file) {
  const out = bytes(file), dv = new DataView(out.buffer, out.byteOffset, out.byteLength), boxes = new Map();
  for (const p of parseCrv(bytes(file), {})) { const g = p.ent.guid, b = boxes.get(g) || [Infinity, Infinity, -Infinity, -Infinity]; for (const q of p.pts) { b[0] = Math.min(b[0], q.x); b[1] = Math.min(b[1], q.y); b[2] = Math.max(b[2], q.x); b[3] = Math.max(b[3], q.y); } boxes.set(g, b); }
  const centres = [...boxes.values()].map(b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]); let n = 0;
  for (let i = 0; i + 16 <= out.length; i++) { const x = dv.getFloat64(i, true); if (!isFinite(x) || Math.abs(x) > 1e5) continue; const y = dv.getFloat64(i + 8, true); if (centres.some(c => Math.abs(c[0] - x) < 0.01 && Math.abs(c[1] - y) < 0.01)) { dv.setFloat64(i, x + 5, true); n++; i += 15; } }
  return { out, n };
}
const stale = staleAnchors('sample-points.crv3d');
ok('anchors: the test fixture was really altered', stale.n >= 4, stale.n);
ok('anchors: with the check off, the file opens and it is noted', parseCrv(stale.out, {}).report.some(r => r.code === 'STALE_ANCHORS' && r.level === 'info'));
let anchorErr = null; try { parseCrv(stale.out, { strictAnchors: true }); } catch (e) { anchorErr = e; }
ok('anchors: with the check on, the file is refused and says why', anchorErr && anchorErr.anchorMismatch === true && /anchor/.test(anchorErr.message), anchorErr && anchorErr.message);
ok('anchors: with the check on, a good file still opens', parseCrv(bytes('sample-points.crv3d'), { strictAnchors: true }).length > 0);

// --- Save and Save As: what gets overwritten and what does not ---
async function saveChecks() {
  if (!studio) return;
  const mkHandle = name => ({ name, kind: 'file', writes: [], data: null, async createWritable() { const h = this; return { async write(d) { h.data = d; h.writes.push(d); }, async close() {} }; } });
  const dxfT = (extra, u) => ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(u || 1), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'L1', '10', '0', '20', '0', '11', '4', '21', '0'].concat(extra || [], ['0', 'ENDSEC', '0', 'EOF']).join('\n');
  const textEnt = ['0', 'TEXT', '8', 'L1', '10', '1', '20', '1', '40', '1', '1', 'HELLO'];
  const reset = () => eIn(studio, 'newJob();PB.file=null;document.getElementById("gcModal").style.display="none";SETTINGS.importUnits="auto";SETTINGS.strictAnchors=false;');
  let picked = null, pickH = null; studio.showSaveFilePicker = async o => { picked = o; return pickH; };
  const open = (name, text, h) => { studio.__t = text; studio.__h = h; eIn(studio, 'importText(' + JSON.stringify(name) + ',__t,__h)'); };
  const save = () => eIn(studio, 'fileSave()'), saveAs = () => eIn(studio, 'fileSaveAs()');

  reset(); let h = mkHandle('a.dxf'); open('a.dxf', dxfT(), h); await save();
  ok('save: a clean DXF writes back to itself', h.writes.length === 1 && eIn(studio, 'projectFile.format') === 'dxf', h.writes.length);
  { const e = vm.runInContext('(t=>parseDxf(t))', studio)(h.data); ok('save: what was written reopens as the same line', e.length === 1 && e[0].layer === 'L1', JSON.stringify(e).slice(0, 200)); }

  reset(); h = mkHandle('b.dxf'); open('b.dxf', dxfT(textEnt), h); pickH = mkHandle('b-edited.dxf'); picked = null; await save();
  ok('save: a DXF that lost text on import is never overwritten', h.writes.length === 0 && picked && picked.suggestedName === 'b-edited.dxf' && pickH.writes.length === 1, picked && picked.suggestedName);

  reset(); h = mkHandle('c.dxf'); open('c.dxf', dxfT([], 4), h); pickH = mkHandle('c2.dxf'); picked = null; await save();
  ok('save: a DXF converted from mm is never overwritten', h.writes.length === 0 && !!picked);

  reset(); h = mkHandle('d.dxf'); open('d.dxf', dxfT(), h); eIn(studio, 'opsQueue.push({p:{},ids:[],name:"x"})'); pickH = mkHandle('d.aqcam'); picked = null; await save();
  ok('save: toolpaths divert a DXF save to .aqcam', h.writes.length === 0 && picked && /\.aqcam$/.test(picked.suggestedName) && eIn(studio, 'projectFile.format') === 'aqcam', picked && picked.suggestedName);

  reset(); h = mkHandle('e.dxf'); open('e.dxf', dxfT(), h); eIn(studio, 'doc.shapes=[]'); picked = null; await save();
  ok('save: an emptied DXF does not wipe the file', h.writes.length === 0 && !picked);

  reset(); eIn(studio, 'doc.shapes=[CADCORE.mkPoly([{x:0,y:0},{x:1,y:1}],false,"0")]'); const job1 = mkHandle('job.aqcam'); eIn(studio, 'setSaveTarget'); studio.__j = job1; eIn(studio, 'setSaveTarget(__j,"job.aqcam","aqcam")');
  h = mkHandle('f.dxf'); open('f.dxf', dxfT(), h); await save();
  ok('save: a DXF merged into a job saves the job, not the DXF', h.writes.length === 0 && job1.writes.length === 1, h.writes.length + '/' + job1.writes.length);

  reset(); eIn(studio, 'doc.shapes=[CADCORE.mkPoly([{x:0,y:0},{x:1,y:1}],false,"0")]'); pickH = mkHandle('out.dxf'); picked = null; await saveAs();
  ok('save as: the name chosen sets the format', eIn(studio, 'projectFile.format') === 'dxf' && /LINE|POLYLINE/.test(pickH.data) && picked.types.length === 2, String(pickH.data).slice(0, 60));
  await save(); ok('save as: Save then goes to the new file', pickH.writes.length === 2, pickH.writes.length);

  const denied = mkHandle('g.dxf'); denied.queryPermission = async () => 'prompt'; denied.requestPermission = async () => 'denied';
  reset(); open('g.dxf', dxfT(), denied); pickH = mkHandle('g2.dxf'); picked = null; await save();
  ok('save: refused permission falls back to Save As', denied.writes.length === 0 && !!picked && pickH.writes.length === 1);

  // G-code: bytes exact, the handle survives an edit, unapplied hand edits are not lost
  reset(); const tapH = mkHandle('p.tap'); studio.__h = tapH;
  const tap = 'G0 Z0.5\r\nG0 X1 Y1\r\nG1 Z-0.1 F20\r\nG1 X2 F60 [caf\xe9]\r\nG0 Z0.5\r\n'; studio.__b = Uint8Array.from(Buffer.from(tap, 'latin1')).buffer;
  eIn(studio, 'openProgramBytes("p.tap",__b,__h)');
  await save(); ok('save: an unedited program is not rewritten', tapH.writes.length === 0, tapH.writes.length);
  eIn(studio, 'gcCommit(TAPEDIT.translate(PB.file.text,{dx:1,dy:0}));document.getElementById("gcModal").style.display="block";document.getElementById("gcText").value=PB.file.text.replace(/\\r\\n/g,"\\n")');   // a real text box reports LF
  ok('save: a CRLF program in the text box is not mistaken for unapplied edits', eIn(studio, 'gcTextPending()') === false);
  await save();
  const want = eIn(studio, 'TAPEDIT.textToBytes(PB.file.text)');
  ok('save: an edited program writes back to the opened file', tapH.writes.length === 1 && Buffer.from(tapH.data).equals(Buffer.from(want)), tapH.writes.length);
  ok('save: edited bytes keep CRLF and the comment byte', Buffer.from(tapH.data).toString('latin1').includes('[caf\xe9]\r\n'));
  eIn(studio, 'document.getElementById("gcModal").style.display="block";document.getElementById("gcText").value=PB.file.text+"G0 X9\\n"');
  await save(); ok('save: hand edits that were not applied block the save', tapH.writes.length === 1, tapH.writes.length);
  eIn(studio, 'document.getElementById("gcText").value=PB.file.text'); pickH = mkHandle('p2.tap'); picked = null; await saveAs();
  ok('save as: G-code writes the new file and Save follows it', pickH.writes.length === 1 && eIn(studio, 'PB.file.name') === 'p2.tap' && /-edited\.tap$/.test(picked.suggestedName), picked && picked.suggestedName);
  eIn(studio, 'document.getElementById("gcModal").style.display="none";doc.shapes=[CADCORE.mkPoly([{x:0,y:0},{x:1,y:1}],false,"0")]');
  ok('save: with a drawing open and the editor closed, Save means the drawing', eIn(studio, 'programIsCurrent()') === false);

  // Settings reach the importers
  reset(); const ab3 = fs.readFileSync(path.join(__dirname, 'sample-tabs.crv3d')); studio.__ab3 = ab3.buffer.slice(ab3.byteOffset, ab3.byteOffset + ab3.byteLength);
  eIn(studio, 'importCRV("s.crv3d",__ab3)'); const w0 = eIn(studio, 'job.w');
  reset(); eIn(studio, 'SETTINGS.importUnits="mm";importCRV("s.crv3d",__ab3)');
  ok('settings: units apply to a Vectric open', Math.abs(eIn(studio, 'job.w') * 25.4 - w0) < 1e-6 && eIn(studio, 'lastReport.items.some(r=>r.code==="UNITS_CHOSEN")'), eIn(studio, 'job.w') + ' vs ' + w0);
  ok('settings: the report offers the other units', eIn(studio, '!!lastReport.opts.action'));
  reset(); eIn(studio, 'SETTINGS.importUnits="mm"'); open('m.dxf', dxfT(), mkHandle('m.dxf'));
  ok('settings: units apply to a DXF open, which is then not overwritten', Math.abs(eIn(studio, 'CADCORE.bbox(doc.shapes[0]).maxX') - 4 / 25.4) < 1e-6 && !!eIn(studio, 'projectFile.why'));
  reset(); eIn(studio, 'SETTINGS.strictAnchors=true'); studio.__st = stale.out.buffer.slice(stale.out.byteOffset, stale.out.byteOffset + stale.out.byteLength);
  eIn(studio, 'importCRV("st.crv3d",__st)');
  ok('settings: anchor check on refuses in the studio', eIn(studio, 'doc.shapes.length') === 0 && eIn(studio, 'lastReport.items[0].code') === 'ANCHOR_MISMATCH');
  eIn(studio, 'lastReport.opts.action.fn()');
  ok('settings: Open Anyway opens it', eIn(studio, 'doc.shapes.length') > 0);
  reset();
}
saveChecks().catch(e => ok('save checks ran', false, e.stack)).then(() => {
  console.log(`\n${pass}/${pass + fail} crv checks passed`);
  process.exit(fail ? 1 : 0);
});
