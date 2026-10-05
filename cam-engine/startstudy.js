// startstudy.js — which rule picks Vectric's entry point on a closed contour? Scores candidate rules
// against the library (Vectric TAP + its CRV).
const fs = require('fs'), path = require('path'), vm = require('vm');
const { parseTap } = require('./tapcompare.js'); const { passesOf } = require('./tap2spec.js');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(__dirname, 'crvparse.js'), 'utf8') + ';this.P=parseCrv;', ctx);
const [rep, src, lim] = [JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), process.argv[3], +process.argv[4] || 100];
const nearOnSegs = (S, x, y) => { let b = [1e9]; for (const s of S) { const dx = s.x1 - s.x0, dy = s.y1 - s.y0, L = dx * dx + dy * dy; let t = L ? ((x - s.x0) * dx + (y - s.y0) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); const px = s.x0 + dx * t, py = s.y0 + dy * t, d = Math.hypot(px - x, py - y); if (d < b[0]) b = [d, px, py]; } return b; };
const nearPoly = (P, x, y) => { let b = [1e9]; for (let k = 0; k < P.length - 1; k++) { const a = P[k], c = P[k + 1], dx = c.x - a.x, dy = c.y - a.y, L = dx * dx + dy * dy; let t = L ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); const px = a.x + dx * t, py = a.y + dy * t, d = Math.hypot(px - x, py - y); if (d < b[0]) b = [d, px, py, k]; } return b; };
const sc = {}, add = (k, v) => { if (v === null) return; sc[k] = sc[k] || [0, 0]; sc[k][0] += v ? 1 : 0; sc[k][1]++; };
const samples = [];
for (const j of rep.jobs.filter(x => x.status === 'PASS').slice(0, lim)) {
  let polys, T; try { polys = ctx.P(new Uint8Array(fs.readFileSync(path.join(src, j.crv))), { tol: 0.001 }); T = parseTap(fs.readFileSync(path.join(src, j.tap), 'utf8')); } catch (e) { continue; }
  const closed = polys.filter(p => p.ent.closed);
  let prevEnd = { x: 0, y: 0 }, seen = new Set(), toolFirst = true;
  for (const t of T) { toolFirst = true;
    for (const p of passesOf(t)) {
      const cut = p.filter(s => s.z1 < -1e-6 && Math.abs(s.z0 - s.z1) < 1e-6 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 1e-9);
      if (cut.length < 3) { prevEnd = { x: p[p.length - 1].x1, y: p[p.length - 1].y1 }; continue; }
      const e = { x: cut[0].x0, y: cut[0].y0 }, last = cut[cut.length - 1], isClosed = Math.hypot(last.x1 - e.x, last.y1 - e.y) < 0.01;
      // which vector: the closed vector whose distance to the pass midpoint ~ constant (use entry + mid)
      const mid = cut[Math.floor(cut.length / 2)];
      let best = null; for (const v of closed) { const a = nearPoly(v.pts, e.x, e.y)[0], b = nearPoly(v.pts, mid.x0, mid.y0)[0]; if (Math.abs(a - b) < 0.003 && a < 1 && (!best || a < best.d)) best = { v, d: a }; }
      const key = best ? best.v.ent.guid + '|' + best.d.toFixed(3) : null;
      if (isClosed && best && !seen.has(key)) {
        seen.add(key);
        const v = best.v, r = best.d, st = v.pts[0];
        const pr = (q) => { const n = nearOnSegs(cut, q.x, q.y); return Math.hypot(n[1] - e.x, n[2] - e.y) < 0.01; };
        add('A node0 (vector start)', pr(st));
        const a2 = Math.abs(Math.hypot(e.x - st.x, e.y - st.y) - r) < 0.01; add('A2 entry at r from node0', a2); add('H A2 or prevEnd', a2 || pr(prevEnd));
        add('H by type r>0: A2', r > 0.01 ? a2 : null); add('H by type r=0: prevEnd', r <= 0.01 ? pr(prevEnd) : null);
        add('B nearest to prev end', pr(prevEnd));
        add('C nearest to origin', pr({ x: 0, y: 0 }));
        add('D node0 OR prevEnd', pr(st) || pr(prevEnd));
        add('E first of tool: origin / else prevEnd', toolFirst ? pr({ x: 0, y: 0 }) : pr(prevEnd));
        add('F first of tool: node0 / else prevEnd', toolFirst ? pr(st) : pr(prevEnd));
        // span-end nodes
        const ends = v.ent.spanEnds || []; add('G at some span end', ends.some(q => pr(q)));
        if (samples.length < 25 && !a2 && !pr(prevEnd)) samples.push({ job: j.tap.slice(-40), e, st: { x: +st.x.toFixed(4), y: +st.y.toFixed(4) }, prevEnd, toolFirst, r: +r.toFixed(4) });
        toolFirst = false;
      }
      prevEnd = { x: p[p.length - 1].x1, y: p[p.length - 1].y1 };
    } }
}
for (const [k, v] of Object.entries(sc)) console.log(k.padEnd(40), v[0] + '/' + v[1], (100 * v[0] / v[1]).toFixed(1) + '%');
console.log(JSON.stringify(samples.slice(0, 12), null, 0));
