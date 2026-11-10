/* cncengine.js — the 3D engine window that the studio's 3D View tab opens. Same three.js r160 + OrbitControls bundle as the
 * 3D Product Viewer (package/aq3d-three.min.js), set up as a plain CNC table: a flat background, the spoilboard with an inch grid,
 * the stock, the toolpaths by tool, a cutter that plays through the program, and the numbers needed before cutting.
 *
 * The window parses the G-code itself with gcodesim.js, so it shows what the file says and not a second copy of the studio's state.
 * World axes are machine axes (X right, Y away from the operator, Z up), in inches, with the table's lower left corner at 0,0.
 *
 * Pure parts (placement, summarize, buildGroups, countBefore) are unit-tested in cncenginetest.js. page() builds the window's HTML
 * from script text the studio already carries, so the studio stays one offline file.
 */
(function (root, factory) {
  const m = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  root.CNCENGINE = m;
})(typeof self !== 'undefined' ? self : this, function (root) {
'use strict';

const TOOL_COLORS = [0x38bdf8, 0x4ade80, 0xfacc15, 0xc084fc, 0xfb923c, 0xf472b6, 0x2dd4bf, 0xa3e635];
const RAPID_COLOR = 0xff5a4d;
const OFF_TABLE_TOL = 0.01;

// Where the program sits on the table. A job knows its stock and origin. A bare program does not: its X0 Y0 is taken as the table
// corner, unless it cuts at negative coordinates, in which case it is slid just far enough to fit.
function placement(p, job) {
  const b = p.bounds;   // gcodesim returns inches, metric programs included
  if (job) return { dx: -job.x0, dy: -job.y0, bedZ: -job.thickness, stock: { x0: 0, y0: 0, x1: job.x1 - job.x0, y1: job.y1 - job.y0, thickness: job.thickness }, cutBox: null, assumedOrigin: false };
  const hasCut = b.cutX0 <= b.cutX1, deepest = hasCut ? b.z0 : 0;
  const dx = hasCut && b.cutX0 < -OFF_TABLE_TOL ? -b.cutX0 : 0, dy = hasCut && b.cutY0 < -OFF_TABLE_TOL ? -b.cutY0 : 0;
  return { dx, dy, bedZ: Math.min(deepest, -0.25), stock: null, assumedOrigin: true,
    cutBox: hasCut ? { x0: b.cutX0 + dx, y0: b.cutY0 + dy, x1: b.cutX1 + dx, y1: b.cutY1 + dy, z0: deepest } : null };
}

// One draw group per tool, plus one for all rapids. idx holds each segment's move number, in program order, for playback.
function buildGroups(p, G, pl) {
  const keyOf = i => p.kind[i] === G.RAPID ? 'r' : p.tool[i], counts = new Map();
  for (let i = 0; i < p.n; i++) { const k = keyOf(i); counts.set(k, (counts.get(k) || 0) + 1); }
  const groups = new Map(); for (const [k, n] of counts) groups.set(k, { key: k, n: 0, idx: new Int32Array(n), pos: new Float32Array(n * 6) });
  const dx = pl.dx, dy = pl.dy;
  for (let i = 0; i < p.n; i++) {
    const g = groups.get(keyOf(i)), o = g.n * 6;
    g.idx[g.n++] = i;
    g.pos[o] = p.x0[i] + dx; g.pos[o + 1] = p.y0[i] + dy; g.pos[o + 2] = p.z0[i];
    g.pos[o + 3] = p.x1[i] + dx; g.pos[o + 4] = p.y1[i] + dy; g.pos[o + 5] = p.z1[i];
  }
  return [...groups.values()];
}
// How many entries of the sorted array idx come before move i.
function countBefore(idx, i) { let lo = 0, hi = idx.length; while (lo < hi) { const m = (lo + hi) >> 1; if (idx[m] < i) lo = m + 1; else hi = m; } return lo; }

// The numbers and the warnings. Lengths and depths come back in inches.
function summarize(p, G, pl, opts) {
  const b = p.bounds, tl = G.timeline(p, opts.rapid), byTool = new Map(), warnings = [];
  let inStock = 0, inStockLine = 0, clearance = Infinity;
  for (let i = 0; i < p.n; i++) {
    const moved = p.x0[i] !== p.x1[i] || p.y0[i] !== p.y1[i];
    if (p.kind[i] === G.RAPID) {
      if (moved && p.z1[i] < -1e-6 && p.z0[i] < -1e-6) { if (!inStock) inStockLine = p.line[i]; inStock++; }
      if (moved && p.z1[i] >= 0 && p.z1[i] < clearance) clearance = p.z1[i];
      continue;
    }
    const t = byTool.get(p.tool[i]) || { tool: p.tool[i], cut: 0, plunge: 0, minutes: 0, deepest: 0 }; byTool.set(p.tool[i], t);
    const L = tl.len[i]; if (p.kind[i] === G.PLUNGE) t.plunge += L; else t.cut += L;
    t.minutes += p.feed[i] > 0 ? tl.len[i] / p.feed[i] : 0;
    t.deepest = Math.min(t.deepest, p.z1[i]);
  }
  const hasCut = b.cutX0 <= b.cutX1, W = opts.table.w, H = opts.table.h;
  const cut = hasCut ? { x0: b.cutX0 + pl.dx, y0: b.cutY0 + pl.dy, x1: b.cutX1 + pl.dx, y1: b.cutY1 + pl.dy } : null;
  const deepest = hasCut ? b.z0 : 0;
  if (cut && (cut.x0 < -OFF_TABLE_TOL || cut.y0 < -OFF_TABLE_TOL || cut.x1 > W + OFF_TABLE_TOL || cut.y1 > H + OFF_TABLE_TOL))
    warnings.push({ level: 'bad', msg: 'Cuts run off the ' + W + ' x ' + H + ' table: X ' + cut.x0.toFixed(2) + ' to ' + cut.x1.toFixed(2) + ', Y ' + cut.y0.toFixed(2) + ' to ' + cut.y1.toFixed(2) + '.' });
  else if (p.n && ((b.x1 + pl.dx) > W + OFF_TABLE_TOL || (b.y1 + pl.dy) > H + OFF_TABLE_TOL || (b.x0 + pl.dx) < -OFF_TABLE_TOL || (b.y0 + pl.dy) < -OFF_TABLE_TOL))
    warnings.push({ level: 'warn', msg: 'A rapid goes past the edge of the ' + W + ' x ' + H + ' table.' });
  if (inStock) warnings.push({ level: 'bad', msg: inStock + ' rapid move(s) travel below Z0, first at line ' + inStockLine + '.' });
  if (pl.stock && deepest < -(pl.stock.thickness + 0.1)) warnings.push({ level: 'warn', msg: 'Cuts ' + (-deepest - pl.stock.thickness).toFixed(3) + ' into the spoilboard, past the ' + pl.stock.thickness + ' stock.' });
  if (pl.assumedOrigin) warnings.push({ level: 'note', msg: (pl.dx || pl.dy) ? 'The program has negative coordinates, so it was slid onto the table for this view.' : 'Placed with program X0 Y0 at the table corner. The file does not say where the work origin is on the machine.' });
  const iss = p.issues || []; for (const i of iss.slice(0, 8)) warnings.push({ level: i.level === 'loss' ? 'bad' : 'warn', msg: i.msg });
  if (iss.length > 8) warnings.push({ level: 'warn', msg: (iss.length - 8) + ' more line(s) need attention.' });
  return { tl, tools: [...byTool.values()].sort((a, c) => a.tool - c.tool), cut, deepest, clearance: clearance === Infinity ? null : clearance, warnings };
}

const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%;margin:0;background:#22272c;color:#dfe5ea;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
#app{display:grid;grid-template-columns:minmax(0,1fr) 310px;grid-template-rows:42px minmax(0,1fr) 46px;height:100%}
#top,#bar{display:flex;align-items:center;gap:6px;padding:0 10px;background:#2b3137}#top{grid-column:1/3;border-bottom:1px solid #3b434b}#bar{border-top:1px solid #3b434b}
#name{font-weight:600;margin-right:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
button,select,input[type=number]{font:inherit;color:inherit;background:#3b434b;border:1px solid #4d5660;border-radius:4px;padding:3px 9px;cursor:pointer}button:hover{background:#4d5660}button.on{background:#2f7dbd;border-color:#2f7dbd}
label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}.sp{flex:1}#view{position:relative;min-width:0;min-height:0}canvas{display:block;width:100%;height:100%}
#over{position:absolute;left:50%;top:18px;transform:translateX(-50%);background:#2b3137;border:1px solid #4d5660;border-radius:6px;padding:8px 14px;display:none;text-align:center}
aside{grid-row:2/4;grid-column:2;overflow:auto;border-left:1px solid #3b434b;background:#262c31;padding:10px}h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#93a0ab;margin:12px 0 5px}h3:first-child{margin-top:0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{padding:2px 4px;text-align:right;font-weight:400}td:first-child,th:first-child{text-align:left}th{color:#93a0ab}
.kv{display:grid;grid-template-columns:auto 1fr;gap:1px 10px;font-variant-numeric:tabular-nums}.kv b{font-weight:400;color:#93a0ab}.kv span{text-align:right}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px}.w{padding:5px 7px;border-radius:4px;margin-bottom:4px;background:#3b434b}.w.bad{background:#7a2b2b}.w.warn{background:#6a5320}
#src{font:11px/1.45 ui-monospace,Menlo,monospace;white-space:pre;overflow:hidden;background:#1d2125;border-radius:4px;padding:4px}#src div{padding:0 4px;white-space:pre;overflow:hidden;text-overflow:ellipsis}#src .now{background:#2f7dbd;color:#fff}
#slider{flex:1;min-width:60px}#clock{font-variant-numeric:tabular-nums;white-space:nowrap}`;
const BODY = `<div id="app"><div id="top"><span id="name">No program</span><button data-v="top">Top</button><button data-v="front">Front</button><button data-v="iso">Iso</button><button data-v="table">Whole table</button><button data-v="job">Zoom to cuts</button><span class="sp"></span>
<label><input type="checkbox" id="tRapids" checked>Rapids</label><label><input type="checkbox" id="tStock" checked>Stock</label><label><input type="checkbox" id="tGrid" checked>Grid</label><label>Rapid ipm <input type="number" id="rapid" value="300" min="10" step="50" style="width:70px"></label></div>
<div id="view"><canvas id="c"></canvas><div id="over"></div></div>
<aside><h3>Job</h3><div class="kv" id="job"></div><h3>Tools</h3><table id="tools"></table><h3>Checks</h3><div id="warn"></div><h3>Current move</h3><div class="kv" id="now"></div><h3>G-code</h3><div id="src"></div></aside>
<div id="bar"><button id="bStart" title="Start">|&lt;</button><button id="bPrevT" title="Previous tool">&lt;T</button><button id="bPrev" title="Previous move">&lt;</button><button id="bPlay" title="Play or pause (space)">Play</button><button id="bNext" title="Next move">&gt;</button><button id="bNextT" title="Next tool">T&gt;</button><button id="bEnd" title="End">&gt;|</button><input type="range" id="slider" min="0" max="10000" value="10000"><span id="clock"></span><select id="speed"><option value="auto">Auto</option><option value="1">1x</option><option value="5">5x</option><option value="20">20x</option><option value="100">100x</option><option value="500">500x</option></select></div></div>`;

// The window's HTML. libs = the text of the scripts it needs, in order.
function page(libs) {
  const open = '<scr' + 'ipt>', close = '</scr' + 'ipt>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>3D Engine</title><style>' + CSS + '</style></head><body>' + BODY +
    libs.map(s => open + s + close).join('') + open + 'CNCENGINE.start();' + close + '</body></html>';
}

function fmtTime(min) { const s = Math.round(min * 60), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); }
const hex = c => '#' + c.toString(16).padStart(6, '0');

function start() {
  const L = root.__AQ3D_LIBS__, THREE = L.THREE, G = root.GCSIM, $ = id => document.getElementById(id), cv = $('c');
  const say = m => { $('over').textContent = m || ''; $('over').style.display = m ? 'block' : 'none'; };
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, logarithmicDepthBuffer: true }); }
  catch (e) { say('This computer could not start 3D graphics (WebGL).'); return; }
  renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2)); renderer.setClearColor(0x22272c, 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.5, 8000); camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x70777f, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-40, -60, 120); scene.add(sun);
  cv.addEventListener('pointerdown', e => { controls.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN; }, true);
  const controls = new L.OrbitControls(camera, cv);
  Object.assign(controls, { screenSpacePanning: true, zoomToCursor: true, enableDamping: false });
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };

  let queued = false;
  const draw = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); }); };
  controls.addEventListener('change', draw);
  const size = () => { const v = $('view'); renderer.setSize(v.clientWidth, v.clientHeight, false); camera.aspect = v.clientWidth / Math.max(1, v.clientHeight); camera.updateProjectionMatrix(); draw(); };
  new ResizeObserver(size).observe($('view'));

  const dispose = g => { if (!g) return; scene.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); };
  let tableG = null, gridG = null, stockG = null, pathG = null, cutter = null;
  let S = null, lastName = null, table = { w: 60, h: 120 };   // S: the loaded program and everything derived from it

  const box = (w, h, d, x, y, z, color, extra) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial(Object.assign({ color }, extra))); m.position.set(x, y, z); return m; };
  const lines = (pts, color, opacity) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3)); return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })); };
  function label(text, x, y, z, color) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 64; const a = c.getContext('2d'); a.font = '600 40px sans-serif'; a.textAlign = 'center'; a.textBaseline = 'middle'; a.fillStyle = color || '#ffffff'; a.fillText(text, 64, 32);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })); s.position.set(x, y, z); s.scale.set(5, 2.5, 1); return s;
  }
  function buildTable(pl) {
    dispose(tableG); dispose(gridG); const W = table.w, H = table.h, z = pl.bedZ, mdf = 0.75, rail = 4;
    tableG = new THREE.Group(); gridG = new THREE.Group();
    tableG.add(box(W, H, mdf, W / 2, H / 2, z - mdf / 2, 0xb9a27c));                                       // spoilboard
    tableG.add(box(W + rail * 2, H + rail * 2, 3, W / 2, H / 2, z - mdf - 1.5, 0x6b7278));                 // steel frame
    const minor = [], major = [];
    for (let x = 0; x <= W + 1e-6; x++) (x % 12 === 0 ? major : minor).push(x, 0, z + 0.01, x, H, z + 0.01);
    for (let y = 0; y <= H + 1e-6; y++) (y % 12 === 0 ? major : minor).push(0, y, z + 0.01, W, y, z + 0.01);
    gridG.add(lines(minor, 0x6d5c3f, 0.35)); gridG.add(lines(major, 0x3f3424, 0.9));
    for (let x = 12; x <= W + 1e-6; x += 12) tableG.add(label(String(x), x, -2.2, z));
    for (let y = 12; y <= H + 1e-6; y += 12) tableG.add(label(String(y), -2.6, y, z));
    tableG.add(label('X0 Y0', -2.6, -2.2, z, '#9fd3ff'));
    tableG.add(lines([0, 0, z + 0.02, 8, 0, z + 0.02], 0xff5555, 1)); tableG.add(lines([0, 0, z + 0.02, 0, 8, z + 0.02], 0x55dd66, 1));
    scene.add(tableG); scene.add(gridG); gridG.visible = $('tGrid').checked;
  }
  function buildStock(pl) {
    dispose(stockG); stockG = new THREE.Group();
    const r = pl.stock ? { x0: pl.stock.x0, y0: pl.stock.y0, x1: pl.stock.x1, y1: pl.stock.y1, z0: -pl.stock.thickness } : pl.cutBox;
    if (r) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0, d = Math.max(0.01, -r.z0), g = new THREE.BoxGeometry(w, h, d), cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      if (pl.stock) { const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xd9d3c3, transparent: true, opacity: 0.22, depthWrite: false })); m.position.set(cx, cy, r.z0 / 2); stockG.add(m); }
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: pl.stock ? 0xf1ecdd : 0x9fd3ff })); e.position.set(cx, cy, r.z0 / 2); stockG.add(e);
    }
    scene.add(stockG); stockG.visible = $('tStock').checked;
  }
  function buildPaths() {
    dispose(pathG); pathG = new THREE.Group(); S.draw = new Map(); let c = 0; const colors = new Map();
    for (const t of S.prog.tools.slice().sort((a, b) => a - b)) colors.set(t, TOOL_COLORS[c++ % TOOL_COLORS.length]);
    S.colors = colors;
    for (const g of S.groups) {
      const color = g.key === 'r' ? RAPID_COLOR : (colors.get(g.key) || TOOL_COLORS[0]);
      const attr = new THREE.BufferAttribute(g.pos, 3), mk = () => { const q = new THREE.BufferGeometry(); q.setAttribute('position', attr); return q; };
      const dim = new THREE.LineSegments(mk(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: g.key === 'r' ? 0.18 : 0.32 }));
      const bright = new THREE.LineSegments(mk(), new THREE.LineBasicMaterial({ color, transparent: g.key === 'r', opacity: g.key === 'r' ? 0.65 : 1 }));
      dim.frustumCulled = bright.frustumCulled = false; pathG.add(dim); pathG.add(bright); S.draw.set(g.key, { g, dim, bright });
    }
    scene.add(pathG);
    if (cutter) { scene.remove(cutter); cutter.geometry.dispose(); cutter.material.dispose(); cutter = null; }
    S.cutterTool = null;
  }
  function setCutter(t) {
    if (S.cutterTool === t && cutter) return; S.cutterTool = t;
    if (cutter) { scene.remove(cutter); cutter.geometry.dispose(); cutter.material.dispose(); }
    const c = (S.tools && S.tools[t]) || { type: 'flat', radius: 0.125, angle: 90 }, r = Math.max(0.02, c.radius), V = c.type === 'v';
    const h = V ? Math.max(0.05, r / Math.tan((c.angle || 90) * Math.PI / 360)) : 1.5;
    const g = new THREE.CylinderGeometry(V ? r : r, V ? 0 : r, h, 24); g.rotateX(Math.PI / 2); g.translate(0, 0, h / 2);
    cutter = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85 })); scene.add(cutter);
  }

  function view(which) {
    const W = table.w, H = table.h; let b = { x0: 0, y0: 0, x1: W, y1: H, z: 0 };
    if (which === 'job' && S && S.sum.cut) { const c = S.sum.cut, p = 1; b = { x0: c.x0 - p, y0: c.y0 - p, x1: c.x1 + p, y1: c.y1 + p, z: 0 }; }
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, sx = b.x1 - b.x0 + (which === 'job' ? 0 : 14), sy = b.y1 - b.y0 + (which === 'job' ? 0 : 14);
    const t = Math.tan(camera.fov * Math.PI / 360), a = camera.aspect || 1;
    let dist = Math.max(sx / a, sy) / 2 / t * 1.06, dir;
    if (which === 'front') { dir = [0, -1, 0.04]; dist = Math.max(sx / a, 12) / 2 / t * 1.1; }
    else if (which === 'iso') { dir = [-0.55, -0.75, 0.7]; dist *= 1.1; }
    else dir = [0, -0.0015, 1];
    const n = Math.hypot(...dir);
    controls.target.set(cx, cy, b.z); camera.position.set(cx + dir[0] / n * dist, cy + dir[1] / n * dist, b.z + dir[2] / n * dist);
    controls.update(); draw();
  }

  function fillPanel() {
    const s = S.sum, p = S.pl, job = $('job'), row = (k, v) => '<b>' + k + '</b><span>' + v + '</span>'; job.innerHTML = '';
    const stock = p.stock ? (p.stock.x1 - p.stock.x0).toFixed(3) + ' x ' + (p.stock.y1 - p.stock.y0).toFixed(3) + ' x ' + p.stock.thickness.toFixed(3) : 'not in this file';
    job.innerHTML = row('Stock', stock) + row('Cut X', s.cut ? s.cut.x0.toFixed(3) + ' to ' + s.cut.x1.toFixed(3) : '-') + row('Cut Y', s.cut ? s.cut.y0.toFixed(3) + ' to ' + s.cut.y1.toFixed(3) : '-') +
      row('Deepest Z', s.deepest.toFixed(4)) + row('Lowest retract', s.clearance == null ? '-' : 'Z' + s.clearance.toFixed(4)) + row('Moves', S.prog.n.toLocaleString()) + row('Run time', fmtTime(s.tl.total) + ' at ' + S.rapid + ' ipm rapids');
    const t = $('tools'); t.innerHTML = '<tr><th>Tool</th><th>Cut in</th><th>Plunge</th><th>Deepest</th><th>Feed time</th></tr>';
    for (const x of s.tools) {
      const tr = document.createElement('tr'), d = document.createElement('td'), cb = document.createElement('input'), sw = document.createElement('span');
      cb.type = 'checkbox'; cb.checked = true; cb.onchange = () => { const e = S.draw.get(x.tool); if (e) { e.dim.visible = e.bright.visible = cb.checked; draw(); } };
      sw.className = 'sw'; sw.style.background = hex(S.colors.get(x.tool) || TOOL_COLORS[0]); const dia = S.tools && S.tools[x.tool] ? ' (' + (S.tools[x.tool].radius * 2).toFixed(3) + ')' : '';
      d.append(cb, sw, 'T' + x.tool + dia); tr.append(d);
      for (const v of [x.cut.toFixed(1), x.plunge.toFixed(1), x.deepest.toFixed(3), fmtTime(x.minutes)]) { const c = document.createElement('td'); c.textContent = v; tr.append(c); }
      t.append(tr);
    }
    const w = $('warn'); w.innerHTML = ''; if (!s.warnings.length) { const e = document.createElement('div'); e.className = 'w'; e.textContent = 'Nothing to flag.'; w.append(e); }
    for (const x of s.warnings) { const e = document.createElement('div'); e.className = 'w ' + x.level; e.textContent = x.msg; w.append(e); }
  }
  function setT(T) {
    if (!S || !S.prog.n) return; const p = S.prog, tl = S.sum.tl; S.T = Math.max(0, Math.min(tl.total, T));
    const loc = G.locate(tl, p.n, S.T);
    for (const e of S.draw.values()) e.bright.geometry.setDrawRange(0, countBefore(e.g.idx, loc.i >= p.n ? p.n : loc.i + (loc.u > 0 ? 1 : 0)) * 2);
    const q = G.pointAt(p, loc.i, loc.u), i = Math.min(loc.i, p.n - 1); setCutter(p.tool[i]);
    cutter.position.set(q[0] + S.pl.dx, q[1] + S.pl.dy, q[2]);
    const kinds = { [G.RAPID]: 'Rapid', [G.PLUNGE]: 'Plunge' }, row = (k, v) => '<b>' + k + '</b><span>' + v + '</span>';
    $('now').innerHTML = row('Line', p.line[i]) + row('Move', kinds[p.kind[i]] || 'Cut') + row('Tool', 'T' + p.tool[i]) + row('Feed', p.kind[i] === G.RAPID ? 'rapid' : p.feed[i].toFixed(1)) + row('Spindle', Math.round(p.rpm[i])) + row('X', q[0].toFixed(4)) + row('Y', q[1].toFixed(4)) + row('Z', q[2].toFixed(4));
    const L = p.line[i], src = $('src'), a = Math.max(1, L - 4), b = Math.min(S.lines.length, L + 4); src.textContent = '';
    for (let n = a; n <= b; n++) { const d = document.createElement('div'); d.textContent = n + '  ' + S.lines[n - 1]; if (n === L) d.className = 'now'; src.append(d); }
    $('clock').textContent = fmtTime(S.T) + ' / ' + fmtTime(tl.total);
    if (!S.sliding) $('slider').value = tl.total ? Math.round(S.T / tl.total * 10000) : 10000;
    draw();
  }
  let playing = false, last = 0;
  function setPlay(on) { playing = !!(on && S && S.prog.n); $('bPlay').textContent = playing ? 'Pause' : 'Play'; $('bPlay').classList.toggle('on', playing); if (playing) { if (S.T >= S.sum.tl.total) S.T = 0; last = performance.now(); requestAnimationFrame(tick); } }
  function tick(now) {
    if (!playing) return; const sp = $('speed').value, tl = S.sum.tl, dt = Math.min(0.1, (now - last) / 1000); last = now;
    const perSec = sp === 'auto' ? tl.total / 30 : (+sp) / 60;   // machine minutes per real second
    setT(S.T + dt * perSec); if (S.T >= tl.total) { setPlay(false); return; } requestAnimationFrame(tick);
  }
  const stepMove = d => { if (!S) return; setPlay(false); const p = S.prog, tl = S.sum.tl, l = G.locate(tl, p.n, S.T), i = Math.max(0, Math.min(p.n, l.i + d)); setT(tl.t0[i]); };
  const stepTool = d => { if (!S) return; setPlay(false); const p = S.prog, tl = S.sum.tl; let i = Math.min(p.n - 1, G.locate(tl, p.n, S.T).i); const t = p.tool[i]; while (i >= 0 && i < p.n && p.tool[i] === t) i += d; if (i < 0) { setT(0); return; } if (i >= p.n) { setT(tl.total); return; } if (d < 0) { const u = p.tool[i]; while (i > 0 && p.tool[i - 1] === u) i--; } setT(tl.t0[i]); };

  function analyse() { S.sum = summarize(S.prog, G, S.pl, { table, rapid: S.rapid }); fillPanel(); }
  function load(d) {
    table = d.table && d.table.w > 0 && d.table.h > 0 ? { w: d.table.w, h: d.table.h } : table;
    setPlay(false); const first = lastName === null, renamed = d.name !== lastName; lastName = d.name;
    $('name').textContent = d.name || 'No program'; document.title = (d.name || 'No program') + ' - 3D Engine';
    if (!d.text) {
      S = null; dispose(pathG); pathG = null; dispose(stockG); stockG = null; if (cutter) { scene.remove(cutter); cutter = null; }
      const pl = { bedZ: -0.25, stock: null, cutBox: null }; buildTable(pl); say(d.empty || 'No toolpaths yet.'); $('job').innerHTML = ''; $('tools').innerHTML = ''; $('warn').innerHTML = ''; $('now').innerHTML = ''; $('src').textContent = ''; $('clock').textContent = '';
      if (first || renamed) view('table'); else draw(); return;
    }
    say(''); let prog; try { prog = G.parseGcode(d.text, { aToY: d.aToY || 0 }); } catch (e) { say('Could not read this program: ' + e.message); return; }
    if (!prog.n) { say('This program has no moves.'); return; }
    const pl = placement(prog, d.job || null);
    S = { prog, pl, groups: buildGroups(prog, G, pl), tools: d.tools || {}, lines: d.text.split(/\r\n|\r|\n/), rapid: Math.max(10, +$('rapid').value || 300), T: 0 };
    buildTable(pl); buildStock(pl); buildPaths(); analyse();
    const r = S.draw.get('r'); if (r) r.dim.visible = r.bright.visible = $('tRapids').checked;
    setT(S.sum.tl.total); if (first || renamed) view('iso'); else draw();
  }

  document.querySelectorAll('[data-v]').forEach(b => b.onclick = () => view(b.dataset.v));
  $('tRapids').onchange = e => { const r = S && S.draw.get('r'); if (r) { r.dim.visible = r.bright.visible = e.target.checked; draw(); } };
  $('tStock').onchange = e => { if (stockG) { stockG.visible = e.target.checked; draw(); } };
  $('tGrid').onchange = e => { if (gridG) { gridG.visible = e.target.checked; draw(); } };
  $('rapid').onchange = e => { if (!S) return; const f = S.sum.tl.total ? S.T / S.sum.tl.total : 1; S.rapid = Math.max(10, +e.target.value || 300); analyse(); setT(f * S.sum.tl.total); };
  $('bPlay').onclick = () => setPlay(!playing); $('bStart').onclick = () => { setPlay(false); if (S) setT(0); }; $('bEnd').onclick = () => { setPlay(false); if (S) setT(S.sum.tl.total); };
  $('bPrev').onclick = () => stepMove(-1); $('bNext').onclick = () => stepMove(1); $('bPrevT').onclick = () => stepTool(-1); $('bNextT').onclick = () => stepTool(1);
  $('slider').oninput = e => { if (!S) return; setPlay(false); S.sliding = true; setT(e.target.value / 10000 * S.sum.tl.total); S.sliding = false; };
  addEventListener('keydown', e => { if (/INPUT|SELECT/.test(e.target.tagName) && e.target.type !== 'range') return; if (e.code === 'Space') { e.preventDefault(); setPlay(!playing); } else if (e.key === 'ArrowLeft') stepMove(-1); else if (e.key === 'ArrowRight') stepMove(1); });
  addEventListener('message', e => { if (root.opener && e.source !== root.opener) return; if (e.data && e.data.type === 'cnc-program') load(e.data); });
  root.__CNC = { get S() { return S; }, view, setT, setPlay, get cam() { return camera; } };
  size();
  buildTable({ bedZ: -0.25, stock: null, cutBox: null }); view('table');
  if (root.opener) root.opener.postMessage({ type: 'cnc-ready' }, '*'); else say('Open this window from the 3D View tab in CAD/CAM.');
}

return { placement, buildGroups, countBefore, summarize, fmtTime, page, start };
});
