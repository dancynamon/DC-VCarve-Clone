/* LGC 50 — Job 1, Board 5.

   Two ops, two tools, posted as one program:
     T8  drill 4 holes on the board centreline (plain plunge, no peck), S10000
     T3  4 cross-cuts across the 3.5" board width, 4 depth steps each, 1 tab each, S18000

   The cross-cuts are OPEN contours offset by the tool radius to the RIGHT of travel —
   a separation cut, so the kerf falls on the waste side. Successive cuts alternate which
   side they start from (entry:'serpentine'), and the tour is an ascending-Y sweep.

   Tool geometry and speeds come from the exported Vectric tool database via tool(); the
   only per-toolpath overrides are noted at the line. */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, dir, fs, path }) {
  const ents = parseDxf(fs.readFileSync(path.join(dir, 'source.dxf'), 'utf8'));
  const polys = [];
  for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
  const contours = CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));

  // the drilled holes are the Ø0.375 circles on the centreline; the cross-cuts are the
  // only open contours in the file
  const isHole = c => {
    if (!c.closed) return false;
    const b = CAM.boundsOf([c.pts]);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    return Math.abs(w - 0.375) < 0.01 && Math.abs(h - 0.375) < 0.01;
  };
  const holes = contours.filter(isHole);
  const cuts = contours.filter(c => !c.closed);

  const T8 = tool(8, 'T8 - Drill (0.375")');           // Ø0.375, F62.46, plunge 20, S10000
  const T3 = tool(3, 'T3a - Amana 43518 - Plastic/Wood/MDF - 0.375');  // Ø0.375, F80, plunge 20, S18000

  const drill = CAM.drillOp(holes, Object.assign(toolOpts(T8), {
    topZ: 0, cutDepth: 1.5, peck: 0,
    order: 'optimize', orderStart: { x: 0, y: 115 },
  }));
  const cross = CAM.profileOp(cuts, Object.assign(toolOpts(T3), {
    topZ: 0, cutDepth: 1.5,
    passDepth: 0.375,        // toolpath override: the tool's default pass depth is 0.5
    feed: 60,                // toolpath override: the tool's default feed is 80
    openSide: 'right', entry: 'serpentine', order: 'sweep',
    orderStart: { x: 3.5, y: 48.5 },                // tour begins at the right edge, mid-board
    tabs: { count: 1, length: 0.875, height: 0.1 },
    leadType: 'none', rampLen: 0,
  }));

  const ops = drill.ops.concat(cross.ops);
  ops.forEach(op => { op.clearZ = 0.8; });
  return CAM.postProcess({ name: 'LGC-50-board-5', units: 'inch', ops }, CAM.POSTS.shopsabre);
};
