/* 20-piece male print jig (foam) — rebuild the VCarve job headlessly from source.dxf.

   Two things about this job are not obvious from the numbers alone:

   - It is MIXED-SIDE. The 20 jig pieces are cavities, cut INSIDE their contours; only the
     sheet outline is cut outside. Deriving "outside" from the extents is wrong here — the
     extents are set by the outline, which drowns out the 20 pieces. The envelope check
     passes either way for that reason, so it cannot be used to settle the question.
   - It is ONE tool block, not two. The reference has a single `T2`, so the inside passes
     and the outside pass must be merged into one op rather than posted as two, which
     would emit a spurious TOOLCHANGE.

   There are also no leads: each pass closes exactly on its own start point (0.0000). */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, dir, fs, path }) {
  const ents = parseDxf(fs.readFileSync(path.join(dir, 'source.dxf'), 'utf8'));
  const polys = [];
  for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
  const contours = CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));

  // the sheet outline is the contour that contains all the others
  let sheetIdx = 0, best = -Infinity;
  contours.forEach((c, i) => { if (c.area > best) { best = c.area; sheetIdx = i; } });
  const sheet = contours[sheetIdx];
  const pieces = contours.filter((_, i) => i !== sheetIdx);

  // The database has five entries on tool 2. This one matches the reference on diameter,
  // feed and plunge; only the spindle differs (the tool is defined at 24000, the job ran it
  // at 20000 - foam, so slower is what you would expect).
  const T2 = tool(2, 'T2a - F80 Vortex 4135');

  const common = Object.assign(toolOpts(T2), {
    topZ: 0, cutDepth: 0.75, passDepth: 0.75,
    rpm: 20000,              // toolpath override: the tool is defined at S24000
    tabs: { count: 0, length: 0, height: 0 },
    leadType: 'none', rampLen: 0,
  });

  // pieces first (cavities), toured nearest-neighbour; then the outline frees the panel
  const inner = CAM.profileOp(pieces, Object.assign({ side: 'inside', climb: false, order: 'optimize', entry: 'nearest' }, common));
  const outer = CAM.profileOp([sheet], Object.assign({ side: 'outside', climb: false }, common));

  const op = Object.assign({}, inner.ops[0], {
    passes: inner.ops[0].passes.concat(outer.ops[0].passes),
    clearZ: 0.2,
  });

  return CAM.postProcess({ name: 'print-jig', units: 'inch', ops: [op] }, CAM.POSTS.shopsabre);
};
