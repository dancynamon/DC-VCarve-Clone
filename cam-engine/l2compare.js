#!/usr/bin/env node
// l2compare.js — PROGRAM-level comparison (blind-test level L2) of our .tap against Vectric's.
//   node cam-engine/l2compare.js vectric.tap ours.tap [--json]
// L1 (tapcompare) asks "same part?". L2 also asks "same program?": tool order, RPM, feeds, depth
// levels, pass count, and for every pass (paired by geometry) the same entry point, direction,
// depth, tab count and lead. Text formatting and the ORDER of passes within a tool are reported,
// not failed. Exit 0 only when L1 and every L2 check pass.
const fs = require('fs'), path = require('path');
const { parseTap, compare } = require('./tapcompare.js');
const { passesOf } = require('./tap2spec.js');
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, 'shoptools.json'), 'utf8'));
const TOL = 0.005;

function describe(tool) {
  const passes = passesOf(tool).map(ps => {
    const cut = ps.filter(s => Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-9);
    const zmin = ps.reduce((m, s) => Math.min(m, s.z0, s.z1), 0);
    let area = 0, len = 0, cx = 0, cy = 0;
    for (const s of cut) { area += s.x0 * s.y1 - s.x1 * s.y0; const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0); len += L; cx += (s.x0 + s.x1) / 2 * L; cy += (s.y0 + s.y1) / 2 * L; }
    const floorRuns = []; let up = false;
    for (const s of ps) { const isUp = s.z1 > zmin + 0.01 && s.z1 < 0; if (isUp && !up) floorRuns.push(1); up = isUp; }
    const first = ps.find(s => s.z1 < s.z0 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1e-9) || ps[0];
    const firstCut = cut[0];
    return { entry: { x: first.x1, y: first.y1 }, depth: +zmin.toFixed(4), len, cx: len ? cx / len : first.x1, cy: len ? cy / len : first.y1,
             dir: Math.abs(area) < 1e-6 ? 'open' : (area > 0 ? 'CCW' : 'CW'), tabs: floorRuns.length,
             ramp: !!(firstCut && firstCut.z1 < firstCut.z0 - 1e-6), leadArc: !!(firstCut && firstCut.arc) };
  });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(e => +e[0])[0] ?? null;
  return { tool: tool.tool, rpm: tool.rpm, feed: top(tool.feeds), plunge: top(tool.plungeFeeds),
           depths: [...new Set(passes.map(p => p.depth))].sort((a, b) => b - a), passes,
           clearZ: (() => { const z = tool.segs.filter(s => s.rapid && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-6).map(s => s.z1); return z.length ? Math.min(...z) : null; })() };
}

function l2(textA, textB) {
  const A = parseTap(textA).map(describe), B = parseTap(textB).map(describe), issues = [];
  const seqA = A.map(t => t.tool).join(','), seqB = B.map(t => t.tool).join(',');
  if (seqA !== seqB) issues.push({ what: 'tool order', vectric: seqA, ours: seqB });
  for (let k = 0; k < Math.min(A.length, B.length); k++) {
    const a = A[k], b = B[k], T = `T${a.tool}#${k + 1}`;
    for (const f of ['rpm', 'feed', 'plunge', 'clearZ']) if (a[f] !== b[f]) issues.push({ what: `${T} ${f}`, vectric: a[f], ours: b[f] });
    if (a.depths.join() !== b.depths.join()) issues.push({ what: `${T} depth levels`, vectric: a.depths.join(' '), ours: b.depths.join(' ') });
    if (a.passes.length !== b.passes.length) issues.push({ what: `${T} pass count`, vectric: a.passes.length, ours: b.passes.length });
    // pair passes by depth + centroid, then compare what the operator would see
    const used = new Set(); let orderSame = true;
    a.passes.forEach((p, i) => {
      let best = -1, bd = Infinity;
      b.passes.forEach((q, j) => { if (used.has(j) || q.depth !== p.depth) return; const d = Math.hypot(p.cx - q.cx, p.cy - q.cy) + Math.abs(p.len - q.len); if (d < bd) { bd = d; best = j; } });
      if (best < 0 || bd > 0.1) { issues.push({ what: `${T} pass ${i + 1} (z ${p.depth}) unmatched`, vectric: `${p.cx.toFixed(3)},${p.cy.toFixed(3)}`, ours: '-' }); return; }
      used.add(best); if (best !== i) orderSame = false;
      const q = b.passes[best], at = `${T} pass ${i + 1} @${p.cx.toFixed(2)},${p.cy.toFixed(2)} z${p.depth}`;
      const de = Math.hypot(p.entry.x - q.entry.x, p.entry.y - q.entry.y);
      if (de > TOL) issues.push({ what: `${at} entry point`, vectric: `${p.entry.x.toFixed(4)},${p.entry.y.toFixed(4)}`, ours: `${q.entry.x.toFixed(4)},${q.entry.y.toFixed(4)}`, off: +de.toFixed(4) });
      if (p.dir !== q.dir) issues.push({ what: `${at} direction`, vectric: p.dir, ours: q.dir });
      if (p.tabs !== q.tabs) issues.push({ what: `${at} tabs`, vectric: p.tabs, ours: q.tabs });
      if (p.ramp !== q.ramp) issues.push({ what: `${at} ramp`, vectric: p.ramp, ours: q.ramp });
    });
    if (!orderSame) issues.push({ what: `${T} pass order differs (info only)`, info: true });
  }
  if (A.length !== B.length) issues.push({ what: 'tool block count', vectric: A.length, ours: B.length });
  const l1 = compare(textA, textB, { tools: TOOLS });
  const hard = issues.filter(x => !x.info);
  return { pass: l1.pass && hard.length === 0, l1: l1.pass, issues };
}

if (require.main === module) {
  const av = process.argv.slice(2), json = av.includes('--json'), pos = av.filter(a => a !== '--json');
  if (pos.length !== 2) { console.error('usage: l2compare.js vectric.tap ours.tap [--json]'); process.exit(2); }
  const r = l2(fs.readFileSync(pos[0], 'utf8'), fs.readFileSync(pos[1], 'utf8'));
  if (json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(`${r.pass ? 'L2 PASS' : 'L2 FAIL'}  (L1 ${r.l1 ? 'pass' : 'FAIL'})  ${path.basename(pos[0])} vs ${path.basename(pos[1])}`);
    const groups = {}; for (const x of r.issues) { const k = x.what.replace(/pass \d+ @[-\d.,]+ /, 'pass * ').replace(/#\d+/, ''); (groups[k] = groups[k] || []).push(x); }
    for (const [k, v] of Object.entries(groups)) console.log(`  ${v.length > 1 ? v.length + 'x ' : ''}${k}: vectric ${v[0].vectric ?? ''} ours ${v[0].ours ?? ''}${v[0].off ? ' (off ' + v[0].off + ')' : ''}`);
  }
  process.exit(r.pass ? 0 : 1);
}
module.exports = { l2, describe };
