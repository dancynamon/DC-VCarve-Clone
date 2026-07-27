/* LGC 50 — Job 1, Board 3. Four ops, four tools, posted as one program:

     T8  drill 10 holes (Ø0.375 and one Ø0.25) at -1.5, S10000
     T3  pocket the Ø1.5 circle at (1.296, 86.693), 2 depth steps, rings linked
     T9  Ø0.125 inside-profile finishing pass around that same circle at -0.5
     T3  5 cross-cuts, 4 depth steps each, tabs by constant 3" spacing

   The DXF carries DUPLICATE circles — six coincident pairs — so the hole selection has to
   dedupe by centroid or it drills 16 holes instead of 10. */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, dir, fs, path }) {
  const ents = parseDxf(fs.readFileSync(path.join(dir, 'source.dxf'), 'utf8'));
  const polys = [];
  for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
  const contours = CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));

  const size = c => { const b = CAM.boundsOf([c.pts]); return { w: b.maxX - b.minX, h: b.maxY - b.minY }; };
  const isRound = (c, d) => { const s = size(c); return c.closed && Math.abs(s.w - d) < 0.01 && Math.abs(s.h - d) < 0.01; };

  // drill holes: round, Ø0.25 or Ø0.375, deduped by centroid
  const seen = new Set();
  const holes = contours.filter(c => isRound(c, 0.375) || isRound(c, 0.25)).filter(c => {
    const k = CAM.centroid(c.pts); const key = k.x.toFixed(3) + ',' + k.y.toFixed(3);
    if (seen.has(key)) return false; seen.add(key); return true;
  });
  const pocketCirc = contours.filter(c => isRound(c, 1.5));
  const cuts = contours.filter(c => !c.closed);

  const T8 = tool(8, 'T8 - Drill (0.375")');                            // Ø0.375, F62.46, p20, S10000
  const T3 = tool(3, 'T3a - Amana 43518 - Plastic/Wood/MDF - 0.375');   // Ø0.375, F80,    p20, S18000
  const T9 = tool(9, 'T9b - Amana 46270-K - 0.125" Dia');               // Ø0.125, F100,   p25, S18000

  const drill = CAM.drillOp(holes, Object.assign(toolOpts(T8), {
    topZ: 0, cutDepth: 1.5, peck: 0,
    order: 'optimize', orderStart: { x: 0, y: 0 },
  }));
  const pocket = CAM.pocketOp(pocketCirc, Object.assign(toolOpts(T3), {
    topZ: 0, cutDepth: 0.5, passDepth: 0.25,
    linkRings: true, climb: true,
    feed: 60,                // toolpath override: the tool's default feed is 80
    // MEASURED off the reference (least-squares circle fit per ring, identical on boards 3
    // and 4 to five decimals), not read from a dialog - see notes.md:
    stepoverIn: 0.09384,     //   ring spacing; 25% of the tool would be 0.09375
    allowance: 0.00635,      //   stock left on the wall for the T9 finishing pass
    arcs: false,             //   Vectric tessellates pocket rings into G1, ~100 per circle
  }));
  const finish = CAM.profileOp(pocketCirc, Object.assign(toolOpts(T9), {
    side: 'inside', topZ: 0, cutDepth: 0.5, passDepth: 0.5,
    plunge: 30,              // toolpath override: the tool's default plunge is 25
    // Vectric tessellates this circle into 100 G1 segments rather than emitting G2/G3 -
    // same as its pocket rings on the identical circle, on both boards 3 and 4 (four
    // independent samples). Why circles specifically, we do not know; see ARC-FITTING.md.
    arcs: false,
    leadType: 'none', rampLen: 0,
    tabs: { count: 0, length: 0, height: 0 },
  }));
  const cross = CAM.profileOp(cuts, Object.assign(toolOpts(T3), {
    topZ: 0, cutDepth: 1.5,
    passDepth: 0.375,        // toolpath override: the tool's default pass depth is 0.5
    feed: 60,                // toolpath override: the tool's default feed is 80
    openSide: 'right', entry: 'serpentine', order: 'sweep',
    orderStart: { x: 3.5, y: 63.2 },        // sweep wraps at this cut
    tabs: { spacing: 3, length: 0.875, height: 0.1 },
    leadType: 'none', rampLen: 0,
  }));

  const ops = drill.ops.concat(pocket.ops, finish.ops, cross.ops);
  ops.forEach(op => { op.clearZ = 0.8; });
  return CAM.postProcess({ name: 'LGC-50-board-3', units: 'inch', ops }, CAM.POSTS.shopsabre);
};
