/* tapedit.js — edit a posted G-code program without retyping it. Pure (no DOM), unit-tested in tapedittest.js.
 *
 * Rules every edit obeys:
 *  - Only the numbers an edit is about change. Every other line, comment, space and line ending survives byte for byte.
 *  - Modal state is honoured: G90/G91, G20/G21, the active motion mode, the active tool.
 *  - Every edit re-simulates the program afterwards and checks the result against what the edit promised, line by line.
 *    A mismatch is a refusal, not a warning.
 *  - A program that cannot be understood is refused, naming the line. Nothing is guessed.
 *  - A retract is never lowered. Depth and feed changes are bounded by the same limits the post uses.
 *
 * Text is a "binary string": one char per byte (latin1), so unedited bytes survive any encoding.
 */
(function (root, factory) {
  const mod = factory(typeof module !== 'undefined' && module.exports ? require('./gcodesim.js') : root.GCSIM);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.TAPEDIT = mod;
})(typeof self !== 'undefined' ? self : this, function (GCSIM) {
'use strict';

const OLE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const LIMITS = { maxFeed: 1000, maxRpm: 24000, maxClearZ: 6 };   // same defaults as camcore's post-time speed check
const EPS = 1e-4;

class TapRefusal extends Error {
  constructor(code, line, msg) { super(line ? 'Line ' + line + ': ' + msg : msg); this.code = code; this.line = line || null; this.refused = true; }
}
const refuse = (code, line, msg) => { throw new TapRefusal(code, line, msg); };

// ---- bytes <-> text ------------------------------------------------------------------------------------------
// Decide what a file holding G-code bytes is before anything tries to run it. {ok:true,text} or {ok:false,code,msg}.
function readBytes(u8, name) {
  const label = name || 'This file';
  if (!u8 || !u8.length) return { ok: false, code: 'EMPTY_FILE', msg: label + ' is empty (0 bytes), so there is nothing to open.' };
  if (OLE.every((b, i) => u8[i] === b)) return { ok: false, code: 'NOT_GCODE_VECTRIC', msg: label + ' is not G-code. It is a Vectric job file (a binary .crv or .crv3d) saved with a G-code extension. Rename it to .crv3d and open that, or re-post the toolpath from VCarve.' };
  const head = u8.subarray(0, Math.min(4096, u8.length));
  if (head.indexOf(0) >= 0) return { ok: false, code: 'NOT_GCODE_BINARY', msg: label + ' is a binary file, not G-code. Nothing was opened.' };
  let text = '';
  for (let i = 0; i < u8.length; i += 8192) text += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return { ok: true, text };
}
function textToBytes(text) { const u = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) u[i] = text.charCodeAt(i) & 255; return u; }

function splitLines(text) {
  const out = [], re = /\r\n|\n|\r/g; let m, p = 0;
  while ((m = re.exec(text))) { out.push({ text: text.slice(p, m.index), eol: m[0] }); p = m.index + m[0].length; }
  if (p < text.length || !out.length) out.push({ text: text.slice(p), eol: '' });
  return out;
}
const joinLines = L => L.map(l => l.text + l.eol).join('');

// ---- understanding a program ---------------------------------------------------------------------------------
const G_OK = new Set([0, 1, 2, 3, 4, 17, 20, 21, 40, 49, 53, 54, 64, 80, 90, 91, 94]);
const WORD_OK = new Set('GMXYZIJRFSTNP'.split(''));

function analyse(text) {
  const lines = splitLines(text), info = [], blockers = [];
  const st = { mode: 0, abs: true, unit: 1, t: 0, x: 0, y: 0, z: null, f: 0, s: 0, fLine: 0, sLine: 0, sec: -1 };
  const sections = [];
  const block = (code, n, why) => blockers.push({ code, line: n + 1, why, raw: lines[n].text.trim().slice(0, 60) });
  lines.forEach((l, n) => {
    const tk = GCSIM.tokenizeLine(l.text), I = { n, tk, words: {}, G: [], M: [], motion: false, tool: st.t };
    info.push(I);
    if (!l.text.trim()) return;
    for (const w of tk.words) { if (w.L === 'G') I.G.push(w.v); else if (w.L === 'M') I.M.push(w.v); else I.words[w.L] = w; }
    const isG53 = I.G.indexOf(53) >= 0;
    if (tk.unclosed) block('UNCLOSED_COMMENT', n, 'a comment bracket is never closed');
    if (tk.junk != null || tk.bare.some(b => !(isG53 && 'XYZ'.indexOf(b) >= 0))) { block('JUNK_TEXT', n, 'this text cannot be read as G-code'); return; }
    for (const k of Object.keys(I.words)) if (!WORD_OK.has(k) && !(k === 'C' && I.M.length)) block('WORD_' + k, n, 'the ' + k + ' word is not understood');
    for (const g of I.G) if (!G_OK.has(g)) block('G' + g, n, 'G' + g + ' is not understood');
    I.isG53 = isG53;
    if (I.G.indexOf(4) >= 0) { I.dwell = true; return; }
    if (isG53) return;
    if (I.G.indexOf(21) >= 0) st.unit = 1 / 25.4;
    if (I.G.indexOf(20) >= 0) st.unit = 1;
    if (I.G.indexOf(90) >= 0) st.abs = true;
    if (I.G.indexOf(91) >= 0) st.abs = false;
    I.unit = st.unit; I.abs = st.abs;
    const w = I.words;
    if (w.T) { st.t = Math.round(w.T.v); st.sec++; sections.push({ tool: st.t, tLine: n, first: n, end: n }); I.tool = st.t; }
    if (w.S) { st.s = w.S.v; st.sLine = n; }
    if (w.F) { st.f = w.F.v; st.fLine = n; }
    for (const g of I.G) if (g >= 0 && g <= 3) st.mode = g;
    I.mode = st.mode; I.fLine = st.fLine; I.sec = st.sec;
    const arc = st.mode === 2 || st.mode === 3;
    if (arc && (w.X || w.Y || w.Z) && !w.I && !w.J && !w.R) block('ARC_WITHOUT_CENTER', n, 'this arc has no I, J or R');
    if (!w.X && !w.Y && !w.Z && !(arc && (w.I || w.J))) return;
    I.motion = true;
    I.feedMove = st.mode !== 0;
    const u = st.unit;
    const nx = w.X ? (st.abs ? w.X.v * u : st.x + w.X.v * u) : st.x;
    const ny = w.Y ? (st.abs ? w.Y.v * u : st.y + w.Y.v * u) : st.y;
    const nz = w.Z ? (st.abs ? w.Z.v * u : (st.z || 0) + w.Z.v * u) : (st.z == null ? 0 : st.z);
    I.plunge = st.mode === 1 && st.z != null && nz < st.z - 1e-9 && Math.abs(nx - st.x) < 1e-9 && Math.abs(ny - st.y) < 1e-9;
    I.endZ = nz;
    st.x = nx; st.y = ny; st.z = nz;
  });
  // Where each tool's section starts (the M5/M51 block in front of its T word) and ends.
  const isToolBlockLine = I => !I.motion && !I.dwell && (I.M.length > 0 || !lines[I.n].text.trim()) && !I.G.length && !I.tk.words.some(w => w.L !== 'M');
  for (let k = 0; k < sections.length; k++) {
    let s = sections[k].tLine; const lower = k ? sections[k - 1].tLine : -1;
    while (s - 1 > lower && isToolBlockLine(info[s - 1])) s--;
    while (s < sections[k].tLine && !lines[s].text.trim()) s++;    // a blank line in front of the block belongs to what came before
    sections[k].first = s;
  }
  let lastFeed = -1; info.forEach(I => { if (I.motion && I.feedMove) lastFeed = I.n; });
  for (let k = 0; k < sections.length; k++) sections[k].end = k + 1 < sections.length ? sections[k + 1].first - 1 : Math.max(lastFeed, sections[k].tLine);
  return { lines, info, blockers, sections, lastFeed };
}

function requireUnderstood(m, what) {
  if (m.blockers.length) {
    const b = m.blockers[0];
    refuse(b.code, b.line, 'cannot ' + what + ': ' + b.why + ' ("' + b.raw + '")' + (m.blockers.length > 1 ? ' (and ' + (m.blockers.length - 1) + ' more line' + (m.blockers.length > 2 ? 's' : '') + ' like it)' : ''));
  }
}

// ---- word rewriting --------------------------------------------------------------------------------------------
function decimalsOf(s) { const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
function fmtLike(orig, v, minDec) { const d = Math.min(8, Math.max(decimalsOf(orig), minDec || 0)); const t = v.toFixed(d); return Number(t) === 0 ? (0).toFixed(d) : t; }
function decimalsOfDelta(v) { const s = String(Math.abs(v)); if (/e/i.test(s)) return 6; return Math.min(6, decimalsOf(s)); }

function applyEdits(m, edits) {   // edits: [{n, word, text}] -> new text, change list. One word per edit.
  const byLine = new Map();
  for (const e of edits) { if (!byLine.has(e.n)) byLine.set(e.n, []); byLine.get(e.n).push(e); }
  const changes = [];
  const out = m.lines.map((l, n) => {
    const es = byLine.get(n); if (!es) return l;
    let t = l.text;
    for (const e of es.slice().sort((a, b) => b.word.vs - a.word.vs)) t = t.slice(0, e.word.vs) + e.text + t.slice(e.word.ve);
    if (t === l.text) return l;
    changes.push({ line: n + 1, before: l.text, after: t });
    return { text: t, eol: l.eol };
  });
  return { text: joinLines(out), changes };
}

// ---- what the sim says -------------------------------------------------------------------------------------------
// One end state per source line, so two simulations can be compared whatever the move counts.
function lineEnds(p) {
  const M = new Map();
  for (let i = 0; i < p.n; i++) M.set(p.line[i], { x: p.x1[i], y: p.y1[i], z: p.z1[i], feed: p.feed[i], tool: p.tool[i], rpm: p.rpm[i], kind: p.kind[i] });
  return M;
}
function stats(text) {
  const p = GCSIM.parseGcode(text), tl = GCSIM.timeline(p, 300), b = p.bounds;
  let minRetract = Infinity, maxZ = -Infinity, feedMin = Infinity, feedMax = 0, rpmMin = Infinity, rpmMax = 0;
  for (let i = 0; i < p.n; i++) {
    if (p.kind[i] === GCSIM.RAPID && p.z1[i] > 0 && p.z1[i] < minRetract) minRetract = p.z1[i];
    if (p.z1[i] > maxZ) maxZ = p.z1[i];
    if (p.kind[i] !== GCSIM.RAPID) { if (p.feed[i] < feedMin) feedMin = p.feed[i]; if (p.feed[i] > feedMax) feedMax = p.feed[i]; if (p.rpm[i] > 0) { if (p.rpm[i] < rpmMin) rpmMin = p.rpm[i]; if (p.rpm[i] > rpmMax) rpmMax = p.rpm[i]; } }
  }
  const hasCut = b.cutX0 <= b.cutX1;
  return { prog: p, moves: p.n, tools: p.tools.slice(), deepest: p.n ? b.z0 : null, top: isFinite(maxZ) ? maxZ : null, minRetract: isFinite(minRetract) ? minRetract : null,
    cut: hasCut ? { x0: b.cutX0, y0: b.cutY0, x1: b.cutX1, y1: b.cutY1 } : null,
    feed: feedMax > 0 ? [feedMin, feedMax] : null, rpm: rpmMax > 0 ? [rpmMin, rpmMax] : null,
    cutLen: tl.cutLen, plungeLen: tl.plungeLen, rapidLen: tl.rapidLen, minutes: tl.total, issues: p.issues };
}
function report(before, after, changes) {
  const A = stats(before), B = stats(after), f = v => v == null ? 'none' : (+v.toFixed(4)).toString(), box = c => c ? f(c.x0) + ', ' + f(c.y0) + ' to ' + f(c.x1) + ', ' + f(c.y1) : 'none';
  const rows = [
    ['Moves', A.moves, B.moves], ['Tools', A.tools.map(t => 'T' + t).join(' ') || 'none', B.tools.map(t => 'T' + t).join(' ') || 'none'],
    ['Cut area (X, Y)', box(A.cut), box(B.cut)], ['Deepest Z', f(A.deepest), f(B.deepest)], ['Lowest retract Z', f(A.minRetract), f(B.minRetract)],
    ['Feed range', A.feed ? A.feed.map(f).join(' to ') : 'none', B.feed ? B.feed.map(f).join(' to ') : 'none'],
    ['Spindle RPM', A.rpm ? A.rpm.map(f).join(' to ') : 'none', B.rpm ? B.rpm.map(f).join(' to ') : 'none'],
    ['Cut length (in)', A.cutLen.toFixed(2), B.cutLen.toFixed(2)], ['Run time (min)', A.minutes.toFixed(2), B.minutes.toFixed(2)],
    ['Lines changed', '', changes.length]
  ];
  return { before: A, after: B, changes, rows };
}

// Compare the re-simulation with what the edit promised. expect(oldEnd, line) -> {x,y,z,feed,rpm} in inches (only keys given are checked).
function verifyEnds(m, before, afterText, expect, lineMap, what) {
  const oldP = GCSIM.parseGcode(before), newP = GCSIM.parseGcode(afterText);
  const oldE = lineEnds(oldP), newE = lineEnds(newP);
  for (const [ln, a] of oldE) {
    const newLn = lineMap ? lineMap(ln) : ln;
    if (newLn == null) continue;
    const want = expect(a, ln);
    let b = newE.get(newLn);
    if (!b) {   // a line can stop being a move when the machine is already where it points (a retract to the height it is already at)
      let pos = null;
      for (let i = 0; i < newP.n && newP.line[i] < newLn; i++) pos = { x: newP.x1[i], y: newP.y1[i], z: newP.z1[i] };
      if (!pos || (want.x != null && Math.abs(pos.x - want.x) > EPS) || (want.y != null && Math.abs(pos.y - want.y) > EPS) || (want.z != null && Math.abs(pos.z - want.z) > EPS))
        refuse('VERIFY_FAILED', ln, what + ': the re-simulation lost the move on this line, so the edit was not applied.');
      continue;
    }
    for (const k of (a.kind === GCSIM.RAPID ? ['x', 'y', 'z'] : ['x', 'y', 'z', 'feed', 'tool', 'rpm'])) if (want[k] != null && Math.abs(b[k] - want[k]) > EPS * Math.max(1, Math.abs(want[k])))
      refuse('VERIFY_FAILED', ln, what + ': the re-simulation shows ' + k + ' = ' + b[k] + ', expected ' + want[k] + ', so the edit was not applied.');
  }
}

function sameLineCheck(m, editedText, changes) {
  const L = splitLines(editedText);
  if (L.length !== m.lines.length) refuse('VERIFY_FAILED', null, 'the edit changed the number of lines.');
  const set = new Set(changes.map(c => c.line - 1));
  L.forEach((l, n) => { if (!set.has(n) && (l.text !== m.lines[n].text || l.eol !== m.lines[n].eol)) refuse('VERIFY_FAILED', n + 1, 'a line outside the edit changed.'); });
}

function finite(v, name) { if (typeof v !== 'number' || !isFinite(v)) refuse('BAD_INPUT', null, name + ' must be a number.'); }

// ---- edits ---------------------------------------------------------------------------------------------------------
// Move the program in XY. The park move after the last cut stays where it is (the machine's Y115 is not part of the job),
// unless opts.movePark. dx, dy in inches. Incremental lines are left alone: they move with whatever they start from.
function translate(text, opts) {
  const dx = opts.dx || 0, dy = opts.dy || 0; finite(dx, 'X offset'); finite(dy, 'Y offset');
  const m = analyse(text); requireUnderstood(m, 'translate this program');
  if (!dx && !dy) refuse('BAD_INPUT', null, 'the offset is zero.');
  const edits = [], park = []; let absXY = 0;
  for (const I of m.info) {
    if (!I.motion || I.isG53) continue;
    if (I.words.A) refuse('ROTARY', I.n + 1, 'cannot translate a rotary program (this line has an A axis).');
    if (!I.abs) continue;
    if ((I.words.X || I.words.Y) && !opts.movePark && !I.feedMove && I.n > m.lastFeed) { park.push(I.n + 1); continue; }
    if (I.words.X) { absXY++; if (dx) edits.push({ n: I.n, word: I.words.X, text: fmtLike(text.slice(0, 0) + m.lines[I.n].text.slice(I.words.X.vs, I.words.X.ve), I.words.X.v + dx / I.unit, decimalsOfDelta(dx / I.unit)) }); }
    if (I.words.Y) { absXY++; if (dy) edits.push({ n: I.n, word: I.words.Y, text: fmtLike(m.lines[I.n].text.slice(I.words.Y.vs, I.words.Y.ve), I.words.Y.v + dy / I.unit, decimalsOfDelta(dy / I.unit)) }); }
  }
  if (!absXY) refuse('NO_ABSOLUTE_XY', null, 'cannot translate: the program never sets an absolute X or Y position.');
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  const parkSet = new Set(park);
  verifyEnds(m, text, r.text, (a, ln) => parkSet.has(ln) ? { x: a.x, y: a.y, z: a.z } : { x: a.x + dx, y: a.y + dy, z: a.z, feed: a.feed, tool: a.tool, rpm: a.rpm }, null, 'translate');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: park.length ? ['Park move on line ' + park.join(', ') + ' was left where it is.'] : [] };
}

function inScope(m, I, tool) { return tool == null || I.tool === tool; }

// Multiply F. opts.which: 'all' | 'cut' | 'plunge'. opts.tool limits it to one tool's sections.
function scaleFeed(text, opts) {
  const factor = opts.factor; finite(factor, 'Feed factor');
  if (!(factor > 0)) refuse('BAD_INPUT', null, 'the feed factor must be above zero.');
  const which = opts.which || 'all', tool = opts.tool == null ? null : opts.tool, maxFeed = opts.maxFeed || LIMITS.maxFeed;
  const m = analyse(text); requireUnderstood(m, 'scale feeds');
  const edits = [], changedF = new Set();
  for (const I of m.info) {
    if (!I.words.F || !inScope(m, I, tool)) continue;
    const isPlunge = !!I.plunge;
    if (which === 'cut' && isPlunge) continue;
    if (which === 'plunge' && !isPlunge) continue;
    const nv = I.words.F.v * factor;
    if (nv * I.unit > maxFeed) refuse('OVER_LIMIT', I.n + 1, 'feed would be ' + (nv * I.unit).toFixed(1) + ' in/min, over the ' + maxFeed + ' in/min limit.');
    changedF.add(I.n);
    edits.push({ n: I.n, word: I.words.F, text: fmtLike(m.lines[I.n].text.slice(I.words.F.vs, I.words.F.ve), nv, 1) });
  }
  if (!edits.length) refuse('NOTHING_TO_DO', null, 'no matching F words were found' + (tool != null ? ' for T' + tool : '') + '.');
  if (tool != null) for (const I of m.info) {
    if (!I.motion || !I.feedMove || I.tool !== tool) continue;
    if (!changedF.has(I.fLine) && !(which === 'plunge' && !I.plunge) && !(which === 'cut' && I.plunge)) refuse('INHERITED_FEED', I.n + 1, 'T' + tool + ' uses the feed set on line ' + (I.fLine + 1) + ', outside its own section, so scaling only this tool would be a guess.');
  }
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  const fByLine = new Map(m.info.filter(I => I.motion).map(I => [I.n + 1, I.fLine]));
  verifyEnds(m, text, r.text, (a, ln) => ({ x: a.x, y: a.y, z: a.z, feed: changedF.has(fByLine.get(ln)) ? a.feed * factor : a.feed, tool: a.tool, rpm: a.rpm }), null, 'feed scale');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: [] };
}

