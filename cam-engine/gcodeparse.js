/* gcodeparse.js - modal G-code interpreter (pure, no DOM). Node + browser.
   Turns real controller G-code (Vectric, ShopSabre/WinCNC, generic ISO) into an
   absolute, format-independent move list, so two programs written in different
   dialects can be compared on what the spindle actually does. Handles modal
   motion/feed, G90/G91, G20/G21 unit normalization (everything comes out in
   INCHES), comments, line numbers, lowercase words, and I/J or R arcs. */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.GParse = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// letter + number, tolerating whitespace between them (ShopSabre posts `g4 x 4`)
const WORD = /([A-Za-z])\s*([-+]?(?:[0-9]*\.)?[0-9]+)/g;
const MOTION = { 0: 'rapid', 1: 'line', 2: 'arc', 3: 'arc' };
// non-motion G-codes we recognize; seeing one must NOT trigger a move
const SETTING = new Set([4,17,18,19,20,21,28,30,40,41,42,43,49,53,54,55,56,57,58,59,61,64,80,90,91,92,93,94,98,99]);

function stripComments(line) {
  const s = line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
  return /^\s*%\s*$/.test(s) ? '' : s;   // % program delimiter carries no motion
}

function words(line) {
  const out = [];
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(line))) out.push({ l: m[1].toUpperCase(), v: parseFloat(m[2]) });
  return out;
}

/* parse(text, opts) -> {units, moves, events, warnings}
   moves: {seq,type:'rapid'|'line'|'arc', x,y,z, cx,cy,cw, feed, tool, line}
          x/y/z are ABSOLUTE INCHES at the END of the move; cx/cy is the arc
          center (absolute inches); every move carries the modal feed in effect. */
function parse(text, opts) {
  opts = opts || {};
  const moves = [], events = [], warnings = [];
  // start position: unknown until first commanded, treated as 0 (controllers home first)
  let x = 0, y = 0, z = 0;
  let mode = null, feed = null, abs = true, k = 1, tool = null, rpm = null, seq = 0;
  let sawUnits = false;

  const lines = String(text).split(/\r\n|\r|\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const src = lines[ln];
    const clean = stripComments(src);
    if (!clean.trim()) continue;
    const ws = words(clean);
    if (!ws.length) continue;

    const gs = ws.filter(w => w.l === 'G').map(w => Math.round(w.v));
    const ms = ws.filter(w => w.l === 'M').map(w => Math.round(w.v));
    const ax = {};
    for (const w of ws) if ('XYZIJRF'.includes(w.l)) ax[w.l] = w.v;   // last wins
    const hasN = ws.some(w => w.l === 'N');   // line numbers: recognized, ignored
    if (hasN) { /* no-op: N words are addressing, not motion */ }

    // ---- settings that change how later words are interpreted ----
    for (const g of gs) {
      if (g === 20) { k = 1; sawUnits = true; }
      else if (g === 21) { k = 25.4; sawUnits = true; }   // mm -> divide by 25.4 below
      else if (g === 90) abs = true;
      else if (g === 91) abs = false;
      else if (!SETTING.has(g) && MOTION[g] === undefined) warnings.push(`line ${ln + 1}: unrecognized G${g}`);
    }
    const s = 1 / k;   // scale factor from file units to inches

    // ---- M words / tool / spindle ----
    for (const w of ws) if (w.l === 'T') tool = Math.round(w.v);
    for (const w of ws) if (w.l === 'S') rpm = w.v;
    for (const m of ms) {
      if (m === 6) events.push({ type: 'toolchange', tool, line: ln + 1 });
      else if (m === 3 || m === 4) events.push({ type: 'spindle', on: true, rpm, cw: m === 3, line: ln + 1 });
      else if (m === 5) events.push({ type: 'spindle', on: false, line: ln + 1 });
      else if (m === 2 || m === 30) events.push({ type: 'end', line: ln + 1 });
    }
    // a bare T with no M6 is an ATC tool change (ShopSabre posts `T9` alone)
    if (ws.some(w => w.l === 'T') && !ms.includes(6)) events.push({ type: 'toolchange', tool, line: ln + 1 });

    // ---- dwell: G4's X/P is a TIME, never an axis. Must not be read as a move. ----
    if (gs.includes(4)) {
      events.push({ type: 'dwell', sec: ax.X != null ? ax.X : (ws.find(w => w.l === 'P') || {}).v, line: ln + 1 });
      continue;
    }
    if (gs.includes(28) || gs.includes(30)) { events.push({ type: 'home', line: ln + 1 }); continue; }

    if (ax.F != null) feed = ax.F * s;   // modal feed, normalized to inch/min

    // ---- resolve motion mode: an explicit G0-3 sets it, otherwise it is modal ----
    let mg = null;
    for (const g of gs) if (MOTION[g] !== undefined) mg = g;
    if (mg !== null) mode = mg;
    const hasAxis = ax.X != null || ax.Y != null || ax.Z != null;
    if (!hasAxis) continue;              // e.g. a lone `S18000` or `M3` line
    if (mode === null) {
      // axis words before any motion word (ShopSabre header emits a bare `Z2`)
      mode = 0;
      warnings.push(`line ${ln + 1}: axis move with no motion mode; assuming G0`);
    }

    const nx = ax.X != null ? (abs ? ax.X * s : x + ax.X * s) : x;
    const ny = ax.Y != null ? (abs ? ax.Y * s : y + ax.Y * s) : y;
    const nz = ax.Z != null ? (abs ? ax.Z * s : z + ax.Z * s) : z;

    if (mode === 2 || mode === 3) {
      let cx, cy;
      if (ax.I != null || ax.J != null) {          // I/J are center offsets from the arc START
        cx = x + (ax.I || 0) * s; cy = y + (ax.J || 0) * s;
      } else if (ax.R != null) {                   // R form: pick the center on the correct side
        const r = ax.R * s, dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
        const h2 = r * r - (d / 2) * (d / 2);
        const h = Math.sqrt(Math.max(0, h2));
        const mx = (x + nx) / 2, my = (y + ny) / 2;
        // R>0 = minor arc, R<0 = major arc; sign flips which side the center sits on
        const sgn = (mode === 2 ? -1 : 1) * (r < 0 ? -1 : 1);
        cx = mx + sgn * h * (-dy / (d || 1)); cy = my + sgn * h * (dx / (d || 1));
      } else {
        warnings.push(`line ${ln + 1}: arc with no I/J/R; treated as a line`);
        moves.push({ seq: seq++, type: 'line', x: nx, y: ny, z: nz, feed, tool, line: ln + 1 });
        x = nx; y = ny; z = nz; continue;
      }
      moves.push({ seq: seq++, type: 'arc', x: nx, y: ny, z: nz, cx, cy, cw: mode === 2, feed, tool, line: ln + 1 });
    } else {
      moves.push({ seq: seq++, type: MOTION[mode], x: nx, y: ny, z: nz, feed, tool, line: ln + 1 });
    }
    x = nx; y = ny; z = nz;
  }

  if (!sawUnits && opts.assumeUnits === 'mm') warnings.push('no G20/G21 in file; assumed inches');
  return { units: 'inch', moves, events, warnings };
}

return { parse, stripComments, words };
});
