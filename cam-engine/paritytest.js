/* paritytest.js - the parity harness runner.  `npm run parity`
   Two jobs:
   1. SELF-VERIFICATION (always runs, needs no fixtures). Proves the differ is
      trustworthy before any real Vectric file exists:
        - FORMAT VARIANTS of our own output (modal-collapsed, commented+numbered,
          whitespace/case noise, metric) must all read as PARITY. If one fails,
          the parser is dialect-sensitive and would raise false alarms on a real
          Vectric file.
        - SEMANTIC MUTATIONS (flipped arc, wrong depth, dropped pass, shifted X,
          wrong feed) must all read as DIFF. If one passes, the differ is blind
          and would green-light a program that cuts the wrong part.
   2. FIXTURE MODE (runs when cam-engine/fixtures/parity/<job>/ exists). Compares
      a real Vectric-posted reference.tap against ours for the same job. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
const GP = require('./gcodeparse.js');
const P = require('./parity.js');

// dxfparse.js is a browser-concatenated script (no module.exports) - same vm trick importtest.js uses
let parseDxf, entityToPolys;
try {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8'), ctx);
  parseDxf = ctx.parseDxf; entityToPolys = ctx.entityToPolys;
} catch (e) { /* leave undefined -> the per-fixture check below fails clearly */ }

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL', name, extra || ''); } }

const facts = txt => P.normalize(GP.parse(txt));
const cmp = (refTxt, ourTxt) => P.compare(facts(refTxt), facts(ourTxt));

// ---------- a reference program with arcs, tabs, multipass and two ops ----------
const rect = C.mkRect(6, 5, 12, 8);
const circ = C.mkCircle({ x: 21, y: 9 }, 1.5);
const rectC = CAM.assembleContours(C.shapesToContoursInput([rect]));
const circC = CAM.assembleContours(C.shapesToContoursInput([circ]));
const prof = CAM.profileOp(rectC, {
  side: 'outside', toolDia: 0.25, cutDepth: 0.5, passDepth: 0.25, feed: 120, plunge: 60, rpm: 18000,
  toolNum: 9, leadType: 'arc', leadLen: 0.25, rampLen: 0.15, tabs: { count: 4, length: 0.4, height: 0.1 },
});
const drill = CAM.drillOp(circC, { toolDia: 0.25, cutDepth: 0.4, peck: 0.1, feed: 60, plunge: 30, rpm: 18000, toolNum: 9 });
const job = { name: 'parity-self', units: 'inch', ops: prof.ops.concat(drill.ops) };
const SHOP = CAM.postProcess(job, CAM.POSTS.shopsabre);
const GEN = CAM.postProcess(job, CAM.POSTS.generic);

ok('reference program has cutting passes', facts(SHOP).passCount > 0, 'passCount=' + facts(SHOP).passCount);
ok('reference program has arcs', facts(SHOP).passes.some(p => p.arcs.length), 'no G2/G3 emitted');
ok('reference program has tab lifts', facts(SHOP).tabLifts > 0, 'tabLifts=' + facts(SHOP).tabLifts);
ok('identical text is parity', cmp(SHOP, SHOP).equivalent);
ok('shopsabre vs generic are parity', cmp(SHOP, GEN).equivalent, P.report(cmp(SHOP, GEN), 'post-vs-post'));

// ---------- format variants: same job, different dialect ----------
const AXIS = /([XYZIJRF])\s*(-?[\d.]+)/g;

// drop redundant modal words the way a terser post would
function modalCollapse(txt) {
  let lastG = null, lastF = null;
  return txt.split(/\r?\n/).map(l => {
    let s = l, m = s.match(/^\s*(G[0-3])\b/i);
    if (m) { const g = m[1].toUpperCase(); if (g === lastG) s = s.replace(/^\s*G[0-3]\b\s*/i, ''); lastG = g; }
    const f = s.match(/F([\d.]+)/i);
    if (f) { if (f[1] === lastF) s = s.replace(/\s*F[\d.]+/i, ''); lastF = f[1]; }
    return s;
  }).join('\r\n');
}
// comments + line numbers, the way Vectric writes them
function addNoise(txt) {
  let n = 10;
  return txt.split(/\r?\n/).map(l => {
    if (!l.trim()) return '(  )';
    return `N${n += 10} ${l}  (move ${n})`;
  }).join('\n');
}
// deterministic on purpose: a test that varies run to run cannot be trusted as a gate
function caseNoise(txt) {
  return txt.split(/\r?\n/).map((l, i) => (i % 2 ? l.toLowerCase() : l) + '   ').join('\n');
}
// convert to millimetres, the way a metric post would write the same job
function toMetric(txt) {
  return txt.split(/\r?\n/).map(l => {
    if (/g4/i.test(l)) return l;                       // G4's X is a dwell TIME, not an axis
    return l.replace(/G20/i, 'G21').replace(AXIS, (_, a, v) => a + (parseFloat(v) * 25.4).toFixed(4));
  }).join('\n');
}

const variants = {
  'modal-collapsed': modalCollapse(SHOP),
  'commented+numbered': addNoise(SHOP),
  'case/whitespace noise': caseNoise(SHOP),
  'metric (G21, x25.4)': toMetric(GEN),
};
for (const [name, txt] of Object.entries(variants)) {
  const base = name.startsWith('metric') ? GEN : SHOP;
  // guard against a false green: a transform whose regex matched nothing would
  // "pass" while testing nothing at all
  ok('variant actually rewrote the text: ' + name, txt !== base, 'transform was a no-op');
  const r = cmp(base, txt);
  ok('variant reads as PARITY: ' + name, r.equivalent, '\n' + P.report(r, name));
}

