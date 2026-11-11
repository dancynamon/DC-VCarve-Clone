// Guard for jig.js: board-jig stock (lane auto-fill, a 1.125" board's real top, the air-cut check, README parsing,
// cut-free parts). The last block replays Dan's real LGC files when the Dropbox folder is on this machine.
const fs = require('fs'), path = require('path'), os = require('os');
global.ClipperLib = require('./package/clipper.js');
const CAM = require('./camcore.js');
const S = require('./gcodesim.js');
const J = require('./jig.js');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);
const jig = J.PRESETS.lgc6;
const flat = r => () => ({ type: 'flat', radius: r || 0.125 });
const laneMid = k => J.laneX(jig, k).x0 + jig.boardW / 2;
// a program that plunges and runs a short slot in the given lanes at the given Y values
function prog(cuts, depth) {
  const g = ['G90', 'T3', 'Z1', 'F60'];
  for (const c of cuts) { const x = c.x != null ? c.x : laneMid(c.lane);
    g.push('G0 X' + x.toFixed(4) + ' Y' + c.y0.toFixed(4) + ' Z0.5', 'G1 Z' + (c.z != null ? c.z : (depth || -0.5)) + ' F20', 'G1 Y' + c.y1.toFixed(4) + ' F60', 'G0 Z0.5'); }
  return S.parseGcode(g.join('\n'));
}

// ---- geometry ----
{
  ok('6 lanes, 7.625 pitch, lane 1 at 4.188', near(J.laneX(jig, 1).x0, 4.188) && near(J.laneX(jig, 2).x0, 11.813) && near(J.laneX(jig, 6).x1, 4.188 + 5 * 7.625 + 3.5));
  const L = J.emptyLoad(jig); L[0] = { type: 'full', thickness: 1.5 }; L[1] = { type: 'ab', thickness: 1.125 }; L[2] = { type: 'a', thickness: 1.5 };
  const P = J.piecesFor(jig, L);
  ok('full + A+B + A only = 4 boards', P.length === 4, P.length);
  ok('97in board loads against the Y 0.5 stop', near(P[0].y0, 0.5) && near(P[0].h, 97));
  ok('piece B butts above piece A', near(P[2].y0, 49) && near(P[2].h, 48.5) && P[2].part === 'B');
  ok('1.5 board top is Z0', near(P[0].zTop, 0));
  ok('1.125 board top is Z -0.375 (boards sit on the table)', near(P[1].zTop, -0.375) && near(P[1].thickness, 1.125));
}

// ---- lane auto-fill ----
{
  const p = prog([{ lane: 1, y0: 5, y1: 20 }, { lane: 1, y0: 60, y1: 80 }, { lane: 3, y0: 5, y1: 30 }, { lane: 5, y0: 55, y1: 70 }]);
  const a = J.autoFill(jig, p, 'AM-LGC-50 - 1 LEGS - 3.5x97.tap', flat());
  ok('lanes with cuts get a 97in board', a[0].type === 'full' && a[2].type === 'full' && a[4].type === 'full', a.map(l => l.type).join());
  ok('lanes without cuts stay empty', a[1].type === 'empty' && a[3].type === 'empty' && a[5].type === 'empty');
  ok('thickness defaults to 1.5', a.every(l => l.thickness === 1.5));
  const b = J.autoFill(jig, p, 'AM-LGC-60 - 4 SHORT PARTS - 48.5in pieces - 1.5in.tap', flat());
  ok('48s job: cuts both sides of Y 49 -> A+B', b[0].type === 'ab', b[0].type);
  ok('48s job: cuts only below Y 49 -> piece A only', b[2].type === 'a', b[2].type);
  ok('48s job: cuts only above Y 49 still needs A under B', b[4].type === 'ab', b[4].type);
  ok('"48s" in the name also counts', J.autoFill(jig, p, 'job 48s.tap', flat())[0].type === 'ab');
  ok('a full job with cuts both sides is still a 97in board', a[0].type === 'full');
  // rapids and moves above Z0 do not load a lane; a cutter clipping a lane edge does
  const q = S.parseGcode('G90\nT3\nZ1\nG0 X' + laneMid(2) + ' Y5 Z0.5\nG0 Y40\nG1 X' + (J.laneX(jig, 4).x0 - 0.1) + ' Y5 Z-0.25 F20\nG1 Y20\n');
  const c = J.autoFill(jig, q, 'x.tap', flat(0.1875));
  ok('rapids over a lane do not load it', c[1].type === 'empty');
  ok('a cutter overlapping the lane edge loads it', c[3].type === 'full', c.map(l => l.type).join());
}

