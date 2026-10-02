#!/usr/bin/env node
// tapcompare.js — is our G-code the same cut as Vectric's?
//
//   node cam-engine/tapcompare.js vectric.tap ours.tap [--tol 0.005] [--ztol 0.005] [--json]
//
// Compares the CUT, not the text. Move order, lead shapes, arc-vs-line output and rapid heights are
// allowed to differ; where the tool goes into material is not. For each tool number, every cutting
// move of A is sampled (0.02") and must lie within --tol of a cutting move of B that is at least as
// deep (within --ztol), and vice versa. A ⊆ B catches material we would leave; B ⊆ A catches material
// we would remove that Vectric does not (an overcut, a missing tab, an extra pass). Both must pass.
// Also prints the per-tool recipe (RPM, feed, plunge, depth levels, cut length, est. time) side by side.
const fs = require('fs'), path = require('path');

function parseTap(text) {
  const tools = []; let cur = null;
  let x = 0, y = 0, z = 2, mode = 'G0', feed = 0, rpm = 0, have = false;
  const newTool = t => { cur = { tool: t, rpm, segs: [], feeds: {}, plungeFeeds: {} }; tools.push(cur); };
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
    if (!line || line[0] === '%') continue;
    const tm = line.match(/^T(\d+)/); if (tm) { newTool(+tm[1]); continue; }
    const sm = line.match(/^S(\d+(?:\.\d+)?)/); if (sm) { rpm = +sm[1]; if (cur) cur.rpm = rpm; continue; }
    if (/^G4\b|^M|^G9[01]\b|^G2[01]\b|^G1[789]\b|^G4[09]\b/.test(line) && !/[XYZ]-?[\d.]/.test(line.replace(/^G4\s*X\s*[\d.]+/, ''))) continue;
    const gm = line.match(/G0*([0-3])(?![0-9])/); if (gm) mode = 'G' + gm[1];
    const v = c => { const m = line.match(new RegExp(c + '\\s*(-?\\d*\\.?\\d+)')); return m ? +m[1] : null; };
    const F = v('F'); if (F !== null) feed = F;
    if (/^Z-?[\d.]+$/.test(line)) { z = v('Z'); continue; }            // bare "Z2" safe-height line
    const nx = v('X'), ny = v('Y'), nz = v('Z');
    if (nx === null && ny === null && nz === null) continue;
    if (!cur) newTool(0);
    const x0 = x, y0 = y, z0 = z;
    if (nx !== null) x = nx; if (ny !== null) y = ny; if (nz !== null) z = nz;
    const rapid = mode === 'G0';
    let arc = false;
    const push = (a, b, c, d, e, f) => cur.segs.push({ x0: a, y0: b, z0: c, x1: d, y1: e, z1: f, rapid, feed, arc });
    if ((mode === 'G2' || mode === 'G3') && (v('I') !== null || v('J') !== null)) {
      arc = true; const I = v('I') || 0, J = v('J') || 0, cx = x0 + I, cy = y0 + J, r = Math.hypot(I, J);
      let sa = Math.atan2(y0 - cy, x0 - cx), ea = Math.atan2(y - cy, x - cx);
      if (mode === 'G2') { if (ea >= sa - 1e-12) ea -= 2 * Math.PI; } else { if (ea <= sa + 1e-12) ea += 2 * Math.PI; }
      const n = Math.max(4, Math.ceil(Math.abs(ea - sa) * r / 0.01));
      let px = x0, py = y0, pz = z0;
      for (let k = 1; k <= n; k++) { const t = k / n, a = sa + (ea - sa) * t;
        const qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a), qz = z0 + (z - z0) * t;
        push(px, py, pz, qx, qy, qz); px = qx; py = qy; pz = qz; }
      x = px; y = py;
    } else push(x0, y0, z0, x, y, z);
    if (!rapid) {
      const plunge = Math.hypot(x - x0, y - y0) < 1e-6 && z < z0;
      const bag = plunge ? cur.plungeFeeds : cur.feeds; bag[feed] = (bag[feed] || 0) + 1;
    }
  }
  return tools.filter(t => t.segs.some(s => !s.rapid));   // a header that only parks (G0 Z2 / G0 X0 Y0) before the first T is not a tool
}

