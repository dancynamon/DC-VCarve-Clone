#!/usr/bin/env node
// tap2spec.js — recover a job's machining recipe from a Vectric-posted .tap and the .crv it came from.
//
//   node cam-engine/tap2spec.js job.crv3d vectric.tap [more.tap ...] --out job.aqjob.json [--name N]
//
// The .crv supplies the geometry (exact vectors, by layer); the .tap supplies what Vectric did with it
// (tool numbers, RPM, feeds, depths, sides, direction, leads, tabs). Each cutting pass in the .tap is
// explained by ONE vector it runs at a constant offset from: offset ≈ 0 is "on", otherwise the offset
// is the tool radius and inside/outside comes from which side of the vector the pass runs. Plunge-only
// passes are drills, matched to the vector whose centroid they hit. A pass nothing explains is listed
// as UNMATCHED and the spec is marked incomplete — never guessed. Verify with repost + tapcompare.
const fs = require('fs'), path = require('path');
const { parseTap } = require('./tapcompare.js');
const { crvIndex } = require('./repost.js');

const r4 = v => Math.round(v * 1e4) / 1e4;
function polyArea(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; } return a / 2; }
function pointInPoly(x, y, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; }
function distToPoly(x, y, pts, closed) {
  let best = Infinity, sgn = 0; const n = pts.length, last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - a.x) * dx + (y - a.y) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) { best = d; sgn = Math.sign(dx * (y - a.y) - dy * (x - a.x)); }   // +1 = left of vector direction
  }
  return { d: best, left: sgn > 0 };
}
function bboxOf(pts) { const b = [1e9, 1e9, -1e9, -1e9]; for (const p of pts) { b[0] = Math.min(b[0], p.x); b[1] = Math.min(b[1], p.y); b[2] = Math.max(b[2], p.x); b[3] = Math.max(b[3], p.y); } return b; }
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// split one tool block into passes: maximal runs of feed moves that go below Z0
function passesOf(tool) {
  const out = []; let cur = null;
  for (const s of tool.segs) {
    if (s.rapid) { if (cur) out.push(cur); cur = null; continue; }
    (cur = cur || []).push(s);
  }
  if (cur) out.push(cur);
  return out.filter(p => p.some(s => Math.min(s.z0, s.z1) < -1e-6));
}
function sample(segs, step) {
  const pts = [];
  for (const s of segs) { const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; pts.push({ x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t, z: s.z0 + (s.z1 - s.z0) * t, arc: s.arc, along: 0 }); } }
  const s = segs[segs.length - 1]; if (s) pts.push({ x: s.x1, y: s.y1, z: s.z1, arc: s.arc });
  let acc = 0; for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); pts[i].along = acc; }
  return pts;
}