// ---------- mutations: the differ must catch every one ----------
function flipArc(txt) { let done = false; return txt.replace(/^(G2|G3)\b/gim, m => (done ? m : (done = true, m === 'G2' ? 'G3' : 'G2'))); }
function shiftDepth(txt) { let done = false; return txt.replace(/Z(-[\d.]+)/g, (m, v) => (done ? m : (done = true, 'Z' + (parseFloat(v) - 0.05).toFixed(4)))); }
function dropPass(txt) {
  const L = txt.split(/\r?\n/), starts = [];
  L.forEach((l, i) => { if (/^G0\s+X/i.test(l)) starts.push(i); });
  if (starts.length < 2) return txt;
  L.splice(starts[0], starts[1] - starts[0]);
  return L.join('\r\n');
}
function shiftX(txt) { return txt.replace(/X(-?[\d.]+)/g, (_, v) => 'X' + (parseFloat(v) + 0.05).toFixed(4)); }
function changeFeed(txt) { return txt.replace(/F([\d.]+)/g, (_, v) => 'F' + (parseFloat(v) + 25).toFixed(1)); }

const mutations = {
  'flipped arc direction': flipArc(SHOP),
  'cut 0.05" deeper': shiftDepth(SHOP),
  'dropped a whole pass': dropPass(SHOP),
  'shifted X by 0.05"': shiftX(SHOP),
  'wrong feed rate': changeFeed(SHOP),
};
for (const [name, txt] of Object.entries(mutations)) {
  ok('mutation actually rewrote the text: ' + name, txt !== SHOP, 'transform was a no-op');
  const r = cmp(SHOP, txt);
  const caught = r.checks.filter(c => !c.ok).map(c => c.name);
  ok('mutation CAUGHT: ' + name, !r.equivalent, 'differ reported parity - it is blind to this');
  if (!r.equivalent) ok('  -> named by a check: ' + caught.join(','), caught.length > 0);
}

// ---------- fixture mode ----------
const FIX = path.join(__dirname, 'fixtures', 'parity');
let fixtures = [];
if (fs.existsSync(FIX)) fixtures = fs.readdirSync(FIX)
  .filter(d => !d.startsWith('_') && !d.startsWith('.'))          // _template/ etc. are not fixtures
  .filter(d => fs.statSync(path.join(FIX, d)).isDirectory());

if (!fixtures.length) {
  console.log(`\n  (no fixtures yet - drop a real Vectric job in cam-engine/fixtures/parity/<name>/`);
  console.log(`   see fixtures/parity/README.md. Self-verification above still proves the differ.)`);
} else {
  console.log('');
  const pending = [];
  for (const name of fixtures) {
    const dir = path.join(FIX, name);
    const refPath = path.join(dir, 'reference.tap');
    if (!fs.existsSync(refPath)) { ok(`fixture ${name}: reference.tap present`, false, 'missing reference.tap'); continue; }
    const ref = fs.readFileSync(refPath, 'utf8');

    // Every fixture's source geometry must stay importable. This is the cheapest
    // possible early warning: if dxfparse regresses, the parity fixtures go
    // unbuildable, and we want to hear about it here rather than mid-diff.
    const dxfPath = path.join(dir, 'source.dxf');
    if (fs.existsSync(dxfPath)) {
      try {
        const ents = parseDxf(fs.readFileSync(dxfPath, 'utf8'));
        const polys = []; for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
        const shapes = C.dxfPolysToShapes(polys);
        const contours = CAM.assembleContours(C.shapesToContoursInput(shapes));
        const closed = contours.filter(c => c.closed).length;
        ok(`fixture ${name}: source.dxf imports to closed contours`,
          shapes.length > 0 && closed > 0, `shapes=${shapes.length} closed=${closed}`);
      } catch (e) {
        ok(`fixture ${name}: source.dxf imports to closed contours`, false, e.message);
      }
    }

    let ours = null;
    if (fs.existsSync(path.join(dir, 'ours.tap'))) ours = fs.readFileSync(path.join(dir, 'ours.tap'), 'utf8');
    else if (fs.existsSync(path.join(dir, 'job.js'))) {
      try { ours = require(path.join(dir, 'job.js'))({ CAM, C, parseDxf, entityToPolys, dir, fs, path }); }
      catch (e) { ok(`fixture ${name}: job.js runs`, false, e.message); continue; }
    }
    // A reference with no `ours` side yet is QUEUED WORK, not a regression. Failing
    // here would make `npm test` red just for banking a job, which would push us
    // toward not banking them - exactly backwards.
    if (ours == null) {
      const geom = fs.readdirSync(dir).filter(f => /\.(dxf|svg)$/i.test(f));
      const opaque = fs.readdirSync(dir).filter(f => /\.(crv|crv3d)$/i.test(f));
      pending.push({ name, why: geom.length ? `geometry: ${geom.join(', ')}` : (opaque.length ? `NO READABLE GEOMETRY (${opaque.join(', ')})` : 'no geometry') });
      continue;
    }
    const r = cmp(ref, ours);
    console.log(P.report(r, `fixture: ${name}`));
    ok(`fixture ${name}: parity with Vectric`, r.equivalent);
  }
  if (pending.length) {
    console.log(`\n  PENDING - reference banked, no 'ours' side built yet (not a failure):`);
    for (const p of pending) console.log(`    - ${p.name.padEnd(26)} ${p.why}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
