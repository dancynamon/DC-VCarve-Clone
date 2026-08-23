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


// ---- recipes + the cut-list chain -------------------------------------------
// Build a self-contained catalog: a plain part, and a part whose holes need their own inside op.
const chain = path.join(tmp, 'chain'); fs.mkdirSync(path.join(chain, 'parts'), { recursive: true });
const CC = require('./cadcore.js');
fs.writeFileSync(path.join(chain, 'parts', 'plain.dxf'), CC.toDXF([CC.mkRect(0, 0, 20, 10, 'OUTLINE')]));
const holed = [CC.mkRect(0, 0, 24, 18, 'OUTLINE')];
for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) holed.push(CC.mkCircle({ x: 5 + i * 7, y: 5 + j * 8 }, 2, 'HOLES'));
fs.writeFileSync(path.join(chain, 'parts', 'holed.dxf'), CC.toDXF(holed));
fs.writeFileSync(path.join(chain, 'parts', 'huge.dxf'), CC.toDXF([CC.mkRect(0, 0, 200, 200, 'OUTLINE')]));

const CAT = {
  defaults: { sheet: '48x96', spacing: 0.5, margin: 0.25, post: 'shopsabre' },
  recipes: {
    plain: { ops: [{ op: 'profile', side: 'outside', tool: 1, dia: 0.25, depth: 1.5, pass: 1.5, feed: 100, rpm: 24000, clearz: 0.8 }] },
    holes: {
      ops: [
        { op: 'profile', side: 'inside', layer: 'HOLES', tool: 3, dia: 0.25, depth: 1.5, pass: 1.5, feed: 90, rpm: 24000, clearz: 0.8, optional: true },
        { op: 'profile', side: 'outside', 'exclude-layer': 'HOLES', tool: 1, dia: 0.25, depth: 1.5, pass: 1.5, feed: 100, rpm: 24000, clearz: 0.8 },
      ],
    },
    sloppy: { ops: [{ op: 'profile', side: 'outside', tool: 1, dia: 0.25, depth: 1.5, pass: 1.5, feed: 100, rpm: 24000 }] },
    backwards: {
      ops: [
        { op: 'profile', side: 'outside', tool: 1, dia: 0.25, depth: 1.5, pass: 1.5 },
        { op: 'profile', side: 'inside', layer: 'HOLES', tool: 3, dia: 0.25, depth: 1.5, pass: 1.5 },
      ],
    },
  },
  parts: {
    PLAIN: { file: 'parts/plain.dxf', recipe: 'plain' },
    HOLED: { file: 'parts/holed.dxf', recipe: 'holes' },
    SLOPPY: { file: 'parts/holed.dxf', recipe: 'sloppy' },
    HUGE: { file: 'parts/huge.dxf', recipe: 'plain' },
    PRE: { file: 'parts/plain.dxf', recipe: 'plain', prenested: true },
    BADRECIPE: { file: 'parts/plain.dxf', recipe: 'nope' },
    BADFILE: { file: 'parts/missing.dxf', recipe: 'plain' },
  },
};
const catPath = path.join(chain, 'parts.json');
fs.writeFileSync(catPath, JSON.stringify(CAT, null, 2));
let clN = 0;
const cutlist = rows => { const p = path.join(chain, `cl${++clN}.csv`); fs.writeFileSync(p, 'color,shape,qty,order,status\n' + rows.join('\n') + '\n'); return p; };

// --- cut --recipe: multi-op into one file with a tool change ---
const rec = runJSON(['cut', '--in', path.join(chain, 'parts', 'holed.dxf'), '--recipe', 'holes', '--catalog', catPath, '--out', f('rec.tap')]);
ok('cut --recipe succeeds', rec.ok === true, rec.error || rec.parseError);
const recG = fs.existsSync(f('rec.tap')) ? fs.readFileSync(f('rec.tap'), 'utf8') : '';
ok('recipe posts both tools', /^T3/m.test(recG) && /^T1/m.test(recG));
ok('recipe reports itself as the op', rec.op === 'recipe:holes', rec.op);
ok('unknown recipe fails clearly', /not in/.test(runJSON(['cut', '--in', path.join(chain, 'parts', 'plain.dxf'), '--recipe', 'nope', '--catalog', catPath, '--dry-run']).error || ''));