function analyze(index, taps) {
  const vecs = [];
  for (const layer of Object.keys(index)) index[layer].forEach((v, i) => {
    vecs.push({ layer, i, closed: v.closed, pts: v.pts, bb: bboxOf(v.pts), area: v.closed ? polyArea(v.pts) : 0,
                cx: v.pts.reduce((a, p) => a + p.x, 0) / v.pts.length, cy: v.pts.reduce((a, p) => a + p.y, 0) / v.pts.length });
  });
  const hits = [], unmatched = [], blocks = [];
  for (const tp of taps) for (const tool of parseTap(tp.text)) {
    const rapidsZ = tool.segs.filter(s => s.rapid && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-6).map(s => s.z1);
    const blk = { file: tp.name, tool: tool.tool, rpm: tool.rpm,
      feed: +Object.entries(tool.feeds).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      plunge: +Object.entries(tool.plungeFeeds).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      clearZ: rapidsZ.length ? pct(rapidsZ, 0.1) : 0.25 };
    blocks.push(blk);
    passesOf(tool).forEach((ps, pi) => {
      const zmin = ps.reduce((m, s) => Math.min(m, s.z0, s.z1), Infinity);
      const xyLen = ps.reduce((a, s) => a + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0);
      if (xyLen < 1e-4) {                                     // drill: plunge only
        const s = ps[0], c = vecs.filter(v => v.closed).map(v => ({ v, d: Math.hypot(v.cx - s.x0, v.cy - s.y0) })).sort((a, b) => a.d - b.d)[0];
        if (c && c.d < 0.01) hits.push({ blk, kind: 'drill', v: c.v, depth: zmin, pass: pi });
        else unmatched.push({ blk, pass: pi, why: 'plunge at ' + r4(s.x0) + ',' + r4(s.y0) + ' hits no vector centroid' });
        return;
      }
      const all = sample(ps, 0.02), deep = all.filter(p => Math.abs(p.z - zmin) < 1e-4 || true);
      const total = all[all.length - 1].along;
      const pb = bboxOf(all);
      let best = null;
      for (const v of vecs) {
        if (v.bb[0] > pb[2] + 1 || v.bb[2] < pb[0] - 1 || v.bb[1] > pb[3] + 1 || v.bb[3] < pb[1] - 1) continue;
        const ds = deep.map(p => distToPoly(p.x, p.y, v.pts, v.closed).d);
        // ignore the first/last 0.5" of travel (leads), score the body
        const body = ds.filter((d, k) => deep[k].along > 0.5 && deep[k].along < total - 0.5);
        const use = body.length > 10 ? body : ds;
        const med = pct(use, 0.5), spread = pct(use, 0.98) - pct(use, 0.02);
        if (!best || spread + Math.abs(med) * 1e-3 < best.spread + Math.abs(best.med) * 1e-3) best = { v, med, spread, ds };
      }
      if (!best || best.spread > 0.004) {
        const pk = matchPocket(all, vecs, pb);
        if (pk) { hits.push({ blk, kind: 'pocket', v: pk.v, toolDia: r4(2 * pk.r), stepover: pk.stepover, climb: pk.climb, depth: zmin, pass: pi }); return; }
        unmatched.push({ blk, pass: pi, why: 'no vector at constant offset (best spread ' + (best ? r4(best.spread) : '-') + ')', bbox: pb.map(r4) }); return; }
      const v = best.v, off = best.med;
      // side
      let side;
      const mid = deep[Math.floor(deep.length / 2)];
      if (off < 0.003) side = 'on';
      else if (v.closed) side = pointInPoly(mid.x, mid.y, v.pts) ? 'inside' : 'outside';
      else side = distToPoly(mid.x, mid.y, v.pts, false).left ? 'left' : 'right';
      // direction: orientation of the pass vs the vector
      let climb = null, reverse = false;
      if (v.closed && side !== 'on') {
        const body = deep.filter(p => p.along > 0.5 && p.along < total - 0.5);
        const ccw = polyArea(body.length > 10 ? body : deep) > 0;
        climb = side === 'outside' ? !ccw : ccw;              // camcore: outside wantCCW = !climb, inside wantCCW = climb
      } else if (!v.closed) {
        const a = deep[0], va = v.pts[0], vb = v.pts[v.pts.length - 1];
        reverse = Math.hypot(a.x - vb.x, a.y - vb.y) < Math.hypot(a.x - va.x, a.y - va.y);
      }
      // lead: travel at the start before the pass settles onto the offset
      let leadLen = 0, leadArc = false;
      for (let k = 0; k < deep.length; k++) { if (Math.abs(best.ds[k] - off) < 0.003) break; leadLen = deep[k + 1] ? deep[k + 1].along : deep[k].along; leadArc = leadArc || !!deep[k].arc; }
      // tabs: runs of the deepest pass held above the floor
      const runs = []; let run = null;
      for (const p of all) { const up = p.z > zmin + 0.01 && p.z < -1e-4;
        if (up) { if (!run) run = { a: p.along, z: p.z }; run.b = p.along; } else if (run) { runs.push(run); run = null; } }
      if (run) runs.push(run);
      const tabRuns = runs.filter(t => t.b - t.a > 0.05);
      hits.push({ blk, kind: 'profile', v, side, toolDia: side === 'on' ? null : r4(2 * off), climb, reverse,
                  depth: zmin, leadLen: leadLen > 0.02 ? r4(leadLen) : 0, leadType: leadLen > 0.02 ? (leadArc ? 'arc' : 'line') : 'none',
                  tabs: tabRuns.length ? { count: tabRuns.length, length: r4(pct(tabRuns.map(t => t.b - t.a), 0.5)), height: r4(pct(tabRuns.map(t => t.z), 0.5) - zmin) } : null,
                  pass: pi, spread: best.spread });
    });
  }
  return { hits, unmatched, blocks, vecs };
}