// ---- 1.125 board top: carving starts from the board's real top ----
{
  const L = J.emptyLoad(jig); L[0] = { type: 'full', thickness: 1.5 }; L[1] = { type: 'full', thickness: 1.125 };
  const p = prog([{ lane: 1, y0: 10, y1: 20, z: -0.875 }, { lane: 2, y0: 10, y1: 20, z: -0.875 }, { lane: 2, y0: 40, y1: 50, z: -0.25 }, { lane: 2, y0: 60, y1: 70, z: -1.5 }]);
  const jc = new J.JigCarver(CAM, S, p, J.piecesFor(jig, L), flat(), 0.05); jc.seek(p.n, 0);
  const [f1, f2] = jc.fields;
  const at = (f, x, y) => f.z[Math.floor((y - f.y0) / f.res) * f.nx + Math.floor((x - f.x0) / f.res)];
  ok('Z -0.875 cuts a 1.5 board 0.875 deep', near(at(f1, laneMid(1), 15), -0.875, 1e-4), at(f1, laneMid(1), 15));
  ok('Z -0.875 cuts a 1.125 board 0.5 deep', near(at(f2, laneMid(2), 15), -0.5, 1e-4), at(f2, laneMid(2), 15));
  ok('a cut above a 1.125 board top (Z -0.25) is air', at(f2, laneMid(2), 45) === 0, at(f2, laneMid(2), 45));
  ok('Z -1.5 goes through a 1.125 board to the table', near(at(f2, laneMid(2), 65), -1.125, 1e-4) && near(f2.floor, -1.125));
  ok('a board is only carved where the cutter overlaps it', at(f1, laneMid(1), 45) === 0 && at(f1, laneMid(1), 65) === 0);
  ok('carving reports which boards changed', (() => { const p2 = prog([{ lane: 2, y0: 10, y1: 12 }]); const c = new J.JigCarver(CAM, S, p2, J.piecesFor(jig, L), flat(), 0.05); c.seek(p2.n, 0); const d = c.takeDirty(); return d && d.length === 1 && d[0] === 1 && c.takeDirty() === null; })());
  // scrubbing backwards re-carves from fresh boards
  jc.seek(1, 0); ok('scrub back to the start leaves the boards uncut', at(f1, laneMid(1), 15) === 0 && at(f2, laneMid(2), 15) === 0);
}

