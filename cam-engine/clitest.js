// CLI regression guard: drives cli.js as a subprocess the way a skill or a script would,
// so the headless front door stays wired to the same engine the studio uses.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }

const CLI = path.join(__dirname, 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqcam-cli-'));
const f = n => path.join(tmp, n);
const S = n => path.join(__dirname, n);

function run(args) {   // -> {out, code}
  try { return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status == null ? -1 : e.status }; }
}
const runJSON = args => { const r = run([...args, '--json']); try { return JSON.parse(r.out); } catch (e) { return { ok: false, parseError: r.out }; } };

// ---- help / posts ----
ok('help exits 0 and names the commands', (() => { const r = run(['help']); return r.code === 0 && /cut/.test(r.out) && /nest/.test(r.out); })());
const posts = runJSON(['posts']);
ok('posts lists shopsabre + generic', posts.ok && posts.posts.some(p => p.key === 'shopsabre') && posts.posts.some(p => p.key === 'generic'), JSON.stringify(posts.posts || []));

// ---- info ----
const info = runJSON(['info', '--in', S('sample.dxf')]);
ok('info reports shapes and contours', info.ok && info.files[0].shapes >= 2 && info.files[0].contours >= 2, JSON.stringify(info.files && info.files[0]));
ok('info reports a bbox with positive extent', info.ok && info.files[0].bbox.w > 0 && info.files[0].bbox.h > 0);
ok('info reports layers', info.ok && Object.keys(info.files[0].layers).length >= 1);

// ---- cut: every op, from every importable format ----
for (const op of ['profile', 'pocket', 'drill', 'vcarve']) {
  const out = f(`op-${op}.tap`);
  const r = runJSON(['cut', '--in', S('sample.dxf'), '--op', op, '--dia', '0.25', '--depth', '0.2', '--out', out]);
  ok(`cut --op ${op} succeeds`, r.ok === true, r.error || r.parseError);
  ok(`cut --op ${op} emits passes`, r.ok && r.passes > 0, r.passes);
  ok(`cut --op ${op} writes g-code`, fs.existsSync(out) && /G90/.test(fs.readFileSync(out, 'utf8')));
}
for (const [name, src] of [['svg', 'sample.svg'], ['pdf', 'sample-logo.pdf']]) {
  const out = f(`in-${name}.tap`);
  const r = runJSON(['cut', '--in', S(src), '--out', out]);
  ok(`cut accepts ${name} input`, r.ok === true && r.passes > 0, r.error || r.parseError);
  ok(`cut from ${name} writes g-code`, fs.existsSync(out) && /G[01]/.test(fs.readFileSync(out, 'utf8')));
}

// ---- cut: options actually reach the engine ----
const deep = runJSON(['cut', '--in', S('sample.dxf'), '--depth', '0.5', '--pass', '0.25', '--out', f('deep.tap')]);
const shallow = runJSON(['cut', '--in', S('sample.dxf'), '--depth', '0.25', '--pass', '0.25', '--out', f('shallow.tap')]);
ok('deeper cut yields more passes', deep.ok && shallow.ok && deep.passes > shallow.passes, `${deep.passes} vs ${shallow.passes}`);
ok('cut reports an estimated run time', deep.estimatedMinutes > 0, deep.estimatedMinutes);

const arcs = runJSON(['cut', '--in', S('sample.dxf'), '--out', f('arcs.tap')]);
const noArcs = runJSON(['cut', '--in', S('sample.dxf'), '--no-arcs', '--out', f('noarcs.tap')]);
ok('--no-arcs suppresses G2/G3', arcs.arcs > 0 && noArcs.arcs === 0, `${arcs.arcs} vs ${noArcs.arcs}`);

const gen = run(['cut', '--in', S('sample.dxf'), '--post', 'generic', '--out', f('gen.tap')]);
ok('generic post writes LF-only line ends', gen.code === 0 && !/\r\n/.test(fs.readFileSync(f('gen.tap'), 'utf8')));
ok('shopsabre post writes CRLF line ends', /\r\n/.test(fs.readFileSync(f('arcs.tap'), 'utf8')));

const tabs = runJSON(['cut', '--in', S('sample.dxf'), '--tabs', '4', '--tab-height', '0.1', '--out', f('tabs.tap')]);
ok('tabs produce a toolpath', tabs.ok && tabs.passes > 0, tabs.error);

const dry = runJSON(['cut', '--in', S('sample.dxf'), '--dry-run', '--out', f('never.tap')]);
ok('--dry-run reports without writing', dry.ok && dry.out === null && !fs.existsSync(f('never.tap')));

