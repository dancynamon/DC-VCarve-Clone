// Guard for tapedit.js and the G-code reading fixes in gcodesim.js: every edit re-simulates, unedited bytes survive,
// and a program that cannot be understood is refused with its line named.
const E = require('./tapedit.js'), S = require('./gcodesim.js');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);
const refused = (fn, code, line) => { try { fn(); return false; } catch (e) { return e.refused === true && (!code || e.code === code) && (line == null || e.line === line); } };
const whyRefused = fn => { try { fn(); return 'not refused'; } catch (e) { return e.code + ' line ' + e.line + ': ' + e.message; } };
const lines = t => t.split('\r\n');
// Bytes above 127 on purpose (a degree sign in Windows-1252): reading as UTF-8 would corrupt them.
const PROG = ['[job \xb0 name]', 'G90', '', 'M5', 'M51', 'T2', 'Z2.0000', 'S18000', 'M3', 'g4 x 4', 'M50', '', 'F100.0',
  'G0 X1.0000 Y1.0000 Z0.8000', 'G1   Z-0.2500 F20.0', 'G1 X5.0000 F100.0', 'G2 X6.0000 Y2.0000 I0.0000 J1.0000', 'G1 Z-0.5000 F20.0', 'G1 X1.0000 F100.0  [F50.0]', 'G0   Z0.8000',
  'M5', 'M51', 'T8', 'S10000', 'M3', 'g4 x 4', 'M50', 'G0 X3.0000 Y3.0000 Z0.8000', 'G1 Z-1.5500 F30.0', 'G0   Z0.8000', '',
  'G0 Z2.0000', 'G0 X0.0000 Y115.0000', '', 'M5', 'm51'].join('\r\n') + '\r\n';
const lineOf = (t, s) => lines(t).findIndex(l => l.indexOf(s) >= 0) + 1;

