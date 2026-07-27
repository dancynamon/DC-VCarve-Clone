/* LGC 50 — Job 1, Board 1. First multi-tool fixture.

   Two ops, two tools, posted as one program:
     T8  drill 4 holes on the board centreline (plain plunge, no peck)
     T3  4 cross-cuts across the 3.5" board width, 4 depth steps each, 1 tab each

   The cross-cuts are OPEN contours offset by the tool radius to the RIGHT of travel —
   a separation cut, so the kerf falls on the waste side. Travel direction alternates,
   each cut starting where the last ended; that falls out of entry:'nearest'. */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, dir, fs, path }) {
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

  const drill = CAM.drillOp(holes, {
    toolNum: 8, toolDia: 0.375, topZ: 0, cutDepth: 1.5, peck: 0,
    feed: 62.5, plunge: 20, rpm: 18000,
    order: 'optimize', orderStart: { x: 0, y: 0 },     // this job's drill tour starts at the origin
  });
  const cross = CAM.profileOp(cuts, {
    toolNum: 3, toolDia: 0.375, topZ: 0, cutDepth: 1.5, passDepth: 0.375,
    feed: 60, plunge: 20, rpm: 18000,
    openSide: 'right', entry: 'serpentine', order: 'sweep',
    orderStart: { x: 3.5, y: 48.5 },                // tour begins at the right edge, mid-board
    tabs: { count: 1, length: 0.875, height: 0.1 },
    leadType: 'none', rampLen: 0,
  });

  const ops = drill.ops.concat(cross.ops);
  ops.forEach(op => { op.clearZ = 0.8; });
  return CAM.postProcess({ name: 'LGC-50-board-1', units: 'inch', ops }, CAM.POSTS.shopsabre);
};
