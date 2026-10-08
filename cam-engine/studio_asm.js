/* studio_asm.js — the 2D + 3D Assembly view of CAD/CAM Studio.
 *
 * Splits the stage: the 2D sheet editor stays on the left, a live 3D assembly of every sheet's parts is on the right.
 * An assembly is a .assembly.json kept next to its DXFs (format in assembly.js); open it together with the DXFs
 * (File > Open Assembly…, or drop them all at once). Each DXF becomes a sheet you can switch the editor to; its
 * toolpaths come from its layer names in Dan's style. With no assembly file, the 3D side shows the open sheet's parts
 * extruded flat where they sit.
 *
 * Live sync: every 2D render schedules a refresh; a cheap fingerprint of the active sheet decides whether anything
 * changed, and assembly.js rebuilds only the parts whose geometry or placement changed. 2D selection highlights the
 * parts it touches; clicking a part in 3D switches to its sheet and selects its outline + cuts in 2D.
 *
 * Loaded after studio_app.js; shares its globals (doc, sel, job, opsQueue, history, …).
 */
const ASM = {
  on: false, data: null, name: '', sheets: [], active: null, cache: new Map(), r: null, failed: false,
  lastFp: null, lastHi: '', raf: 0, stats: { ms: 0, rebuilt: [], parts: 0, at: 0 }, built: null, flat: true
};
const ASM_LAYER_COLORS = { profile: '#1b2b3f', inside: '#b8541c', drill: '#8a2f8f', pocket: '#1f7a3a', skip: '#b8860b', sheet: '#9aa5b1', unknown: '#3b4fb8' };
function asmLayerColor(name) { const k = ASSEMBLY.layerRule(name).kind; return name === 'NOTES' ? '#9aa5b1' : (ASM_LAYER_COLORS[k] || '#1b2b3f'); }
function asmThicknessFromName(name, dflt) {
  const m = /(\d+(?:\.\d+)?|\.\d+)\s*(?:in\b|"|thick)/i.exec(String(name || '').replace(/\d+(?:\.\d+)?x\d+(?:\.\d+)?/g, ''));
  const t = m ? parseFloat(m[1]) : NaN;
  return (t > 0 && t <= 6) ? t : dflt;
}
// DXF text -> {shapes, layers Map, job patch, queue} — the studio's import path plus layer-name defaults
function asmSheetFromDxf(name, text, thickness) {
  const polys = []; for (const e of parseDxf(text)) for (const p of entityToPolys(e)) polys.push(p);
  const shapes = CADCORE.dxfPolysToShapes(polys);
  const names = []; for (const s of shapes) if (names.indexOf(s.layer) < 0) names.push(s.layer);
  const layers = new Map(names.map(n => [n, { visible: true, color: asmLayerColor(n) }]));
  const T = thickness || asmThicknessFromName(name, job.thickness || 0.75);
  const sheetShape = shapes.find(s => s.layer === 'SHEET');
  const jb = { thickness: T };
  if (sheetShape) { const b = CADCORE.bboxAll([sheetShape]); jb.w = +(b.maxX - b.minX).toFixed(4); jb.h = +(b.maxY - b.minY).toFixed(4); jb.origin = 'bl'; }
  const queue = ASSEMBLY.isLayerJob(names) ? ASSEMBLY.jobFromLayers(names, T).queue.map(normalizeOp) : [];
  return { shapes, layers, job: jb, queue, layerNames: names };
}
// Hook for importText: a single layer-named DXF gets its sheet size, thickness and toolpaths from its layers.
function asmApplyLayerDefaults(name, shapes) {
  const names = []; for (const s of shapes) if (names.indexOf(s.layer) < 0) names.push(s.layer);
  if (!ASSEMBLY.isLayerJob(names)) return false;
  for (const n of names) if (!doc.layers.has(n)) doc.layers.set(n, { visible: true, color: asmLayerColor(n) });
  const T = asmThicknessFromName(name, job.thickness);
  job.thickness = T;
  const sh = shapes.find(s => s.layer === 'SHEET');
  if (sh) { const b = CADCORE.bboxAll([sh]); job.w = +(b.maxX - b.minX).toFixed(4); job.h = +(b.maxY - b.minY).toFixed(4); job.origin = 'bl'; }
  applyJobInputs();
  if (!opsQueue.length) { opsQueue = ASSEMBLY.jobFromLayers(names, T).queue.map(normalizeOp); buildQueueList(); }
  setMsg('Layer defaults: ' + opsQueue.length + ' toolpath(s) from ' + names.length + ' layer(s), ' + T + '" thick — T8 drills first, pockets one pass, sheet profiles CCW');
  return true;
}

// ---- sheets ------------------------------------------------------------------------------------------------
function asmSheet(id) { return ASM.sheets.find(s => s.id === id); }
function asmStoreActive() {
  const sh = asmSheet(ASM.active); if (!sh) return;
  sh.st = { shapes: doc.shapes, layers: doc.layers, opsQueue, job: Object.assign({}, job), history, future, activeLayer };
  sh.items = null;   // recomputed from st.shapes when the sheet is not the one being edited
}
function asmLoadSheet(id, quiet) {
  const sh = asmSheet(id); if (!sh || id === ASM.active) return;
  asmStoreActive();
  const st = sh.st;
  doc.shapes = st.shapes; doc.layers = st.layers; opsQueue = st.opsQueue; Object.assign(job, st.job);
  history = st.history || []; future = st.future || []; activeLayer = st.activeLayer || (st.layers.keys().next().value || '0');
  ASM.active = id; sel.clear(); editingIdx = null; toolpaths = null; drillMarks = null;
  applyJobInputs(); buildQueueList(); syncPanels(); fitJob();
  const pick = document.getElementById('asmSheet'); if (pick) pick.value = id;
  if (!quiet) setMsg('Editing ' + (sh.label || sh.file || id) + ' — ' + doc.shapes.length + ' shape(s), ' + opsQueue.length + ' toolpath(s)');
  ASM.lastFp = null; render();
}
function asmItemsOf(shapes) {
  const out = [];
  for (const s of shapes) { if (s.annotation || s.type === 'dim' || !layerVisible(s.layer)) continue;
    CADCORE.flatten(s).forEach((lp, i) => out.push({ id: s.id, loop: i, layer: s.layer, pts: lp.pts, closed: lp.closed })); }
  return out;
}
// cheap change detector for the sheet being edited: geometry, layers, visibility, thickness
function asmFingerprint() {
  let h = 2166136261 >>> 0, n = 0;
  const mix = v => { h = Math.imul(h ^ (Math.round(v * 4096) | 0), 16777619) >>> 0; };
  for (const s of doc.shapes) {
    if (!layerVisible(s.layer)) continue;
    for (const c of String(s.layer)) mix(c.charCodeAt(0));
    for (const lp of CADCORE.flatten(s)) { mix(lp.closed ? 7 : 3); for (const p of lp.pts) { mix(p.x); mix(p.y); n++; } }
  }
  return h + ':' + n + ':' + doc.shapes.length + ':' + job.thickness + ':' + ASM.active;
}

// ---- open --------------------------------------------------------------------------------------------------
function asmReadText(f) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = e => res(e.target.result); rd.onerror = rej; rd.readAsText(f); }); }
const asmBase = n => String(n || '').split(/[\\/]/).pop().toLowerCase();
// files: File objects (or {name, text}) — one optional *.assembly.json plus the sheets' DXFs
async function asmOpenFiles(files) {
  const list = [];
  for (const f of files) list.push({ name: f.name, text: f.text != null && typeof f.text === 'string' ? f.text : await asmReadText(f) });
  const jsonF = list.find(f => /\.json$/i.test(f.name) && /"aqcam-assembly"/.test(f.text));
  const dxfs = list.filter(f => /\.dxf$/i.test(f.name));
  let asm = null, missing = [];
  if (jsonF) {
    try { asm = JSON.parse(jsonF.text); } catch (e) { setMsg('Assembly file is not valid JSON: ' + e.message); return false; }
    const errs = ASSEMBLY.validateAssembly(asm);
    if (errs.length) { setMsg('Assembly file problem: ' + errs[0]); return false; }
  }
  const sheets = [];
  if (asm) {
    for (const s of asm.sheets) {
      const f = dxfs.find(d => d.name === s.file) || dxfs.find(d => asmBase(d.name) === asmBase(s.file));
      if (!f) { missing.push(s.file || s.id); continue; }
      sheets.push(Object.assign({}, s, { file: f.name, text: f.text }));
    }
    if (!sheets.length) { setMsg('Assembly "' + (asm.name || jsonF.name) + '": none of its DXFs were opened with it (' + missing.join(', ') + ')'); return false; }
  } else {
    if (!dxfs.length) { setMsg('Nothing to assemble — open DXFs (and optionally their .assembly.json)'); return false; }
    dxfs.forEach((d, i) => sheets.push({ id: 's' + (i + 1), file: d.name, text: d.text, label: d.name.replace(/\.dxf$/i, '') }));
  }
  ASM.sheets = sheets.map(s => {
    const T = s.thickness || asmThicknessFromName(s.file, job.thickness || 0.75);
    const r = asmSheetFromDxf(s.file, s.text, T);
    const jb = Object.assign({ w: job.w, h: job.h, thickness: T, origin: 'bl', show: true }, r.job);
    return { id: s.id, label: s.label || s.file, file: s.file, thickness: T, color: s.color, setupOf: s.setupOf,
      st: { shapes: r.shapes, layers: r.layers, opsQueue: r.queue, job: jb, history: [], future: [], activeLayer: r.layerNames[0] || '0' } };
  });
  ASM.data = asm || ASSEMBLY.defaultAssembly(ASM.sheets.map(s => ({ id: s.id, w: s.st.job.w })));
  ASM.flat = !asm;
  ASM.name = asm ? (asm.name || jsonF.name) : (ASM.sheets.length + ' sheet(s), flat');
  ASM.cache = new Map(); ASM.lastFp = null; ASM.active = null;
  asmBuildSheetPicker();
  const first = ASM.sheets.find(s => !s.setupOf) || ASM.sheets[0];
  asmLoadSheet(first.id, true);
  setView('asm');
  if (ASM.r) { asmRefresh(true); ASM.r.frameAll(); ASM.r.draw(); }
  setMsg('Opened ' + ASM.name + ' — ' + ASM.sheets.length + ' sheet(s)' + (missing.length ? ' · MISSING: ' + missing.join(', ') : '') + ' · editing ' + first.label);
  return true;
}
async function asmOpenFolder() {
  if (!window.showDirectoryPicker) { document.getElementById('asmInput').click(); return; }
  let dir; try { dir = await window.showDirectoryPicker(); } catch (e) { return; }
  const files = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.(dxf|json)$/i.test(name)) files.push(await h.getFile());
  asmOpenFiles(files);
}
function asmSaveJSON() {
  const a = ASM.data && !ASM.flat ? ASM.data : null;
  if (!a) { setMsg('No assembly file is open (flat sheets have nothing to save)'); return; }
  download((ASM.name || 'product').replace(/[\\/:*?"<>|]+/g, '-') + '.assembly.json', JSON.stringify(a, null, 2) + '\n', 'application/json');
}

// ---- the 3D pane -------------------------------------------------------------------------------------------
function asmBuildSheetPicker() {
  const el = document.getElementById('asmSheet'); if (!el) return;
  el.innerHTML = '';
  for (const s of ASM.sheets) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.label + (s.setupOf ? '  (2nd setup of ' + s.setupOf.part + ')' : ''); el.appendChild(o); }
  el.value = ASM.active || '';
  el.parentElement.style.display = ASM.sheets.length ? '' : 'none';
}
function asmInitRenderer() {
  if (ASM.r || ASM.failed) return ASM.r;
  const c = document.getElementById('asmGl'); if (!c) { ASM.failed = true; return null; }
  ASM.r = GLVIEW.createAssemblyRenderer(c);
  if (!ASM.r) { ASM.failed = true; setMsg('3D assembly: WebGL unavailable'); return null; }
  asmApplyTheme();
  asmBindMouse(c);
  return ASM.r;
}
function asmApplyTheme() { if (ASM.r) ASM.r.setClear(darkMode ? [0.11, 0.13, 0.17] : [0.93, 0.95, 0.98]); }
function asmBindMouse(c) {
  let drag = null;
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.addEventListener('mousedown', e => { e.preventDefault(); drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button !== 0 || e.shiftKey, moved: false }; c.classList.add('drag'); });
  window.addEventListener('mousemove', e => {
    if (!drag || !ASM.r) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) { const k = ASM.r.cam.dist * 0.0012; ASM.r.pan(-dx * k, dy * k); } else ASM.r.orbit(dx * 0.008, dy * 0.008);
    ASM.r.draw();
  });
  window.addEventListener('mouseup', e => {
    if (!drag) return; const d = drag; drag = null; c.classList.remove('drag');
    if (!d.moved && e.target === c) { const r = c.getBoundingClientRect(); asmPickAt(e.clientX - r.left, e.clientY - r.top, e.shiftKey); }
  });
  c.addEventListener('wheel', e => { e.preventDefault(); if (!ASM.r) return; ASM.r.zoom(Math.exp(e.deltaY * 0.0012)); ASM.r.draw(); }, { passive: false });
  c.addEventListener('dblclick', e => { e.preventDefault(); if (!ASM.r) return; ASM.r.frameAll(); ASM.r.draw(); });
}
// 3D -> 2D: pick a part, switch the editor to its sheet, select its outline and cuts
function asmPickAt(px, py, add) {
  if (!ASM.r || !ASM.built) return null;
  const hit = ASM.r.pick(px, py);
  if (!hit) { if (!add) { sel.clear(); render(); syncPanels(); } return null; }
  const part = ASM.built.parts.find(p => p.id === hit.id); if (!part) return null;
  asmSelectPart(part, add);
  return part.id;
}
function asmSelectPart(part, add) {
  if (ASM.sheets.length) {
    const want = (part.sheet === ASM.active || part.setupSheets.indexOf(ASM.active) >= 0) ? ASM.active : part.sheet;
    if (want && want !== ASM.active && asmSheet(want)) asmLoadSheet(want, true);
  }
  const have = new Set(doc.shapes.map(s => s.id));
  if (!add) sel.clear();
  for (const id of part.ids) if (have.has(id)) sel.add(id);
  render(); syncPanels();
  setMsg('3D → 2D: ' + part.label + ' (' + [...sel].length + ' shape(s) on ' + ((asmSheet(ASM.active) || {}).label || 'this sheet') + ')');
}
function asmSetSplit(on) {
  ASM.on = !!on;
  const st = document.querySelector('.stage'); if (st) st.classList.toggle('split', ASM.on);
  resize();
  if (!ASM.on) return;
  if (!asmInitRenderer()) return;
  ASM.lastFp = null; asmRefresh(true);
  ASM.r.frameAll(); ASM.r.draw();
}
// called from render(): coalesce to one refresh per frame
function asmOnRender() { if (!ASM.on || ASM.raf) return; ASM.raf = requestAnimationFrame(() => { ASM.raf = 0; asmRefresh(false); }); }
function asmSheetsInput() {
  const out = {};
  if (!ASM.sheets.length) { out.sheet = { items: asmItemsOf(doc.shapes), thickness: job.thickness }; return out; }
  for (const s of ASM.sheets) {
    if (s.id === ASM.active) out[s.id] = { items: asmItemsOf(doc.shapes), thickness: job.thickness };
    else { if (!s.items) s.items = asmItemsOf(s.st.shapes); out[s.id] = { items: s.items, thickness: s.st.job.thickness }; }
  }
  return out;
}
function asmRefresh(force) {
  if (!ASM.on || !asmInitRenderer()) return;
  const t0 = performance.now();
  const fp = asmFingerprint();
  let didBuild = false;
  if (force || fp !== ASM.lastFp) {
    ASM.lastFp = fp;
    const data = ASM.sheets.length ? ASM.data : ASSEMBLY.defaultAssembly([{ id: 'sheet', w: job.w }]);
    let built;
    try { built = ASSEMBLY.buildAssembly(data, asmSheetsInput(), ASM.cache); }
    catch (err) { setMsg('3D assembly failed: ' + err.message); return; }
    const keep = new Set();
    for (const p of built.parts) {
      keep.add(p.id);
      if (built.rebuilt.indexOf(p.id) >= 0 || !ASM.r.parts.has(p.id)) ASM.r.setPart(p.id, p.mesh, hex3(p.color));
    }
    for (const id of [...ASM.r.parts.keys()]) if (!keep.has(id)) ASM.r.removePart(id);
    if (!ASM.built) ASM.r.frameAll();
    ASM.built = built; didBuild = true;
  }
  // 2D -> 3D: highlight every part the 2D selection touches
  const hi = [];
  if (ASM.built && sel.size) for (const p of ASM.built.parts) {
    const here = !ASM.sheets.length || p.sheet === ASM.active || p.setupSheets.indexOf(ASM.active) >= 0;
    if (here && p.ids.some(id => sel.has(id))) hi.push(p.id);
  }
  const hk = hi.join('|');
  if (hk !== ASM.lastHi || didBuild) { ASM.lastHi = hk; ASM.r.setHighlight(hi); ASM.r.draw(); }
  if (didBuild) {
    ASM.stats = { ms: Math.round(performance.now() - t0), rebuilt: ASM.built.rebuilt.slice(), parts: ASM.built.parts.length, at: Date.now(), errors: ASM.built.errors };
    asmStatus();
  }
  window.__asmStats = Object.assign({ highlight: hi }, ASM.stats);
}
function asmStatus() {
  const el = document.getElementById('asmStat'); if (!el || !ASM.built) return;
  const b = ASM.built, s = ASM.stats;
  const bend = b.parts.find(p => p.info && p.info.rise);
  el.textContent = (ASM.sheets.length ? ASM.name : 'This sheet, flat') + ' · ' + b.parts.length + ' part(s)'
    + (bend ? ' · arch ' + bend.info.rise.toFixed(2) + '" rise' : '')
    + (s.rebuilt.length ? ' · rebuilt ' + (s.rebuilt.length > 3 ? s.rebuilt.length + ' parts' : s.rebuilt.join(', ')) + ' in ' + s.ms + ' ms' : '')
    + (b.unplaced.length ? ' · ' + b.unplaced.length + ' part(s) not in the assembly' : '')
    + (b.errors.length ? ' · ⚠ ' + b.errors[0] : '');
}
function asmReset() {
  ASM.sheets = []; ASM.data = null; ASM.active = null; ASM.flat = true; ASM.name = ''; ASM.cache = new Map(); ASM.built = null; ASM.lastFp = null;
  if (ASM.r) for (const id of [...ASM.r.parts.keys()]) ASM.r.removePart(id);
  asmBuildSheetPicker();
}
function asmInit() {
  const g = id => document.getElementById(id);
  const inp = g('asmInput'); if (inp) inp.onchange = e => { const fs = [...e.target.files]; inp.value = ''; if (fs.length) asmOpenFiles(fs); };
  const pick = g('asmSheet'); if (pick) pick.onchange = e => asmLoadSheet(e.target.value);
  const fit = g('asmFit'); if (fit) fit.onclick = () => { if (ASM.r) { ASM.r.frameAll(); ASM.r.draw(); } };
  const iso = g('asmIso'); if (iso) iso.onclick = () => { if (ASM.r) { ASM.r.frameAll(); ASM.r.cam.yaw = -Math.PI / 2 + 0.6; ASM.r.cam.pitch = 0.5; ASM.r.draw(); } };
  const side = g('asmSide'); if (side) side.onclick = () => { if (ASM.r) { ASM.r.frameAll(); ASM.r.cam.yaw = 0; ASM.r.cam.pitch = 0.05; ASM.r.draw(); } };
  const top = g('asmTop'); if (top) top.onclick = () => { if (ASM.r) { ASM.r.frameAll(); ASM.r.cam.yaw = -Math.PI / 2; ASM.r.cam.pitch = GLVIEW.PITCH_LIMIT; ASM.r.draw(); } };
  Object.assign(MENU_ACTIONS, { 'asmopen': () => g('asmInput').click(), 'asmfolder': () => asmOpenFolder(), 'asmsave': () => asmSaveJSON(), 'vasm': () => setView('asm') });
  // dropping several files (or an assembly file) at once opens them as an assembly
  document.body.addEventListener('drop', e => {
    const fs = [...(e.dataTransfer && e.dataTransfer.files || [])];
    if (fs.length > 1 || (fs[0] && /\.json$/i.test(fs[0].name))) { e.stopImmediatePropagation(); e.preventDefault(); asmOpenFiles(fs); }
  }, true);
  window.addEventListener('resize', () => { if (ASM.on && ASM.r) ASM.r.draw(); });
}
asmInit();
