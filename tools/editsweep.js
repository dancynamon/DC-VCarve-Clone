#!/usr/bin/env node
// editsweep.js — run every structured G-code edit against every .tap under a folder, and round-trip every .dxf through save and
// reopen. Read-only on the input; writes only a summary to --out. Reports how often each edit applied or was refused and why.
//   node tools/editsweep.js --out <dir> [--jobs N] <root>
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ENGINE = path.join(__dirname, '..', 'cam-engine');

function loadDxf() {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ENGINE, 'dxfparse.js'), 'utf8') + ';this.parseDxf=parseDxf;this.entityToPolys=entityToPolys;', ctx);
  return ctx;
}
function segDist(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }
function worst(from, to) { let w = 0; for (const p of from) { let best = Infinity; for (let i = 1; i < to.length; i++) { const d = segDist(p, to[i - 1], to[i]); if (d < best) best = d; if (best < 1e-5) break; } if (best > w) w = best; } return w; }

function doTap(f, TE) {
  const u = new Uint8Array(fs.readFileSync(f)), out = { file: f, edits: {} };
  const r = TE.readBytes(u, path.basename(f));
  if (!r.ok) { out.unreadable = r.code; return out; }
  if (!Buffer.from(TE.textToBytes(r.text)).equals(Buffer.from(u))) out.bytesChanged = true;
  const t = r.text;
  let s; try { s = TE.stats(t); } catch (e) { out.statsErr = e.message; return out; }
  const edits = {
    translate: () => TE.translate(t, { dx: 1.5, dy: -0.75 }),
    feed: () => TE.scaleFeed(t, { factor: 0.9 }), speed: () => TE.scaleSpeed(t, { factor: 0.9 }),
    shiftDepth: () => TE.shiftCutDepth(t, { dz: -0.01 }),
    finalDepth: () => TE.setFinalDepth(t, { z: (s.deepest == null ? -1 : s.deepest) - 0.01 }),
    safeZ: () => TE.raiseSafeHeight(t, { z: Math.min(6, (s.minRetract || 0.25) + 0.1) }),
  };
  if (s.tools.length >= 2) edits.removeTool = () => TE.removeTool(t, { tool: s.tools[0] });
  for (const [k, fn] of Object.entries(edits)) {
    try { const res = fn(); out.edits[k] = 'ok'; if (k !== 'removeTool' && res.changes.some(c => c.after == null)) out.edits[k] = 'BAD_LINE_REMOVED'; }
    catch (e) { out.edits[k] = e.refused ? 'refused:' + e.code : 'CRASH:' + e.message.slice(0, 80); if (e.refused && e.line && !out.firstRefused) out.firstRefused = e.line; }
  }
  return out;
}
function doDxf(f, C, ctx) {
  const out = { file: f };
  let text = fs.readFileSync(f, 'latin1');
  if (!text.length) { out.empty = true; return out; }
  const load = t => { const e = ctx.parseDxf(t), ps = []; for (const q of e) for (const p of ctx.entityToPolys(q)) ps.push(p); return { e, ps, sh: C.dxfPolysToShapes(ps) }; };
  let a; try { a = load(text); } catch (e) { out.parseErr = e.message.slice(0, 100); return out; }
  if (!a.sh.length) { out.noShapes = true; return out; }
  const b = load(C.toDXF(a.sh));
  out.layers = [new Set(a.sh.map(s => s.layer)).size, new Set(b.sh.map(s => s.layer)).size];
  out.count = [a.sh.length, b.sh.length];
  let w = 0;
  if (b.sh.length === a.sh.length) for (let i = 0; i < a.sh.length; i++) { const A = a.sh[i], B = b.sh[i]; const pa = A.closed ? A.pts.concat([A.pts[0]]) : A.pts, pb = B.closed ? B.pts.concat([B.pts[0]]) : B.pts; w = Math.max(w, worst(pa, pb), worst(pb, pa)); }
  out.worst = w;
  return out;
}

