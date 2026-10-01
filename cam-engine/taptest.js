// Guards tapcompare (the pass/fail gate) and tap2spec (recipe recovery). The gate matters most: a
// comparator that passes everything would wave a bad program onto the machine, so most checks here
// are things it MUST catch.
const CAM = require('./camcore.js');
const { compare, parseTap } = require('./tapcompare.js');
const { analyze, buildSpec } = require('./tap2spec.js');
const { repostJob } = require('./repost.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } };
const TOOLS = { 2: { dia: 0.25 }, 5: { dia: 0.125 } };
const sq = (x0, y0, w, h) => [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }, { x: x0, y: y0 }];
const post = ops => CAM.postProcess({ name: 't', units: 'inch', ops }, CAM.POSTS.shopsabre);
const prof = (pts, o) => CAM.profileOp(CAM.assembleContours([{ closed: true, pts }]), Object.assign({ side: 'outside', toolNum: 2, toolDia: 0.25, cutDepth: 1.5, passDepth: 1.5, feed: 100, plunge: 30, rpm: 24000, climb: false }, o)).ops;
const pock = (pts, o) => CAM.pocketOp(CAM.assembleContours([{ closed: true, pts }]), Object.assign({ toolNum: 2, toolDia: 0.25, cutDepth: 1.5, passDepth: 1.5, stepover: 0.5, feed: 100, plunge: 30, rpm: 24000, climb: false }, o)).ops;
const cmp = (a, b) => compare(a, b, { tools: TOOLS });

const base = post(prof(sq(0, 0, 10, 6)));
ok('identical program passes', cmp(base, base).pass);
ok('climb vs conventional (same cut) passes', cmp(base, post(prof(sq(0, 0, 10, 6), { climb: true }))).pass);
ok('wall moved 0.01" fails', !cmp(base, post(prof(sq(0, 0, 10.01, 6)))).pass);
ok('wall moved 0.003" passes (inside 0.005 bar)', cmp(base, post(prof(sq(0, 0, 10.003, 6)))).pass);
ok('shallower cut fails', !cmp(base, post(prof(sq(0, 0, 10, 6), { cutDepth: 1.4, passDepth: 1.4 }))).pass);
ok('added tab fails', !cmp(base, post(prof(sq(0, 0, 10, 6), { tabs: { count: 2, length: 0.5, height: 0.125 } }))).pass);
ok('inside instead of outside fails', !cmp(base, post(prof(sq(0, 0, 10, 6), { side: 'inside' }))).pass);
ok('two passes vs one to same depth passes', cmp(base, post(prof(sq(0, 0, 10, 6), { passDepth: 0.75 }))).pass);
const extra = post(prof(sq(0, 0, 10, 6)).concat(prof(sq(20, 0, 2, 2))));
ok('extra part cut fails', !cmp(base, extra).pass);
ok('missing tool fails', !cmp(base + '\nT5\nS12000\nG0 X1 Y1 Z0.5\nG1 Z-0.1 F30\nG1 X2 F60\nG0 Z0.5\n', base).pass);
const hole = sq(2, 2, 1, 1);
ok('pocket: different stepover, same cleared region, passes', cmp(post(pock(hole)), post(pock(hole, { stepover: 0.4 }))).pass);
ok('pocket vs outline only fails', !cmp(post(pock(hole)), post(prof(hole, { side: 'inside' }))).pass);
ok('parseTap: WinCNC bare "Z2" and incremental arcs', (() => {
  const t = parseTap('T2\nZ2\nS24000\nG0 X-0.125 Y0 Z0.2\nG1 Z-1.5 F30\nG3 X0 Y-0.125 I0.125 J0 F100\nG0 Z0.2\n')[0];
  const last = t.segs.filter(s => !s.rapid).pop();
  return t.tool === 2 && t.rpm === 24000 && Math.abs(last.x1) < 1e-6 && Math.abs(last.y1 + 0.125) < 1e-6;
})());

// tap2spec: recover the recipe from a program the engine itself wrote, then re-post and compare
const vec = { 'Layer 1': [{ closed: true, pts: sq(0, 0, 10, 6) }], Holes: [{ closed: true, pts: sq(2, 2, 1, 1) }, { closed: true, pts: sq(5, 2, 1, 1) }],
              Engrave: [{ closed: false, pts: [{ x: 1, y: 5 }, { x: 4, y: 5 }, { x: 4, y: 4 }] }] };
const prog = post([...pock(sq(2, 2, 1, 1)), ...pock(sq(5, 2, 1, 1)),
  ...CAM.profileOp(CAM.assembleContours([vec.Engrave[0]]), { side: 'on', toolNum: 5, toolDia: 0.125, cutDepth: 0.1, passDepth: 0.1, feed: 40, plunge: 40, rpm: 12000 }).ops,
  ...prof(sq(0, 0, 10, 6), { passDepth: 0.75, tabs: { count: 0 } })]);
const an = analyze(vec, [{ name: 'job', text: prog }]);
ok('tap2spec: every pass explained', an.unmatched.length === 0, JSON.stringify(an.unmatched));
const spec = { name: 'job', ops: buildSpec(an, { toolDia: T => (TOOLS[T] || {}).dia || null }).job };
const ops = spec.ops.map(o => o.op + (o.side ? ':' + o.side : '')).sort().join(',');
ok('tap2spec: finds pocket, on-line engrave, outside profile', ops === 'pocket,profile:on,profile:outside', ops);
const outside = spec.ops.find(o => o.side === 'outside');
ok('tap2spec: outside profile dia/depth/pass/direction', outside && outside.toolDia === 0.25 && outside.cutDepth === 1.5 && outside.passDepth === 0.75 && outside.climb === false, JSON.stringify(outside));
const pk = spec.ops.find(o => o.op === 'pocket');
ok('tap2spec: pocket tool and stepover', pk && pk.toolDia === 0.25 && Math.abs(pk.stepover - 0.5) < 0.02 && pk.select.length === 2, JSON.stringify(pk));
const re = repostJob(vec, Object.assign({}, spec, { reorder: false })).gcode;
ok('tap2spec round trip: re-posted program cuts the same part', cmp(prog, re).pass, require('./tapcompare.js').fmt(cmp(prog, re), 'orig', 're'));

console.log(`\n${pass}/${pass + fail} tap checks passed`);
process.exit(fail ? 1 : 0);