function summarize(t) {
  const cuts = t.segs.filter(s => !s.rapid && Math.min(s.z0, s.z1) < 0);
  const depths = {}; let len = 0, min = 0, bb = [1e9, 1e9, -1e9, -1e9], plunges = 0;
  for (const s of t.segs) {
    const d = Math.hypot(s.x1 - s.x0, s.y1 - s.y0, s.z1 - s.z0), f = s.rapid ? 400 : (s.feed || 60);
    min += d / f;
    if (!s.rapid && s.z1 < s.z0 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1e-6 && s.z1 < 0) plunges++;
  }
  for (const s of cuts) {
    len += Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    if (Math.abs(s.z0 - s.z1) < 1e-6) { const k = s.z1.toFixed(4); depths[k] = (depths[k] || 0) + Math.hypot(s.x1 - s.x0, s.y1 - s.y0); }
    for (const [px, py] of [[s.x0, s.y0], [s.x1, s.y1]]) { bb[0] = Math.min(bb[0], px); bb[1] = Math.min(bb[1], py); bb[2] = Math.max(bb[2], px); bb[3] = Math.max(bb[3], py); }
  }
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(e => +e[0]);
  return { tool: t.tool, rpm: t.rpm, feed: top(t.feeds)[0] || null, plunge: top(t.plungeFeeds)[0] || null,
           depths: Object.keys(depths).map(Number).filter(d => depths[d.toFixed(4)] > 0.5).sort((a, b) => b - a),
           maxDepth: cuts.reduce((m, s) => Math.min(m, s.z0, s.z1), 0), cutLen: len, plunges,
           minutes: min, bbox: bb.map(v => +v.toFixed(4)) };
}

// grid hash of cutting segments for nearest-covering-segment queries
function indexSegs(segs, cell) {
  const g = new Map(), key = (i, j) => i * 100003 + j;
  segs.forEach((s, n) => {
    const i0 = Math.floor(Math.min(s.x0, s.x1) / cell), i1 = Math.floor(Math.max(s.x0, s.x1) / cell);
    const j0 = Math.floor(Math.min(s.y0, s.y1) / cell), j1 = Math.floor(Math.max(s.y0, s.y1) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!g.has(k)) g.set(k, []); g.get(k).push(n); }
  });
  return { g, key, cell, segs };
}
function segDistZ(px, py, s) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return [Math.hypot(px - s.x0, py - s.y0), Math.min(s.z0, s.z1)];   // plunge: cuts every depth down to its bottom
  let t = ((px - s.x0) * dx + (py - s.y0) * dy) / L2; t = Math.max(0, Math.min(1, t));
  return [Math.hypot(px - (s.x0 + dx * t), py - (s.y0 + dy * t)), s.z0 + (s.z1 - s.z0) * t];
}
// For every sampled cutting point of A: distance to the nearest B cut that is at least as deep.
function coverage(A, idxB, o) {
  const R = o.search, step = 0.02, out = { max: 0, n: 0, over: 0, worst: null, p995: 0 }, ds = [];
  for (const s of A) {
    const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n, px = s.x0 + (s.x1 - s.x0) * t, py = s.y0 + (s.y1 - s.y0) * t, pz = s.z0 + (s.z1 - s.z0) * t;
      if (pz >= -1e-6) continue;
      let best = Infinity;
      const ci = Math.floor(px / idxB.cell), cj = Math.floor(py / idxB.cell), r = Math.ceil(R / idxB.cell);
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        const lst = idxB.g.get(idxB.key(i, j)); if (!lst) continue;
        for (const m of lst) { const [d, z] = segDistZ(px, py, idxB.segs[m]); if (d < best && z <= pz + o.ztol) best = d; }
      }
      out.n++; ds.push(best);
      if (best > out.max) { out.max = best; out.worst = { x: +px.toFixed(4), y: +py.toFixed(4), z: +pz.toFixed(4) }; }
      if (best > o.tol) { out.over++; (out.fails = out.fails || []).push({ x: px, y: py, z: pz }); }
    }
  }
  ds.sort((a, b) => a - b); out.p995 = ds.length ? ds[Math.floor(ds.length * 0.995)] : 0;
  return out;
}