function scaleSpeed(text, opts) {
  const factor = opts.factor; finite(factor, 'Speed factor');
  if (!(factor > 0)) refuse('BAD_INPUT', null, 'the speed factor must be above zero.');
  const tool = opts.tool == null ? null : opts.tool, maxRpm = opts.maxRpm || LIMITS.maxRpm;
  const m = analyse(text); requireUnderstood(m, 'scale spindle speeds');
  const edits = [], changedS = new Set();
  for (const I of m.info) {
    if (!I.words.S || !inScope(m, I, tool)) continue;
    const nv = I.words.S.v * factor;
    if (nv > maxRpm) refuse('OVER_LIMIT', I.n + 1, 'spindle speed would be ' + nv.toFixed(0) + ' rpm, over the ' + maxRpm + ' rpm limit.');
    changedS.add(I.n);
    edits.push({ n: I.n, word: I.words.S, text: fmtLike(m.lines[I.n].text.slice(I.words.S.vs, I.words.S.ve), Math.round(nv), 0) });
  }
  if (!edits.length) refuse('NOTHING_TO_DO', null, 'no matching S words were found.');
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  verifyEnds(m, text, r.text, a => ({ x: a.x, y: a.y, z: a.z, feed: a.feed, tool: a.tool }), null, 'speed scale');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: [] };
}

