/* Template parity fixture: rebuild a real VCarve job headlessly and post it, so
   the comparison re-runs on every `npm test` instead of being a one-off check.

   Copy this directory, rename it after the job, drop the VCarve-posted
   `reference.tap` next to it, and edit the geometry + params below to match the
   real job. Export a single function returning the posted G-code as a string.

   The geometry below is the job from the reference screenshot: 11.5 x 17.5 PVC
   signs on a 48 x 96 sheet, corner drill holes + an outside profile with tabs.
   Replace the numbers with the real ones. */
module.exports = function ({ CAM, C }) {
  const SIGN_W = 11.5, SIGN_H = 17.5;
  const TOOL_DIA = 0.25;          // Amana 51377-Z or whatever the job actually ran
  const MATERIAL_T = 0.125;       // PVC thickness

  // --- geometry: one sign, positioned where it sits on the sheet ---
  const x0 = 1.0, y0 = 1.0;
  const outline = C.mkRect(x0, y0, SIGN_W, SIGN_H);
  const holeR = 0.125, inset = 0.5;
  const holes = [
    C.mkCircle({ x: x0 + inset, y: y0 + inset }, holeR),
    C.mkCircle({ x: x0 + SIGN_W - inset, y: y0 + inset }, holeR),
    C.mkCircle({ x: x0 + inset, y: y0 + SIGN_H - inset }, holeR),
    C.mkCircle({ x: x0 + SIGN_W - inset, y: y0 + SIGN_H - inset }, holeR),
  ];

  const outlineC = CAM.assembleContours(C.shapesToContoursInput([outline]));
  const holesC = CAM.assembleContours(C.shapesToContoursInput(holes));

  // --- toolpaths, in the same ORDER VCarve ran them (order is compared) ---
  const drill = CAM.drillOp(holesC, {
    toolNum: 9, toolDia: TOOL_DIA, cutDepth: MATERIAL_T + 0.02, peck: 0.1,
    feed: 60, plunge: 30, rpm: 18000,
  });
  const profile = CAM.profileOp(outlineC, {
    toolNum: 9, toolDia: TOOL_DIA, side: 'outside', climb: true,
    cutDepth: MATERIAL_T + 0.02, passDepth: MATERIAL_T + 0.02,
    feed: 120, plunge: 60, rpm: 18000,
    tabs: { count: 4, length: 0.4, height: 0.06 },
    leadType: 'none',
  });

  const job = { name: 'pvc-sign', units: 'inch', ops: drill.ops.concat(profile.ops) };
  return CAM.postProcess(job, CAM.POSTS.shopsabre);
};
