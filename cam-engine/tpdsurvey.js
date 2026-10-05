#!/usr/bin/env node
// tpdsurvey.js — inventory every saved toolpath in the VCarve library: type, tool, ramp, lead, tabs,
// raster, etc. Picks the training examples for each feature the generator must learn.
//   node cam-engine/tpdsurvey.js <root> --out CAD/tpd-survey.json [--budget 140]   (resumable)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { parseToolpathData } = require('./tpdparse.js');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'crvparse.js'), 'utf8') + ';this.open=crvCfbOpen;', ctx);
function* walk(d) { let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (x) { return; }
  for (const x of e) { if (x.name.startsWith('.')) continue; const p = path.join(d, x.name); if (x.isDirectory()) yield* walk(p); else if (/\.crv(3d)?$/i.test(x.name)) yield p; } }
const KEYS = /CutDirection|ProfileType|DoRamping|RampingType|RampingDistance|RampingAngle|LeadType|LeadLength|DoLeadOut|CircularRadius|LinearAngle|OvercutDistance|UseTabs|TabLength|TabThickness|3dTabs|NumTabs|DoRaster|RasterAngle|PocketMode|UseAreaClearTool|Allowance$|SquareCorners|DepthValues|CutDepth$|EditingDialog|ToolpathType|Peck|Dwell|Retract|Flat|Angle$|Chamfer|Fillet|Inlay|Spiral|Helical/;
const av = process.argv.slice(2); const root = av[0], out = av[av.indexOf('--out') + 1], budget = av.includes('--budget') ? +av[av.indexOf('--budget') + 1] : 0;
const S = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { root, files: {} };
const t0 = Date.now(); let n = 0, left = 0;
for (const f of walk(root)) {
  const rel = path.relative(root, f); if (S.files[rel]) continue;
  if (budget && Date.now() - t0 > budget * 1000) { left++; continue; }
  try {
    const c = ctx.open(new Uint8Array(fs.readFileSync(f)));
    if (!c.exists('Toolpaths/ToolpathData')) { S.files[rel] = { tps: [] }; n++; continue; }
    const r = parseToolpathData(new Uint8Array(c.stream('Toolpaths/ToolpathData')));
    S.files[rel] = { tps: r.toolpaths.map(t => ({ name: t.name, type: t.type, tools: t.tools.map(x => [x.toolNum, x.name, x.dia]),
      p: Object.fromEntries(Object.entries(t.params).filter(([k]) => KEYS.test(k))) })) };
  } catch (e) { S.files[rel] = { err: e.message.slice(0, 120) }; }
  n++; if (n % 100 === 0) fs.writeFileSync(out, JSON.stringify(S));
}
fs.writeFileSync(out, JSON.stringify(S));
console.log(`${left ? 'UNFINISHED' : 'DONE'} ${n} this run, ${Object.keys(S.files).length} total, ${left} left`);