function zWords(m, what) {   // every Z word on a real move; refuses incremental Z, which an absolute edit cannot express
  const out = [];
  for (const I of m.info) {
    if (!I.motion || I.isG53 || !I.words.Z) continue;
    if (!I.abs) refuse('INCREMENTAL_Z', I.n + 1, 'cannot ' + what + ': this line moves Z in G91 incremental mode.');
    out.push(I);
  }
  return out;
}
function checkDepthLimit(val, opts, n) { if (opts.maxDepth != null && val < -opts.maxDepth - 1e-9) refuse('TOO_DEEP', n + 1, 'the cut would reach Z' + val.toFixed(4) + ', deeper than the ' + opts.maxDepth + '" limit.'); }

// Shift every below-surface Z by dz (negative = deeper). Retracts and the surface are untouched.
function shiftCutDepth(text, opts) {
  const dz = opts.dz; finite(dz, 'Depth change');
  if (!dz) refuse('BAD_INPUT', null, 'the depth change is zero.');
  const m = analyse(text); requireUnderstood(m, 'change the cut depth');
  const edits = [];
  for (const I of zWords(m, 'change the cut depth')) {
    const zIn = I.words.Z.v * I.unit;
    if (zIn >= 0) continue;
    const nz = zIn + dz;
    if (nz >= -1e-6) refuse('WOULD_NOT_CUT', I.n + 1, 'this cut at Z' + zIn.toFixed(4) + ' would rise to the surface or above.');
    checkDepthLimit(nz, opts, I.n);
    edits.push({ n: I.n, word: I.words.Z, text: fmtLike(m.lines[I.n].text.slice(I.words.Z.vs, I.words.Z.ve), nz / I.unit, decimalsOfDelta(dz / I.unit)) });
  }
  if (!edits.length) refuse('NOTHING_TO_DO', null, 'the program has no cuts below the surface.');
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  verifyEnds(m, text, r.text, a => ({ x: a.x, y: a.y, z: a.z < 0 ? a.z + dz : a.z, feed: a.feed, tool: a.tool, rpm: a.rpm }), null, 'cut depth');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: [] };
}

