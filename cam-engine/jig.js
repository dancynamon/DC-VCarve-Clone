/* jig.js — board-jig stock for the 3D View: instead of one block, the boards that actually sit in a fixture.
 * Pure (no DOM), unit-tested headless (jigtest.js).
 *
 * The preset is Dan's lifeguard-chair jig ("LGC 6-Board Jig"): six lanes on a 7.625" pitch, lane 1's left edge
 * at X 4.188, each board 3.5" wide. Lanes run Y 0.5 to 97.5 and a board loads against the Y 0.5 end stop.
 * Z0 is the top of a 1.5" board; boards sit on the table (Z -1.5), so a 1.125" board's top is at Z -0.375.
 *
 * A lane's load is one of
 *   empty · full (one 97" board) · ab (two 48.5" pieces, A on the stop, B butted above it) · a (piece A only)
 * and a thickness of 1.5 or 1.125. Each board or piece is its own heightfield (camcore stockField) carved by
 * its own gcodesim Carver from that board's real top, so only the material that is really there gets cut.
 *
 *   piecesFor(jig, load)              -> the boards on the table, with their machine-space rectangles and tops
 *   autoFill(jig, prog, name, toolFor)-> a load guessed from where the program cuts
 *   parseRunOrder(text, tapName)      -> thicknesses (and "lane N only") from a "README - run order.txt"
 *   applyRunOrder(load, ro)           -> the load with the README's thicknesses applied
 *   airCuts(jig, prog, load, toolFor) -> cutting moves over an empty lane or past the end of a 48.5" piece
 *   JigCarver                         -> one Carver per board, seeked together
 *   partsOf(field)                    -> connected solid regions of a carved board (cut-free parts / offcuts)
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.JIG = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const RAPID = 0;
const PRESETS = {
  lgc6: { id: 'lgc6', name: 'LGC 6-Board Jig', lanes: 6, pitch: 7.625, x0: 4.188, boardW: 3.5,
    y0: 0.5, y1: 97.5, table: -1.5, full: 97, piece: 48.5, pieceMin: 48.25, split: 49,
    thicknesses: [1.5, 1.125] }
};
const TYPES = ['empty', 'full', 'ab', 'a'];
const TYPE_LABEL = { empty: 'Empty', full: '97in board', ab: '48.5in pieces A+B', a: '48.5in piece A only' };

function laneX(jig, k) { const x0 = jig.x0 + (k - 1) * jig.pitch; return { x0: x0, x1: x0 + jig.boardW }; }
function emptyLoad(jig) { const L = []; for (let k = 0; k < jig.lanes; k++) L.push({ type: 'empty', thickness: jig.thicknesses[0] }); return L; }
function snapThickness(jig, t) {
  let best = null; for (const c of jig.thicknesses) if (Math.abs(c - t) < 0.02) best = c;
  return best;
}

// The boards on the table. zTop = machine Z of the board's top (the table plus its thickness).
function piecesFor(jig, load) {
  const out = [];
  for (let k = 1; k <= jig.lanes; k++) {
    const l = load[k - 1]; if (!l || l.type === 'empty') continue;
    const x = laneX(jig, k), th = l.thickness || jig.thicknesses[0], zTop = jig.table + th;
    const mk = (part, y0, h) => out.push({ lane: k, part: part, x0: x.x0, y0: y0, w: jig.boardW, h: h, thickness: th, zTop: zTop,
      label: 'Lane ' + k + (part === 'full' ? ' · 97in board' : ' · piece ' + part) + ' · ' + th + 'in' });
    if (l.type === 'full') mk('full', jig.y0, jig.full);
    else { mk('A', jig.y0, jig.piece); if (l.type === 'ab') mk('B', jig.y0 + jig.piece, jig.piece); }
  }
  return out;
}

// Where along a move the cutter is below Z0 (the top of a full-height board): [ta, tb] of the move, or null.
function belowTop(p, i, z) {
  const z0 = p.z0[i], z1 = p.z1[i];
  if (z0 >= z && z1 >= z) return null;
  if (z0 < z && z1 < z) return [0, 1];
  const t = (z0 - z) / (z0 - z1);
  return z0 < z ? [0, t] : [t, 1];
}
function cutSpan(p, i, z) {
  if (p.kind[i] === RAPID) return null;
  const s = belowTop(p, i, z == null ? 0 : z); if (!s) return null;
  const at = (a, t) => a[0] + (a[1] - a[0]) * t;
  const xa = at([p.x0[i], p.x1[i]], s[0]), xb = at([p.x0[i], p.x1[i]], s[1]);
  const ya = at([p.y0[i], p.y1[i]], s[0]), yb = at([p.y0[i], p.y1[i]], s[1]);
  return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) };
}
// Lanes a cutter of radius r overlaps along an X span.
function lanesOf(jig, x0, x1, r) {
  const out = [];
  for (let k = 1; k <= jig.lanes; k++) { const L = laneX(jig, k); if (x1 + r > L.x0 + 1e-9 && x0 - r < L.x1 - 1e-9) out.push(k); }
  return out;
}
const radiusOf = (toolFor, t) => { const s = toolFor ? toolFor(t) : null; return s && s.radius > 0 ? s.radius : 0.125; };
const is48Job = name => /48\.5|48s\b/i.test(String(name || ''));

// A lane with cutting moves gets a board. A 48s program (file name says "48.5" or "48s") gets 48.5in pieces:
// A+B when it cuts past Y 49 (the A/B joint), A only when everything is on the first piece. Anything else a 97in board.
function autoFill(jig, prog, name, toolFor) {
  const load = emptyLoad(jig), used = {}, above = {};
  for (let i = 0; i < prog.n; i++) {
    const s = cutSpan(prog, i, 0); if (!s) continue;
    for (const k of lanesOf(jig, s.x0, s.x1, radiusOf(toolFor, prog.tool[i]))) { used[k] = true; if (s.y1 > jig.split) above[k] = true; }
  }
  const p48 = is48Job(name);
  for (let k = 1; k <= jig.lanes; k++) if (used[k]) load[k - 1].type = p48 ? (above[k] ? 'ab' : 'a') : 'full';
  return load;
}

// ---- "README - run order.txt" ----
// The README sitting next to a job's .tap files says how each file is loaded, in numbered sections:
//   2  AM-LGC-60 - 2 LEGS + SEAT               (full boards)
//        lanes 1,2 = 12/8  -> front legs x2
//        lanes 3,4 = 9/8   -> rear legs x2
//   5  AM-LGC-60 - 5 TOP STEP RAILS            (48s, 12/8) - lane 2 only
// 12/8 = 1.5in, 9/8 = 1.125in. The section whose title starts the .tap's name is the one used; a README with
// no numbered sections applies its lane lines to every file. Returns null when nothing applies.
function thicknessOf(s) {
  s = String(s).trim();
  const m = /^(\d+)\/(\d+)$/.exec(s); if (m) return +m[1] / +m[2];
  const v = parseFloat(s); return isFinite(v) ? v : null;
}
const norm = s => String(s || '').toLowerCase().replace(/\.(tap|nc|ngc|gcode|cnc)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function laneList(s) {
  const out = []; const re = /(\d+)\s*(?:-|to)\s*(\d+)|(\d+)/g; let m;
  while ((m = re.exec(s))) { if (m[3]) out.push(+m[3]); else for (let k = +m[1]; k <= +m[2]; k++) out.push(k); }
  return out;
}
function parseRunOrder(text, tapName) {
  const lines = String(text || '').split(/\r?\n/);
  const heads = [];
  lines.forEach((ln, n) => { const m = /^\s{0,3}(\d{1,2})[.)]?\s{2,}(\S.*)$/.exec(ln); if (m) heads.push({ n: n, num: +m[1], title: m[2].split(/\s{2,}|\(/)[0].trim(), line: ln }); });
  let body;
  if (heads.length) {
    const t = norm(tapName); if (!t) return null;
    let best = -1, bestLen = 0;
    heads.forEach((h, k) => { const ht = norm(h.title); if (ht && (t.indexOf(ht) === 0 || t.indexOf(' ' + ht) >= 0) && ht.length > bestLen) { best = k; bestLen = ht.length; } });
    if (best < 0) return null;
    body = lines.slice(heads[best].n, best + 1 < heads.length ? heads[best + 1].n : lines.length);
    body = { head: heads[best].line, rest: body.slice(1), section: heads[best].num, title: heads[best].title };
  } else body = { head: '', rest: lines, section: null, title: null };
  const out = { lanes: {}, only: null, thickness: null, pieces48: false, section: body.section, title: body.title };
  const TH = '(\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
  const assign = new RegExp('\\blanes?\\s+([\\d][\\d\\s,&+-]*(?:and\\s+\\d+)?)\\s*=\\s*' + TH, 'gi');
  for (const ln of [body.head].concat(body.rest)) {
    let m; assign.lastIndex = 0;
    while ((m = assign.exec(ln))) {
      const t = thicknessOf(m[2]); if (!(t > 0)) continue;
      for (const k of laneList(m[1].replace(/and/gi, ','))) out.lanes[k] = t;
    }
  }
  const h = body.head.replace(new RegExp('\\blanes?\\s+[\\d][\\d\\s,&+-]*\\s*=\\s*' + TH, 'gi'), '');
  const only = /\blanes?\s+([\d][\d\s,&+-]*?)\s+only\b/i.exec(h); if (only) out.only = laneList(only[1]);
  const def = /\b(\d+\/8|1\.125|1\.5)\b/.exec(h.replace(/\b48\.5\b/g, '')); if (def) out.thickness = thicknessOf(def[1]);
  out.pieces48 = /\b48s\b|48\.5/i.test(h);
  if (!Object.keys(out.lanes).length && !out.only && out.thickness == null) return null;
  return out;
}
// Thicknesses from the README override the defaults; "lane N only" empties the other lanes. The load is copied.
function applyRunOrder(jig, load, ro) {
  const L = load.map(l => Object.assign({}, l)); if (!ro) return L;
  for (let k = 1; k <= L.length; k++) {
    const l = L[k - 1];
    if (ro.only && ro.only.indexOf(k) < 0) { l.type = 'empty'; continue; }
    const t = ro.lanes[k] != null ? ro.lanes[k] : ro.thickness;
    const s = t != null ? snapThickness(jig, t) : null; if (s != null) l.thickness = s;
  }
  return L;
}

// ---- air cuts ----
// A cutting move (below Z0) over a lane set to Empty, or past the end of the material in a lane. 48.5in pieces
// are taken at their worst case (48.25in actual): piece A ends at Y 48.75, A+B butted together at Y 97.0.
// Returns { moves: [i...], list: [{ i, lane, reason, line }], lanes: {k: count} }.
function coverage(jig, l) {
  if (!l || l.type === 'empty') return null;
  if (l.type === 'full') return [jig.y0, jig.y0 + jig.full];
  if (l.type === 'a') return [jig.y0, jig.y0 + jig.pieceMin];
  return [jig.y0, jig.y0 + 2 * jig.pieceMin];
}
function airCuts(jig, prog, load, toolFor) {
  const res = { moves: [], list: [], lanes: {} };
  for (let i = 0; i < prog.n; i++) {
    const s = cutSpan(prog, i, 0); if (!s) continue;
    for (const k of lanesOf(jig, s.x0, s.x1, radiusOf(toolFor, prog.tool[i]))) {
      const cov = coverage(jig, load[k - 1]); let why = null;
      if (!cov) why = 'lane ' + k + ' is empty';
      else if (s.y1 > cov[1] + 1e-6) why = 'past the end of ' + (load[k - 1].type === 'full' ? 'the 97in board' : load[k - 1].type === 'a' ? 'piece A (48.25in worst case)' : 'piece B (48.25in worst case)') + ' in lane ' + k;
      if (why) { res.moves.push(i); res.list.push({ i: i, lane: k, reason: why, line: prog.line ? prog.line[i] : 0 }); res.lanes[k] = (res.lanes[k] || 0) + 1; break; }
    }
  }
  return res;
}
function summarizeAir(ac) {
  const by = {};
  for (const a of ac.list) { const g = by[a.reason] || (by[a.reason] = { reason: a.reason, count: 0, first: a.i, line0: a.line, line1: a.line });
    g.count++; if (a.line < g.line0) g.line0 = a.line; if (a.line > g.line1) g.line1 = a.line; }
  return Object.keys(by).map(k => by[k]);
}

// ---- carving: one Carver per board, all seeked together ----
function JigCarver(cam, gcsim, prog, pieces, toolFor, res) {
  this.p = prog; this.pieces = pieces;
  this.carvers = pieces.map(pc => new gcsim.Carver(cam, prog, { x0: pc.x0, y0: pc.y0, w: pc.w, h: pc.h, thickness: pc.thickness, zTop: pc.zTop, res: res || 0.05 }, toolFor));
  this.fields = this.carvers.map(c => c.field);
}
JigCarver.prototype.seek = function (i, u) { for (const c of this.carvers) c.seek(i, u); };
// indices of the boards carved since the last call, or null
JigCarver.prototype.takeDirty = function () { const d = []; this.carvers.forEach((c, k) => { if (c.takeDirty()) d.push(k); }); return d.length ? d : null; };

// ---- parts ----
// Connected solid regions of a carved board (4-connected cells that are not cut through). One region = the board
// is still whole. Holding tabs count as cut: a cell with `tab` inches of material or less left (default 0.2, so a
// VCarve 0.125 tab) separates parts, since that is where Dan snaps them free. Regions smaller than `minArea` sq in
// (slivers between passes) are ignored. `tint` per cell: 0 = no tint (whole board / sliver / cut), 1..3 alternating
// per part in Y order.
function partsOf(f, minArea, tab) {
  const nx = f.nx, ny = f.ny, z = f.z, floor = f.floor + (tab == null ? 0.2 : tab) + 1e-4, N = nx * ny;
  const lab = new Int32Array(N).fill(-1), stack = new Int32Array(N), comps = [];
  minArea = minArea == null ? 0.25 : minArea;
  for (let s = 0; s < N; s++) {
    if (lab[s] >= 0 || z[s] <= floor) continue;
    const id = comps.length, c = { id: id, cells: 0, i0: nx, i1: -1, j0: ny, j1: -1 };
    let sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const q = stack[--sp], i = q % nx, j = (q - i) / nx; c.cells++;
      if (i < c.i0) c.i0 = i; if (i > c.i1) c.i1 = i; if (j < c.j0) c.j0 = j; if (j > c.j1) c.j1 = j;
      if (i > 0 && lab[q - 1] < 0 && z[q - 1] > floor) { lab[q - 1] = id; stack[sp++] = q - 1; }
      if (i < nx - 1 && lab[q + 1] < 0 && z[q + 1] > floor) { lab[q + 1] = id; stack[sp++] = q + 1; }
      if (j > 0 && lab[q - nx] < 0 && z[q - nx] > floor) { lab[q - nx] = id; stack[sp++] = q - nx; }
      if (j < ny - 1 && lab[q + nx] < 0 && z[q + nx] > floor) { lab[q + nx] = id; stack[sp++] = q + nx; }
    }
    c.area = c.cells * f.res * f.res;
    c.length = (c.j1 - c.j0 + 1) * f.res; c.width = (c.i1 - c.i0 + 1) * f.res;
    c.y0 = f.y0 + c.j0 * f.res; c.y1 = f.y0 + (c.j1 + 1) * f.res;
    comps.push(c);
  }
  const parts = comps.filter(c => c.area >= minArea).sort((a, b) => a.y0 - b.y0);
  parts.forEach((c, k) => { c.n = k + 1; });
  const tint = new Uint8Array(N);
  if (parts.length > 1) {
    const t = new Uint8Array(comps.length); parts.forEach((c, k) => { t[c.id] = 1 + (k % 3); });
    for (let q = 0; q < N; q++) if (lab[q] >= 0) tint[q] = t[lab[q]];
  }
  return { labels: lab, comps: comps, parts: parts, tint: tint };
}
// The part under a machine (x, y) point on a board's field, or null.
function partAt(f, info, x, y) {
  const i = Math.floor((x - f.x0) / f.res), j = Math.floor((y - f.y0) / f.res);
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return null;
  const id = info.labels[j * f.nx + i]; if (id < 0) return null;
  const c = info.comps[id]; return c.n ? c : null;
}

return { PRESETS: PRESETS, TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, laneX: laneX, emptyLoad: emptyLoad, piecesFor: piecesFor,
  autoFill: autoFill, is48Job: is48Job, parseRunOrder: parseRunOrder, applyRunOrder: applyRunOrder, airCuts: airCuts, summarizeAir: summarizeAir,
  JigCarver: JigCarver, partsOf: partsOf, partAt: partAt, lanesOf: lanesOf };
});