if (process.argv[2] === '--worker') {
  const TE = require(path.join(ENGINE, 'tapedit.js')), C = require(path.join(ENGINE, 'cadcore.js')), ctx = loadDxf();
  process.on('message', ({ i, f }) => {
    let r; try { r = /\.tap$/i.test(f) ? doTap(f, TE) : doDxf(f, C, ctx); } catch (e) { r = { file: f, crash: e.message.slice(0, 200) }; }
    process.send({ i, r });
  });
  process.send({ ready: true });
  return;
}
function walk(root, out) { let e; try { e = fs.readdirSync(root, { withFileTypes: true }); } catch (x) { return; } for (const d of e) { if (d.name.startsWith('.')) continue; const p = path.join(root, d.name); if (d.isDirectory()) walk(p, out); else if (/\.(tap|dxf)$/i.test(d.name)) out.push(p); } }
const av = process.argv.slice(2); let outDir = null, jobs = Math.max(2, os.cpus().length - 2), root = null;
for (let i = 0; i < av.length; i++) { if (av[i] === '--out') outDir = av[++i]; else if (av[i] === '--jobs') jobs = +av[++i]; else root = av[i]; }
if (!outDir || !root) { console.error('usage: editsweep.js --out <dir> <root>'); process.exit(2); }
const files = []; walk(path.resolve(root), files); files.sort();
fs.mkdirSync(outDir, { recursive: true });
const rows = new Array(files.length); let next = 0, done = 0;
const finish = () => {
  const S = {}, bump = (e, k) => { S[e] = S[e] || {}; S[e][k] = (S[e][k] || 0) + 1; };
  let bytesChanged = 0, unreadable = {}, crashes = [], dxfBad = [], worstAll = 0, layerLoss = 0, dxfN = 0, countMiss = 0, ge2 = 0, ge5 = 0;
  for (const r of rows) {
    if (r.bytesChanged) bytesChanged++;
    if (r.unreadable) unreadable[r.unreadable] = (unreadable[r.unreadable] || 0) + 1;
    if (r.edits) for (const [k, v] of Object.entries(r.edits)) { bump(k, v); if (/^(CRASH|BAD)/.test(v)) crashes.push(r.file + ' ' + k + ' ' + v); }
    if (r.crash) crashes.push(r.file + ' ' + r.crash);
    if (r.worst != null) { dxfN++; if (r.worst > worstAll) worstAll = r.worst; if (r.worst > 0.002) ge2++; if (r.worst > 0.005) { ge5++; dxfBad.push(path.basename(r.file) + ' ' + r.worst.toFixed(4)); } }
    if (r.layers && r.layers[0] !== r.layers[1]) layerLoss++;
    if (r.count && r.count[0] !== r.count[1]) countMiss++;
  }
  const sum = { edits: S, bytesChanged, unreadable, crashes: crashes.slice(0, 40), crashN: crashes.length, dxf: { files: dxfN, worstAll, over0002: ge2, over0005: ge5, examples: dxfBad.slice(0, 10), layerLoss, countMiss } };
  fs.writeFileSync(path.join(outDir, 'editsweep.json'), JSON.stringify(sum, null, 1));
  console.log(JSON.stringify(sum, null, 1)); process.exit(0);
};
const start = () => { const w = cp.fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'] }); let cur = -1;
  const give = () => { if (next >= files.length) { w.kill(); return; } cur = next++; w.send({ i: cur, f: files[cur] }); };
  w.on('message', m => { if (m.ready) return give(); rows[m.i] = m.r; cur = -1; if (++done === files.length) finish(); give(); });
  w.on('exit', () => { if (cur >= 0) { rows[cur] = { file: files[cur], crash: 'worker died' }; cur = -1; if (++done === files.length) finish(); else start(); } }); };
for (let j = 0; j < Math.min(jobs, files.length); j++) start();
