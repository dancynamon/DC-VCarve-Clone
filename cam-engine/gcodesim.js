/* gcodesim.js — a posted program as a timed list of moves, for the 3D View's playback and live carving.
 * Pure (no DOM): parseGcode -> program, timeline -> per-move start times, Carver -> material removal up to
 * any point in the program, forwards or backwards. Unit-tested headless (gcsimtest.js).
 *
 * The same parser reads a .tap opened from disk and the program the studio posts from its own toolpath
 * list, so what plays in the 3D View is exactly what the controller would receive.
 *
 * Program moves live in typed arrays (a sheet job runs to hundreds of thousands of moves):
 *   x0 y0 z0 x1 y1 z1   end points (arcs are split into short chords sharing one source line)
 *   kind   0 rapid (G0) · 1 plunge (G1 straight down) · 2 cut (any other G1/G2/G3)
 *   tool   T number in effect · feed  F in effect (in/min) · rpm  S while the spindle runs, else 0
 *   line   1-based source line
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.GCSIM = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const RAPID = 0, PLUNGE = 1, CUT = 2;
const ARC_CHORD = 0.02;       // in — arc chord length when splitting G2/G3 for playback and carving

// One source line as words, with comments understood the way WinCNC reads them: [ ... ] and ( ... ) are comments, and
// so is anything after ';'. Returns {words:[{L,v,ls,vs,ve}], bare:[letters with no number], junk:text|null, unclosed}.
// ls/vs/ve are the offsets of the letter and of the number in the raw line, so an editor can replace just the number.
// Junk (a stray number, 'F80.0.0') is reported and never guessed at: the caller decides what to do with that line.
const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)/y;
function tokenizeLine(raw) {
  const words = [], bare = []; let junk = null, unclosed = false, i = 0;
  const n = raw.length;
  const skip = c => c === ' ' || c === '\t' || c === '\f' || c === '\x1a';
  if (raw.trim()[0] === '%') return { words, bare, junk: null, unclosed: false };
  while (i < n) {
    const c = raw[i];
    if (skip(c)) { i++; continue; }
    if (c === '[' || c === '(') {
      const e = raw.indexOf(c === '[' ? ']' : ')', i);
      if (e < 0) { unclosed = true; i = n; } else i = e + 1;
      continue;
    }
    if (c === ';') break;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      let j = i + 1;
      while (j < n && skip(raw[j])) j++;
      NUM_RE.lastIndex = j;
      const m = NUM_RE.exec(raw);
      if (m) {
        const ve = j + m[0].length;
        if (raw[ve] === '.') { if (junk == null) junk = raw.slice(i, i + 24); i = ve + 1; continue; }    // 'F80.0.0': two decimal points
        words.push({ L: c.toUpperCase(), v: +m[0], ls: i, vs: j, ve: ve });
        i = ve; continue;
      }
      bare.push(c.toUpperCase()); i++; continue;
    }
    if (junk == null) junk = raw.slice(i, i + 24);
    i++;
  }
  return { words, bare, junk, unclosed };
}
// G codes that change nothing the simulator models; any other unknown G is reported.
const G_HARMLESS = new Set([17, 40, 49, 54, 64, 80, 94]);
const ISSUE_CAP = 200, WARN_CAP = 50;

// opts.aToY: inches of Y per degree of A, for a rotary program (A axis = the unwrapped Y).
function parseGcode(text, opts) {
  const aToY = opts && opts.aToY > 0 ? opts.aToY : 0;
  const src = String(text || '').split(/\r\n|\n|\r/);
  const out = { x0: [], y0: [], z0: [], x1: [], y1: [], z1: [], kind: [], tool: [], feed: [], rpm: [], line: [], pause: [] };
  let x = 0, y = 0, z = null, mode = 0, f = 0, s = 0, t = 0, spin = false, abs = true, dwell = 0, pending = 0, firstZ = null, unit = 1, metric = false;
  const tools = [], warnings = [], issues = [], issueCounts = {};
  // issues: what the simulator could not take at face value. Each names its line; level 'loss' means the backplot
  // is not what the machine would do on that line, so the file is not safe to edit or trust without looking.
  const issue = (code, level, ln, msg, raw) => {
    issueCounts[code] = (issueCounts[code] || 0) + 1;
    if (issues.length < ISSUE_CAP) issues.push({ code, level, line: ln, msg, raw: raw === undefined ? undefined : String(raw).slice(0, 80) });
    if (warnings.length < WARN_CAP) warnings.push(msg);
  };
  const push = (ax, ay, az, bx, by, bz, k, ln) => {
    out.x0.push(ax); out.y0.push(ay); out.z0.push(az); out.x1.push(bx); out.y1.push(by); out.z1.push(bz);
    out.kind.push(k); out.tool.push(t); out.feed.push(f); out.rpm.push(spin ? s : 0); out.line.push(ln); out.pause.push(pending); pending = 0;
  };
  for (let n = 0; n < src.length; n++) {
    const raw = src[n], ln = n + 1;
    if (!raw.trim()) continue;
    const tk = tokenizeLine(raw);
    if (tk.unclosed) issue('UNCLOSED_COMMENT', 'warn', ln, 'Line ' + ln + ': a comment bracket is never closed; the rest of the line was treated as a comment', raw);
    const w = {}, G = [], M = [];
    for (const k of tk.words) { if (k.L === 'G') G.push(k.v); else if (k.L === 'M') M.push(k.v); else w[k.L] = k.v; }
    const isG53 = G.indexOf(53) >= 0;
    const badBare = tk.bare.filter(b => !(isG53 && 'XYZ'.indexOf(b) >= 0));
    if (tk.junk != null || badBare.length) { issue('JUNK_TEXT', 'loss', ln, 'Line ' + ln + ' could not be read and was not simulated: "' + raw.trim().slice(0, 60) + '"', raw); continue; }
    if (!tk.words.length && !tk.bare.length) continue;   // a comment line
    if (G.indexOf(4) >= 0) { const d = (w.X != null ? w.X : (w.P != null ? w.P : 0)); dwell += d; pending += d; continue; }   // WinCNC 'G4 X<sec>'
    if (isG53) { issue('G53', 'warn', ln, 'Line ' + ln + ': G53 machine-coordinate move is not simulated (the backplot holds position there)', raw); continue; }
    if (w.L != null) issue('WORD_L', 'warn', ln, 'Line ' + ln + ': WinCNC L word (L' + w.L + ') is not simulated', raw);
    if (G.indexOf(21) >= 0) { unit = 1 / 25.4; metric = true; }   // millimetres: everything here runs in inches
    if (G.indexOf(20) >= 0) unit = 1;
    // rotary: A degrees are the unwrapped Y; a bare Y word is the machine's own Y (e.g. the park move), not the part
    if (aToY) { if (w.A != null) w.Y = w.A * aToY / unit; else delete w.Y; }
    for (const c of 'XYZIJFR') if (w[c] != null) w[c] *= unit;
    if (G.indexOf(90) >= 0) abs = true;
    if (G.indexOf(91) >= 0) { abs = false; issue('G91', 'warn', ln, 'G91 incremental moves at line ' + ln, raw); }
    for (const g of G) if (g !== 0 && g !== 1 && g !== 2 && g !== 3 && g !== 20 && g !== 21 && g !== 90 && g !== 91 && !G_HARMLESS.has(g)) issue('G' + g, 'loss', ln, 'Line ' + ln + ': G' + g + ' is not simulated; the backplot may not match the machine after this line', raw);
    if (w.T != null) { t = Math.round(w.T); if (tools.indexOf(t) < 0) tools.push(t); }
    if (w.S != null) s = w.S;
    if (M.indexOf(3) >= 0 || M.indexOf(4) >= 0) spin = true;
    if (M.indexOf(5) >= 0) spin = false;
    if (w.F != null) f = w.F;
    for (const g of G) if (g === 0 || g === 1 || g === 2 || g === 3) mode = g;
    const isArc = mode === 2 || mode === 3;
    const hasCentre = w.I != null || w.J != null || w.R != null;
    const fullCircle = isArc && w.X == null && w.Y == null && w.Z == null && (w.I != null || w.J != null);   // WinCNC 'G2 I2': a whole circle from where it stands
    if (w.X == null && w.Y == null && w.Z == null && !fullCircle) continue;
    const nx = w.X != null ? (abs ? w.X : x + w.X) : x;
    const ny = w.Y != null ? (abs ? w.Y : y + w.Y) : y;
    const nz = w.Z != null ? (abs ? w.Z : (z || 0) + w.Z) : (z == null ? 0 : z);
    if (z == null) { z = nz; firstZ = nz; if (w.X == null && w.Y == null && !fullCircle) continue; }
    if (isArc && !hasCentre) {
      issue('ARC_WITHOUT_CENTER', 'loss', ln, 'Line ' + ln + ': G' + mode + ' arc has no I, J or R; drawn as a straight line, but the controller may do something else', raw);
    }
    let cx = null, cy = null, r = 0;
    if (isArc && (w.I != null || w.J != null)) {
      cx = x + (w.I || 0); cy = y + (w.J || 0); r = Math.hypot(x - cx, y - cy);
      if (Math.abs(r - Math.hypot(nx - cx, ny - cy)) > 0.002)
        issue('ARC_RADIUS_MISMATCH', 'warn', ln, 'Line ' + ln + ': arc end point is ' + Math.abs(r - Math.hypot(nx - cx, ny - cy)).toFixed(4) + '" off the circle its I/J describe', raw);
    } else if (isArc && w.R != null) {
      const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy), R = Math.abs(w.R);
      if (d < 1e-9 || d > 2 * R + 1e-6) issue('ARC_R_IMPOSSIBLE', 'loss', ln, 'Line ' + ln + ': R arc cannot reach its end point; drawn as a straight line', raw);
      else { // R>0 = the short way round; G2 centre sits to the right of the chord, G3 to the left, flipped for R<0
        const h = Math.sqrt(Math.max(0, R * R - d * d / 4)), side = (mode === 3 ? 1 : -1) * (w.R > 0 ? 1 : -1);
        cx = (x + nx) / 2 - side * h * dy / d; cy = (y + ny) / 2 + side * h * dx / d; r = R;
      }
    }
    if (cx != null) {
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
      if (mode === 2) { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
      if (Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) a1 = a0 + (mode === 2 ? -2 : 2) * Math.PI;   // full circle
      const k = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / ARC_CHORD));
      let px = x, py = y, pz = z;
      for (let i = 1; i <= k; i++) {
        const a = a0 + (a1 - a0) * i / k, qx = i === k ? nx : cx + r * Math.cos(a), qy = i === k ? ny : cy + r * Math.sin(a), qz = z + (nz - z) * i / k;
        push(px, py, pz, qx, qy, qz, CUT, ln); px = qx; py = qy; pz = qz;
      }
    } else {
      const kind = mode === 0 ? RAPID : (nz < z - 1e-9 && Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9 ? PLUNGE : CUT);
      if (nx !== x || ny !== y || nz !== z) push(x, y, z, nx, ny, nz, kind, ln);
    }
    x = nx; y = ny; z = nz;
  }
  if (!out.kind.length && !issues.some(i => i.level === 'loss')) issue('NO_MOTION', 'loss', 1, 'The program contains no moves', '');
  const N = out.kind.length, F = a => Float64Array.from(a);
  const prog = { n: N, x0: F(out.x0), y0: F(out.y0), z0: F(out.z0), x1: F(out.x1), y1: F(out.y1), z1: F(out.z1),
    kind: Uint8Array.from(out.kind), tool: Int32Array.from(out.tool), feed: Float32Array.from(out.feed), rpm: Float32Array.from(out.rpm),
    line: Int32Array.from(out.line), pause: Float32Array.from(out.pause), tools: tools, dwell: dwell, metric: metric, src: src, warnings: warnings, issues: issues, issueCounts: issueCounts, firstZ: firstZ };
  prog.bounds = boundsOf(prog);
  return prog;
}

function boundsOf(p) {
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity, cutX0: Infinity, cutY0: Infinity, cutX1: -Infinity, cutY1: -Infinity };
  for (let i = 0; i < p.n; i++) {
    const xs = [p.x0[i], p.x1[i]], ys = [p.y0[i], p.y1[i]], zs = [p.z0[i], p.z1[i]];
    for (let k = 0; k < 2; k++) {
      if (xs[k] < b.x0) b.x0 = xs[k]; if (xs[k] > b.x1) b.x1 = xs[k];
      if (ys[k] < b.y0) b.y0 = ys[k]; if (ys[k] > b.y1) b.y1 = ys[k];
      if (zs[k] < b.z0) b.z0 = zs[k]; if (zs[k] > b.z1) b.z1 = zs[k];
      if (zs[k] < 0) { if (xs[k] < b.cutX0) b.cutX0 = xs[k]; if (xs[k] > b.cutX1) b.cutX1 = xs[k]; if (ys[k] < b.cutY0) b.cutY0 = ys[k]; if (ys[k] > b.cutY1) b.cutY1 = ys[k]; }
    }
  }
  return b;
}

// Per-move start times (minutes): rapids at `rapid`, everything else at its own F (falling back to rapid when F is 0).
// Dwells (G4 spindle warm-up, one per tool change on WinCNC) pause the clock before the move that follows them.
function timeline(p, rapid) {
  rapid = rapid || 300;
  const t0 = new Float64Array(p.n + 1), len = new Float64Array(p.n);
  let t = 0, cut = 0, rap = 0, plunge = 0, cutT = 0;
  for (let i = 0; i < p.n; i++) {
    const L = Math.hypot(p.x1[i] - p.x0[i], p.y1[i] - p.y0[i], p.z1[i] - p.z0[i]); len[i] = L;
    const rate = p.kind[i] === RAPID ? rapid : (p.feed[i] > 0 ? p.feed[i] : rapid);
    t += (p.pause[i] || 0) / 60; t0[i] = t; t += L / rate;
    if (p.kind[i] === RAPID) rap += L; else { cutT += L / rate; if (p.kind[i] === PLUNGE) plunge += L; else cut += L; }
  }
  t0[p.n] = t;
  return { t0: t0, len: len, total: t, cutLen: cut, rapidLen: rap, plungeLen: plunge, cutMinutes: cutT };
}

// The move running at time T (minutes) and how far through it: {i, u}. i = n means the program has finished.
function locate(tl, n, T) {
  if (!(n > 0) || T >= tl.total) return { i: n, u: 1 };
  if (T <= tl.t0[0]) return { i: 0, u: 0 };
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tl.t0[mid] <= T) lo = mid; else hi = mid - 1; }
  const dt = tl.t0[lo + 1] - tl.t0[lo];
  return { i: lo, u: dt > 0 ? Math.min(1, (T - tl.t0[lo]) / dt) : 1 };
}
function pointAt(p, i, u) {
  if (!p.n) return [0, 0, p.firstZ || 0];
  if (i >= p.n) { const k = p.n - 1; return [p.x1[k], p.y1[k], p.z1[k]]; }
  return [p.x0[i] + (p.x1[i] - p.x0[i]) * u, p.y0[i] + (p.y1[i] - p.y0[i]) * u, p.z0[i] + (p.z1[i] - p.z0[i]) * u];
}

// Material removal up to a point in the program. `cam` supplies stockField / simKernel / carveSegment (camcore);
// `toolFor(T)` -> {type:'flat'|'ball'|'v', radius, angle}. Moving forwards carves only the new stretch; moving
// backwards re-carves from an empty block. `dirty` is the cell box touched since the caller last cleared it.
// stock.floors (optional, two-sided jobs): per-cell depth at which this side meets the other side's cuts; cells
// the other side has already cut through start open.
function Carver(cam, p, stock, toolFor) {
  this.cam = cam; this.p = p; this.toolFor = toolFor;
  this.field = cam.stockField(stock);
  if (stock.floors && stock.floors.length === this.field.z.length) {
    const f = this.field; f.floors = stock.floors; this.base = new Float32Array(f.z.length);
    for (let k = 0; k < f.z.length; k++) this.base[k] = f.floors[k] >= -1e-9 ? f.floor : 0;
    f.z.set(this.base);
  }
  this.kernels = {};
  this.at = { i: 0, u: 0 };
  this.dirty = null;
}
Carver.prototype.kernel = function (t) {
  let k = this.kernels[t]; if (!k) k = this.kernels[t] = this.cam.simKernel(this.toolFor(t), this.field.res);
  return k;
};
Carver.prototype.reset = function () {
  if (this.base) this.field.z.set(this.base); else this.field.z.fill(0); this.at = { i: 0, u: 0 }; this.dirty = { i0: 0, j0: 0, i1: this.field.nx - 1, j1: this.field.ny - 1 };
};
Carver.prototype._mark = function (ax, ay, bx, by, r) {
  const f = this.field, res = f.res;
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - f.x0) / res) - 1), i1 = Math.min(f.nx - 1, Math.floor((Math.max(ax, bx) + r - f.x0) / res) + 1);
  const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - f.y0) / res) - 1), j1 = Math.min(f.ny - 1, Math.floor((Math.max(ay, by) + r - f.y0) / res) + 1);
  if (i0 > i1 || j0 > j1) return;
  const d = this.dirty;
  if (!d) this.dirty = { i0: i0, j0: j0, i1: i1, j1: j1 };
  else { if (i0 < d.i0) d.i0 = i0; if (j0 < d.j0) d.j0 = j0; if (i1 > d.i1) d.i1 = i1; if (j1 > d.j1) d.j1 = j1; }
};
Carver.prototype._carve = function (i, ua, ub) {
  const p = this.p; if (p.kind[i] === RAPID && p.z0[i] >= 0 && p.z1[i] >= 0) return;
  const ax = p.x0[i] + (p.x1[i] - p.x0[i]) * ua, ay = p.y0[i] + (p.y1[i] - p.y0[i]) * ua, az = p.z0[i] + (p.z1[i] - p.z0[i]) * ua;
  const bx = p.x0[i] + (p.x1[i] - p.x0[i]) * ub, by = p.y0[i] + (p.y1[i] - p.y0[i]) * ub, bz = p.z0[i] + (p.z1[i] - p.z0[i]) * ub;
  const k = this.kernel(p.tool[i]);
  if (this.cam.carveSegment(this.field, k, ax, ay, az, bx, by, bz)) this._mark(ax, ay, bx, by, (k.rad + 1) * this.field.res);
};
// Carve so the block shows every move before move i, plus fraction u of move i.
Carver.prototype.seek = function (i, u) {
  const n = this.p.n; if (i >= n) { i = n; u = 0; }
  const a = this.at;
  if (i < a.i || (i === a.i && u < a.u)) this.reset();
  const b = this.at;
  if (i === b.i) { if (u > b.u) this._carve(i, b.u, u); }
  else {
    if (b.i < n) this._carve(b.i, b.u, 1);
    for (let k = b.i + 1; k < i; k++) this._carve(k, 0, 1);
    if (i < n && u > 0) this._carve(i, 0, u);
  }
  this.at = { i: i, u: u };
};
Carver.prototype.takeDirty = function () { const d = this.dirty; this.dirty = null; return d; };

// Two-sided jobs: turn the other side's finished field into this side's floors. The sides share one job
// rectangle; flipping mirrors it left-right ('h') or top-bottom ('v'). A cell the other side cut d deep can
// be cut (thickness - d) deep from this side before it opens.
function floorsFromOtherSide(other, flip) {
  const nx = other.nx, ny = other.ny, T = -other.floor, out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const oi = flip === 'v' ? i : nx - 1 - i, oj = flip === 'v' ? ny - 1 - j : j;
    const d = -other.z[oj * nx + oi];
    out[j * nx + i] = -(T - d);
  }
  return out;
}

// Default tool for a T number in an imported program: the tool-library preset with that number, else a 1/4" flat.
function toolForNumber(lib, t, overrides) {
  const o = overrides && overrides[t];
  if (o) return { type: o.type || 'flat', radius: (o.dia || 0.25) / 2, angle: o.angle || 90 };
  const pre = (lib || []).find(x => x.toolNum === t);
  if (pre) return { type: pre.op === 'vcarve' ? 'v' : 'flat', radius: (pre.dia || 0.25) / 2, angle: pre.angle || 90 };
  return { type: 'flat', radius: 0.125, angle: 90 };
}

return { RAPID: RAPID, PLUNGE: PLUNGE, CUT: CUT, parseGcode: parseGcode, tokenizeLine: tokenizeLine, boundsOf: boundsOf, timeline: timeline, locate: locate, pointAt: pointAt,
  Carver: Carver, toolForNumber: toolForNumber, floorsFromOtherSide: floorsFromOtherSide };
});