// ---- air-cut check ----
{
  const L = J.emptyLoad(jig); L[0] = { type: 'full', thickness: 1.5 }; L[1] = { type: 'a', thickness: 1.5 }; L[2] = { type: 'ab', thickness: 1.5 };
  const p = prog([
    { lane: 1, y0: 5, y1: 90 },          // 0: fine
    { lane: 2, y0: 5, y1: 40 },          // fine
    { lane: 2, y0: 45, y1: 48.7 },       // fine (inside the 48.25 worst case)
    { lane: 2, y0: 47, y1: 48.9 },       // past A's worst-case end (48.75)
    { lane: 3, y0: 40, y1: 96.9 },       // fine across the A/B joint
    { lane: 3, y0: 90, y1: 97.2 },       // past B's worst-case end (97.0)
    { lane: 4, y0: 10, y1: 20 },         // empty lane
    { lane: 4, y0: 10, y1: 20, z: 0.2 }  // above Z0 in an empty lane: not a cut
  ]);
  const ac = J.airCuts(jig, p, L, flat());
  const lanes = ac.list.map(a => a.lane), reasons = ac.list.map(a => a.reason).join(' | ');
  ok('cuts inside the material are not flagged', !ac.list.some(a => a.lane === 1));
  ok('a cut over an Empty lane is flagged', ac.list.some(a => a.lane === 4 && /empty/.test(a.reason)), reasons);
  ok('a cut past piece A (48.25 worst case) is flagged', ac.list.some(a => a.lane === 2 && /piece A/.test(a.reason)), reasons);
  ok('a cut up to 48.7 on piece A is fine', ac.list.filter(a => a.lane === 2).length === 1, lanes.join());
  ok('a cut past A+B (97.0 worst case) is flagged', ac.list.some(a => a.lane === 3 && /piece B/.test(a.reason)), reasons);
  ok('moves above Z0 are never air cuts', ac.moves.every(i => Math.min(p.z0[i], p.z1[i]) < 0) && !ac.list.some(a => p.line[a.i] >= 34), lanes.join());
  ok('flagged moves are cutting moves', ac.moves.every(i => p.kind[i] !== S.RAPID));
  const sum = J.summarizeAir(ac);
  ok('summary groups by reason with source lines', sum.length === 3 && sum.every(g => g.count > 0 && g.line0 > 0), JSON.stringify(sum));
  const none = J.airCuts(jig, p, [{ type: 'full', thickness: 1.5 }, { type: 'full', thickness: 1.5 }, { type: 'full', thickness: 1.5 }, { type: 'full', thickness: 1.5 }, { type: 'empty', thickness: 1.5 }, { type: 'empty', thickness: 1.5 }], flat());
  ok('loading the lanes clears the warnings', none.moves.length === 0, JSON.stringify(J.summarizeAir(none)));
}

// ---- README run-order parsing ----
{
  const rd = [
    'Order 123 - same jig as always. Do NOT re-zero for the 1.125 (9/8) boards.',
    '12/8 = 1.5in 2x4.  9/8 = 1.125x3.5.',
    '',
    '1  AM-LGC-50 - 1 LEGS + LONG STEP          (full boards)',
    '     lanes 1,2 = 9/8   -> rear legs RL 50 x2',
    '     lanes 3,4 = 12/8  -> front legs FL 50 x2',
    '     lanes 5,6 = 9/8   -> long (bottom) step rails',
    '',
    '2  AM-LGC-60 - 2 LEGS + SEAT               (full boards)',
    '     lanes 1,2 = 12/8  -> front legs x2 (71.7in)',
    '     lanes 3,4 = 9/8   -> rear legs x2 (58.4in). Pocket depths already dropped 3/8 for 9/8 stock.',
    '     lane 5    = 12/8  -> 60.1in + 24.1in seat parts',
    '',
    '4  AM-LGC-60 - 4 SHORT PARTS               (48s, 12/8) - same as the normal 60 job 3, load as usual.',
    '',
    '5  AM-LGC-60 - 5 TOP STEP RAILS            (48s, 12/8) - lane 2 only: piece A against the bottom stop,',
    '     piece B butted above it. Cuts S1 x2 (33in).'
  ].join('\n');
  const r1 = J.parseRunOrder(rd, 'AM-LGC-50 - 1 LEGS + LONG STEP - 3.5x97 - MIXED.tap');
  ok('section picked by the .tap name', r1 && r1.section === 1, r1 && r1.section);
  ok('"lanes 1,2 = 9/8" -> 1.125', r1 && r1.lanes[1] === 1.125 && r1.lanes[2] === 1.125 && r1.lanes[5] === 1.125 && r1.lanes[6] === 1.125, JSON.stringify(r1));
  ok('"lanes 3,4 = 12/8" -> 1.5', r1 && r1.lanes[3] === 1.5 && r1.lanes[4] === 1.5);
  const r2 = J.parseRunOrder(rd, 'AM-LGC-60 - 2 LEGS + SEAT - 3.5x97 - MIXED.tap');
  ok('"lane 5    = 12/8" (singular, padded)', r2 && r2.lanes[5] === 1.5 && r2.lanes[3] === 1.125 && r2.lanes[6] === undefined, JSON.stringify(r2));
  ok('the preamble (9/8 mentioned) is not a lane line', r2 && Object.keys(r2.lanes).length === 5);
  const r5 = J.parseRunOrder(rd, 'AM-LGC-60 - 5 TOP STEP RAILS - 48.5in pieces - 1.5in.tap');
  ok('"lane 2 only" in a section heading', r5 && r5.only && r5.only.join() === '2', JSON.stringify(r5));
  ok('heading thickness (48s, 12/8) is the section default', r5 && r5.thickness === 1.5 && r5.pieces48);
  ok('a file the README does not list gets nothing', J.parseRunOrder(rd, 'AM-LGC-72 - 1 LEGS.tap') === null);
  ok('a README with no sections applies to every file', (() => { const r = J.parseRunOrder('lanes 1-3 = 1.125\nlane 6 = 1.5\n', 'anything.tap'); return r && r.lanes[1] === 1.125 && r.lanes[2] === 1.125 && r.lanes[3] === 1.125 && r.lanes[6] === 1.5; })());
  // applying it on top of the auto-fill
  const auto = J.emptyLoad(jig); for (let k = 0; k < 6; k++) auto[k].type = 'full';
  const L1 = J.applyRunOrder(jig, auto, r1);
  ok('README thicknesses override the 1.5 default', L1.map(l => l.thickness).join() === '1.125,1.125,1.5,1.5,1.125,1.125', L1.map(l => l.thickness).join());
  ok('applyRunOrder does not touch the auto-fill it was given', auto[0].thickness === 1.5);
  const L5 = J.applyRunOrder(jig, auto, r5);
  ok('"lane 2 only" empties the other lanes', L5.map(l => l.type).join() === 'empty,full,empty,empty,empty,empty', L5.map(l => l.type).join());
  ok('no README leaves the load alone', J.applyRunOrder(jig, auto, null).map(l => l.type + l.thickness).join() === auto.map(l => l.type + l.thickness).join());
}

