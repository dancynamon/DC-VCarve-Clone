// Headless smoke test: the studio "Self-test" four-op sequence, run purely through the CAM/CADCORE cores (no DOM).
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra || ''); } }

// sample design (same shapes the studio Self-test builds)
const rect = C.mkRect(6, 5, 12, 8);
const circ = C.mkCircle({ x: 21, y: 9 }, 1.5);
const rectC = CAM.assembleContours(C.shapesToContoursInput([rect]));
const circC = CAM.assembleContours(C.shapesToContoursInput([circ]));

const ops = {
  Profile: CAM.profileOp(rectC, { side: 'outside', toolDia: 0.25, cutDepth: 0.5, passDepth: 0.25, leadType: 'arc', leadLen: 0.25, rampLen: 0.15 }),
  Pocket:  CAM.pocketOp(rectC,  { toolDia: 0.25, stepover: 0.4, cutDepth: 0.3, passDepth: 0.25 }),
  Drill:   CAM.drillOp(circC,   { toolDia: 0.25, cutDepth: 0.4, peck: 0.1 }),
  'V-Carve': CAM.vcarveOp(rectC, { bitAngle: 90, step: 0.05, maxDepth: 0.3 }),
};
const posts = { shopsabre: CAM.POSTS.shopsabre, generic: CAM.POSTS.generic };

// 4 ops x 2 posts = 8 checks: each op produces passes AND posts to non-empty g-code on each post
for (const opName of Object.keys(ops)) {
  const res = ops[opName];
  const passes = res.ops[0].passes.length;
  for (const postName of Object.keys(posts)) {
    const g = passes > 0 ? CAM.postProcess({ name: opName, units: 'inch', ops: res.ops }, posts[postName]) : '';
    ok(opName + ' / ' + postName, passes > 0 && g.length > 0, 'passes=' + passes + ' glen=' + g.length);
  }
}

console.log(`\n${pass}/${pass + fail} smoke checks passed`);
process.exit(fail ? 1 : 0);
