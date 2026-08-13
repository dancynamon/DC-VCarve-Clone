#!/usr/bin/env node
// repost.js — re-post a DXF straight through the engine, no browser.
//
// Reads a DXF, runs one CAM operation over every closed contour in it, and writes G-code with the
// ShopSabre post. Exists so a job whose only surviving source is its .dxf can be regenerated after an
// engine fix without hand-rebuilding it in the UI. Same code paths as the studio: dxfparse ->
// cadcore.dxfPolysToShapes -> camcore.assembleContours -> <op>Op -> orderPasses -> postProcess.
//
//   node cam-engine/repost.js in.dxf out.tap --dia 0.25 --depth 1.5 --pass 1.5 \
//        --feed 100 --plunge 30 --rpm 24000 --clear 0.8 --side outside --dir conventional \
//        --lead line --leadlen 0.25
//
// Anything not given falls back to the profileOp defaults. --json prints the summary as JSON.
const fs = require('fs'), path = require('path'), vm = require('vm');
const CAM = require(path.join(__dirname, 'camcore.js'));
const C = require(path.join(__dirname, 'cadcore.js'));

function loadDxfParser() {
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'dxfparse.js'), 'utf8'), ctx);
  return ctx;
}
function dxfToContours(text) {
  const ctx = loadDxfParser();
  const polys = [];
  for (const e of ctx.parseDxf(text)) for (const p of ctx.entityToPolys(e)) polys.push(p);
  return CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));
}
function repost(dxfText, opts) {
  const o = Object.assign({ op: 'profile', name: 'repost', post: 'shopsabre' }, opts || {});
  const contours = dxfToContours(dxfText);
  const res = (o.op === 'pocket') ? CAM.pocketOp(contours, o)
    : (o.op === 'drill') ? CAM.drillOp(contours, o)
    : (o.op === 'vcarve') ? CAM.vcarveOp(contours, Object.assign({}, o, { maxDepth: o.cutDepth, step: o.vstep }))
    : CAM.profileOp(contours, o);
  for (const op of res.ops) op.clearZ = o.clearZ != null ? o.clearZ : 0.25;
  const job = CAM.orderPasses({ name: o.name, units: 'inch', ops: res.ops });
  const g = CAM.postProcess(job, CAM.POSTS[o.post] || CAM.POSTS.shopsabre);
  const passes = res.ops.reduce((n, op) => n + op.passes.length, 0);
  return { gcode: g, contours: contours.length, closed: contours.filter(c => c.closed).length, passes,
           warnings: res.warnings, arcs: (g.match(/^G[23] /gm) || []).length, lines: (g.match(/^G1 /gm) || []).length };
}
module.exports = { repost, dxfToContours };

if (require.main === module) {
  const av = process.argv.slice(2), pos = [], flags = {};
  for (let i = 0; i < av.length; i++) {
    if (av[i].startsWith('--')) { const k = av[i].slice(2); flags[k] = (av[i + 1] && !av[i + 1].startsWith('--')) ? av[++i] : true; }
    else pos.push(av[i]);
  }
  if (pos.length < 2) { console.error('usage: node repost.js <in.dxf> <out.tap> [--dia N --depth N --pass N --feed N --plunge N --rpm N --clear N --side outside|inside|on --dir climb|conventional --lead none|line|arc --leadlen N --tool N --top N --op profile|pocket|drill|vcarve]'); process.exit(2); }
  const num = (k, d) => flags[k] != null ? Math.abs(parseFloat(flags[k])) : d;
  const opts = {
    op: flags.op || 'profile',
    toolNum: flags.tool != null ? parseInt(flags.tool, 10) : 1,
    toolDia: num('dia', 0.25), side: flags.side || 'outside',
    climb: (flags.dir || 'conventional') === 'climb',
    cutDepth: num('depth', 0.25), passDepth: num('pass', num('depth', 0.25)),
    feed: num('feed', 120), plunge: num('plunge', 40), rpm: num('rpm', 18000),
    topZ: flags.top != null ? parseFloat(flags.top) : 0, clearZ: num('clear', 0.25),
    leadType: flags.lead || 'none', leadLen: num('leadlen', 0.25),
    name: path.basename(pos[0]).replace(/\.dxf$/i, '')
  };
  const r = repost(fs.readFileSync(pos[0], 'utf8'), opts);
  fs.writeFileSync(pos[1], r.gcode);
  if (flags.json) console.log(JSON.stringify({ out: pos[1], ...r, gcode: undefined }, null, 2));
  else {
    console.log(`${pos[0]} -> ${pos[1]}`);
    console.log(`  contours ${r.contours} (${r.closed} closed)   passes ${r.passes}   G1 ${r.lines}   G2/G3 ${r.arcs}`);
    for (const w of r.warnings) console.log(`  WARNING: ${w}`);
  }
}