// A path-level miss is only a REAL difference if it changes the material. For a point p that A cuts
// with a tool of radius R, A removes the disc(p, R) down to p.z; check that B removes every point of
// that disc too (some B cut within R + tol of it, at least as deep). Interior clearing moves that
// differ (pocket ring order, a different last ring) pass; a shifted wall, a missing tab, an extra
// cut do not.
function materialCheck(fails, idxB, R, o) {
  let real = 0, worst = null, worstGap = 0; const pts = [];
  const step = Math.max(0.005, R / 8);
  for (const p of (fails || [])) {
    if (real >= (o.maxReal || 300)) { real = Math.max(real, fails.length); break; }   // enough to call it; don't grind
    let gapHere = 0;
    for (let dx = -R; dx <= R + 1e-9; dx += step) for (let dy = -R; dy <= R + 1e-9; dy += step) {
      if (dx * dx + dy * dy > R * R) continue;
      const qx = p.x + dx, qy = p.y + dy;
      let best = Infinity;
      const ci = Math.floor(qx / idxB.cell), cj = Math.floor(qy / idxB.cell), rr = Math.ceil((R + o.tol) / idxB.cell) + 1;
      for (let i = ci - rr; i <= ci + rr; i++) for (let j = cj - rr; j <= cj + rr; j++) {
        const lst = idxB.g.get(idxB.key(i, j)); if (!lst) continue;
        for (const m of lst) { const [d, z] = segDistZ(qx, qy, idxB.segs[m]); if (d < best && z <= p.z + o.ztol) best = d; }
      }
      const gap = best - R; if (gap > gapHere) gapHere = gap;
    }
    if (gapHere > o.tol) { real++; if (pts.length < 2000) pts.push({ x: p.x, y: p.y, z: p.z, gap: gapHere }); if (gapHere > worstGap) { worstGap = gapHere; worst = { x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) }; } }
  }
  return { real, worstGap, worst, pts };
}

function compare(textA, textB, opts) {
  const o = Object.assign({ tol: 0.005, ztol: 0.005, search: 0.5 }, opts || {});
  const A = parseTap(textA), B = parseTap(textB);
  const tools = [...new Set([...A, ...B].map(t => t.tool))].sort((a, b) => a - b);
  const rows = [];
  for (const T of tools) {
    const a = A.filter(t => t.tool === T), b = B.filter(t => t.tool === T);
    const ca = a.flatMap(t => t.segs).filter(s => !s.rapid), cb = b.flatMap(t => t.segs).filter(s => !s.rapid);
    const row = { tool: T, A: a.length ? summarize({ ...a[0], segs: a.flatMap(t => t.segs) }) : null,
                  B: b.length ? summarize({ ...b[0], segs: b.flatMap(t => t.segs) }) : null };
    if (ca.length && cb.length) {
      const ib = indexSegs(cb, 0.25), ia = indexSegs(ca, 0.25);
      row.AinB = coverage(ca, ib, o);
      row.BinA = coverage(cb, ia, o);
      const tl = (o.tools || {})[T];
      row.R = tl && tl.dia ? tl.dia / 2 : null;
      if (row.R != null) {
        row.AinB.material = materialCheck(row.AinB.fails, ib, row.R, o);
        row.BinA.material = materialCheck(row.BinA.fails, ia, row.R, o);
        row.pass = row.AinB.material.real === 0 && row.BinA.material.real === 0;
      } else row.pass = row.AinB.max <= o.tol && row.BinA.max <= o.tol;
      delete row.AinB.fails; delete row.BinA.fails;
    } else row.pass = false;
    rows.push(row);
  }
  return { tol: o.tol, ztol: o.ztol, pass: rows.length > 0 && rows.every(r => r.pass), tools: rows };
}

