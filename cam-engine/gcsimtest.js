// Guard for gcodesim.js: G-code parsing, the playback timeline, and live carving forwards and backwards.
const fs = require('fs'), path = require('path');
global.ClipperLib = require('./package/clipper.js');
const CAM = require('./camcore.js');
const S = require('./gcodesim.js');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);

// ---- parsing ----
{
  const g = ['G90', 'M3 S18000', 'T3', 'Z2', 'F60', 'G0 X1 Y1 Z0.5', 'G1 Z-0.25 F20', 'G1 X3 F60', 'G2 X5 Y1 I1 J0', 'G0 Z2', 'M5'].join('\r\n');
  const p = S.parseGcode(g);
  ok('Z-only first move sets Z without a move', p.firstZ === 2);
  ok('rapid to start', p.kind[0] === S.RAPID && p.x1[0] === 1 && p.y1[0] === 1 && p.z1[0] === 0.5, JSON.stringify([p.kind[0], p.x1[0], p.z1[0]]));
  ok('pure Z-down G1 is a plunge', p.kind[1] === S.PLUNGE && p.z1[1] === -0.25 && p.feed[1] === 20);
  ok('G1 X is a cut at the new F', p.kind[2] === S.CUT && p.x1[2] === 3 && p.feed[2] === 60);
  ok('tool number carried', p.tool[2] === 3 && p.tools.join() === '3');
  ok('spindle rpm while M3', p.rpm[2] === 18000);
  const arc = []; for (let i = 0; i < p.n; i++) if (p.line[i] === 9) arc.push(i);
  ok('G2 arc split into chords on one source line', arc.length > 10, arc.length);
  const last = arc[arc.length - 1];
  ok('arc ends exactly on its end point', p.x1[last] === 5 && p.y1[last] === 1);
  let maxR = 0, minY = 9; for (const i of arc) { maxR = Math.max(maxR, Math.abs(Math.hypot(p.x1[i] - 4, p.y1[i] - 1) - 1)); minY = Math.min(minY, p.y1[i]); }
  ok('arc chords sit on the circle', maxR < 1e-9, maxR);
  ok('G2 from (3,1) about (4,1) runs clockwise over the top', minY >= 1 - 1e-9 && p.y1[arc[Math.floor(arc.length / 2)]] > 1.9);
  ok('bounds (cut bounds exclude the approach rapid)', p.bounds.x1 === 5 && p.bounds.z0 === -0.25 && p.bounds.z1 === 2 && p.bounds.cutX0 === 1 && p.bounds.cutY0 === 1, JSON.stringify(p.bounds));
}
// ---- WinCNC dwell, comments, full circle ----
{
  const p = S.parseGcode('(job)\nG90\nZ1\ng4 x 4\nG0 X0 Y0\nG1 Z-0.1 F10\nG3 X0 Y0 I1 J0 F50 ; full circle\n');
  ok('dwell read from G4 X', p.dwell === 4);
  const tl = S.timeline(p, 300);
  ok('dwell pauses the clock before the next move', near(tl.t0[0], 4 / 60) && p.pause[0] === 4);
  let L = 0; for (let i = 0; i < p.n; i++) if (p.line[i] === 7) L += tl.len[i];
  ok('full-circle G3 length = 2πr', near(L, 2 * Math.PI, 2e-3), L);
  const loc = S.locate(tl, p.n, tl.total / 2);
  ok('locate returns a move and fraction', loc.i >= 0 && loc.i < p.n && loc.u >= 0 && loc.u <= 1);
  ok('locate past the end = finished', S.locate(tl, p.n, tl.total + 1).i === p.n);
}
// ---- timeline rates ----
{
  const p = S.parseGcode('G0 X0 Y0 Z1\nG0 X10\nG1 Z-1 F20\nG1 X20 F100\n');
  const tl = S.timeline(p, 200);
  ok('rapid at rapid rate', near(tl.t0[1] - tl.t0[0], 10 / 200));
  ok('plunge at its F', near(tl.t0[2] - tl.t0[1], 2 / 20));
  ok('cut at its F', near(tl.t0[3] - tl.t0[2], 10 / 100));
  ok('totals', near(tl.cutLen, 10) && near(tl.plungeLen, 2) && near(tl.rapidLen, 10));
}
// ---- carving matches the batch sim, and runs backwards ----
{
  const g = 'Z1\nG0 X1 Y1\nG1 Z-0.25 F20\nG1 X4 F60\nG1 Y3\nG0 Z1\nG0 X2 Y2\nG1 Z-0.5 F20\nG0 Z1\n';
  const p = S.parseGcode(g);
  const stock = { x0: 0, y0: 0, w: 5, h: 4, thickness: 0.75, res: 0.05 };
  const tool = { type: 'flat', radius: 0.125 };
  const c = new S.Carver(CAM, p, stock, () => tool);
  c.seek(p.n, 0);
  const segs = []; for (let i = 0; i < p.n; i++) segs.push({ x0: p.x0[i], y0: p.y0[i], z0: p.z0[i], x1: p.x1[i], y1: p.y1[i], z1: p.z1[i] });
  const batch = CAM.simulateStock(Object.assign({ cuts: [{ tool, segs }] }, stock));
  let diff = 0; for (let i = 0; i < batch.z.length; i++) diff = Math.max(diff, Math.abs(batch.z[i] - c.field.z[i]));
  ok('carving to the end = batch simulateStock', diff < 1e-9, diff);
  ok('a Z-only plunge drills a hole', near(CAM.stockHeightAt(c.field, 2, 2), -0.5));
  // step through move by move — the same as one jump
  const c2 = new S.Carver(CAM, p, stock, () => tool);
  for (let i = 0; i <= p.n; i++) for (const u of [0, 0.3, 0.7]) c2.seek(i, u);
  let d2 = 0; for (let i = 0; i < batch.z.length; i++) d2 = Math.max(d2, Math.abs(batch.z[i] - c2.field.z[i]));
  ok('stepping in small increments = one jump', d2 < 1e-9, d2);
  // back to the middle of the X cut: the Y leg and the hole are gone again
  let iCut = -1; for (let i = 0; i < p.n; i++) if (p.line[i] === 4) iCut = i;
  c.seek(iCut, 0.5);
  ok('seeking backwards re-carves from an empty block', near(CAM.stockHeightAt(c.field, 2, 2), 0) && near(CAM.stockHeightAt(c.field, 4, 2.5), 0));
  ok('...and keeps what was cut before that point', near(CAM.stockHeightAt(c.field, 1.5, 1), -0.25) && near(CAM.stockHeightAt(c.field, 3.6, 1), 0), CAM.stockHeightAt(c.field, 3.6, 1));
  const d = c.takeDirty();
  ok('dirty box reported then cleared', d && d.i0 === 0 && c.takeDirty() === null);
}
// ---- V-bit kernel through the carver ----
{
  const p = S.parseGcode('Z1\nG0 X1 Y1\nG1 Z-0.2 F20\nG1 X3 F60\n');
  const c = new S.Carver(CAM, p, { x0: 0, y0: 0, w: 4, h: 2, thickness: 0.5, res: 0.01 }, () => ({ type: 'v', radius: 0.25, angle: 90 }));
  c.seek(p.n, 0);
  ok('90° V groove: tip depth at centre', near(CAM.stockHeightAt(c.field, 2, 1.005), -0.2, 0.012), CAM.stockHeightAt(c.field, 2, 1.005));
  ok('90° V groove: 0.1" off-centre is half as deep', near(CAM.stockHeightAt(c.field, 2, 1.105), -0.1, 0.012), CAM.stockHeightAt(c.field, 2, 1.105));
}