// ---- WinCNC comments, wrong feeds and tools ----
{
  const p = S.parseGcode('G90\n[T5]\n[G0 X99 Y99]\nT2\nG1 X1 F80.0 [F50.0]\nG1 X2\n(T7)\n');
  ok('brackets are comments: tool', p.tools.join() === '2', p.tools.join());
  ok('brackets are comments: commented-out move does not run', p.bounds.x1 === 2, p.bounds.x1);
  ok('F80.0 [F50.0] feeds at 80', p.feed[1] === 80, p.feed[1]);
  const u = S.parseGcode('G90\n[note\nG1 X1 F10\n');
  ok('an unclosed bracket is reported', u.issues.some(i => i.code === 'UNCLOSED_COMMENT' && i.line === 2));
}
// ---- what the sim would not do before ----
{
  const fc = S.parseGcode('g0x1.5y0\ng2i2f300\n');
  let L = 0; const tl = S.timeline(fc, 300); for (let i = 0; i < fc.n; i++) if (fc.line[i] === 2) L += tl.len[i];
  ok('G2 with I and no X/Y is a full circle', near(L, 2 * Math.PI * 2, 2e-2), L);
  const r = S.parseGcode('G0 X0 Y0 Z0\nG1 Z-0.1 F10\nG2 X2 Y0 R1 F50\n');
  let top = -9; for (let i = 0; i < r.n; i++) if (r.line[i] === 3) top = Math.max(top, r.y1[i]);
  ok('G2 R arc goes over the top', near(top, 1, 0.01), top);
  const r2 = S.parseGcode('G0 X0 Y0 Z0\nG1 Z-0.1 F10\nG3 X2 Y0 R1 F50\n');
  let bot = 9; for (let i = 0; i < r2.n; i++) if (r2.line[i] === 3) bot = Math.min(bot, r2.y1[i]);
  ok('G3 R arc goes under', near(bot, -1, 0.01), bot);
  const noc = S.parseGcode('G0 X0 Y0 Z0\nG1 Z-0.1 F10\nG3 X25\n');
  ok('arc with no centre is drawn straight and named', noc.issues.some(i => i.code === 'ARC_WITHOUT_CENTER' && i.line === 3 && i.level === 'loss') && noc.x1[noc.n - 1] === 25);
  const g53 = S.parseGcode('G0 Z0.25\nG0 X1 Y1\nG1 Z-0.1 F10\nG0 Z0.25\nG53 Z\nm5\nX0Y0\n');
  ok('G53 Z reported, not a parse failure', g53.issues.some(i => i.code === 'G53' && i.line === 5));
  ok('G53 line does not move the backplot', g53.bounds.z1 === 0.25);
  const j = S.parseGcode('G0 X1 Y1 Z1\n.5000 F25.0\nF80.0.0\nerror(1): function not definedG0 X9 Y9 Z0.8\nG0 6.0000\nG1 X2 Y2 F30\n');
  ok('junk text lines are reported by number', [2, 3, 4, 5].every(n => j.issues.some(i => i.code === 'JUNK_TEXT' && i.line === n)), JSON.stringify(j.issues));
  ok('junk text runs no motion', j.bounds.x1 === 2);
  ok('junk does not set a feed', j.feed[j.n - 1] === 30);
  const lw = S.parseGcode('l30\ng90\ng0x1.5y0\n');
  ok('L word reported', lw.issues.some(i => i.code === 'WORD_L' && i.line === 1));
  ok('bare CR line endings count as lines', S.parseGcode('G0 X1\rG0 X2\r').n === 2);
}
// ---- refusing files that are not G-code ----
{
  const ole = new Uint8Array(600); [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1].forEach((b, i) => ole[i] = b);
  const r = E.readBytes(ole, 'x.tap');
  ok('Vectric binary named .tap is refused', !r.ok && r.code === 'NOT_GCODE_VECTRIC' && /Vectric/.test(r.msg), r.msg);
  ok('zero-byte file is named', !E.readBytes(new Uint8Array(0), 'a.tap').ok && E.readBytes(new Uint8Array(0), 'a.tap').code === 'EMPTY_FILE');
  ok('other binary is refused', E.readBytes(new Uint8Array([71, 0, 1, 2]), 'a.tap').code === 'NOT_GCODE_BINARY');
  const bytes = Uint8Array.from([0x47, 0x30, 0x20, 0xb0, 0xe9, 0xff, 0x0d, 0x0a]);
  const t = E.readBytes(bytes, 'a.tap');
  ok('non-UTF8 bytes survive a read + write', Buffer.from(E.textToBytes(t.text)).equals(Buffer.from(bytes)));
}
// ---- translate ----
{
  const r = E.translate(PROG, { dx: 1.5, dy: -0.25 });
  const L = lines(r.text);
  ok('translate moves X/Y and keeps decimals', L[13] === 'G0 X2.5000 Y0.7500 Z0.8000', L[13]);
  ok('translate leaves I/J alone', L[16] === 'G2 X7.5000 Y1.7500 I0.0000 J1.0000', L[16]);
  ok('translate leaves the g4 dwell X alone', L.indexOf('g4 x 4') >= 0 && L[9] === 'g4 x 4');
  ok('park move stays', L[32] === 'G0 X0.0000 Y115.0000', L[32]);
  ok('comment with odd bytes byte-identical', L[0] === '[job \xb0 name]');
  ok('translate: CRLF kept on every line', r.text.split('\n').length === PROG.split('\n').length && !/[^\r]\n/.test(r.text));
  const untouched = lines(PROG).filter((l, i) => !r.changes.some(c => c.line === i + 1));
  ok('translate: only changed lines differ', untouched.every(l => L.indexOf(l) >= 0));
  ok('translate: before/after report', near(r.report.after.cut.x0, r.report.before.cut.x0 + 1.5) && near(r.report.after.cut.y1, r.report.before.cut.y1 - 0.25), JSON.stringify(r.report.after.cut));
  ok('translate: report keeps depth', near(r.report.after.deepest, r.report.before.deepest));
  ok('translate: says park was kept', r.notes.length === 1 && /Park/.test(r.notes[0]));
  const m = E.translate('G21\nG90\nG0 X10 Y10 Z5\nG1 Z-1 F100\nG1 X20\nG0 Z5\n', { dx: 1 });
  ok('translate in G21 converts the inches', lines(m.text.replace(/\n/g, '\r\n'))[2] === 'G0 X35.4 Y10 Z5', m.text);
  const g91 = 'G90\nG0 X1 Y1 Z1\nG91\nG1 X1 F10\nG90\nG0 X0\n';
  const tr = E.translate(g91, { dx: 2 });
  ok('translate honours G91: incremental lines untouched', tr.text.split('\n')[3] === 'G1 X1 F10', tr.text);
  ok('translate refuses an all-incremental program', refused(() => E.translate('G91\nG0 X1 Y1 Z1\nG1 X1 F10\n', { dx: 2 }), 'NO_ABSOLUTE_XY'));
  ok('translate refuses rotary', refused(() => E.translate('G90\nG0 X1 A9 Z1\nG1 X2 F10\n', { dx: 2 }), 'WORD_A') || refused(() => E.translate('G90\nG0 X1 A9 Z1\nG1 X2 F10\n', { dx: 2 }), 'ROTARY'), whyRefused(() => E.translate('G90\nG0 X1 A9 Z1\nG1 X2 F10\n', { dx: 2 })));
  ok('G2 I-only full circle translates by its start', (() => { const r = E.translate('G0 X1 Y0 Z1\nG1 Z-1 F10\ng2i2f300\nG0 Z1\n', { dx: 3 }); return r.text.split('\n')[2] === 'g2i2f300'; })());
}
// ---- refusals name the line ----
{
  const j = 'G90\nG0 X1 Y1 Z1\n.5000 F25.0\nG1 X2 F10\n';
  for (const [nm, fn] of [['translate', () => E.translate(j, { dx: 1 })], ['feed', () => E.scaleFeed(j, { factor: 2 })], ['speed', () => E.scaleSpeed('S100\n' + j, { factor: 2 })], ['depth', () => E.shiftCutDepth(j, { dz: -0.1 })], ['safe', () => E.raiseSafeHeight(j, { z: 2 })], ['tool', () => E.removeTool(j, { tool: 1 })]])
    ok('junk refuses ' + nm, refused(fn, 'JUNK_TEXT', nm === 'speed' ? 4 : 3), whyRefused(fn));
  const b = 'G90\nG92 X0 Y0\nG0 X1 Z1\nG1 X2 F10\n';
  ok('G92 refused with line', refused(() => E.translate(b, { dx: 1 }), 'G92', 2), whyRefused(() => E.translate(b, { dx: 1 })));
  const arc = 'G90\nG0 X0 Y0 Z1\nG1 Z-1 F10\nG3 X25\nG0 Z1\n';
  ok('arc without centre refused', refused(() => E.translate(arc, { dx: 1 }), 'ARC_WITHOUT_CENTER', 4));
  ok('L word refused', refused(() => E.translate('l30\ng90\ng0x1.5y0z1\ng1x2f10\n', { dx: 1 }), 'WORD_L', 1), whyRefused(() => E.translate('l30\ng90\ng0x1.5y0z1\ng1x2f10\n', { dx: 1 })));
}
// ---- feeds and speeds ----
{
  const r = E.scaleFeed(PROG, { factor: 1.5 });
  const L = lines(r.text);
  ok('feed scale rewrites F', L[12] === 'F150.0' && L[14] === 'G1   Z-0.2500 F30.0');
  ok('feed scale leaves the bracket comment', L[18] === 'G1 X1.0000 F150.0  [F50.0]', L[18]);
  ok('feed scale: geometry untouched', near(r.report.after.cutLen, r.report.before.cutLen) && near(r.report.after.deepest, r.report.before.deepest));
  ok('feed scale: run time reported', r.report.after.minutes < r.report.before.minutes);
  const c = E.scaleFeed(PROG, { factor: 2, which: 'cut' });
  ok('feed scale cut only keeps plunge F', lines(c.text)[14] === 'G1   Z-0.2500 F20.0' && lines(c.text)[15] === 'G1 X5.0000 F200.0', lines(c.text)[14] + '|' + lines(c.text)[15]);
  const pl = E.scaleFeed(PROG, { factor: 0.5, which: 'plunge' });
  ok('feed scale plunge only', lines(pl.text)[14] === 'G1   Z-0.2500 F10.0' && lines(pl.text)[15] === 'G1 X5.0000 F100.0');
  const t8 = E.scaleFeed(PROG, { factor: 2, tool: 8 });
  ok('feed scale one tool', lines(t8.text)[28] === 'G1 Z-1.5500 F60.0' && lines(t8.text)[14] === 'G1   Z-0.2500 F20.0');
  ok('feed limit is enforced', refused(() => E.scaleFeed(PROG, { factor: 20 }), 'OVER_LIMIT', 13), whyRefused(() => E.scaleFeed(PROG, { factor: 20 })));
  ok('inherited feed for one tool is refused', refused(() => E.scaleFeed('T1\nF100\nG0 X1 Z1\nG1 X2\nT2\nG0 X3\nG1 X4 Z-1\nT1\nG1 X1\n'.replace(/\n/g, '\n'), { factor: 2, tool: 2 }), 'NOTHING_TO_DO') || refused(() => E.scaleFeed('T1\nF100\nG0 X1 Z1\nG1 X2\nT2\nF50\nT1\nG0 X0\nT2\nG1 X4 Z-1\n', { factor: 2, tool: 2 })) , whyRefused(() => E.scaleFeed('T1\nF100\nG0 X1 Z1\nG1 X2\nT2\nG0 X3\nG1 X4 Z-1\n', { factor: 2, tool: 2 })));
  const s = E.scaleSpeed(PROG, { factor: 1.2 });
  ok('speed scale', lines(s.text)[7] === 'S21600' && lines(s.text)[23] === 'S12000', lines(s.text)[7]);
  ok('speed limit', refused(() => E.scaleSpeed(PROG, { factor: 2 }), 'OVER_LIMIT', 8));
}
// ---- Z edits ----
{
  const d = E.shiftCutDepth(PROG, { dz: -0.05 });
  const L = lines(d.text);
  ok('depth shift moves cuts', L[14] === 'G1   Z-0.3000 F20.0' && L[28] === 'G1 Z-1.6000 F30.0');
  ok('depth shift leaves retracts', L[19] === 'G0   Z0.8000' && L[6] === 'Z2.0000');
  ok('depth limit', refused(() => E.shiftCutDepth(PROG, { dz: -0.1, maxDepth: 1.6 }), 'TOO_DEEP', 29));
  ok('shallower-than-surface is refused', refused(() => E.shiftCutDepth(PROG, { dz: 0.3 }), 'WOULD_NOT_CUT', 15));
  ok('depth refuses incremental Z', refused(() => E.shiftCutDepth('G0 X1 Z1\nG91\nG1 Z-0.5 F10\n', { dz: -0.1 }), 'INCREMENTAL_Z', 3));
  const f = E.setFinalDepth(PROG, { z: -1.7 });
  ok('final depth changes only the deepest level', lines(f.text)[28] === 'G1 Z-1.7000 F30.0' && lines(f.text)[17] === 'G1 Z-0.5000 F20.0');
  ok('final depth keeps pass order', refused(() => E.setFinalDepth(PROG, { z: -0.25 }), 'PASS_ORDER'));
  const s = E.raiseSafeHeight(PROG, { z: 1 });
  ok('safe height raises retracts', lines(s.text)[19] === 'G0   Z1.0000' && lines(s.text)[13] === 'G0 X1.0000 Y1.0000 Z1.0000');
  ok('safe height does not touch the higher Z2', lines(s.text)[6] === 'Z2.0000' && lines(s.text)[31] === 'G0 Z2.0000');
  ok('safe height never lowers', refused(() => E.raiseSafeHeight(PROG, { z: 0.5 }), 'WOULD_LOWER'));
  ok('safe height above the limit is refused', refused(() => E.raiseSafeHeight(PROG, { z: 7 }), 'OVER_LIMIT'));
  ok('safe height honours G21', E.raiseSafeHeight('G21\nG0 X0 Z5\nG1 Z-1 F100\nG0 Z5\n', { z: 1 }).text.split('\n')[1] === 'G0 X0 Z25.4', 'mm');
  ok('safe height: report shows the rise', near(s.report.after.minRetract, 1) && near(s.report.before.minRetract, 0.8));
}
// ---- tool section removal ----
{
  const r = E.removeTool(PROG, { tool: 8 });
  const t = r.text;
  ok('tool removal: T8 gone', !/^T8/m.test(t) && !/Z-1\.5500/.test(t));
  ok('tool removal: footer kept', /G0 Z2\.0000\r\nG0 X0\.0000 Y115\.0000\r\n\r\nM5\r\nm51\r\n$/.test(t), t.slice(-80));
  ok('tool removal: unedited bytes identical', t === PROG.split('\r\n').filter((l, i) => !(i >= 20 && i <= 28)).join('\r\n'));
  ok('tool removal: report tools', r.report.after.tools.join() === '2' && r.report.before.tools.join() === '2,8');
  const f = E.removeTool(PROG, { tool: 2 });
  ok('removing the first tool keeps its retract', /Z2\.0000\r\nM5\r\nM51\r\nT8/.test(f.text) && f.notes.length === 1, f.text.slice(0, 80));
  ok('removing the first tool: no T2 left', !/^T2/m.test(f.text) && f.report.after.tools.join() === '8');
  ok('removing the only tool is refused', refused(() => E.removeTool('T1\nG0 X1 Z1\nG1 X2 Z-1 F10\n', { tool: 1 }), 'WOULD_BE_EMPTY'));
  ok('removing a missing tool is refused', refused(() => E.removeTool(PROG, { tool: 5 }), 'NOTHING_TO_DO'));
  const inh = 'T1\nS100\nM3\nF50\nG0 X1 Z1\nG1 Z-1\nG0 Z1\nT2\nG0 X2\nG1 Z-1\nG0 Z1\n';
  ok('a later tool relying on the removed feed is refused', refused(() => E.removeTool(inh, { tool: 1 }), 'VERIFY_FAILED'), whyRefused(() => E.removeTool(inh, { tool: 1 })));
}
// ---- what the archive taught us ----
{
  // a Z-only line before the first XY move has no XY of its own to translate; a Z after the park stays at the park
  const a = 'G0 Z0.8\nF10\nG0 X1 Y1\nG1 Z-1\nG0 Z0.8\nG0 X5 Y5\nG0 Z2\n';
  const r = E.translate(a, { dx: 1 });
  ok('Z-only line before XY and after park verify cleanly', r.text.split('\n')[2] === 'G0 X2 Y1' && r.text.split('\n')[5] === 'G0 X5 Y5', r.text);
  const f = E.scaleFeed('G0 X1 Z1\nG1 Z-0.75 F29.9\nG1 X2 F100.0\n', { factor: 0.9 });
  ok('feed scale keeps enough decimals to be exact', f.text.split('\n')[1] === 'G1 Z-0.75 F26.91', f.text.split('\n')[1]);
  const g1 = E.raiseSafeHeight('G0 X0 Z0.25\nG1 Z-1 F10\nG1 Z0.25\nG0 X5\nG1 Z-1\nG0 Z0.25\nG0 X0\n', { z: 1 });
  ok('safe height follows named Z only, and says what still travels low', g1.notes.some(n => /feed move/.test(n)), JSON.stringify(g1.notes));
  const pre = E.raiseSafeHeight('G0 X0 Z0.5\nG1 Z-1 F10\nG0 X5\nG0 Z0.5\n', { z: 1 });
  ok('a rapid in stock that was already there does not block the edit, but is named', pre.notes.some(n => /already has/.test(n)), JSON.stringify(pre.notes));
  const twoZ = 'T1\nZ2\nS100\nM3\nF50\nG0 X1 Z1\nG1 Z-1\nG0 Z1\nM5\nT2\nZ2\nS100\nM3\nF60\nG0 X2\nG1 Z-1\nG0 Z1\n';
  const rm = E.removeTool(twoZ, { tool: 1 });
  ok('removing a tool when the next starts with its own Z2', rm.report.after.tools.join() === '2' && !/^T1/m.test(rm.text), rm.text.slice(0, 80));
  const spin = 'T1\nM3\nS100\nF50\nG0 X1 Z1\nG1 Z-1\nG0 Z1\nT2\nS100\nG0 X2\nG1 Z-1\nG0 Z1\n';
  ok('removing a tool whose M3 the next tool needs is refused', refused(() => E.removeTool(spin, { tool: 1 }), 'VERIFY_FAILED'), whyRefused(() => E.removeTool(spin, { tool: 1 })));
}
// ---- text-level edit ----
{
  const a = 'G0 X1 Z1\nG1 Z-0.5 F20\nG0 Z1\n';
  const lowered = E.textEdit(a, 'G0 X1 Z0.05\nG1 Z-0.5 F20\nG0 Z0.05\n');
  ok('text edit reports a lowered retract', lowered.notes.some(n => /retract/.test(n)));
  const deep = E.textEdit(a, a.replace('Z-0.5', 'Z-0.75'));
  ok('text edit reports a deeper cut', deep.notes.some(n => /deeper/.test(n)) && deep.changes.length === 1 && deep.changes[0].line === 2);
  const j = E.textEdit(a, a + 'oops\n');
  ok('text edit simulates and names junk', j.report.after.issues.some(i => i.code === 'JUNK_TEXT' && i.line === 4));
  const same = E.textEdit(a, a);
  ok('text edit with no change has no changes', same.changes.length === 0);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
