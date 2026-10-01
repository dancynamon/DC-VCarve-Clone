#!/usr/bin/env node
// batch.js — VCarve library -> our G-code, proven against Vectric's.
//
//   node cam-engine/batch.js <vcarve folder> --outdir <dir> [--recursive] [--limit N]
//
// For every .tap in a folder: find the .crv/.crv3d (same folder, else parent) whose vectors explain
// it, recover the recipe (tap2spec), re-post it from the CRV (repost), compare to Vectric's cut
// (tapcompare, material-level, 0.005"), and write an AIRCUT dry run for every job that passes.
// Writes <outdir>/report.json and report.md. Never touches the source folder.
const fs = require('fs'), path = require('path');
const { crvIndex, repostJob } = require('./repost.js');
const { analyze, buildSpec } = require('./tap2spec.js');
const { compare } = require('./tapcompare.js');
const { aircut } = require('./aircut.js');
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'shoptools.json'), 'utf8'));
const SKIP_DIR = /^(zzz|old\b|older\b|_to_delete|backup)/i;

function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return []; } }
function* walk(dir, rec) {
  const ents = listDir(dir);
  yield { dir, files: ents.filter(e => e.isFile()).map(e => e.name) };
  if (rec) for (const e of ents) if (e.isDirectory() && !SKIP_DIR.test(e.name) && !e.name.startsWith('.')) yield* walk(path.join(dir, e.name), rec);
}
const safe = s => s.replace(/[^\w .()+-]/g, '_');

function run(src, outdir, o) {
  const report = [], idxCache = new Map();
  const getIdx = f => { if (!idxCache.has(f)) { try { idxCache.set(f, { ix: crvIndex(fs.readFileSync(f)) }); } catch (e) { idxCache.set(f, { err: e.message }); } } return idxCache.get(f); };
  let n = 0;
  for (const { dir, files } of walk(src, o.recursive)) {
    const taps = files.filter(f => /\.tap$/i.test(f) && !/-aq(-AIRCUT)?\.tap$/i.test(f));
    if (!taps.length) continue;
    let crvs = files.filter(f => /\.crv(3d)?$/i.test(f)).map(f => path.join(dir, f));
    if (!crvs.length) crvs = listDir(path.dirname(dir)).filter(e => e.isFile() && /\.crv(3d)?$/i.test(e.name)).map(e => path.join(path.dirname(dir), e.name));
    for (const t of taps) {
      if (o.limit && n >= o.limit) return report;
      n++;
      const tapPath = path.join(dir, t), rel = path.relative(src, tapPath), name = t.replace(/\.tap$/i, '');
      const row = { tap: rel, status: 'UNPAIRED' };
      report.push(row);
      let text; try { text = fs.readFileSync(tapPath, 'utf8'); } catch (e) { row.status = 'ERROR'; row.note = e.message; continue; }
      // pair: the CRV that explains the most passes
      let best = null;
      for (const c of crvs) {
        const g = getIdx(c); if (!g.ix) continue;
        let an; try { an = analyze(g.ix, [{ name, text }]); } catch (e) { continue; }
        const score = an.hits.length - 1000 * an.unmatched.length;
        if (an.hits.length && (!best || score > best.score)) best = { c, an, score, ix: g.ix };
      }
      if (!best) { row.note = crvs.length ? 'no CRV in folder explains any pass' : 'no CRV in folder'; continue; }
      row.crv = path.relative(src, best.c);
      const jobDir = path.join(outdir, path.dirname(rel)); fs.mkdirSync(jobDir, { recursive: true });
      const ops = buildSpec(best.an, { toolDia: T => (TOOLS[T] && TOOLS[T].dia) || null })[name] || [];
      const spec = { name, crv: path.relative(jobDir, best.c), vectric: path.relative(jobDir, tapPath), out: safe(name) + '-aq.tap',
                     complete: best.an.unmatched.length === 0, generatedBy: 'tap2spec', ops,
                     ...(best.an.unmatched.length ? { unmatched: best.an.unmatched.map(u => ({ tool: u.blk.tool, pass: u.pass, why: u.why, bbox: u.bbox })) } : {}) };
      fs.writeFileSync(path.join(jobDir, safe(name) + '.aqjob.json'), JSON.stringify(spec, null, 1));
      row.ops = ops.map(x => `T${x.toolNum} ${x.op}${x.side ? ' ' + x.side : ''} ${x.toolDia || '?'}"/${x.cutDepth}" x${x.select.length}`);
      if (!spec.complete) { row.status = 'PARTIAL'; row.note = best.an.unmatched.length + ' passes not explained: ' + best.an.unmatched[0].why; continue; }
      let g; try { g = repostJob(best.ix, spec).gcode; } catch (e) { row.status = 'ERROR'; row.note = 'repost: ' + e.message; continue; }
      const outTap = path.join(jobDir, spec.out);
      fs.writeFileSync(outTap, g);
      const cmp = compare(text, g, { tools: TOOLS });
      row.status = cmp.pass ? 'PASS' : 'FAIL';
      row.minutes = { vectric: +cmp.tools.reduce((a, x) => a + (x.A ? x.A.minutes : 0), 0).toFixed(1), ours: +cmp.tools.reduce((a, x) => a + (x.B ? x.B.minutes : 0), 0).toFixed(1) };
      if (!cmp.pass) {
        const bad = cmp.tools.filter(x => !x.pass)[0];
        const m = bad.AinB && bad.AinB.material && bad.AinB.material.real ? ['Vectric cuts where we do not', bad.AinB.material]
                : bad.BinA && bad.BinA.material && bad.BinA.material.real ? ['we cut where Vectric does not', bad.BinA.material] : null;
        row.note = `T${bad.tool}: ` + (m ? `${m[0]}, gap ${m[1].worstGap.toFixed(4)}" @ ${JSON.stringify(m[1].worst)}` : (bad.A && bad.B ? 'path check failed' : 'tool missing on one side'));
        continue;
      }
      try {
        let air;
        try { air = aircut(g); } catch (e) { air = aircut(g, { retract: 0.8 }); row.note = 'AIRCUT retract raised to 0.8'; }
        fs.writeFileSync(path.join(jobDir, safe(name) + '-aq-AIRCUT.tap'), air.gcode || air);
      } catch (e) { row.note = 'aircut: ' + e.message; }
    }
  }
  return report;
}