// holes must be cut INSIDE: a 2.000in hole with a 0.25in tool leaves a 1.875in arc radius
const holeRadii = (recG.match(/^G[23].*I(-?[\d.]+) J(-?[\d.]+)/gm) || []).map(l => {
  const m = l.match(/I(-?[\d.]+) J(-?[\d.]+)/); return Math.hypot(+m[1], +m[2]);
}).filter(r => r > 1 && r < 3);
ok('recipe cuts holes inside, not outside', holeRadii.length > 0 && holeRadii.every(r => Math.abs(r - 1.875) < 0.01),
  holeRadii.slice(0, 3).map(r => r.toFixed(4)).join(','));

// --- adjacent same-tool ops merge into one tool block ---
const mergeCat = JSON.parse(JSON.stringify(CAT));
mergeCat.recipes.twice = { ops: [CAT.recipes.plain.ops[0], Object.assign({}, CAT.recipes.plain.ops[0])] };
const mergePath = path.join(chain, 'merge.json'); fs.writeFileSync(mergePath, JSON.stringify(mergeCat));
run(['cut', '--in', path.join(chain, 'parts', 'plain.dxf'), '--recipe', 'twice', '--catalog', mergePath, '--out', f('merge.tap')]);
ok('adjacent same-tool ops emit one tool change', (fs.readFileSync(f('merge.tap'), 'utf8').match(/^T1\r?$/gm) || []).length === 1);

// --- recipe safety checks ---
const sloppy = runJSON(['cut', '--in', path.join(chain, 'parts', 'holed.dxf'), '--recipe', 'sloppy', '--catalog', catPath, '--dry-run']);
ok('outside profile over nested contours is flagged', (sloppy.warnings || []).some(w => /sit inside another/.test(w)), JSON.stringify(sloppy.warnings));
const backwards = runJSON(['cut', '--in', path.join(chain, 'parts', 'holed.dxf'), '--recipe', 'backwards', '--catalog', catPath, '--dry-run']);
ok('an outside profile before later ops is flagged', (backwards.warnings || []).some(w => /cut free before/.test(w)), JSON.stringify(backwards.warnings));

// --- batch: colour grouping, mixed recipes on a sheet, holds, unknown parts ---
const cl = cutlist(['blue,PLAIN,14,#1,paid', 'blue,HOLED,3,#2,paid', 'red,PLAIN,6,#3,paid', 'yellow,HOLED,2,#4,paid']);
const b = runJSON(['batch', '--in', cl, '--catalog', catPath, '--outdir', path.join(chain, 'out')]);
ok('batch succeeds', b.ok === true, b.error || b.parseError);
ok('batch groups by colour', JSON.stringify((b.colors || []).slice().sort()) === '["blue","red","yellow"]', JSON.stringify(b.colors));
ok('batch cuts every ready piece', b.totalPieces === 25, b.totalPieces);
ok('batch writes a .tap and .dxf per sheet', b.sheets.every(s => fs.existsSync(s.file) && fs.existsSync(s.dxf)));
ok('batch never mixes colours on one sheet', new Set(b.sheets.map(s => s.color)).size === 3);
ok('mixed recipes can share a sheet', b.sheets.some(s => s.recipes.length > 1), JSON.stringify(b.sheets.map(s => s.recipes)));
ok('batch reports machine time', b.estimatedMinutes > 0, b.estimatedMinutes);
ok('batch carries order numbers through', b.sheets.every(s => Array.isArray(s.orders)));