// Offset-pocket clearing inside one closed vector: the distances from the pass to the vector cluster at
// r, r+s, r+2s ... (r = tool radius, s = stepover). Accept only when nearly every sample sits on that comb.
function matchPocket(all, vecs, pb) {
  let best = null;
  for (const v of vecs) {
    if (!v.closed || v.bb[0] > pb[0] + 1e-3 || v.bb[1] > pb[1] + 1e-3 || v.bb[2] < pb[2] - 1e-3 || v.bb[3] < pb[3] - 1e-3) continue;
    const pts = all.filter((p, k) => k % 2 === 0);
    if (pts.some(p => !pointInPoly(p.x, p.y, v.pts))) continue;
    const ds = pts.map(p => distToPoly(p.x, p.y, v.pts, true).d);
    const h = {}; for (const d of ds) { const k = Math.round(d / 0.005); h[k] = (h[k] || 0) + 1; }
    const modes = Object.keys(h).map(Number).filter(k => h[k] >= Math.max(4, ds.length * 0.02) && (h[k] >= (h[k - 1] || 0)) && (h[k] >= (h[k + 1] || 0))).sort((a, b) => a - b).map(k => k * 0.005);
    if (modes.length < 1) continue;
    const refined = modes.map(m => { const near = ds.filter(d => Math.abs(d - m) <= 0.004); return near.reduce((a, d) => a + d, 0) / near.length; });
    const r = refined[0];
    const gaps = refined.slice(1).map((m, i) => m - refined[i]);
    const s = gaps.length ? pct(gaps, 0.5) : null;
    const onComb = s ? ds.filter(d => { const k = Math.round((d - r) / s); return k >= 0 && Math.abs(d - (r + k * s)) < 0.006; }).length / ds.length : 0;
    if (onComb < 0.6) continue;
    // direction on the outermost ring
    let cr = 0; const ring = all.filter((p, k) => Math.abs(distToPoly(p.x, p.y, v.pts, true).d - r) < 0.004);
    for (let k = 1; k < ring.length; k++) { const a = ring[k - 1], b = ring[k]; if (Math.hypot(b.x - a.x, b.y - a.y) > 0.1) continue; cr += (a.x - v.cx) * (b.y - a.y) - (a.y - v.cy) * (b.x - a.x); }
    const cand = { v, r, stepover: Math.round(s / (2 * r) * 100) / 100, climb: cr > 0, onComb };
    if (!best || onComb > best.onComb) best = cand;
  }
  return best;
}

const KNOWN_DIA = [0.0625, 0.125, 0.1875, 0.25, 0.3, 0.375, 0.5, 0.625, 0.75, 1];
function snapDia(d) { if (d == null) return null; const k = KNOWN_DIA.find(x => Math.abs(x - d) < 0.004); return k != null ? k : r4(d); }

