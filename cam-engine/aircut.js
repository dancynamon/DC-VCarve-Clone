#!/usr/bin/env node
// aircut.js — turn a posted program into a dry run that cannot touch the material.
//
// Every CUTTING Z (the negative ones, below the Z0 material top) is remapped into a thin band ABOVE
// the surface. Rapid/clearance heights (positive Z) are left exactly as posted, so the machine's Z
// travel envelope is unchanged and the retract plane still sits above every move.
//
// The remap is linear and order-preserving: the deepest pass becomes the LOWEST air pass, so the
// staging is still visible as the program runs — you watch the same sequence, at the same feeds, with
// the same tool changes and dwells, a fixed height above the stock. Nothing else in the file changes.
//
//   node cam-engine/aircut.js in.tap out.tap [--clearance 0.25] [--band 0.30]
//
// clearance = how far the DEEPEST pass sits above the material top.
// band      = vertical spread from deepest to shallowest pass. 0 collapses every pass to one height.
'use strict';
const AIR_DEFAULTS = { clearance: 0.25, band: 0.30 };

function aircut(gcode, opts) {
  const o = Object.assign({}, AIR_DEFAULTS, opts || {});
  if (typeof gcode !== 'string' || !gcode.length) throw new Error('aircut: empty program');
  if (!(o.clearance > 0)) throw new Error('aircut: clearance must be greater than 0 — a dry run has to stay off the stock');
  if (o.band < 0) throw new Error('aircut: band cannot be negative');

  const Z = /Z(-?\d*\.?\d+)/g;
  const cuts = [], rapids = [];
  let m;
  while ((m = Z.exec(gcode))) { const v = parseFloat(m[1]); (v < 0 ? cuts : rapids).push(v); }
  if (!cuts.length) return { gcode, stats: { changed: 0, cutZ: [], airZ: [], retract: null, unchanged: true } };

  const lo = Math.min.apply(null, cuts), hi = Math.max.apply(null, cuts);
  // the lowest positive Z is the retract plane; every air pass must stay clear underneath it
  const retract = rapids.length ? Math.min.apply(null, rapids) : null;
  let band = o.band;
  if (retract != null) {
    const headroom = retract - o.clearance - 0.05;      // keep 0.050" under the retract plane
    if (headroom <= 0) throw new Error(
      `aircut: clearance ${o.clearance}" leaves no room under the ${retract}" retract plane — lower it`);
    if (band > headroom) band = headroom;               // squeeze rather than climb above the retract
  }
  const span = hi - lo;
  const mapZ = v => (span < 1e-9 ? o.clearance : o.clearance + band * (v - lo) / span);
  const fmt = v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4);

  let changed = 0;
  const out = gcode.replace(/Z(-?\d*\.?\d+)/g, (all, num) => {
    const v = parseFloat(num);
    if (!(v < 0)) return all;
    changed++;
    return 'Z' + fmt(mapZ(v));
  });
  const cutZ = Array.from(new Set(cuts)).sort((a, b) => a - b);
  return { gcode: out, stats: { changed, cutZ, airZ: cutZ.map(mapZ), retract, band, unchanged: false } };
}
module.exports = { aircut, AIR_DEFAULTS };

if (require.main === module) {
  const fs = require('fs');
  const av = process.argv.slice(2), pos = [], f = {};
  for (let i = 0; i < av.length; i++) {
    if (av[i].startsWith('--')) {
      const k = av[i].slice(2), v = av[i + 1];
      if (v == null || v.startsWith('--')) { console.error(`aircut: --${k} needs a number`); process.exit(2); }
      const n = Number(v); i++;
      if (!Number.isFinite(n)) { console.error(`aircut: --${k} needs a number, got "${v}"`); process.exit(2); }
      f[k] = n;
    } else pos.push(av[i]);
  }
  if (pos.length !== 2) { console.error('usage: node aircut.js <in.tap> <out.tap> [--clearance N] [--band N]'); process.exit(2); }
  if (require('path').resolve(pos[0]) === require('path').resolve(pos[1])) { console.error('aircut: refusing to overwrite the input'); process.exit(2); }
  let r;
  try { r = aircut(fs.readFileSync(pos[0], 'utf8'), f); } catch (e) { console.error(e.message); process.exit(2); }
  fs.writeFileSync(pos[1], r.gcode);
  console.log(`${pos[0]} -> ${pos[1]}`);
  if (r.stats.unchanged) { console.log('  no cutting moves found — nothing to raise'); process.exit(0); }
  console.log(`  ${r.stats.changed} Z words raised; retract plane ${r.stats.retract}" left as posted`);
  r.stats.cutZ.forEach((z, i) => console.log(`    Z${z.toFixed(4)}  ->  Z${r.stats.airZ[i].toFixed(4)}`));
}
