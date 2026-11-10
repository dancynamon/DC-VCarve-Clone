#!/usr/bin/env node
// crvtoolsweep.js — ground-truth check of toolpath import. For every .crv/.crv3d with a .tap of the same name beside it, post the
// toolpaths the studio imported and compare each tool's cut area and depth with Vectric's own posted file. Read-only on the input.
//   node tools/crvtoolsweep.js --out <dir> <root>
// A bounds comparison, not a toolpath-exact one: it catches wrong sides, wrong tools, wrong depths and missing vectors.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process'), os = require('os');
const ENGINE = path.join(__dirname, '..', 'cam-engine');

function load() {
  global.ClipperLib = require(path.join(ENGINE, 'package/clipper.js'));
  const ctx = { console, Math, JSON, Date, TextDecoder, TextEncoder }; vm.createContext(ctx);
  for (const f of ['tpdparse.js', 'crvparse.js', 'crvtoolpaths.js']) vm.runInContext(fs.readFileSync(path.join(ENGINE, f), 'utf8') + (f === 'crvparse.js' ? ';this.CRVPARSE=CRVPARSE;' : ''), ctx, { filename: f });
  return { ctx, CAM: require(path.join(ENGINE, 'camcore.js')), ASM: require(path.join(ENGINE, 'assembly.js')), G: require(path.join(ENGINE, 'gcodesim.js')), TE: require(path.join(ENGINE, 'tapedit.js')) };
}
const toolBounds = (p, G) => { const c = {}; for (let i = 0; i < p.n; i++) { if (p.kind[i] === G.RAPID || p.z1[i] >= 0) continue; const k = p.tool[i]; const b = c[k] = c[k] || [Infinity, Infinity, -Infinity, -Infinity, Infinity]; b[0] = Math.min(b[0], p.x1[i]); b[1] = Math.min(b[1], p.y1[i]); b[2] = Math.max(b[2], p.x1[i]); b[3] = Math.max(b[3], p.y1[i]); b[4] = Math.min(b[4], p.z1[i]); } return c; };
function doOne(f, E) {
  const tapF = f.replace(/\.crv3?d?$/i, '.tap');
  if (!fs.existsSync(tapF)) return { skip: 'no-tap' };
  const res = E.ctx.CRVPARSE.toShapes(new Uint8Array(fs.readFileSync(f)), { tol: 0.002 });
  if (!res.toolpathData || !res.toolpathData.toolpaths.length) return { skip: 'no-tp' };
  const contours = new Map(), open = [];
  for (const L of res.layers) for (const c of L.contours) if (c.guid) { if (!contours.has(c.guid)) contours.set(c.guid, []); contours.get(c.guid).push(c); if (!c.closed) open.push(c.guid); }
  const tr = E.ctx.CRVTP.toStudioOps(res.toolpathData, { guids: [...contours.keys()], openGuids: open, safeZ: res.safeZ });
  const loss = tr.report.filter(r => r.level === 'loss').map(r => r.code);
  const ops = []; const warn = [];
  for (const o of tr.ops) {
    const cs = E.CAM.assembleContours(o.guids.flatMap(g => contours.get(g)).map(c => ({ pts: c.pts, closed: c.closed })));
    let r; try { r = E.ASM.opResult(E.CAM, o.p, cs); } catch (e) { return { file: f, status: 'op-error', msg: e.message.slice(0, 100) }; }
    for (const op of r.ops) if (op.passes.length) ops.push(op);
    if (r.warnings) warn.push(...r.warnings);
  }
  if (!ops.length) return { file: f, status: loss.length ? 'all-reported' : 'nothing' , loss };
  const g = E.CAM.postProcess({ name: 'x', units: 'inch', ops }, E.CAM.POSTS.shopsabre);
  const tap = E.TE.readBytes(new Uint8Array(fs.readFileSync(tapF)), 'x');
  if (!tap.ok) return { skip: 'tap-unreadable' };
  const A = toolBounds(E.G.parseGcode(g), E.G), B = toolBounds(E.G.parseGcode(tap.text), E.G);
  const tA = Object.keys(A).sort().join(), tB = Object.keys(B).sort().join(); let worst = 0, zBad = 0;
  for (const t of Object.keys(A)) if (B[t]) { for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(A[t][i] - B[t][i])); if (Math.abs(A[t][4] - B[t][4]) > 0.01) zBad = Math.max(zBad, Math.abs(A[t][4] - B[t][4])); }
  const toolsMatch = tA === tB, ok = toolsMatch && worst <= 0.06 && !zBad;
  // A posted .tap often holds only some of the job's toolpaths, or was posted before the job changed. Separate "the Vectric cuts all
  // fall inside what we imported" (a partial .tap, not an error) from a real disagreement.
  const contains = (X, Y) => X && Y && Y[0] >= X[0] - 0.06 && Y[1] >= X[1] - 0.06 && Y[2] <= X[2] + 0.06 && Y[3] <= X[3] + 0.06;
  const oursCoversTap = Object.keys(B).every(t => contains(A[t], B[t]));
  const tapCoversOurs = Object.keys(A).every(t => contains(B[t], A[t]));
  const zOk = Object.keys(A).every(t => !B[t] || Math.abs(A[t][4] - B[t][4]) <= 0.01);
  return { file: f, status: ok ? 'match' : (loss.length ? 'reported-loss' : 'MISMATCH'), toolsMatch, worst: +worst.toFixed(4), zBad: +zBad.toFixed(4), tA, tB, loss, ops: tr.ops.length, oursCoversTap, tapCoversOurs, zOk };
}
if (process.argv[2] === '--worker') { const E = load(); process.on('message', ({ i, f }) => { let r; try { r = doOne(f, E); } catch (e) { r = { file: f, status: 'error', msg: e.message.slice(0, 160) }; } process.send({ i, r }); }); process.send({ ready: true }); return; }
function walk(root, out) { let e; try { e = fs.readdirSync(root, { withFileTypes: true }); } catch (x) { return; } for (const d of e) { if (d.name.startsWith('.')) continue; const p = path.join(root, d.name); if (d.isDirectory()) walk(p, out); else if (/\.crv3?d?$/i.test(d.name)) out.push(p); } }
const av = process.argv.slice(2); let outDir = null, root = null;
for (let i = 0; i < av.length; i++) { if (av[i] === '--out') outDir = av[++i]; else root = av[i]; }
const files = []; if (process.env.CRVT_ONLY) files.push(...JSON.parse(fs.readFileSync(process.env.CRVT_ONLY, 'utf8'))); else walk(path.resolve(root), files); files.sort(); fs.mkdirSync(outDir, { recursive: true });
const rows = new Array(files.length); let next = 0, done = 0;
const finish = () => { const S = {}, mis = []; for (const r of rows) { const k = r.skip ? 'skip:' + r.skip : r.status; S[k] = (S[k] || 0) + 1; if (r.status === 'MISMATCH') mis.push(r); }
  mis.sort((a, b) => b.worst - a.worst);
  const out = { summary: S, mismatches: mis.length, top: mis.slice(0, 15).map(r => ({ f: path.basename(r.file), worst: r.worst, zBad: r.zBad, toolsMatch: r.toolsMatch, tA: r.tA, tB: r.tB, ops: r.ops })) };
  fs.writeFileSync(path.join(outDir, 'crvtool.json'), JSON.stringify({ out, rows: rows.filter(r => !r.skip) }, null, 1)); console.log(JSON.stringify(out, null, 1)); process.exit(0); };
const start = () => { const w = cp.fork(__filename, ['--worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: ['--max-old-space-size=4096'] }); let cur = -1;
  const give = () => { if (next >= files.length) { w.kill(); return; } cur = next++; w.send({ i: cur, f: files[cur] }); };
  w.on('message', m => { if (m.ready) return give(); rows[m.i] = m.r; cur = -1; if (++done === files.length) finish(); give(); });
  w.on('exit', () => { if (cur >= 0) { rows[cur] = { file: files[cur], status: 'crash' }; cur = -1; if (++done === files.length) finish(); else start(); } }); };
for (let j = 0; j < Math.min(os.cpus().length - 2, files.length); j++) start();