if (require.main === module) {
  const av = process.argv.slice(2), o = {}; let src = null, outdir = null;
  for (let i = 0; i < av.length; i++) {
    if (av[i] === '--outdir') outdir = av[++i]; else if (av[i] === '--recursive') o.recursive = true;
    else if (av[i] === '--limit') o.limit = +av[++i];
    else if (av[i].startsWith('--')) { console.error('unknown flag ' + av[i]); process.exit(2); } else src = av[i];
  }
  if (!src || !outdir) { console.error('usage: batch.js <vcarve folder> --outdir <dir> [--recursive] [--limit N]'); process.exit(2); }
  if (path.resolve(outdir).startsWith(path.resolve(src) + path.sep) || path.resolve(outdir) === path.resolve(src)) { console.error('outdir must not be inside the source folder'); process.exit(2); }
  fs.mkdirSync(outdir, { recursive: true });
  const rep = run(src, outdir, o);
  const count = {}; for (const r of rep) count[r.status] = (count[r.status] || 0) + 1;
  fs.writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ src, when: new Date().toISOString(), count, jobs: rep }, null, 1));
  const md = [`# Batch: ${src}`, '', Object.entries(count).map(([k, v]) => `${k} ${v}`).join(' · '), '', '| status | tap | crv | ops | min V/ours | note |', '|---|---|---|---|---|---|',
    ...rep.map(r => `| ${r.status} | ${r.tap} | ${r.crv || ''} | ${(r.ops || []).join('; ')} | ${r.minutes ? r.minutes.vectric + '/' + r.minutes.ours : ''} | ${r.note || ''} |`)].join('\n');
  fs.writeFileSync(path.join(outdir, 'report.md'), md + '\n');
  console.log(JSON.stringify(count));
}
module.exports = { run };
