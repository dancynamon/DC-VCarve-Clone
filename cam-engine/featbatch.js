// featbatch.js — pair CRV<->TAP (batch.run) across a list of library folders, then grade the BLIND generator
// (crv2tap) at L2 on every pair. One combined report so features (tabs, area-clear, leads, raster, ramps)
// can be worked one at a time.   node cam-engine/featbatch.js dirs.json --root "<VCarve Pro>" --out CAD/feat.json --budget 140
const fs = require('fs'), path = require('path');
const { crv2tap } = require('./crv2tap.js');
const { compare, parseTap } = require('./tapcompare.js');
const { l2 } = require('./l2compare.js');
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'shoptools.json'), 'utf8'));
const av = process.argv.slice(2), arg = k => { const i = av.indexOf(k); return i < 0 ? null : av[i + 1]; };
const dirs = [...new Set(Object.values(JSON.parse(fs.readFileSync(av[0], 'utf8'))).flat())];
const root = arg('--root'), out = arg('--out'), budget = +(arg('--budget') || 140), t0 = Date.now();
const R = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { dirs: {}, jobs: {} };
const tmp = path.join(require('os').homedir(), 'featbatch-tmp'); fs.mkdirSync(tmp, { recursive: true });
let left = 0;
for (const d of dirs) {
  if (R.dirs[d]) continue;
  if (Date.now() - t0 > budget * 1000) { left++; continue; }
  const src = path.join(root, d);
  let files; try { files = fs.readdirSync(src); } catch (e) { R.dirs[d] = { err: e.message }; continue; }
  const taps = files.filter(f => /\.tap$/i.test(f) && !/-aq/i.test(f));
  let crvs = files.filter(f => /\.crv(3d)?$/i.test(f)).map(f => path.join(src, f));
  try { crvs = crvs.concat(fs.readdirSync(path.dirname(src)).filter(f => /\.crv(3d)?$/i.test(f)).map(f => path.join(path.dirname(src), f))); } catch (e) {}
  const gen = new Map();   // crv -> { bytes, singles: [{name, gcode, ops}] }
  const getGen = c => { if (!gen.has(c)) { let g = null; try { const bytes = fs.readFileSync(c), all = crv2tap(bytes, {});
      g = { bytes, singles: all.toolpaths.map(n => { try { const o = crv2tap(bytes, { toolpaths: [n] }); return { name: n, gcode: o.gcode, ops: o.ops }; } catch (e) { return null; } }).filter(x => x && x.ops.length) }; } catch (e) {}
      gen.set(c, g); } return gen.get(c); };
  for (const t of taps) {
    if (Date.now() - t0 > budget * 1000) { left++; break; }
    const key = path.join(d, t); if (R.jobs[key]) continue; const row = R.jobs[key] = {};
    try {
      const vtext = fs.readFileSync(path.join(src, t), 'utf8'), vTools = new Set(parseTap(vtext).map(x => x.tool));
      let best = null;
      for (const c of crvs) {
        const g = getGen(c); if (!g) continue;
        const keep = g.singles.filter(s1 => s1.ops.every(o => vTools.has(o.toolNum)) && compare(vtext, s1.gcode, { tools: TOOLS }).tools.filter(x => x.B).every(x => x.BinA && x.BinA.n && x.BinA.over / x.BinA.n < 0.02)).map(s1 => s1.name);
        if (!keep.length) continue;
        const ours = crv2tap(g.bytes, { toolpaths: keep }), cmp = compare(vtext, ours.gcode, { tools: TOOLS });
        const cov = cmp.tools.filter(x => x.A).reduce((a, x) => a + (x.AinB ? x.AinB.n - x.AinB.over : 0), 0) / Math.max(1, cmp.tools.filter(x => x.A).reduce((a, x) => a + (x.AinB ? x.AinB.n : 1), 0));
        if (!best || cov > best.cov) best = { c, keep, ours, cov };
      }
      if (!best) { row.status = 'UNPAIRED'; continue; }
      row.crv = path.relative(root, best.c); row.toolpaths = best.keep; row.cov = +best.cov.toFixed(3); row.warnings = best.ours.warnings;
      const r = l2(vtext, best.ours.gcode);
      row.status = r.pass ? 'L2-PASS' : (r.l1 ? 'L1-ONLY' : 'FAIL');
      row.issues = r.issues.filter(x => !x.info).map(x => x.what.replace(/#\d+/, '').replace(/pass \d+ @[-\d.,]+ /, 'pass * ').replace(/pass \d+ \(z [-\d.]+\)/, 'pass *').replace(/z-?[\d.]+ /, ''));
    } catch (e) { row.status = 'ERROR'; row.err = e.message.slice(0, 160); }
  }
  if (taps.every(t => R.jobs[path.join(d, t)])) R.dirs[d] = { taps: taps.length, crvs: crvs.length };
  fs.writeFileSync(out, JSON.stringify(R));
}
fs.writeFileSync(out, JSON.stringify(R));
const c = {}; for (const r of Object.values(R.jobs)) c[r.status] = (c[r.status] || 0) + 1;
console.log((left ? 'UNFINISHED ' : 'DONE ') + JSON.stringify(c) + ` dirs ${Object.keys(R.dirs).length}/${dirs.length}`);