// Change only the deepest Z level (the final pass) to Z = opts.z.
function setFinalDepth(text, opts) {
  const z = opts.z; finite(z, 'Final depth');
  if (!(z < 0)) refuse('BAD_INPUT', null, 'the final depth must be below the surface (negative Z).');
  const m = analyse(text); requireUnderstood(m, 'change the final depth');
  const list = zWords(m, 'change the final depth').filter(I => I.words.Z.v * I.unit < 0);
  if (!list.length) refuse('NOTHING_TO_DO', null, 'the program has no cuts below the surface.');
  let deepest = Infinity, next = -Infinity;
  for (const I of list) deepest = Math.min(deepest, I.words.Z.v * I.unit);
  for (const I of list) { const v = I.words.Z.v * I.unit; if (v > deepest + EPS && v > next) next = v; }
  if (next > -Infinity && next < 0 && z >= next - EPS) refuse('PASS_ORDER', null, 'Z' + z.toFixed(4) + ' is not below the previous pass at Z' + next.toFixed(4) + '; use the depth shift instead.');
  const edits = [];
  for (const I of list) {
    if (Math.abs(I.words.Z.v * I.unit - deepest) > EPS) continue;
    checkDepthLimit(z, opts, I.n);
    edits.push({ n: I.n, word: I.words.Z, text: fmtLike(m.lines[I.n].text.slice(I.words.Z.vs, I.words.Z.ve), z / I.unit, decimalsOfDelta(z / I.unit)) });
  }
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  verifyEnds(m, text, r.text, a => ({ x: a.x, y: a.y, z: Math.abs(a.z - deepest) <= EPS ? z : a.z, feed: a.feed, tool: a.tool, rpm: a.rpm }), null, 'final depth');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: [] };
}

