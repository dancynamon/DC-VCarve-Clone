#!/usr/bin/env node
// crv2tap.js — post a VCarve job straight from its .crv/.crv3d: geometry AND toolpath recipe come from the
// file (crvparse + tpdparse). No Vectric .tap is read. This is the generator the blind test grades.
//   node cam-engine/crv2tap.js job.crv3d out.tap [--toolpaths "Name A,Name B"] [--json]
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require('./camcore.js');
const { parseToolpathData } = require('./tpdparse.js');
const { repostJob } = require('./repost.js');

function loadCrv(bytes) {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'crvparse.js'), 'utf8') + ';this.open=crvCfbOpen;this.P=parseCrv;', ctx);
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const polys = ctx.P(u, { tol: 0.002 }), cfb = ctx.open(u);
  if (!cfb.exists('Toolpaths/ToolpathData')) throw new Error('CRV has no saved toolpaths');
  const tpd = parseToolpathData(new Uint8Array(cfb.stream('Toolpaths/ToolpathData')), new Set(polys.map(p => p.ent.guid)));
  let safeZ = null;
  if (cfb.exists('Toolpaths/ToolpathPosData')) { const pb = new Uint8Array(cfb.stream('Toolpaths/ToolpathPosData'));
    if (pb.length >= 29) safeZ = new DataView(pb.buffer, pb.byteOffset + 21, 8).getFloat64(0, true); }   // Job Setup "Safe Z"
  return { polys, tpd, safeZ };
}
const depthList = s => (s || '').split(';').map(x => x.trim()).filter(Boolean).map(Number);

// one VCarve toolpath -> one repost op
function toOp(tp, warnings) {
  const P = tp.params, t = tp.tools[0];
  if (!t) { warnings.push(`${tp.name}: no tool record`); return null; }
  if (tp.type === 'Drill') {
    const d = { op: 'drill', toolNum: t.toolNum, toolDia: t.dia, rpm: t.rpm, feed: t.feed, plunge: t.plunge, cutDepth: P._dpdCutDepth, label: tp.name };
    if (P._dpdPeckDrill) d.peck = t.passDepth;                   // VCarve pecks by the tool's pass depth
    if (P._dpdUseDwell && P._dpdDwellTime) warnings.push(`${tp.name}: dwell ${P._dpdDwellTime}s not emitted yet`);
    if (P._dpdRetractGap) warnings.push(`${tp.name}: peck retract gap ${P._dpdRetractGap} not mapped yet`);
    return d;
  }
  const pre = /^Pocket|^AreaClear/.test(tp.type) ? '_pkpd' : '_ppd';
  // pockets with "use area clearance tool": Tool_1 = the finishing (small) tool, Tool_2 = the clearance (big) tool
  const depths = depthList(P._mctddDepthValues ?? (tp.type === 'AreaClearToolpath' ? (P._mctddDepthValues_Tool_2 ?? P._mctddDepthValues_Tool_1) : P._mctddDepthValues_Tool_1));
  const cutDepth = P[pre + 'CutDepth'];
  const base = { toolNum: t.toolNum, toolDia: t.dia, rpm: t.rpm, feed: t.feed, plunge: t.plunge, cutDepth,
                 passDepth: depths.length ? depths[0] : t.passDepth, depths: depths.length ? depths : undefined, label: tp.name };
  // CutDirection: 1 = conventional, 0 = climb (VCarve order of the radio buttons) — CONFIRM on blind test BT-09
  const climb = P[pre + 'CutDirection'] === 0;
  const allowance = P[pre + 'Allowance'] || 0;
  if (tp.type === 'Pocket' || tp.type === 'AreaClearToolpath') {
    if (P._pkpdDoRaster) warnings.push(`${tp.name}: raster pocket not supported yet`);
    const op = Object.assign(base, { op: 'pocket', climb, stepover: t.stepover / t.dia });
    // "Use area clearance tool": VCarve saves the big-tool clear as an AreaClearToolpath "[Clear]" and the small tool
    // as the Pocket of the same name, which then only machines what the big tool could not reach
    if (tp.type === 'Pocket' && tp.restOf) { op.restOf = tp.restOf; op.finishWall = true; }   // small tool: wall + what the big tool left
    return op;
  }
  const m = /^Profile (Outside|Inside|On)$/.exec(tp.type || '');
  if (m) {
    const op = Object.assign(base, { op: 'profile', side: m[1].toLowerCase(), climb });
    if (allowance) op.toolDia = t.dia + 2 * allowance;          // allowance = leave stock; widen the offset
    if (P._ppdUseTabs) op.tabs = { count: P.tabsNumTabs || 1, length: P._ppdTabLength, height: P._ppdTabThickness };
    if (P._mcldDoLeadIn || P._mcldLeadType) warnings.push(`${tp.name}: lead-in params present (type ${P._mcldLeadType}, len ${P._mcldLeadLength}) — mapping unconfirmed`);
    if (P._mcrdDoRamping) warnings.push(`${tp.name}: ramping not mapped yet`);
    return op;
  }
  warnings.push(`${tp.name}: toolpath type "${tp.type}" not supported yet`);
  return null;
}

