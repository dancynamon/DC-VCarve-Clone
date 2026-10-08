#!/usr/bin/env node
// asmbrowser.js — headless end-to-end check of the 2D + 3D Assembly view on the waterslide v4.5 sheets.
//
//   node cam-engine/build.js && node cam-engine/asmbrowser.js [--out DIR] [--fixtures DIR] [--headed]
//
// Opens cadcam-studio.html in headless Chromium (playwright-core), opens the assembly file + its four DXFs, and:
//   1. checks every part was placed (24) and the slide arch solved,
//   2. posts the slide sheet in the browser and requires it to equal asmtap.js's CLI post byte for byte,
//   3. marquee-selects one slide foot hole (drill + counterbore) in 2D — the slide must light up in 3D —
//      and drags it with the mouse,
//   4. requires the 3D to rebuild ONLY the slide, in under 200 ms, with the hole moved in the mesh (a ray down the
//      old hole centre now hits the counterbore floor, a ray down the new centre goes through),
//   5. re-posts and requires the TAP to equal the CLI post of the same edit, and to differ from the original
//      only in the moved hole's moves,
//   6. clicks a step in 3D and requires the editor to switch to the red sheet with that step selected.
// Screenshots + both TAPs land in --out. Exit code 0 only if every check passes.
const fs = require('fs'), path = require('path'), os = require('os');
let pw; try { pw = require('playwright-core'); } catch (e) { pw = require(path.join(os.homedir(), 'node_modules', 'playwright-core')); }
const { loadDxfShapes, moveLoops, postSheet } = require('./asmtap.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('--out', path.join(os.tmpdir(), 'asmbrowser')); fs.mkdirSync(OUT, { recursive: true });
const FIX = opt('--fixtures', path.join(__dirname, 'fixtures', 'waterslide-v4.5'));
const APP = path.join(__dirname, '..', 'cadcam-studio.html');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name + (extra != null ? '  (' + extra + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (extra != null ? '  (' + extra + ')' : '')); } };

