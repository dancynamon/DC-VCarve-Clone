/* parity.js - semantic comparison of two G-code programs (pure, no DOM).
   Answers "do these two programs cut the same part the same way?" while ignoring
   dialect: modal vs explicit words, comments, line numbers, inch vs mm, CRLF,
   word order, decimal padding. Consumes gcodeparse.parse() output.

   The unit of comparison is a PASS: a run of contiguous cutting moves bounded by
   rapids. That maps 1:1 onto "the tool went down, cut something, came up", which
   is what a machinist actually compares between two programs. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.Parity = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const DEF = { xyTol: 0.001, zTol: 0.001, feedTol: 0.05, lenTol: 0.005 };  // inches / rel. fraction

function arcLen(m, from) {
  const r = Math.hypot(from.x - m.cx, from.y - m.cy);
  let a0 = Math.atan2(from.y - m.cy, from.x - m.cx), a1 = Math.atan2(m.y - m.cy, m.x - m.cx);
  let d = m.cw ? a0 - a1 : a1 - a0;
  while (d <= 1e-9) d += Math.PI * 2;
  return r * d;
}
function moveLen(m, from) {
  return m.type === 'arc' ? arcLen(m, from) : Math.hypot(m.x - from.x, m.y - from.y);
}

/* normalize(parsed) -> comparable facts about the program */
function normalize(parsed) {
  const passes = [];
  let cur = null, pos = { x: 0, y: 0, z: 0 };
  let cutLength = 0;
  const feeds = new Set();

  for (const m of parsed.moves) {
    if (m.type === 'rapid') {
      if (cur) { passes.push(cur); cur = null; }        // retract closes the pass
    } else {
      if (!cur) cur = { start: { x: pos.x, y: pos.y }, entryZ: pos.z, moves: [], arcs: [], minZ: Infinity, maxZ: -Infinity, len: 0, lifts: 0 };
      const L = moveLen(m, pos);
      cur.len += L; cutLength += L;
      cur.moves.push(m);
      if (m.type === 'arc') cur.arcs.push(m.cw ? 'cw' : 'ccw');
      if (m.z < cur.minZ) cur.minZ = m.z;
      if (m.z > cur.maxZ) cur.maxZ = m.z;
      // a Z rise mid-pass without a retract is a holding tab (or a bridge)
      if (m.z > pos.z + 1e-9 && cur.moves.length > 1) cur.lifts++;
      if (m.feed != null) feeds.add(Math.round(m.feed * 100) / 100);
    }
    pos = { x: m.x, y: m.y, z: m.z };
  }
  if (cur) passes.push(cur);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of passes) for (const m of p.moves) {
    if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y;
  }
  const depths = [];
  for (const p of passes) if (isFinite(p.minZ)) depths.push(Math.round(p.minZ * 1e4) / 1e4);

  return {
    passes,
    passCount: passes.length,
    envelope: passes.length ? { minX, maxX, minY, maxY } : null,
    depths: depths.slice().sort((a, b) => a - b),
    feeds: Array.from(feeds).sort((a, b) => a - b),
    cutLength,
    toolChanges: parsed.events.filter(e => e.type === 'toolchange').length,
    tabLifts: passes.reduce((s, p) => s + p.lifts, 0),
  };
}

const f4 = n => (n == null || !isFinite(n) ? String(n) : n.toFixed(4));

/* compare(aText, bText, parseFn, opts) -> {equivalent, checks:[{name,ok,detail}]}
   `a` is the reference (Vectric), `b` is ours. */
function compare(a, b, opts) {
  const t = Object.assign({}, DEF, opts || {});
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? '' : detail });

  add('pass count', a.passCount === b.passCount, `ref ${a.passCount} vs ours ${b.passCount}`);

  if (a.envelope && b.envelope) {
    const keys = ['minX', 'maxX', 'minY', 'maxY'];
    const bad = keys.filter(k => Math.abs(a.envelope[k] - b.envelope[k]) > t.xyTol);
    add('xy envelope', !bad.length, bad.map(k => `${k} ref ${f4(a.envelope[k])} vs ours ${f4(b.envelope[k])}`).join('; '));
  } else add('xy envelope', a.envelope === b.envelope, 'one program has no cutting moves');

  // depth set: same distinct cut depths, same number of passes at each
  const dz = (u, v) => Math.abs(u - v) <= t.zTol;
  const dDiff = a.depths.length !== b.depths.length || a.depths.some((v, i) => !dz(v, b.depths[i]));
  add('cut depths', !dDiff, `ref [${a.depths.map(f4)}] vs ours [${b.depths.map(f4)}]`);

  // cut ORDER: the sequence of pass entry points, in program order
  const n = Math.min(a.passCount, b.passCount);
  let orderBad = -1;
  for (let i = 0; i < n; i++) {
    const pa = a.passes[i].start, pb = b.passes[i].start;
    if (Math.abs(pa.x - pb.x) > t.xyTol || Math.abs(pa.y - pb.y) > t.xyTol) { orderBad = i; break; }
  }
  add('cut order', orderBad < 0, orderBad < 0 ? '' :
    `pass ${orderBad + 1} starts ref (${f4(a.passes[orderBad].start.x)},${f4(a.passes[orderBad].start.y)}) vs ours (${f4(b.passes[orderBad].start.x)},${f4(b.passes[orderBad].start.y)})`);

  // arc direction sequence per pass - catches a climb/conventional flip
  let arcBad = -1, arcDetail = '';
  for (let i = 0; i < n; i++) {
    const aa = a.passes[i].arcs, bb = b.passes[i].arcs;
    if (aa.length !== bb.length || aa.some((v, j) => v !== bb[j])) {
      arcBad = i; arcDetail = `pass ${i + 1} ref [${aa}] vs ours [${bb}]`; break;
    }
  }
  add('arc directions', arcBad < 0, arcDetail);

  // total cutting distance - a coarse catch-all for missing/extra geometry
  const rel = a.cutLength ? Math.abs(a.cutLength - b.cutLength) / a.cutLength : (b.cutLength ? 1 : 0);
  add('cut length', rel <= t.lenTol, `ref ${f4(a.cutLength)}" vs ours ${f4(b.cutLength)}" (${(rel * 100).toFixed(2)}% off)`);

  const fBad = a.feeds.length !== b.feeds.length || a.feeds.some((v, i) => Math.abs(v - b.feeds[i]) > t.feedTol);
  add('feed rates', !fBad, `ref [${a.feeds}] vs ours [${b.feeds}]`);

  add('tool changes', a.toolChanges === b.toolChanges, `ref ${a.toolChanges} vs ours ${b.toolChanges}`);
  add('tab lifts', a.tabLifts === b.tabLifts, `ref ${a.tabLifts} vs ours ${b.tabLifts}`);

  return { equivalent: checks.every(c => c.ok), checks };
}

function report(res, label) {
  const lines = [];
  lines.push(`${res.equivalent ? 'PARITY' : 'DIFF  '}  ${label}`);
  for (const c of res.checks) if (!c.ok) lines.push(`         x ${c.name}: ${c.detail}`);
  return lines.join('\n');
}

return { normalize, compare, report, DEF };
});
