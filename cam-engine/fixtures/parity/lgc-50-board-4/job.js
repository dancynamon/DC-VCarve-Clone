/* LGC 50 — Job 1, Board 4. Six ops, five tools, posted as one program:

     T10  drill 4 slots at -0.5
     T5   2 shallow open cuts at -0.1
     T8   drill 6 holes at -1.5 (DXF has duplicate circles - dedupe by centroid)
     T3   pocket the Ø1.5 circle, 2 depth steps, rings linked
     T9   Ø0.125 inside-profile finish around that circle at -0.5
     T3   7 cross-cuts, 4 depth steps each, tabs by constant 3" spacing

   T5's offset was MEASURED, not guessed: 0.1900" +/- 0.0001 over 78 mid-path samples
   across both of its passes. It does not decompose to a standard tool — 0.1900 is
   0.1875 + 0.0025, so most likely a Ø0.375 tool carrying a 0.0025" allowance (Vectric's
   "allowance offset"), or a Ø0.38 tool. We model the effective offset, which is what
   reproduces the path; the decomposition is ambiguous and does not matter here. */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, dir, fs, path }) {
  const ents = parseDxf(fs.readFileSync(path.join(dir, 'source.dxf'), 'utf8'));
  const polys = [];
  for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
  const contours = CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));

  const size = c => { const b = CAM.boundsOf([c.pts]); return { w: b.maxX - b.minX, h: b.maxY - b.minY }; };
  const near = (v, t) => Math.abs(v - t) < 0.01;
  const isRound = (c, d) => c.closed && near(size(c).w, d) && near(size(c).h, d);
  const dedupe = list => { const seen = new Set(); return list.filter(c => {
    const k = CAM.centroid(c.pts); const key = k.x.toFixed(3) + ',' + k.y.toFixed(3);
    if (seen.has(key)) return false; seen.add(key); return true; }); };

  const slots = contours.filter(c => c.closed && near(size(c).w, 0.125) && near(size(c).h, 0.137));
  const holes = dedupe(contours.filter(c => isRound(c, 0.375) || isRound(c, 0.25)));
  const circle = contours.filter(c => isRound(c, 1.5));
  const open = contours.filter(c => !c.closed);
  // T5 cuts the two open contours nearest y=72.5 and y=83.0; T3 cuts all seven
  const shallow = open.filter(c => { const y = CAM.centroid(c.pts).y; return near(y, 72.508) || near(y, 83.030); });

  const T10 = tool(10, 'T10b - Amana 55260 Countersink - 0.25');        // F62.46, p20, S10000
  const T5  = tool(5,  'T5e - Amana 49706 Roundover 0.380');            // Ø0.380, F100, p25, S20000
  const T8  = tool(8,  'T8 - Drill (0.375")');                          // Ø0.375, F62.46, p20, S10000
  const T3  = tool(3,  'T3a - Amana 43518 - Plastic/Wood/MDF - 0.375'); // Ø0.375, F80,  p20, S18000
  const T9  = tool(9,  'T9b - Amana 46270-K - 0.125" Dia');             // Ø0.125, F100, p25, S18000

  const t10 = CAM.drillOp(slots, Object.assign(toolOpts(T10), {
    topZ: 0, cutDepth: 0.5, peck: 0,
    order: 'optimize', orderStart: { x: 0, y: 0 },
  }));
  const t5 = CAM.profileOp(shallow, Object.assign(toolOpts(T5), {
    topZ: 0, cutDepth: 0.1, passDepth: 0.1,
    openSide: 'right', entry: 'serpentine', order: 'sweep',
    serpentineOver: open,    // direction is set by the board layout, not by this op's subset
    orderStart: { x: 3.5, y: 48.5 },
    tabs: { count: 0, length: 0, height: 0 }, leadType: 'none', rampLen: 0,
  }));
  const t8 = CAM.drillOp(holes, Object.assign(toolOpts(T8), {
    topZ: 0, cutDepth: 1.5, peck: 0,
    order: 'optimize', orderStart: { x: 0, y: 0 },
  }));
  const pocket = CAM.pocketOp(circle, Object.assign(toolOpts(T3), {
    topZ: 0, cutDepth: 0.5, passDepth: 0.25,
    stepover: 0.25, linkRings: true, climb: true,
    feed: 60,                // toolpath override: the tool's default feed is 80
  }));
  const finish = CAM.profileOp(circle, Object.assign(toolOpts(T9), {
    side: 'inside', topZ: 0, cutDepth: 0.5, passDepth: 0.5,
    plunge: 30,              // toolpath override: the tool's default plunge is 25
    leadType: 'none', rampLen: 0,
    tabs: { count: 0, length: 0, height: 0 },
  }));
  const cross = CAM.profileOp(open, Object.assign(toolOpts(T3), {
    topZ: 0, cutDepth: 1.5,
    passDepth: 0.375,        // toolpath override: the tool's default pass depth is 0.5
    feed: 60,                // toolpath override: the tool's default feed is 80
    openSide: 'right', entry: 'serpentine', order: 'sweep',
    orderStart: { x: 3.5, y: 86.7 },        // sweep wraps at this cut
    tabs: { spacing: 3, length: 0.875, height: 0.1 }, leadType: 'none', rampLen: 0,
  }));

  const ops = t10.ops.concat(t5.ops, t8.ops, pocket.ops, finish.ops, cross.ops);
  ops.forEach(op => { op.clearZ = 0.8; });
  return CAM.postProcess({ name: 'LGC-50-board-4', units: 'inch', ops }, CAM.POSTS.shopsabre);
};
