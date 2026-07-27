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


// ---- CAM panel wiring: a control that exists in the markup but is never read (or is read
// but does not exist) is silently dead. These three were exactly that until Phase 1c:
// profileOp/postProcess honoured leadAngle, overcut and clearZ, but the studio could not
// set any of them, so the app could not reproduce a job the engine could.
const fs = require('fs'), path = require('path');
const shell = fs.readFileSync(path.join(__dirname, 'studio_shell.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'studio_app.js'), 'utf8');
for (const id of ['camClearZ', 'camLeadAngle', 'camOvercut']) {
  ok('shell defines #' + id, new RegExp('id="' + id + '"').test(shell));
  ok('app reads #' + id, app.includes("'" + id + "'"));
}
// and the params they feed must actually reach the engine
for (const key of ['clearZ', 'leadAngle', 'overcut']) {
  ok('camParams emits ' + key, new RegExp('\\b' + key + ':').test(app));
}

// ---- .tool import wiring: same dead-control risk. The importer is useless if the button
// is not in the markup, the file input is not listened to, or tooldbparse.js never makes it
// into the built page.
ok('shell defines #btnToolImport', /id="btnToolImport"/.test(shell));
ok('shell defines #toolDbFile', /id="toolDbFile"/.test(shell));
ok('app wires btnToolImport', app.includes("'btnToolImport'"));
ok('app listens to toolDbFile', app.includes("'toolDbFile'"));
ok('app calls ToolDb.parseToolDb', app.includes('ToolDb.parseToolDb'));
ok('app calls ToolDb.toolsToLibrary', app.includes('ToolDb.toolsToLibrary'));
const build = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
ok('build bundles tooldbparse.js', build.includes('tooldbparse.js'));
// ...and it must be bundled BEFORE studio_app.js or ToolDb is undefined at call time
ok('tooldbparse.js bundled before studio_app.js',
  build.indexOf('tooldbparse.js') < build.indexOf('studio_app.js'));

console.log(`\n${pass}/${pass + fail} smoke checks passed`);
process.exit(fail ? 1 : 0);
