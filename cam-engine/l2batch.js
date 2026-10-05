#!/usr/bin/env node
// l2batch.js — run the BLIND generator (crv2tap, recipe from the CRV) over library jobs whose Vectric TAP
// is known, and grade every one at L2. The library is the training set; the blind test set is the exam.
//   node cam-engine/l2batch.js --report CAD/batch-mats/report.json --src "<folder the report ran on>" --out CAD/l2-mats.json [--budget 140] [--resume]
// Which toolpaths went into a given TAP is not recorded anywhere, so each toolpath is generated alone and
// kept when its cut lies inside Vectric's (L1 coverage); the kept set, in CRV order, is the job.
const fs = require('fs'), path = require('path');
const { crv2tap } = require('./crv2tap.js');
const { compare, parseTap } = require('./tapcompare.js');
const { l2 } = require('./l2compare.js');
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'shoptools.json'), 'utf8'));
const av = process.argv.slice(2), arg = k => { const i = av.indexOf(k); return i < 0 ? null : av[i + 1]; };
const rep = JSON.parse(fs.readFileSync(arg('--report'), 'utf8')), src = arg('--src'), out = arg('--out'), budget = +(arg('--budget') || 0);
const R = av.includes('--resume') && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { jobs: {} };
const t0 = Date.now(); let left = 0;
for (const j of rep.jobs.filter(x => x.status === 'PASS')) {
  if (R.jobs[j.tap]) continue;
  if (budget && Date.now() - t0 > budget * 1000) { left++; continue; }
  const row = R.jobs[j.tap] = { crv: j.crv };
  try {
    const crvBytes = fs.readFileSync(path.join(src, j.crv)), vtext = fs.readFileSync(path.join(src, j.tap), 'utf8');
    const vTools = new Set(parseTap(vtext).map(t => t.tool));
    const all = crv2tap(crvBytes, {});
    const keep = [];
    for (const name of all.toolpaths) {
      let one; try { one = crv2tap(crvBytes, { toolpaths: [name] }); } catch (e) { continue; }
      if (!one.ops.length || !one.ops.every(o => vTools.has(o.toolNum))) continue;
      const c = compare(vtext, one.gcode, { tools: TOOLS });
      const inside = c.tools.filter(t => t.B).every(t => t.BinA && t.BinA.n && t.BinA.over / t.BinA.n < 0.02);
      if (inside) keep.push(name);
    }
    row.toolpaths = keep;
    if (!keep.length) { row.status = 'NO-TOOLPATHS'; continue; }
    const ours = crv2tap(crvBytes, { toolpaths: keep });
    row.warnings = ours.warnings;
    const r = l2(vtext, ours.gcode);
    row.status = r.pass ? 'L2-PASS' : (r.l1 ? 'L1-ONLY' : 'FAIL');
    row.issues = r.issues.filter(x => !x.info).map(x => x.what.replace(/#\d+/, '').replace(/pass \d+ @[-\d.,]+ /, 'pass * ').replace(/pass \d+ \(z [-\d.]+\)/, 'pass *').replace(/z-?[\d.]+ /, ''));
  } catch (e) { row.status = 'ERROR'; row.err = e.message.slice(0, 160); }
  if (Object.keys(R.jobs).length % 10 === 0) fs.writeFileSync(out, JSON.stringify(R));
}
fs.writeFileSync(out, JSON.stringify(R, null, 0));
const c = {}; for (const r of Object.values(R.jobs)) c[r.status] = (c[r.status] || 0) + 1;
console.log((left ? 'UNFINISHED ' : 'DONE ') + JSON.stringify(c));
