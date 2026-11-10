// Guard for the 3D engine window's pure parts: where a program sits on the table, what it warns about, and how playback counts moves.
const G = require('./gcodesim.js'), E = require('./cncengine.js');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t === undefined ? 1e-6 : t);
const table = { w: 60, h: 120 };
const sum = (text, job, tbl) => { const p = G.parseGcode(text), pl = E.placement(p, job || null); return { p, pl, s: E.summarize(p, G, pl, { table: tbl || table, rapid: 300 }) }; };
const prog = ['G20', 'T1', 'M3 S18000', 'G0 Z0.5', 'G0 X1 Y1', 'G1 Z-0.25 F20', 'G1 X11 F100', 'G0 Z0.5', 'T2', 'G0 X20 Y2', 'G1 Z-0.5 F10', 'G1 Y12 F50', 'G0 Z1', ''].join('\n');

{ // a bare program
  const { p, pl, s } = sum(prog);
  ok('bare program: X0 Y0 is the table corner', pl.dx === 0 && pl.dy === 0 && pl.assumedOrigin);
  ok('bare program: the bed sits at the deepest cut', near(pl.bedZ, -0.5), pl.bedZ);
  ok('bare program: it says the origin is assumed', s.warnings.some(w => w.level === 'note' && /work origin/.test(w.msg)));
  ok('cut area', near(s.cut.x0, 1) && near(s.cut.x1, 20) && near(s.cut.y1, 12), JSON.stringify(s.cut));
  ok('deepest Z and lowest retract', near(s.deepest, -0.5) && near(s.clearance, 0.5), s.deepest + ' ' + s.clearance);
  const t1 = s.tools.find(t => t.tool === 1), t2 = s.tools.find(t => t.tool === 2);
  ok('per-tool lengths', near(t1.cut, 10) && near(t1.plunge, 0.75) && near(t2.cut, 10), JSON.stringify(s.tools));
  ok('per-tool feed time', near(t1.minutes, 10 / 100 + 0.75 / 20, 1e-6), t1.minutes);
  ok('per-tool depth', near(t1.deepest, -0.25) && near(t2.deepest, -0.5));
  ok('a clean program has no red flags', !s.warnings.some(w => w.level === 'bad'), JSON.stringify(s.warnings));
  const gs = E.buildGroups(p, G, pl), keys = gs.map(g => g.key).sort().join();
  ok('one group per tool plus rapids', keys === '1,2,r', keys);
  ok('every move is in exactly one group', gs.reduce((n, g) => n + g.n, 0) === p.n);
  const g1 = gs.find(g => g.key === 1), i = g1.idx[1];
  ok('group positions are the move', near(g1.pos[6], p.x0[i]) && near(g1.pos[9], p.x1[i]) && near(g1.pos[11], p.z1[i]));
  ok('countBefore', E.countBefore(Int32Array.from([2, 5, 9]), 0) === 0 && E.countBefore(Int32Array.from([2, 5, 9]), 5) === 1 && E.countBefore(Int32Array.from([2, 5, 9]), 6) === 2 && E.countBefore(Int32Array.from([2, 5, 9]), 99) === 3);
}
{ // a job with stock and a centred origin
  const job = { x0: -5, y0: -10, x1: 5, y1: 10, thickness: 0.75 };
  const { p, pl, s } = sum('G0 Z0.5\nG0 X-4 Y-9\nG1 Z-0.75 F20\nG1 X4 F100\nG0 Z0.5\n', job);
  ok('job: the stock sits at the table corner', pl.dx === 5 && pl.dy === 10 && pl.stock.x1 === 10 && pl.stock.y1 === 20);
  ok('job: the bed is under the stock', pl.bedZ === -0.75);
  ok('job: cuts are shifted with it', near(s.cut.x0, 1) && near(s.cut.y0, 1), JSON.stringify(s.cut));
  ok('job: no origin note', !s.warnings.some(w => w.level === 'note'));
  const g = E.buildGroups(p, G, pl).find(q => q.key !== 'r'); ok('job: drawn positions are shifted', near(g.pos[0], 1) && near(g.pos[1], 1), g.pos[0]);
  const deep = sum('G0 Z0.5\nG0 X0 Y0\nG1 Z-1 F20\nG0 Z0.5\n', job).s;
  ok('job: cutting past the stock is flagged', deep.warnings.some(w => /spoilboard/.test(w.msg)), JSON.stringify(deep.warnings));
}
{ // warnings
  const off = sum('G0 Z0.5\nG0 X70 Y1\nG1 Z-0.1 F20\nG0 Z0.5\n').s;
  ok('cuts off the table are red', off.warnings.some(w => w.level === 'bad' && /off the 60 x 120/.test(w.msg)), JSON.stringify(off.warnings));
  const park = sum('G0 Z0.5\nG0 X1 Y1\nG1 Z-0.1 F20\nG0 Z2\nG0 X1 Y130\n').s;
  ok('a rapid past the table is a warning, not a cut error', park.warnings.some(w => w.level === 'warn' && /rapid goes past/.test(w.msg)) && !park.warnings.some(w => w.level === 'bad'), JSON.stringify(park.warnings));
  const big = sum('G0 Z0.5\nG0 X70 Y1\nG1 Z-0.1 F20\nG0 Z0.5\n', null, { w: 80, h: 120 }).s;
  ok('the table size setting decides what is off it', !big.warnings.some(w => w.level === 'bad'), JSON.stringify(big.warnings));
  const rapidIn = sum('G0 Z0.5\nG0 X1 Y1\nG1 Z-0.2 F20\nG0 X5 Y1\nG0 Z0.5\n').s;
  ok('a rapid through the stock is red and names the line', rapidIn.warnings.some(w => w.level === 'bad' && /line 4/.test(w.msg)), JSON.stringify(rapidIn.warnings));
  const neg = sum('G0 Z0.5\nG0 X-3 Y-2\nG1 Z-0.1 F20\nG1 X3 F60\nG0 Z0.5\n'), n = neg.pl;
  ok('a negative-coordinate program is slid onto the table and says so', n.dx === 3 && n.dy === 2 && neg.s.warnings.some(w => /slid onto the table/.test(w.msg)), JSON.stringify(n));
  const mm = sum('G21\nG0 Z12.7\nG0 X25.4 Y25.4\nG1 Z-25.4 F500\nG1 X50.8 F1000\nG0 Z12.7\n');
  ok('a metric program is drawn in inches', near(mm.s.cut.x1, 2) && near(mm.s.deepest, -1), JSON.stringify(mm.s.cut));
}
{ // the window's HTML
  const h = E.page(['var a=1;', 'var b=2;']);
  ok('page: carries the scripts in order', h.indexOf('var a=1;') > 0 && h.indexOf('var b=2;') > h.indexOf('var a=1;') && h.indexOf('CNCENGINE.start()') > h.indexOf('var b=2;'));
  ok('fmtTime', E.fmtTime(1.5) === '1:30' && E.fmtTime(61) === '1:01:00', E.fmtTime(61));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