// ---- cut-free parts ----
{
  const L = J.emptyLoad(jig); L[0] = { type: 'full', thickness: 1.5 };
  const x0 = J.laneX(jig, 1).x0 - 0.3, x1 = J.laneX(jig, 1).x1 + 0.3;
  // two through cuts across the board at Y 30 and Y 70 -> three parts (bottom offcut, 40in part, top offcut)
  const p = S.parseGcode(['G90', 'T3', 'Z1', 'G0 X' + x0 + ' Y30 Z0.5', 'G1 Z-1.5 F20', 'G1 X' + x1 + ' F60', 'G0 Z0.5', 'G0 X' + x0 + ' Y70', 'G1 Z-1.5 F20', 'G1 X' + x1 + ' F60', 'G0 Z0.5'].join('\n'));
  const jc = new J.JigCarver(CAM, S, p, J.piecesFor(jig, L), flat(0.1875), 0.05);
  jc.seek(0, 0); const whole = J.partsOf(jc.fields[0]);
  ok('an uncut board is one part, untinted', whole.parts.length === 1 && whole.tint.every(t => t === 0));
  jc.seek(p.n, 0); const f = jc.fields[0], P = J.partsOf(f);
  ok('two through cuts make three parts', P.parts.length === 3, P.parts.length);
  const mid = J.partAt(f, P, laneMid(1), 50);
  ok('part between the cuts is ~39.6in long', mid && near(mid.length, 40 - 0.375, 0.11), mid && mid.length);
  ok('hover hits the part, not the kerf', J.partAt(f, P, laneMid(1), 30) === null);
  const t0 = P.tint[Math.floor((10 - f.y0) / f.res) * f.nx + 20], t1 = P.tint[Math.floor((50 - f.y0) / f.res) * f.nx + 20];
  ok('neighbouring parts get different tints', t0 > 0 && t1 > 0 && t0 !== t1, t0 + '/' + t1);
  // a cut that is not through does not separate
  const q = S.parseGcode(['G90', 'T3', 'Z1', 'G0 X' + x0 + ' Y30 Z0.5', 'G1 Z-0.75 F20', 'G1 X' + x1 + ' F60', 'G0 Z0.5'].join('\n'));
  const jq = new J.JigCarver(CAM, S, q, J.piecesFor(jig, L), flat(0.1875), 0.05); jq.seek(q.n, 0);
  ok('a dado that is not through keeps the board whole', J.partsOf(jq.fields[0]).parts.length === 1);
  // a 0.125 holding tab still counts as separated (that is where the part snaps free)
  const t = S.parseGcode(['G90', 'T3', 'Z1', 'G0 X' + x0 + ' Y30 Z0.5', 'G1 Z-1.375 F20', 'G1 X' + x1 + ' F60', 'G0 Z0.5'].join('\n'));
  const jt = new J.JigCarver(CAM, S, t, J.piecesFor(jig, L), flat(0.1875), 0.05); jt.seek(t.n, 0);
  ok('a cut leaving a 0.125 tab separates the parts', J.partsOf(jt.fields[0]).parts.length === 2);
}

