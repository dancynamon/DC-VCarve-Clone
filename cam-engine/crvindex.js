#!/usr/bin/env node
// crvindex.js — geometry signatures for every .crv/.crv3d under a folder, so a .tap can find the CRV
// that made it even when it is not in the same folder (or the CRV was renamed / saved elsewhere).
//   node cam-engine/crvindex.js <root> --out CAD/crv-index.json [--budget 140]    (resumable)
// Signature per file: every vector's bbox centre + size (closed and open), rounded to 0.001".
const fs = require('fs'), path = require('path');
const { crvIndex } = require('./repost.js');

function* walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) { if (e.name.startsWith('.')) continue; const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p); else if (/\.crv(3d)?$/i.test(e.name)) yield p; }
}
function signature(ix) {
  const v = [];
  for (const L of Object.keys(ix)) for (const c of ix[L]) {
    let b = [1e9, 1e9, -1e9, -1e9]; for (const p of c.pts) { b[0] = Math.min(b[0], p.x); b[1] = Math.min(b[1], p.y); b[2] = Math.max(b[2], p.x); b[3] = Math.max(b[3], p.y); }
    v.push([+((b[0] + b[2]) / 2).toFixed(3), +((b[1] + b[3]) / 2).toFixed(3), +(b[2] - b[0]).toFixed(3), +(b[3] - b[1]).toFixed(3)]);
  }
  return v;
}
// score how well a CRV signature explains a tap's pass bboxes: fraction of passes whose bbox centre sits on a
// vector's centre with a size within 2" (tool offset either side), plus a penalty for size mismatch
function scoreSig(sig, passBoxes) {
  if (!sig || !sig.length || !passBoxes.length) return 0;
  const grid = new Map(), k = (x, y) => Math.round(x) + ',' + Math.round(y);
  for (const s of sig) { const key = k(s[0], s[1]); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(s); }
  let hit = 0;
  for (const b of passBoxes) {
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, w = b[2] - b[0], h = b[3] - b[1];
    let ok = false;
    for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++) {
      for (const s of grid.get(Math.round(cx) + dx + ',' + (Math.round(cy) + dy)) || [])
        if (Math.abs(s[0] - cx) < 0.06 && Math.abs(s[1] - cy) < 0.06 && Math.abs(s[2] - w) < 2.01 && Math.abs(s[3] - h) < 2.01) { ok = true; break; }
    }
    if (ok) hit++;
  }
  return hit / passBoxes.length;
}

if (require.main === module) {
  const av = process.argv.slice(2); let root = null, out = null, budget = 0;
  for (let i = 0; i < av.length; i++) { if (av[i] === '--out') out = av[++i]; else if (av[i] === '--budget') budget = +av[++i]; else root = av[i]; }
  if (!root || !out) { console.error('usage: crvindex.js <root> --out index.json [--budget s]'); process.exit(2); }
  const idx = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { root, files: {} };
  const t0 = Date.now(); let n = 0, left = 0;
  for (const f of walk(root)) {
    const rel = path.relative(root, f); let st; try { st = fs.statSync(f); } catch (e) { continue; }
    const have = idx.files[rel]; if (have && have.mtime === st.mtimeMs) continue;
    if (budget && Date.now() - t0 > budget * 1000) { left++; continue; }
    try { idx.files[rel] = { mtime: st.mtimeMs, sig: signature(crvIndex(fs.readFileSync(f))) }; }
    catch (e) { idx.files[rel] = { mtime: st.mtimeMs, err: e.message.slice(0, 200) }; }
    n++;
    if (n % 50 === 0) fs.writeFileSync(out, JSON.stringify(idx));
  }
  fs.writeFileSync(out, JSON.stringify(idx));
  console.log(`${left ? 'UNFINISHED' : 'DONE'} indexed ${n} this run, ${Object.keys(idx.files).length} total, ${left} left`);
}
module.exports = { signature, scoreSig };
