#!/usr/bin/env node
// paritytest.js — real VCarve jobs as the gate.
//
// Every folder in fixtures/parity holds a .tap posted by VCarve (reference.tap) and the job it came
// from (source.crv3d). Each one goes through the same pipeline as batch.js: recover the recipe from
// Vectric's program, re-post it from the CRV with our CAM, and compare the two cuts at material
// level (0.005"). fixtures/parity/expected.json records where each job stands today.
//
//   A job listed PASS that stops passing fails this test: that is a regression.
//   A job listed as a known gap is reported, never failed: banking a job must not turn the suite red.
//   A known gap that starts passing is reported as "promote" so expected.json gets updated.
//
//   node cam-engine/paritytest.js            run the gate
//   node cam-engine/paritytest.js --update   rewrite expected.json from this run
const fs = require('fs'), os = require('os'), path = require('path');
const { run } = require('./batch.js');

const DIR = path.join(__dirname, 'fixtures', 'parity');
const EXPECTED = path.join(DIR, 'expected.json');
const update = process.argv.includes('--update');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-parity-'));
const report = run(DIR, out, { recursive: true });
const got = {};
for (const r of report) got[path.dirname(r.tap)] = { status: r.status, note: r.note || '' };

// a fixture folder with no reference.tap never reaches the report; say so instead of skipping it silently
for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
  if (d.isDirectory() && !d.name.startsWith('_') && !got[d.name]) got[d.name] = { status: 'UNPAIRED', note: 'no reference.tap in folder' };
}
const names = Object.keys(got).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (update) {
  const exp = {}; for (const n of names) exp[n] = got[n].status;
  fs.writeFileSync(EXPECTED, JSON.stringify(exp, null, 1) + '\n');
  console.log('wrote ' + path.relative(process.cwd(), EXPECTED));
}
const expected = fs.existsSync(EXPECTED) ? JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) : {};

let pass = 0, fail = 0, gaps = 0, promote = 0;
for (const n of names) {
  const g = got[n], want = expected[n];
  if (!want) { fail++; console.log(`  FAIL ${n}: not in expected.json (got ${g.status}); run with --update`); continue; }
  if (want === 'PASS') {
    if (g.status === 'PASS') pass++;
    else { fail++; console.log(`  FAIL ${n}: matched Vectric before, now ${g.status}${g.note ? ' — ' + g.note : ''}`); }
  } else if (g.status === 'PASS') { promote++; console.log(`  promote ${n}: now matches Vectric; run with --update`); }
  else { gaps++; console.log(`  known gap ${n}: ${g.status}${g.note ? ' — ' + g.note : ''}`); }
}
for (const n of Object.keys(expected)) if (!got[n]) { fail++; console.log(`  FAIL ${n}: listed in expected.json but the fixture is gone`); }

console.log(`\n${pass} of ${names.length} real VCarve jobs match Vectric within 0.005" · ${gaps} known gaps · ${promote} to promote · ${fail} failed`);
process.exit(fail ? 1 : 0);
