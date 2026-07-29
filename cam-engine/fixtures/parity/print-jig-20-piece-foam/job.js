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
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, Crv3d, dir, fs, path }) {
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

  // The ORDER the 20 pieces are cut in is not in the DXF - it is the project's nesting
  // order, and no rule reproduces it (not DXF order, not nearest-neighbour; Vectric's tour
  // is 19% LONGER in rapid travel than NN, see notes.md). It IS in the project file: the
  // stored toolpath runs are in cutting order, and the posted entry is each pass's stored
  // CLOSING point. On all 20 pieces the stored chain closes exactly on its own start, so
  // first and last coincide and match the .tap to four decimals; on the sheet outline the
  // stored chain starts one tessellation sliver into a corner arc and ends at (0.125, 0.25)
  // - and the .tap enters at the closing point, not the sliver. Read it from source.crv3d.
  const crv = Crv3d.parseCrv3d(fs.readFileSync(path.join(dir, 'source.crv3d')));
  const sheetBB = CAM.boundsOf([sheet.pts]);
  const entries = [];                        // piece entry points, in stored cutting order
  let sheetEntry = null;                     // ...and the outline's own entry
  for (const g of crv.geometry) {
    let sx = 0, sy = 0;
    for (const q of g.points) { sx += q.x; sy += q.y; }
    const cx = sx / g.points.length, cy = sy / g.points.length;
    // a run belongs to the sheet outline if its centroid hugs the sheet's own bbox edge
    const onSheet = Math.min(cx - sheetBB.minX, sheetBB.maxX - cx, cy - sheetBB.minY, sheetBB.maxY - cy) < 1.0;
    const last = entries[entries.length - 1];
    const gl = g.points[g.points.length - 1];
    if (onSheet) { if (last) last.done = true; sheetEntry = { x: gl.x, y: gl.y }; continue; }
    if (last && !last.done && Math.hypot(cx - last.cx, cy - last.cy) < 4) { last.cx = cx; last.cy = cy; last.x = gl.x; last.y = gl.y; continue; }
    entries.push({ x: gl.x, y: gl.y, cx, cy, done: false });
  }
  if (entries.length !== pieces.length) throw new Error('expected ' + pieces.length + ' piece entries in source.crv3d, found ' + entries.length);

  // cut each piece where and in the order the project says; then the outline frees the panel
  const passes = [];
  for (const e of entries) {
    let best = null, bd = Infinity;
    for (const c of pieces) { const k = CAM.centroid(c.pts); const d = Math.hypot(k.x - e.cx, k.y - e.cy); if (d < bd) { bd = d; best = c; } }
    const one = CAM.profileOp([best], Object.assign({ side: 'inside', climb: false, startAt: { x: e.x, y: e.y } }, common));
    passes.push(...one.ops[0].passes);
  }
  // the outline's entry comes from the project too: Vectric enters at the corner-arc end
  // (0.125, 0.25), not at the corner bisector where our entryTarget would land
  const outer = CAM.profileOp([sheet], Object.assign({ side: 'outside', climb: false, startAt: sheetEntry }, common));
  passes.push(...outer.ops[0].passes);

  const op = Object.assign({}, outer.ops[0], { passes, clearZ: 0.2 });

  return CAM.postProcess({ name: 'print-jig', units: 'inch', ops: [op] }, CAM.POSTS.shopsabre);
};