// :N is a nest quantity — on cut it would stack N identical toolpaths in place, so it must be refused
const one = runJSON(['cut', '--in', S('sample.dxf'), '--dry-run']);
const three = runJSON(['cut', '--in', S('sample.dxf') + ':3', '--dry-run']);
ok('cut refuses a :N quantity', three.ok === false && /nest/.test(three.error || ''), three.error);

// ---- nest ----
const nest = runJSON(['nest', '--in', S('sample.dxf') + ':6', '--sheet', '24x48', '--spacing', '0.5', '--out', f('nested.dxf')]);
ok('nest places every part', nest.ok && nest.placed === 6 && nest.unplaced.length === 0, JSON.stringify(nest.unplaced || nest.error));
ok('nest reports sheets and utilization', nest.sheets >= 1 && nest.utilization > 0, `${nest.sheets} / ${nest.utilization}%`);
ok('nest writes a dxf', fs.existsSync(f('nested.dxf')));

// a nested sheet must re-import as (parts x shapes-per-part) geometry — proves groups moved intact
const nestInfo = runJSON(['info', '--in', f('nested.dxf')]);
ok('nested dxf re-imports with all parts', nestInfo.ok && nestInfo.files[0].shapes === one.shapes * 6, `${nestInfo.files[0] && nestInfo.files[0].shapes} vs ${one.shapes * 6}`);

// parts stay inside the sheet envelope
const inside = (nest.placements || []).every(p => p.x >= 0 && p.y >= 0 && p.x + p.w <= 24 + 1e-6 && p.y + p.h <= 48 + 1e-6);
ok('nest keeps parts inside the sheet', inside, JSON.stringify(nest.placements));

const small = runJSON(['nest', '--in', S('sample.dxf') + ':8', '--sheet', '12x12', '--per-sheet', '--out', f('ps.dxf')]);
ok('--per-sheet writes one file per sheet', small.ok && small.out.length === small.sheets && small.out.every(p => fs.existsSync(p)), JSON.stringify(small.out));
ok('small sheet forces multiple sheets', small.sheets > 1, small.sheets);

const tooBig = runJSON(['nest', '--in', S('sample.dxf'), '--sheet', '2x2', '--dry-run']);
ok('parts larger than the sheet fail clearly', tooBig.ok === false && /too large/.test(tooBig.error || ''), tooBig.error);

// ---- convert ----
ok('convert dxf -> svg', runJSON(['convert', '--in', S('sample.dxf'), '--out', f('c.svg')]).ok && fs.existsSync(f('c.svg')));
ok('convert svg -> dxf', runJSON(['convert', '--in', S('sample.svg'), '--out', f('c.dxf')]).ok && fs.existsSync(f('c.dxf')));
ok('converted dxf still cuts', runJSON(['cut', '--in', f('c.dxf'), '--dry-run']).passes > 0);
ok('convert rejects an unknown output format', runJSON(['convert', '--in', S('sample.dxf'), '--out', f('c.tap')]).ok === false);

// ---- layer filtering ----
const layer = Object.keys(info.files[0].layers)[0];
ok('--layer keeps a real layer', runJSON(['cut', '--in', S('sample.dxf'), '--layer', layer, '--dry-run']).ok === true);
ok('--layer on a missing layer fails clearly', /layer filter/.test(runJSON(['cut', '--in', S('sample.dxf'), '--layer', 'NOPE', '--dry-run']).error || ''));
ok('--exclude-layer removes it', runJSON(['cut', '--in', S('sample.dxf'), '--exclude-layer', layer, '--dry-run']).ok === false);

// ---- failure modes exit non-zero and report as JSON ----
for (const [name, args] of [
  ['missing file', ['cut', '--in', f('nope.dxf')]],
  ['bad op', ['cut', '--in', S('sample.dxf'), '--op', 'bogus']],
  ['bad post', ['cut', '--in', S('sample.dxf'), '--post', 'bogus']],
  ['unknown command', ['bogus']],
  ['tool too big to pocket', ['cut', '--in', S('sample.dxf'), '--op', 'pocket', '--dia', '99']],
]) {
  const r = run([...args, '--json']);
  ok(`${name}: exits non-zero`, r.code !== 0, r.code);
  let j = null; try { j = JSON.parse(r.out); } catch (e) { /* reported below */ }
  ok(`${name}: reports {ok:false,error} as JSON`, !!j && j.ok === false && typeof j.error === 'string', r.out.slice(0, 120));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} CLI checks passed`);
process.exit(fail ? 1 : 0);