// Raise every rapid retract that sits below Z = opts.z up to it. Only ever raises.
function raiseSafeHeight(text, opts) {
  const z = opts.z; finite(z, 'Safe Z');
  const maxZ = opts.maxClearZ || LIMITS.maxClearZ;
  if (!(z > 0)) refuse('BAD_INPUT', null, 'safe Z must be above the surface.');
  if (z > maxZ) refuse('OVER_LIMIT', null, 'safe Z ' + z + ' is over the ' + maxZ + '" limit.');
  const m = analyse(text); requireUnderstood(m, 'change the safe height');
  const edits = []; let lowest = Infinity;
  for (const I of zWords(m, 'change the safe height')) {
    if (I.mode !== 0) continue;
    const v = I.words.Z.v * I.unit;
    if (v <= 0) continue;
    if (v < lowest) lowest = v;
    if (v < z - 1e-9) edits.push({ n: I.n, word: I.words.Z, text: fmtLike(m.lines[I.n].text.slice(I.words.Z.vs, I.words.Z.ve), z / I.unit, decimalsOfDelta(z / I.unit)) });
  }
  if (!isFinite(lowest)) refuse('NOTHING_TO_DO', null, 'the program has no rapid retracts above the surface.');
  if (!edits.length) refuse('WOULD_LOWER', null, 'every retract is already at or above Z' + z + ' (lowest is Z' + lowest.toFixed(4) + '). This tool only raises retracts; lowering one needs a re-post.');
  const r = applyEdits(m, edits);
  sameLineCheck(m, r.text, r.changes);
  verifyEnds(m, text, r.text, a => ({ x: a.x, y: a.y, feed: a.feed, tool: a.tool, rpm: a.rpm, z: a.kind === GCSIM.RAPID && a.z > 0 && a.z < z - 1e-9 ? z : a.z }), null, 'safe height');
  const after = GCSIM.parseGcode(r.text);
  for (let i = 0; i < after.n; i++) if (after.kind[i] === GCSIM.RAPID && (Math.abs(after.x1[i] - after.x0[i]) > 1e-9 || Math.abs(after.y1[i] - after.y0[i]) > 1e-9) && after.z0[i] < 0)
    refuse('RAPID_IN_STOCK', after.line[i], 'a rapid XY move would run below the surface.');
  return { text: r.text, changes: r.changes, report: report(text, r.text, r.changes), notes: [] };
}

