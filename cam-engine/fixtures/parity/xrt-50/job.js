/* XRT-50 — rebuild the VCarve job headlessly from source.dxf and post it.
   Every parameter below was derived from the DXF + reference.tap pair, not read off a
   dialog; see notes.md for how each one was recovered. */
module.exports = function ({ CAM, C, parseDxf, entityToPolys, tool, toolOpts, dir, fs, path }) {
  const ents = parseDxf(fs.readFileSync(path.join(dir, 'source.dxf'), 'utf8'));
  const polys = [];
  for (const e of ents) for (const q of entityToPolys(e)) polys.push(q);
  const contours = CAM.assembleContours(C.shapesToContoursInput(C.dxfPolysToShapes(polys)));

  // The tool database matches this job exactly - Ø0.25, F100, plunge 30, S24000 - and the
  // Ø0.25 was independently confirmed by the cut sitting 0.125" proud of the DXF extents
  // on all four sides. Nothing here is overridden.
  const T1 = tool(1, 'T1 - Vortex Custom Tool for Rescue Tubes');

  const res = CAM.profileOp(contours, Object.assign(toolOpts(T1), {
    side: 'outside',
    climb: false,                       // reference arcs are all CCW -> conventional
    topZ: 0, cutDepth: 1.5, passDepth: 1.5,   // single pass, clean through 1.5" foam
    tabs: { count: 0, length: 0, height: 0 }, // no mid-cut Z lifts in the reference
    leadType: 'line', leadLen: 0.25,
    leadAngle: 15,                      // Vectric's linear leads sit 15 deg off tangent
    overcut: 0.25,                      // and carry 0.25" past the start before departing
    rampLen: 0,                         // reference plunges straight down at the lead start
  }));
  res.ops.forEach(op => { op.clearZ = 0.8; });   // reference retracts to Z0.8, not the 0.25 default

  return CAM.postProcess({ name: 'XRT-50', units: 'inch', ops: res.ops }, CAM.POSTS.shopsabre);
};