function crv2tap(bytes, opts) {
  opts = opts || {};
  const { polys, tpd, safeZ } = loadCrv(bytes);
  const index = {}, where = {};
  for (const p of polys) { (index[p.layer] = index[p.layer] || []).push({ closed: !!p.ent.closed, pts: p.pts, tabs: p.ent.tabs || [] });
    (where[p.ent.guid] = where[p.ent.guid] || []).push([p.layer, index[p.layer].length - 1]); }
  const warnings = [], ops = [];
  const want = opts.toolpaths ? new Set(opts.toolpaths) : null;
  const clearDia = {};
  for (const tp of tpd.toolpaths) {
    if (tp.type === 'AreaClearToolpath' && tp.tools[0]) clearDia[tp.name] = tp.tools[0].dia;
    else if (tp.type === 'Pocket' && clearDia[tp.name]) tp.restOf = clearDia[tp.name];
    if (want && !want.has(tp.name)) continue;
    const op = toOp(tp, warnings); if (!op) continue;
    if (safeZ != null && safeZ > 0 && safeZ < 6) op.clearZ = safeZ;
    op.select = [];
    for (const g of (tp.selection || [])) for (const s of (where[g] || [])) op.select.push(s);
    if (!op.select.length) { warnings.push(`${tp.name}: selection resolved to no vectors`); continue; }
    ops.push(op);
  }
  const r = repostJob(index, { name: opts.name || 'job', ops });
  return { gcode: r.gcode, ops, warnings: warnings.concat(r.warnings), toolpaths: tpd.toolpaths.map(t => t.name) };
}

if (require.main === module) {
  const av = process.argv.slice(2), pos = []; let tps = null, json = false;
  for (let i = 0; i < av.length; i++) { if (av[i] === '--toolpaths') tps = av[++i].split(','); else if (av[i] === '--json') json = true; else pos.push(av[i]); }
  if (pos.length !== 2) { console.error('usage: crv2tap.js job.crv3d out.tap [--toolpaths "A,B"]'); process.exit(2); }
  if (/\.(crv|crv3d|dxf)$/i.test(pos[1])) { console.error('refusing to write G-code over a source file'); process.exit(2); }
  const r = crv2tap(fs.readFileSync(pos[0]), { toolpaths: tps, name: path.basename(pos[0]).replace(/\.crv3d?$/i, '') });
  fs.writeFileSync(pos[1], r.gcode);
  if (json) console.log(JSON.stringify({ ...r, gcode: undefined }, null, 1));
  else { console.log(`${pos[0]} -> ${pos[1]}  toolpaths in file: ${r.toolpaths.join(' | ')}`);
    for (const o of r.ops) console.log(`  ${o.label}: T${o.toolNum} ${o.op}${o.side ? ' ' + o.side : ''} dia ${o.toolDia} depths ${(o.depths || []).join('/')} F${o.feed}/${o.plunge} S${o.rpm} climb ${o.climb} x${o.select.length}`);
    for (const w of r.warnings) console.log('  WARNING: ' + w); }
}
module.exports = { crv2tap, loadCrv };