function fmt(r, nameA, nameB) {
  const L = [];
  const f = v => v == null ? '-' : (typeof v === 'number' ? (+v.toFixed(4)).toString() : String(v));
  L.push(`${r.pass ? 'PASS' : 'FAIL'}  tol ${r.tol}" (xy) / ${r.ztol}" (z)   A=${nameA}  B=${nameB}`);
  for (const t of r.tools) {
    L.push(`  T${t.tool}  ${t.pass ? 'pass' : 'FAIL'}`);
    for (const k of ['rpm', 'feed', 'plunge', 'maxDepth', 'cutLen', 'plunges', 'minutes'])
      L.push(`    ${k.padEnd(9)} A ${f(t.A && t.A[k]).padStart(10)}   B ${f(t.B && t.B[k]).padStart(10)}`);
    L.push(`    depths    A ${t.A ? t.A.depths.join(',') : '-'}   B ${t.B ? t.B.depths.join(',') : '-'}`);
    const c = (n, s) => s ? `    ${n}  max ${s.max === Infinity ? '>0.5' : s.max.toFixed(4)}  p99.5 ${s.p995 === Infinity ? '>0.5' : s.p995.toFixed(4)}  over-tol ${s.over}/${s.n}${s.worst && s.max > r.tol ? '  worst @ ' + JSON.stringify(s.worst) : ''}` : `    ${n}  (tool missing on one side)`;
    L.push(c('A⊆B', t.AinB)); L.push(c('B⊆A', t.BinA));
    const mt = (n, s) => s && s.material ? `    ${n} material (R ${t.R}): ${s.material.real ? s.material.real + ' points change the part, worst gap ' + s.material.worstGap.toFixed(4) + ' @ ' + JSON.stringify(s.material.worst) : 'same part'}` : null;
    if (t.R != null) { L.push(mt('A⊆B', t.AinB)); L.push(mt('B⊆A', t.BinA)); } else L.push('    (no tool radius for T' + t.tool + ' — path-level check only)');
  }
  return L.join('\n');
}

if (require.main === module) {
  const a = process.argv.slice(2), pos = [], o = {}; let json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--json') json = true;
    else if (a[i] === '--tools') o.tools = JSON.parse(fs.readFileSync(a[++i], 'utf8'));
    else if (a[i] === '--tol') o.tol = +a[++i]; else if (a[i] === '--ztol') o.ztol = +a[++i];
    else if (a[i].startsWith('--')) { console.error('unknown flag ' + a[i]); process.exit(2); }
    else pos.push(a[i]);
  }
  if (pos.length !== 2) { console.error('usage: tapcompare.js vectric.tap ours.tap [--tol 0.005] [--ztol 0.005] [--json]'); process.exit(2); }
  if (!o.tools) { const d = path.join(__dirname, 'shoptools.json'); if (fs.existsSync(d)) o.tools = JSON.parse(fs.readFileSync(d, 'utf8')); }
  const r = compare(fs.readFileSync(pos[0], 'utf8'), fs.readFileSync(pos[1], 'utf8'), o);
  console.log(json ? JSON.stringify(r, (k, v) => v === Infinity ? 'inf' : v, 1) : fmt(r, path.basename(pos[0]), path.basename(pos[1])));
  process.exit(r.pass ? 0 : 1);
}
module.exports = { parseTap, summarize, compare, fmt };