function buildSpec(an, meta) {
  // fold passes of the same tool block + vector into one per-vector recipe
  const perVec = new Map();
  for (const h of an.hits) {
    const key = h.blk.file + '|' + h.blk.tool + '|' + h.v.layer + '|' + h.v.i + '|' + h.kind + '|' + (h.side || '');
    if (!perVec.has(key)) perVec.set(key, { h, depths: [] });
    perVec.get(key).depths.push(h.depth);
    if (h.tabs) perVec.get(key).h = h;                                   // the tabbed (deepest) pass carries the tab info
  }
  const groups = new Map();
  for (const { h, depths } of perVec.values()) {
    const ds = [...new Set(depths.map(r4))].sort((a, b) => b - a);
    const cutDepth = r4(-ds[ds.length - 1]), passDepth = r4(-ds[0]);
    const b = h.blk;
    const op = h.kind === 'pocket'
      ? { op: 'pocket', climb: h.climb, toolNum: b.tool, toolDia: snapDia(h.toolDia), stepover: h.stepover,
          rpm: b.rpm, feed: b.feed, plunge: b.plunge, cutDepth, passDepth, clearZ: b.clearZ }
      : h.kind === 'drill'
      ? { op: 'drill', toolNum: b.tool, toolDia: meta.toolDia(b.tool), rpm: b.rpm, feed: b.feed || b.plunge, plunge: b.plunge, cutDepth, clearZ: b.clearZ }
      : { op: 'profile', side: h.side, climb: h.climb == null ? false : h.climb, toolNum: b.tool,
          toolDia: h.side === 'on' ? meta.toolDia(b.tool) : snapDia(h.toolDia),
          rpm: b.rpm, feed: b.feed, plunge: b.plunge, cutDepth, passDepth, clearZ: b.clearZ,
          leadType: h.leadType, leadLen: h.leadLen || 0.25, ...(h.tabs ? { tabs: h.tabs } : {}) };
    const k = JSON.stringify([b.file, op]);
    if (!groups.has(k)) groups.set(k, { ...op, label: `${b.file} T${b.tool} ${op.op}${op.side ? ' ' + op.side : ''}`, _file: b.file, select: [] });
    groups.get(k).select.push(h.reverse ? [h.v.layer, h.v.i, { reverse: true }] : [h.v.layer, h.v.i]);
  }
  const ops = [...groups.values()];
  const byFile = {};
  for (const o of ops) { (byFile[o._file] = byFile[o._file] || []).push(o); delete o._file; }
  return byFile;
}

if (require.main === module) {
  const av = process.argv.slice(2), pos = []; let outDir = null, name = null, tools = {};
  for (let i = 0; i < av.length; i++) {
    if (av[i] === '--outdir') outDir = av[++i];
    else if (av[i] === '--tools') tools = JSON.parse(fs.readFileSync(av[++i], 'utf8'));
    else if (av[i].startsWith('--')) { console.error('unknown flag ' + av[i]); process.exit(2); }
    else pos.push(av[i]);
  }
  if (pos.length < 2 || !outDir) { console.error('usage: tap2spec.js job.crv3d vectric.tap [more.tap ...] --outdir DIR [--tools shoptools.json]'); process.exit(2); }
  const crv = pos[0], index = crvIndex(fs.readFileSync(crv));
  const taps = pos.slice(1).map(f => ({ name: path.basename(f).replace(/\.tap$/i, ''), path: f, text: fs.readFileSync(f, 'utf8') }));
  const an = analyze(index, taps);
  const meta = { toolDia: T => (tools[T] && tools[T].dia) || null };
  const byFile = buildSpec(an, meta);
  fs.mkdirSync(outDir, { recursive: true });
  for (const tp of taps) {
    const ops = byFile[tp.name] || [];
    const un = an.unmatched.filter(u => u.blk.file === tp.name);
    const spec = { name: tp.name, crv: path.relative(outDir, crv), out: tp.name + '-aq.tap', vectric: path.relative(outDir, tp.path),
                   complete: un.length === 0, generatedBy: 'tap2spec', ops,
                   ...(un.length ? { unmatched: un.map(u => ({ tool: u.blk.tool, pass: u.pass, why: u.why, bbox: u.bbox })) } : {}) };
    const f = path.join(outDir, tp.name + '.aqjob.json');
    fs.writeFileSync(f, JSON.stringify(spec, null, 1));
    console.log(`${spec.complete ? 'OK  ' : 'PART'} ${f}: ${ops.length} ops, ${ops.reduce((n, o) => n + o.select.length, 0)} vectors${un.length ? ', ' + un.length + ' unmatched passes' : ''}`);
    for (const o of ops) console.log(`     T${o.toolNum} ${o.op}${o.side ? ' ' + o.side : ''} dia ${o.toolDia} depth ${o.cutDepth}/${o.passDepth || ''} climb ${o.climb} lead ${o.leadType || ''} ${o.tabs ? 'tabs ' + JSON.stringify(o.tabs) : ''} x${o.select.length}`);
  }
}
module.exports = { analyze, buildSpec, passesOf };