// ---- two-sided: the other side's cuts set this side's floors ----
{
  const stock = { x0: 0, y0: 0, w: 4, h: 2, thickness: 1, res: 0.05 }, tool = { type: 'flat', radius: 0.125 };
  // bottom side: a 0.6" deep slot along y at x = 1 (in the bottom frame), and a through hole at (3,1)
  const bot = new S.Carver(CAM, S.parseGcode('Z1\nG0 X1 Y0.2\nG1 Z-0.6 F20\nG1 Y1.8 F60\nG0 Z1\nG0 X3 Y1\nG1 Z-1 F20\nG0 Z1\n'), stock, () => tool);
  bot.seek(bot.p.n, 0);
  const floors = S.floorsFromOtherSide(bot.field, 'h');
  ok('floors: uncut cell = full thickness', near(floors[Math.floor(1 / 0.05) * 80 + 40], -1));
  // flipped left-right: bottom x=1 is top x=3
  const top = new S.Carver(CAM, S.parseGcode('Z1\nG0 X0.5 Y1\nG1 Z-0.5 F20\nG1 X3.5 F60\nG0 Z1\n'), Object.assign({ floors }, stock), () => tool);
  ok('floors: the other side\'s through hole starts open (mirrored)', near(CAM.stockHeightAt(top.field, 1, 1), -1));
  top.seek(top.p.n, 0);
  ok('a 0.5" groove crossing the 0.6" slot from below breaks through there', near(CAM.stockHeightAt(top.field, 3, 1), -1));
  ok('...and is 0.5" deep elsewhere', near(CAM.stockHeightAt(top.field, 2, 1), -0.5));
  top.seek(0, 0);
  ok('rewinding restores the other side\'s holes, not a blank block', near(CAM.stockHeightAt(top.field, 1, 1), -1) && near(CAM.stockHeightAt(top.field, 3, 1), 0));
}
// ---- rotary: Y posts as A degrees and plays back unwrapped ----
{
  global.ClipperLib = global.ClipperLib || require('./package/clipper.js');
  const D = 4, circ = Math.PI * D;
  const op = CAM.profileOp([{ closed: false, pts: [{ x: 1, y: 0 }, { x: 1, y: circ / 4 }, { x: 3, y: circ / 4 }] }], { side: 'on', toolDia: 0.25, cutDepth: 0.1, passDepth: 0.1 }).ops[0];
  const g = CAM.postProcess({ name: 'r', units: 'inch', ops: [op] }, Object.assign({}, CAM.POSTS.shopsabre, { rotary: { diameter: D, y0: 0 } }));
  ok('rotary post: a quarter turn is A90', /A90\.0000/.test(g) && !/ Y\d/.test(g.replace(/^G0 X0\.0000 Y115\.0000$/m, '')), g.split('\r\n').filter(l => /A/.test(l)).slice(0, 3).join('|'));
  ok('rotary post: no arcs', !/^G[23] /m.test(g));
  const p = S.parseGcode(g, { aToY: circ / 360 });
  let maxY = 0; for (let i = 0; i < p.n; i++) if (p.z1[i] < 0) maxY = Math.max(maxY, p.y1[i]);
  ok('rotary playback: A unwraps back to Y', near(maxY, circ / 4, 1e-3), maxY);
}
// ---- tool defaults for imported programs ----
{
  const lib = CAM.defaultTools();
  const v = S.toolForNumber(lib, 3);
  ok('T number matches the tool library preset', v.type === 'v' && v.radius === 0.25 && v.angle === 60);
  ok('unknown T = 1/4" flat', S.toolForNumber(lib, 99).radius === 0.125);
  ok('per-T override wins', S.toolForNumber(lib, 3, { 3: { type: 'flat', dia: 0.5 } }).radius === 0.25 && S.toolForNumber(lib, 3, { 3: { type: 'flat', dia: 0.5 } }).type === 'flat');
}
// ---- a real Vectric WinCNC file ----
{
  const f = path.join(__dirname, '..', 'CAD', 'LGC 50 Job 1 Board 3.tap');
  if (fs.existsSync(f)) {
    const p = S.parseGcode(fs.readFileSync(f, 'utf8'));
    ok('real .tap parses with moves', p.n > 100, p.n);
    ok('real .tap tools and a 4 s dwell per tool', p.tools.indexOf(8) >= 0 && p.dwell % 4 === 0 && p.dwell >= 4 * p.tools.length, p.tools.join() + ' / ' + p.dwell);
    ok('real .tap cuts 1.5" deep', near(p.bounds.z0, -1.5, 0.05), p.bounds.z0);
    const tl = S.timeline(p, 300);
    ok('real .tap has a positive run time', tl.total > 1, tl.total);
    ok('no G91 warnings on a Vectric file', p.warnings.length === 0, p.warnings[0]);
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