// ---- Dan's real LGC files (Dropbox), when present ----
{
  const D = path.join(os.homedir(), 'Dropbox/VCarve Pro/Aquamentor Lifeguard Chair/Customers/Amazon Tracey 113-1430256-5957036');
  if (!fs.existsSync(D)) console.log('  (skipped: real LGC test files not on this machine)');
  else {
    const lib = JSON.parse(fs.readFileSync(path.join(__dirname, 'shoptools.json'), 'utf8'));
    const toolFor = t => { const e = lib[t]; return e ? { type: e.type === 'ball' ? 'ball' : 'flat', radius: e.dia / 2 } : { type: 'flat', radius: 0.125 }; };
    const rd = fs.readFileSync(path.join(D, 'README - run order.txt'), 'utf8');
    const want = {
      'AM-LGC-50 - 1 LEGS + LONG STEP - 3.5x97 - MIXED.tap': 'full1.125,full1.125,full1.5,full1.5,full1.125,full1.125',
      'AM-LGC-60 - 2 LEGS + SEAT - 3.5x97 - MIXED.tap': 'full1.5,full1.5,full1.125,full1.125,full1.5,empty',
      'AM-LGC-60 - 4 SHORT PARTS - 48.5in pieces - 1.5in.tap': 'ab1.5,ab1.5,ab1.5,a1.5,empty,empty',
      'AM-LGC-60 - 5 TOP STEP RAILS - 48.5in pieces - 1.5in.tap': 'empty,ab1.5,empty,empty,empty,empty'
    };
    for (const f of Object.keys(want)) {
      const p = S.parseGcode(fs.readFileSync(path.join(D, f), 'utf8'));
      const L = J.applyRunOrder(jig, J.autoFill(jig, p, f, toolFor), J.parseRunOrder(rd, f));
      const got = L.map(l => l.type + (l.type === 'empty' ? '' : l.thickness)).join();
      ok('real file loads as the README says: ' + f, got === want[f], got);
      ok('no air cuts in a correctly loaded real file: ' + f, J.airCuts(jig, p, L, toolFor).moves.length === 0);
    }
    // 60 #2: the rear-leg pockets on the 9/8 boards (lanes 3,4) land 0.5in deep
    const f2 = 'AM-LGC-60 - 2 LEGS + SEAT - 3.5x97 - MIXED.tap', p2 = S.parseGcode(fs.readFileSync(path.join(D, f2), 'utf8'));
    const L2 = J.applyRunOrder(jig, J.autoFill(jig, p2, f2, toolFor), J.parseRunOrder(rd, f2));
    const pcs = J.piecesFor(jig, L2), k3 = pcs.findIndex(pc => pc.lane === 3);
    const jc = new J.JigCarver(CAM, S, p2, [pcs[k3]], toolFor, 0.05); jc.seek(p2.n, 0);
    const fz = jc.fields[0].z, depths = {}; for (const v of fz) if (v < -0.01 && v > jc.fields[0].floor + 1e-3) { const d = (-v).toFixed(2); depths[d] = (depths[d] || 0) + 1; }
    const top = Object.keys(depths).sort((a, b) => depths[b] - depths[a])[0];
    ok('60 #2 pockets on the 1.125 boards land 0.5in deep', top === '0.50', JSON.stringify(depths));
    ok('60 #2 lane 3 ends up as separate parts', J.partsOf(jc.fields[0]).parts.length >= 2);
  }
}

console.log(`\n${pass}/${pass + fail} jig checks passed`);
process.exit(fail ? 1 : 0);