const held = runJSON(['batch', '--in', cutlist(['blue,PLAIN,2,#5,unpaid - hold', 'blue,PLAIN,3,#6,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out2'), '--dry-run']);
ok('a held row is not cut', held.held.length === 1 && held.totalPieces === 3, JSON.stringify({ held: held.held, pieces: held.totalPieces }));
const forced = runJSON(['batch', '--in', cutlist(['blue,PLAIN,2,#7,unpaid - hold', 'blue,PLAIN,3,#8,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out3'), '--include-hold', '--dry-run']);
ok('--include-hold cuts it anyway', forced.totalPieces === 5, forced.totalPieces);

const unk = runJSON(['batch', '--in', cutlist(['blue,NOSUCH,2,#9,paid', 'blue,PLAIN,1,#10,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out4'), '--dry-run']);
ok('an uncatalogued part stops the run', unk.ok === false && /no part file for/.test(unk.error || ''), unk.error);
const skipped = runJSON(['batch', '--in', cutlist(['blue,NOSUCH,2,#11,paid', 'blue,PLAIN,1,#12,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out5'), '--skip-unknown', '--dry-run']);
ok('--skip-unknown cuts the rest and names what it skipped', skipped.ok === true && skipped.unknownParts.includes('NOSUCH') && skipped.totalPieces === 1, JSON.stringify(skipped.unknownParts));

const pre = runJSON(['batch', '--in', cutlist(['blue,PRE,3,#13,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out6')]);
ok('a prenested part is cut as-is, not nested', pre.ok && pre.prenested.length === 1 && pre.totalSheets === 0, JSON.stringify(pre.prenested));
ok('a prenested part reports its repeat count', pre.prenested[0].runs === 3, pre.prenested[0].runs);

const huge = runJSON(['batch', '--in', cutlist(['blue,HUGE,1,#14,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'out7'), '--dry-run']);
ok('a part too big for the sheet is reported, not silently dropped', (huge.warnings || []).some(w => /does not fit/.test(w)), JSON.stringify(huge.warnings));

ok('a bad recipe reference fails clearly', /not in/.test(runJSON(['batch', '--in', cutlist(['blue,BADRECIPE,1,#15,paid']), '--catalog', catPath, '--dry-run']).error || ''));
ok('a missing part file fails clearly', /no such file/.test(runJSON(['batch', '--in', cutlist(['blue,BADFILE,1,#16,paid']), '--catalog', catPath, '--dry-run']).error || ''));
ok('batch --dry-run writes nothing', runJSON(['batch', '--in', cutlist(['blue,PLAIN,2,#17,paid']), '--catalog', catPath, '--outdir', path.join(chain, 'nodir'), '--dry-run']).written.length === 0 && !fs.existsSync(path.join(chain, 'nodir')));

// --- batch accepts JSON as well as CSV, and a bare array ---
const jsonCl = path.join(chain, 'cl.json');
fs.writeFileSync(jsonCl, JSON.stringify({ sheet: '48x96', items: [{ part: 'PLAIN', color: 'blue', qty: 4, order: '#18', status: 'paid' }] }));
ok('batch reads a JSON cut list', runJSON(['batch', '--in', jsonCl, '--catalog', catPath, '--outdir', path.join(chain, 'out8'), '--dry-run']).totalPieces === 4);
const arrCl = path.join(chain, 'arr.json');
fs.writeFileSync(arrCl, JSON.stringify([{ sku: 'PLAIN', color: 'red', qty: 2 }]));
ok('batch reads a bare JSON array', runJSON(['batch', '--in', arrCl, '--catalog', catPath, '--outdir', path.join(chain, 'out9'), '--dry-run']).totalPieces === 2);

// --- cut list validation ---
const badQty = path.join(chain, 'badqty.csv');
fs.writeFileSync(badQty, 'color,shape,qty\nblue,PLAIN,lots\n');
ok('a non-numeric qty fails clearly', /qty/.test(runJSON(['batch', '--in', badQty, '--catalog', catPath, '--dry-run']).error || ''));
const noPart = path.join(chain, 'nopart.csv');
fs.writeFileSync(noPart, 'color,qty\nblue,2\n');
ok('a row with no part column fails clearly', /part/.test(runJSON(['batch', '--in', noPart, '--catalog', catPath, '--dry-run']).error || ''));
ok('a missing catalog fails clearly', /no parts catalog/.test(runJSON(['batch', '--in', cl, '--catalog', path.join(chain, 'nope.json'), '--dry-run']).error || ''));
const quoted = path.join(chain, 'quoted.csv');
fs.writeFileSync(quoted, 'color,shape,qty,order,status\n"blue","PLAIN",2,"#19, rush","paid"\n');
ok('quoted CSV fields parse', runJSON(['batch', '--in', quoted, '--catalog', catPath, '--outdir', path.join(chain, 'out10'), '--dry-run']).totalPieces === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} CLI checks passed`);
process.exit(fail ? 1 : 0);
