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

// Vectric tessellates offset curves with chords; where its chord sags off the true offset by more than
// the bar, our arc-true path "differs". A failure point is excused only when (a) it is a small
// deviation (gap <= 0.03"), and (b) the CRV says Vectric is the one off the geometry: Vectric's point
// sits off every valid offset of that tool (A side), or our point sits exactly on one (B side).
function distToVecs(ix, x, y) {
  let best = Infinity;
  for (const L of Object.keys(ix)) for (const v of ix[L]) { const P = v.pts, n = P.length, last = v.closed ? n : n - 1;
    for (let i = 0; i < last; i++) { const a = P[i], b = P[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      if (Math.abs(x - a.x) > 2 && Math.abs(x - b.x) > 2) continue;
      let t = L2 ? ((x - a.x) * dx + (y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t); if (d < best) best = d; } }
  return best;
}
function excuseChords(cmp, spec, ix) {
  let worst = 0, n = 0;
  for (const t of cmp.tools) {
    if (t.pass) continue;
    if (!t.AinB || !t.AinB.material) return;
    const offs = [...new Set(spec.ops.filter(o => o.toolNum === t.tool && o.op === 'profile').map(o => o.side === 'on' ? 0 : o.toolDia / 2))];
    if (!offs.length) return;
    const offErr = p => Math.min(...offs.map(r => Math.abs(distToVecs(ix, p.x, p.y) - r)));
    for (const p of t.AinB.material.pts) { if (p.gap > 0.03 || offErr(p) <= 0.003) return; worst = Math.max(worst, p.gap); n++; }
    for (const p of t.BinA.material.pts) { if (p.gap > 0.03 || offErr(p) > 0.002) return; worst = Math.max(worst, p.gap); n++; }
    if (t.AinB.material.pts.length < t.AinB.material.real || t.BinA.material.pts.length < t.BinA.material.real) return;
  }
  cmp.pass = true; cmp.chord = worst; cmp.chordPts = n;
}

function run(src, outdir, o) {
  const report = o.prior || [], idxCache = new Map(), done = new Set(report.map(r => r.tap)), t0 = Date.now();
  const getIdx = f => { if (!idxCache.has(f)) { try { idxCache.set(f, { ix: crvIndex(fs.readFileSync(f)) }); } catch (e) { idxCache.set(f, { err: e.message }); } } return idxCache.get(f); };
  let n = 0;
  for (const { dir, files } of walk(src, o.recursive)) {
    const taps = files.filter(f => /\.tap$/i.test(f) && !/-aq(-AIRCUT)?\.tap$/i.test(f));
    if (!taps.length) continue;
    let crvs = files.filter(f => /\.crv(3d)?$/i.test(f)).map(f => path.join(dir, f));
    if (!crvs.length) crvs = listDir(path.dirname(dir)).filter(e => e.isFile() && /\.crv(3d)?$/i.test(e.name)).map(e => path.join(path.dirname(dir), e.name));
    for (const t of taps) {
      const tapPath = path.join(dir, t), rel = path.relative(src, tapPath), name = t.replace(/\.tap$/i, '');
      if (done.has(rel)) continue;
      if (o.save) o.save(report);
      if (process.env.BATCH_TRACE) console.error('>> ' + rel);
      if ((o.limit && n >= o.limit) || (o.budget && Date.now() - t0 > o.budget * 1000)) { report.unfinished = true; return report; }
      n++;
      const row = { tap: rel, status: 'UNPAIRED' };
      report.push(row);
      let text; try { text = fs.readFileSync(tapPath, 'utf8'); } catch (e) { row.status = 'ERROR'; row.note = e.message; continue; }
      // pair: the CRV that explains the most passes
      let best = null; const tj = Date.now();
      const tok = x => new Set(path.basename(x).toLowerCase().replace(/\.(tap|crv3d|crv)$/, '').split(/[^a-z0-9]+/).filter(Boolean));
      const tt = tok(t), sim = c => { const a = tok(c); let k = 0; for (const w of a) if (tt.has(w)) k++; return k / Math.max(1, a.size + tt.size - k); };
      // probe every candidate on a few passes, then run the full analysis on the best two only
      const cands = [];
      for (const c of crvs.slice().sort((a, b) => sim(b) - sim(a))) {
        const g = getIdx(c); if (!g.ix) continue;
        let pr; try { pr = analyze(g.ix, [{ name, text }], { probe: 6 }); } catch (e) { continue; }
        if (pr.hits.length) cands.push({ c, g, s: pr.hits.length - 2 * pr.unmatched.length });
        if (pr.hits.length && !pr.unmatched.length && cands.length >= 1 && sim(c) > 0.5) break;
      }
      cands.sort((a, b) => b.s - a.s);
      for (const { c, g } of cands.slice(0, 2)) {
        let an; try { an = analyze(g.ix, [{ name, text }]); } catch (e) { continue; }
        const score = an.hits.length - 1000 * an.unmatched.length;
        if (an.hits.length && (!best || score > best.score)) best = { c, an, score, ix: g.ix };
        if (best && best.an.unmatched.length === 0) break;
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
      const jobTools = Object.assign({}, TOOLS);
      for (const x of ops) if (!jobTools[x.toolNum] && x.toolDia && x.op !== 'drill') jobTools[x.toolNum] = { dia: x.toolDia, source: 'measured' };
      let cmp; try { cmp = compare(text, g, { tools: jobTools }); } catch (e) { row.status = 'ERROR'; row.note = 'compare: ' + e.message; continue; }
      row.status = cmp.pass ? 'PASS' : 'FAIL'; row.sec = Math.round((Date.now() - tj) / 1000);
      if (cmp.chord) row.note = `Vectric chord error up to ${cmp.chord.toFixed(4)}" (${cmp.chordPts} pts); ours follows the vector`;
      row.minutes = { vectric: +cmp.tools.reduce((a, x) => a + (x.A ? x.A.minutes : 0), 0).toFixed(1), ours: +cmp.tools.reduce((a, x) => a + (x.B ? x.B.minutes : 0), 0).toFixed(1) };
      if (!cmp.pass) excuseChords(cmp, spec, best.ix);
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
    else if (av[i] === '--budget') o.budget = +av[++i];
    else if (av[i] === '--resume') o.resume = true;
    else if (av[i].startsWith('--')) { console.error('unknown flag ' + av[i]); process.exit(2); } else src = av[i];
  }
  if (!src || !outdir) { console.error('usage: batch.js <vcarve folder> --outdir <dir> [--recursive] [--limit N]'); process.exit(2); }
  if (path.resolve(outdir).startsWith(path.resolve(src) + path.sep) || path.resolve(outdir) === path.resolve(src)) { console.error('outdir must not be inside the source folder'); process.exit(2); }
  fs.mkdirSync(outdir, { recursive: true });
  const rj = path.join(outdir, 'report.json');
  if (o.resume && fs.existsSync(rj)) o.prior = JSON.parse(fs.readFileSync(rj, 'utf8')).jobs;
  o.save = r => fs.writeFileSync(rj, JSON.stringify({ src, when: new Date().toISOString(), unfinished: true, jobs: r.filter(x => x.status !== 'UNPAIRED' || x.note) }, null, 1));
  const rep = run(src, outdir, o);
  const count = {}; for (const r of rep) count[r.status] = (count[r.status] || 0) + 1;
  fs.writeFileSync(path.join(outdir, 'report.json'), JSON.stringify({ src, when: new Date().toISOString(), unfinished: !!rep.unfinished, count, jobs: rep }, null, 1));
  const md = [`# Batch: ${src}`, '', Object.entries(count).map(([k, v]) => `${k} ${v}`).join(' · '), '', '| status | tap | crv | ops | min V/ours | note |', '|---|---|---|---|---|---|',
    ...rep.map(r => `| ${r.status} | ${r.tap} | ${r.crv || ''} | ${(r.ops || []).join('; ')} | ${r.minutes ? r.minutes.vectric + '/' + r.minutes.ours : ''} | ${r.note || ''} |`)].join('\n');
  fs.writeFileSync(path.join(outdir, 'report.md'), md + '\n');
  console.log((rep.unfinished ? 'UNFINISHED ' : 'DONE ') + JSON.stringify(count));
}
module.exports = { run };