(async () => {
  const browser = await pw.chromium.launch({ headless: args.indexOf('--headed') < 0, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 960 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + APP);
  await page.waitForFunction(() => typeof ASM !== 'undefined' && typeof ASSEMBLY !== 'undefined');
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} const b = document.getElementById('restoreBar'); if (b) b.style.display = 'none'; });

  // ---- a single layer-named DXF through the ordinary Open: layers, sheet size, thickness, toolpaths, flat 3D
  const asmFile0 = fs.readdirSync(FIX).find(f => /\.assembly\.json$/.test(f));
  const baseDxf = path.join(FIX, JSON.parse(fs.readFileSync(path.join(FIX, asmFile0), 'utf8')).sheets[0].file);
  await page.setInputFiles('#fileInput', baseDxf);
  await page.waitForFunction(() => doc.shapes.length > 0);
  const one = await page.evaluate(() => ({ shapes: doc.shapes.length, layers: [...doc.layers.keys()].filter(n => n !== '0').sort(), w: job.w, h: job.h, t: job.thickness,
    ops: opsQueue.map(q => q.name) }));
  ok('base DXF opens: 5 layers (NOTES is text only), 17 cut shapes + sheet', one.layers.length === 5 && one.shapes === 18, one.layers.join(',') + ' · ' + one.shapes + ' shapes');
  ok('sheet size + thickness from SHEET layer / file name', one.w === 48.5 && one.h === 97 && one.t === 1.5, one.w + ' x ' + one.h + ' x ' + one.t);
  ok('toolpaths from layer names', one.ops.length === 5 && /^Drill/.test(one.ops[0]) && /Profile sheet/.test(one.ops[4]), one.ops.join(' | '));
  await page.evaluate(() => setView('asm'));
  await page.waitForFunction(() => window.__asmStats && window.__asmStats.parts === 1);
  ok('no assembly file: the sheet shows flat in 3D', await page.evaluate(() => window.__asmStats.parts === 1 && !ASM.sheets.length));
  await page.screenshot({ path: path.join(OUT, '0-single-dxf.png') });

  // ---- open the assembly: JSON + DXFs through the File > Open Assembly input
  const asmFile = fs.readdirSync(FIX).find(f => /\.assembly\.json$/.test(f));
  const asm = JSON.parse(fs.readFileSync(path.join(FIX, asmFile), 'utf8'));
  await page.setInputFiles('#asmInput', [asmFile].concat(asm.sheets.map(s => s.file)).map(f => path.join(FIX, f)));
  await page.waitForFunction(() => ASM.sheets.length > 0 && window.__asmStats && window.__asmStats.parts > 1, null, { timeout: 30000 });
  let st = await page.evaluate(() => Object.assign({}, window.__asmStats, { active: ASM.active, split: ASM.on, sheets: ASM.sheets.length, rise: (ASM.built.parts.find(p => p.id === 'slide') || {}).info }));
  ok('assembly opened in split view', st.split && st.sheets === 4, st.sheets + ' sheets, editing ' + st.active);
  ok('all 24 parts placed', st.parts === 24 && !(st.errors || []).length, st.parts + ' parts' + ((st.errors || []).length ? ' · ' + st.errors[0] : ''));
  ok('slide arch solved', st.rise && st.rise.rise > 17 && st.rise.rise < 19, st.rise && st.rise.rise.toFixed(3) + '" rise');
  const cold = await page.evaluate(() => { const t = performance.now(); ASSEMBLY.buildAssembly(ASM.data, asmSheetsInput(), new Map()); return Math.round(performance.now() - t); });
  ok('full rebuild of all 24 parts under 1 s', cold < 1000, cold + ' ms');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '1-opened.png') });

  // ---- switch the 2D editor to the slide sheet
  await page.selectOption('#asmSheet', 'slide');
  const queue = await page.evaluate(() => opsQueue.map(q => q.name + ' · T' + q.p.toolNum + ' · ' + q.p.cutDepth));
  ok('slide toolpaths from layer names', queue.length === 4 && /^Drill/.test(queue[0]), queue.join(' | '));

  const post = async name => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => postJob())]);
    const file = path.join(OUT, name); await dl.saveAs(file); return { file, text: fs.readFileSync(file, 'utf8'), suggested: dl.suggestedFilename() };
  };
  const slideDxf = path.join(FIX, asm.sheets.find(s => s.id === 'slide').file);
  const before = await post('slide-before.tap');
  const cliBefore = postSheet(loadDxfShapes(slideDxf), 1.5).gcode;
  ok('browser post == CLI post (unedited slide)', before.text === cliBefore, before.suggested);

  // ---- 2D edit: marquee-select the slide's foot hole at (4.25, 6.7347) and drag it with the mouse
  await page.evaluate(() => { doc.layers.get('SHEET').visible = false; fitJob(); render(); });   // the SHEET rect would swallow the marquee start
  const W2Sp = (x, y) => page.evaluate(([x, y]) => { const r = cv.getBoundingClientRect(), q = W2S({ x, y }); return { x: r.left + q.x, y: r.top + q.y }; }, [x, y]);
  const a = await W2Sp(-1.5, 8.2), b = await W2Sp(5.6, 5.3);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
  const picked = await page.evaluate(() => selectedShapes().map(s => s.layer).sort());
  ok('marquee selected drill + counterbore', picked.join(',') === 'DRILL_0.375_THRU,POCKET_2.00D_0.50DEEP', picked.join(','));
  await page.waitForFunction(() => (window.__asmStats.highlight || []).length > 0, null, { timeout: 3000 }).catch(() => {});
  st = await page.evaluate(() => window.__asmStats);
  ok('2D selection highlights the slide in 3D', (st.highlight || []).join(',') === 'slide', (st.highlight || []).join(','));

  const ppi = await page.evaluate(() => view.ppi);
  const c0 = await W2Sp(4.25, 6.7347);
  const statsAt = await page.evaluate(() => window.__asmStats.at);
  await page.keyboard.down('Meta');
  await page.mouse.move(c0.x, c0.y); await page.mouse.down();
  await page.mouse.move(c0.x + 0.25 * ppi, c0.y, { steps: 3 }); await page.mouse.move(c0.x + 0.5 * ppi, c0.y, { steps: 3 });
  await page.mouse.up(); await page.keyboard.up('Meta');
  await page.waitForFunction(at => window.__asmStats.at > at, statsAt);
  await page.waitForTimeout(120);
  const moved = await page.evaluate(() => { const d = doc.shapes.find(s => s.layer === 'DRILL_0.375_THRU' && sel.has(s.id)); const b = CADCORE.bboxAll([d]); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; });
  const dx = moved.x - 4.25, dy = moved.y - 6.7347;
  ok('foot hole moved by the drag', Math.abs(dx - 0.5) < 0.1 && Math.abs(dy) < 0.02, 'Δ ' + dx.toFixed(4) + ', ' + dy.toFixed(4));
  st = await page.evaluate(() => window.__asmStats);
  ok('3D rebuilt only the slide', st.rebuilt.join(',') === 'slide', st.rebuilt.join(','));
  ok('3D refresh under 200 ms', st.ms < 200, st.ms + ' ms');

  // the mesh itself: straight-down rays through the old and new hole centres (slide x = world x, slide y 6.7347 = world y 6.75)
  const rays = await page.evaluate(([nx]) => {
    const slide = ASM.r.parts.get('slide');
    const hit = x => { const h = GLVIEW.pickParts({ o: [x, 6.75, 100], d: [0, 0, -1] }, [slide]); return h ? +(100 - h.t).toFixed(3) : null; };
    return { old: hit(4.25), now: hit(nx) };
  }, [moved.x]);
  ok('3D: old hole centre is now counterbore floor (z 2.5)', rays.old != null && Math.abs(rays.old - 2.5) < 0.01, 'hit z ' + rays.old);
  ok('3D: new hole centre is a thru hole', rays.now == null, 'hit ' + rays.now);
  await page.screenshot({ path: path.join(OUT, '2-hole-moved.png') });

  // ---- regenerate the TAP and compare with the CLI post of the same edit
  const after = await post('slide-after.tap');
  const sh = loadDxfShapes(slideDxf);
  moveLoops(sh, 'DRILL_0.375_THRU@4.25,6.7347=' + dx + ',' + dy); moveLoops(sh, 'POCKET_2.00D_0.50DEEP@4.25,6.7347=' + dx + ',' + dy);
  const cliAfter = postSheet(sh, 1.5).gcode;
  fs.writeFileSync(path.join(OUT, 'slide-after-cli.tap'), cliAfter);
  ok('browser post == CLI post (edited slide)', after.text === cliAfter);
  const A = before.text.split(/\r?\n/), B = after.text.split(/\r?\n/);
  const changed = B.filter((l, i) => l !== A[i]);
  const xs = new Set(changed.map(l => (/X(-?[\d.]+)/.exec(l) || [])[1]).filter(Boolean).map(v => (+v).toFixed(2)));
  const nx = moved.x.toFixed(4);
  ok('TAP changed only around the moved hole', A.length === B.length && changed.length > 0 && changed.every(l => !/X/.test(l) || Math.abs(+/X(-?[\d.]+)/.exec(l)[1] - moved.x) < 1.01),
    changed.length + ' line(s) changed, X values ' + [...xs].slice(0, 6).join(' '));
  ok('TAP drills the new position to exactly -T', /G0 X\S+ Y6\.7347 Z0\.2000\r?\nG1 Z-1\.5000 F20\.0/.test(after.text) && after.text.indexOf('X' + nx + ' Y6.7347 Z0.2000') >= 0, 'X' + nx);

  // ---- 3D -> 2D: click step 1 in the 3D view
  await page.evaluate(() => { ASM.r.frameAll(); ASM.r.cam.yaw = Math.PI / 2 + 0.5; ASM.r.cam.pitch = 0.45; ASM.r.draw(); });   // from the step (exit) side: the arch hides them from the default view
  const tgt = await page.evaluate(() => { const p = ASM.built.parts.find(q => q.id === 'step1'), P = ASM.r.parts.get('step1').positions;
    let c = [0, 0, 0]; for (let i = 0; i < P.length; i += 3) { c[0] += P[i]; c[1] += P[i + 1]; c[2] += P[i + 2]; } c = c.map(v => v / (P.length / 3));   // inside the step: the first surface the ray meets is the step's
    const s = ASM.r.project(c); const r = document.getElementById('asmGl').getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y, n: p.ids.length }; });
  await page.mouse.click(tgt.x, tgt.y);
  await page.waitForFunction(() => ASM.active === 'red' && (window.__asmStats.highlight || []).indexOf('step1') >= 0, null, { timeout: 3000 }).catch(() => {});
  const after3d = await page.evaluate(() => ({ active: ASM.active, sel: [...sel].length, layers: selectedShapes().map(s => s.layer), hi: window.__asmStats.highlight }));
  ok('3D click switches the editor to the red sheet', after3d.active === 'red', after3d.active);
  ok('3D click selects the step outline + its cuts in 2D', after3d.sel === tgt.n && after3d.layers.indexOf('OUTSIDE_PROFILE') >= 0, after3d.sel + ' shapes: ' + [...new Set(after3d.layers)].join(','));
  ok('...and the step is highlighted in 3D', (after3d.hi || []).indexOf('step1') >= 0, (after3d.hi || []).join(','));
  await page.screenshot({ path: path.join(OUT, '3-step-picked.png') });
  await page.evaluate(() => { ASM.r.frameAll(); ASM.r.cam.yaw = 0; ASM.r.cam.pitch = 0.05; ASM.r.draw(); });
  await page.locator('#asmPane').screenshot({ path: path.join(OUT, '4-side.png') });

  ok('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed — screenshots + TAPs in ' + OUT);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