// Remove every section cut with opts.tool. The surrounding program keeps working on its own M5/T/S/M3 blocks.
function removeTool(text, opts) {
  const tool = opts.tool; finite(tool, 'Tool number');
  const m = analyse(text); requireUnderstood(m, 'remove a tool section');
  if (m.info.some(I => I.motion && !I.abs)) refuse('INCREMENTAL', (m.info.find(I => I.motion && !I.abs) || {}).n + 1, 'cannot remove a tool section from a program that uses G91 incremental moves.');
  const secs = m.sections.filter(s => s.tool === tool);
  if (!secs.length) refuse('NOTHING_TO_DO', null, 'T' + tool + ' is not in this program.');
  const keptTools = m.sections.filter(s => s.tool !== tool);
  if (!keptTools.length) refuse('WOULD_BE_EMPTY', null, 'T' + tool + ' is the only tool; removing it would leave nothing to cut.');
  const removed = new Set(), notes = [];
  for (const s of secs) {
    let keepZ = null;
    if (s === m.sections[0]) for (let n = s.tLine + 1; n <= s.end; n++) {   // the first block's Z2 is the program's only retract before the next tool's first move
      const I = m.info[n];
      if (I.motion && (I.words.X || I.words.Y)) break;
      if (I.motion && I.words.Z && !I.words.X && !I.words.Y && I.mode === 0 && I.endZ > 0) { keepZ = n; break; }
    }
    for (let n = s.first; n <= s.end; n++) if (n !== keepZ) removed.add(n);
    if (keepZ != null) notes.push('Kept the retract on line ' + (keepZ + 1) + ' (' + m.lines[keepZ].text.trim() + ') so the next tool does not start from an unknown height.');
  }
  const out = [], changes = [], map = new Map(); let k = 0;
  m.lines.forEach((l, n) => { if (removed.has(n)) { changes.push({ line: n + 1, before: l.text, after: null }); return; } out.push(l); map.set(n + 1, ++k); });
  const newText = joinLines(out);
  // a kept line must still do what it says; an axis it does not name legitimately inherits a different position after the gap
  verifyEnds(m, text, newText, (a, ln) => { const w = m.info[ln - 1].words; return { x: w.X ? a.x : null, y: w.Y ? a.y : null, z: w.Z ? a.z : null, feed: a.feed, tool: a.tool, rpm: a.rpm }; }, ln => map.has(ln) ? map.get(ln) : null, 'tool removal');
  const after = GCSIM.parseGcode(newText);
  if (!after.n) refuse('WOULD_BE_EMPTY', null, 'nothing would be left to cut.');
  for (let i = 0; i < after.n; i++) if (after.kind[i] === GCSIM.RAPID && (Math.abs(after.x1[i] - after.x0[i]) > 1e-9 || Math.abs(after.y1[i] - after.y0[i]) > 1e-9) && (after.z0[i] < 0 || after.z1[i] < 0))
    refuse('RAPID_IN_STOCK', after.line[i], 'removing T' + tool + ' would leave a rapid XY move below the surface.');
  return { text: newText, changes, report: report(text, newText, changes), notes };
}

