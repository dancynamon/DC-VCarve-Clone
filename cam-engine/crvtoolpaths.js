// crvtoolpaths.js — turn the toolpath definitions saved in a .crv/.crv3d (tpdparse.js) into the studio's toolpath list.
// Browser + node. toOp() is the mapping crv2tap.js has always used (it is shared, so the CLI and the studio agree); toStudioOps()
// wraps it for the toolpath panel and accounts for everything that cannot be carried over.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.CRVTP = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
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

// Studio toolpath parameters for a mapped op. Fields the panel needs but Vectric does not specify take the panel's own defaults.
function studioParams(op, safeZ) {
  const p = Object.assign({ op: op.op, toolNum: op.toolNum, toolDia: op.toolDia, side: op.side || 'outside', climb: !!op.climb,
    cutDepth: Math.abs(op.cutDepth || 0.25), passDepth: Math.abs(op.passDepth || op.cutDepth || 0.25), feed: op.feed, plunge: op.plunge, rpm: op.rpm,
    topZ: 0, clearZ: safeZ != null ? safeZ : 0.25, stepover: op.stepover != null ? op.stepover : 0.4, pocketStyle: 'offset', rampEntry: false, finishDia: 0, finishNum: 2, peck: op.peck || 0,
    bitAngle: 90, vstep: 0.02, flatDepth: 0, clearDia: 0, clearNum: 2, leadType: 'none', leadLen: 0.25, rampLen: 0, style: 'pocket', part: 'both', clearance: 0, clearanceOn: 'female',
    pocketDepth: 0.125, maleDepth: 0.125, startDepth: 0, maleMargin: 0.25, mirrorMale: true, chWidth: 0.125, chOffset: 0, qeSharp: 150, fluteTool: 'ball', flRamp: 'both', flRampLen: 0, flSmooth: false,
    prMax: 0, moAlign: 'center', moStep: 0.1, tabs: op.tabs || { count: 0, length: 0.4, height: 0.1 } }, op.depths ? { depths: op.depths } : {});
  return p;
}

// -> { ops:[{name,p,guids}], report:[{code,level,msg,count,items}] }. Nothing is dropped without being named.
function toStudioOps(tpd, opts) {
  opts = opts || {};
  const present = new Set(opts.guids || []), ops = [], notConverted = [], noSelection = [], notes = [], rest = [];
  const clearDia = {};
  for (const tp of (tpd && tpd.toolpaths) || []) {
    const hadArea = tp.type === 'AreaClearToolpath';
    if (hadArea && tp.tools[0]) clearDia[tp.name] = tp.tools[0].dia;
    else if (tp.type === 'Pocket' && clearDia[tp.name]) tp.restOf = clearDia[tp.name];
    const w = [];
    let op = null; try { op = toOp(tp, w); } catch (e) { w.push(`${tp.name}: ${e.message}`); }
    if (!op) { notConverted.push((tp.name || '(unnamed)') + (tp.type ? ' [' + tp.type + ']' : '')); continue; }
    const guids = (tp.selection || []).filter(g => present.has(g));
    if (!guids.length) { noSelection.push(tp.name); continue; }
    if (op.restOf) { rest.push(tp.name); delete op.restOf; delete op.finishWall; }
    const p = studioParams(op, opts.safeZ);
    if (tp.params && tp.params._pkpdDoRaster) p.pocketStyle = 'raster';
    for (const m of w) notes.push(m);
    if (op.tabs) notes.push(`${tp.name}: ${op.tabs.count} tab(s) kept by count and size; their positions were not carried and are spaced evenly`);
    ops.push({ name: tp.name, p, guids });
  }
  const report = [];
  if (notConverted.length) report.push({ code: 'TOOLPATH_NOT_CONVERTED', level: 'loss', msg: notConverted.length + ' saved toolpath(s) are of a kind this app cannot rebuild and were not imported', count: notConverted.length, items: notConverted.slice(0, 8) });
  if (noSelection.length) report.push({ code: 'TOOLPATH_NO_VECTORS', level: 'loss', msg: noSelection.length + ' saved toolpath(s) were not imported because their vectors are not in the drawing (deleted in VCarve, or on a layer that was not saved)', count: noSelection.length, items: noSelection.slice(0, 8) });
  if (rest.length) report.push({ code: 'TOOLPATH_REST_AS_FULL', level: 'warn', msg: rest.length + ' small-tool pocket(s) came in as a full pass of that tool (VCarve only cut what the big tool left), so they will take longer', count: rest.length, items: rest.slice(0, 8) });
  if (notes.length) report.push({ code: 'TOOLPATH_SETTINGS_NOT_CARRIED', level: 'warn', msg: notes.length + ' toolpath setting(s) could not be carried over exactly; review before posting', count: notes.length, items: notes.slice(0, 8) });
  return { ops, report };
}

return { toOp, toStudioOps, studioParams };
});