// Hand edit: nothing is refused, but the new text is simulated, every problem named, and any lowered retract or deeper
// cut called out so it cannot pass unnoticed.
function textEdit(before, after) {
  const A = splitLines(before), B = splitLines(after), changes = [];
  let i = 0; while (i < A.length && i < B.length && A[i].text === B[i].text) i++;
  let ea = A.length - 1, eb = B.length - 1;
  while (ea >= i && eb >= i && A[ea].text === B[eb].text) { ea--; eb--; }
  for (let k = i; k <= Math.max(ea, eb); k++) if (k <= ea || k <= eb) changes.push({ line: k + 1, before: k <= ea ? A[k].text : null, after: k <= eb ? B[k].text : null });
  const rep = report(before, after, changes), notes = [];
  const a = rep.before, b = rep.after;
  if (a.minRetract != null && b.minRetract != null && b.minRetract < a.minRetract - 1e-9) notes.push('WARNING: the lowest retract went from Z' + a.minRetract.toFixed(4) + ' to Z' + b.minRetract.toFixed(4) + '.');
  if (a.deepest != null && b.deepest != null && b.deepest < a.deepest - 1e-9) notes.push('WARNING: the program now cuts deeper, Z' + a.deepest.toFixed(4) + ' to Z' + b.deepest.toFixed(4) + '.');
  const prog = b.prog;
  for (let k = 0; k < prog.n; k++) if (prog.kind[k] === GCSIM.RAPID && (Math.abs(prog.x1[k] - prog.x0[k]) > 1e-9 || Math.abs(prog.y1[k] - prog.y0[k]) > 1e-9) && prog.z0[k] < 0) { notes.push('WARNING: line ' + prog.line[k] + ' rapids in XY below the surface.'); break; }
  return { text: after, changes, report: rep, notes };
}

return { TapRefusal, readBytes, textToBytes, splitLines, analyse, stats, report, translate, scaleFeed, scaleSpeed, shiftCutDepth, setFinalDepth, raiseSafeHeight, removeTool, textEdit, LIMITS };
});
