// Guard for the bitmap tracer (D1): threshold -> despeckle -> boundary trace -> simplify -> smooth -> inches.
const T = require('./bitmaptrace.js');
const CAM = require('./camcore.js');
const C = require('./cadcore.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);

// Build an RGBA image from an ASCII map ('#' = black ink, '.' = white). Row 0 is the TOP row.
function img(rows) {
  const h = rows.length, w = rows[0].length, data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (j * w + i) * 4, ink = rows[j][i] === '#';
    data[k] = data[k + 1] = data[k + 2] = ink ? 0 : 255; data[k + 3] = 255;
  }
  return { width: w, height: h, data: data };
}
const bboxOf = pts => pts.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y),
  maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 });

// ---- threshold ----
{
  const im = img(['.#.', '###', '.#.']);
  const th = T.thresholdBitmap(im, {});
  ok('threshold: counts the ink pixels', th.ink === 5, th.ink);
  ok('threshold: keeps the image size', th.width === 3 && th.height === 3);
  // row 0 of the image is the TOP, so it must land at the HIGH y end of the bitmap
  ok('threshold: flips rows to y-up', th.bits[2 * 3 + 1] === 1 && th.bits[0 * 3 + 1] === 1 && th.bits[0] === 0);
  const inv = T.thresholdBitmap(im, { invert: true });
  ok('threshold: invert swaps ink and background', inv.ink === 4, inv.ink);
  // a fully transparent image has no ink whatever its colour
  const clear = { width: 2, height: 2, data: new Uint8Array(16) };
  ok('threshold: transparent pixels are background', T.thresholdBitmap(clear, {}).ink === 0);
  // threshold level actually moves the cut
  const grey = { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) };
  ok('threshold: grey is ink below a high cut', T.thresholdBitmap(grey, { threshold: 200 }).ink === 1);
  ok('threshold: grey is background below a low cut', T.thresholdBitmap(grey, { threshold: 50 }).ink === 0);
}

// ---- trace: a solid rectangle ----
{
  const th = T.thresholdBitmap(img(['....', '.##.', '.##.', '....']), {});
  const loops = T.traceBitmap(th.bits, 4, 4);
  ok('trace: one loop for one blob', loops.length === 1, loops.length);
  ok('trace: rectangle reduces to 4 corners', loops[0].pts.length === 4, JSON.stringify(loops[0].pts));
  const b = bboxOf(loops[0].pts);
  ok('trace: loop follows the pixel edges', b.minX === 1 && b.maxX === 3 && b.minY === 1 && b.maxY === 3, JSON.stringify(b));
  ok('trace: outer contour is CCW', T.signedArea(loops[0].pts) > 0, T.signedArea(loops[0].pts));
  ok('trace: area equals the ink area', near(Math.abs(T.signedArea(loops[0].pts)), 4), T.signedArea(loops[0].pts));
}

// ---- trace: a ring — the counter must come out as a CW hole ----
{
  const th = T.thresholdBitmap(img(['#####', '#...#', '#...#', '#...#', '#####']), {});
  const loops = T.traceBitmap(th.bits, 5, 5);
  ok('trace: ring gives an outer loop and a hole', loops.length === 2, loops.length);
  const areas = loops.map(l => T.signedArea(l.pts)).sort((a, b) => b - a);
  ok('trace: outer is CCW, hole is CW', areas[0] > 0 && areas[1] < 0, JSON.stringify(areas));
  ok('trace: hole area matches the counter', near(Math.abs(areas[1]), 9), areas[1]);
  // that winding is exactly what the CAM region builder needs — pocket it and the hole survives
  const cont = loops.map(l => ({ pts: l.pts, closed: true }));
  const pk = CAM.pocketOp(CAM.assembleContours(cont), { toolDia: 0.5, cutDepth: 0.2, passDepth: 0.2, stepover: 0.5 });
  ok('trace: traced ring pockets as a region with a hole', pk.ops[0].passes.length > 0, JSON.stringify(pk.warnings));
}

// ---- trace: two separate blobs ----
{
  const th = T.thresholdBitmap(img(['#.#', '...', '#.#']), {});
  ok('trace: four separate pixels give four loops', T.traceBitmap(th.bits, 3, 3).length === 4);
}

// ---- despeckle ----
{
  const th = T.thresholdBitmap(img(['####.', '####.', '####.', '####.', '....#']), {});
  const ds = T.despeckle(th.bits, 5, 5, 3);
  ok('despeckle: removes the single-pixel speck', ds.removed === 1, ds.removed);
  ok('despeckle: keeps the big blob', ds.bits.reduce((a, b) => a + b, 0) === 16, ds.bits.reduce((a, b) => a + b, 0));
  ok('despeckle: 0 minArea is a no-op', T.despeckle(th.bits, 5, 5, 0).bits === th.bits);
  // an enclosed pinhole gets filled, but the outside background never does
  const ph = T.thresholdBitmap(img(['#####', '#####', '##.##', '#####', '#####']), {});
  const dp = T.despeckle(ph.bits, 5, 5, 3);
  ok('despeckle: fills an enclosed pinhole', dp.filled === 1 && dp.bits.reduce((a, b) => a + b, 0) === 25, dp.filled);
  const openBg = T.thresholdBitmap(img(['##', '#.']), {});
  ok('despeckle: never fills background that reaches the border', T.despeckle(openBg.bits, 2, 2, 9).filled === 0);
}

// ---- simplify ----
{
  const line = []; for (let i = 0; i <= 20; i++) line.push({ x: i, y: 0 });
  ok('simplify: a straight run collapses to its endpoints', T.simplifyPath(line, 0.5, false).length === 2);
  const ell = []; for (let i = 0; i <= 10; i++) ell.push({ x: i, y: 0 }); for (let i = 1; i <= 10; i++) ell.push({ x: 10, y: i });
  ok('simplify: keeps a real corner', T.simplifyPath(ell, 0.5, false).length === 3, T.simplifyPath(ell, 0.5, false).length);
  const bent = line.slice(); bent[10] = { x: 10, y: 5 };
  ok('simplify: tolerance above the deviation drops it', T.simplifyPath(bent, 10, false).length === 2);
  ok('simplify: tol 0 is a no-op', T.simplifyPath(bent, 0, false).length === bent.length);
  // a staircase circle simplifies a lot but stays closed and roughly the same size
  const circ = []; for (let a = 0; a < 64; a++) circ.push({ x: Math.round(20 * Math.cos(a / 64 * 6.2832)), y: Math.round(20 * Math.sin(a / 64 * 6.2832)) });
  const s = T.simplifyPath(circ, 1.0, true);
  ok('simplify: closed loop loses points', s.length < circ.length && s.length >= 3, circ.length + '->' + s.length);
  const b0 = bboxOf(circ), b1 = bboxOf(s);
  ok('simplify: closed loop keeps its extent', near(b0.maxX, b1.maxX, 1.5) && near(b0.minY, b1.minY, 1.5), JSON.stringify(b1));
}

// ---- smooth ----
{
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  ok('smooth: amount 0 is a no-op', T.smoothPath(sq, true, 0).length === 4);
  ok('smooth: 90° corners are preserved as corners', T.smoothPath(sq, true, 1, 60).length === 4);
  // a shallow zig-zag is below the corner threshold, so it does get rounded
  const zig = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 0 }, { x: 30, y: 1 }, { x: 40, y: 0 }, { x: 40, y: -10 }, { x: 0, y: -10 }];
  ok('smooth: shallow bends are rounded', T.smoothPath(zig, true, 1, 60).length > zig.length, T.smoothPath(zig, true, 1, 60).length);
  ok('smooth: a lower corner threshold protects more vertices',
     T.smoothPath(zig, true, 1, 5).length < T.smoothPath(zig, true, 1, 60).length);
}

// ---- full pipeline in inches ----
{
  const rows = []; for (let j = 0; j < 40; j++) rows.push(new Array(80).fill('.').join(''));
  for (let j = 8; j < 32; j++) { const r = rows[j].split(''); for (let i = 10; i < 70; i++) r[i] = '#'; rows[j] = r.join(''); }
  const im = img(rows);
  const r = T.traceImage(im, { dpi: 20, tol: 0.5, smooth: 0, despeckle: 0 });
  ok('pipeline: one contour', r.loops.length === 1, r.loops.length);
  const b = bboxOf(r.loops[0].pts);
  ok('pipeline: dpi scales pixels to inches', near(b.maxX - b.minX, 3, 1e-6) && near(b.maxY - b.minY, 1.2, 1e-6), JSON.stringify(b));
  ok('pipeline: stats report the traced size', near(r.stats.widthInches, 4) && near(r.stats.heightInches, 2), JSON.stringify(r.stats));
  ok('pipeline: counts outer vs hole loops', r.stats.outer === 1 && r.stats.holes === 0);
  ok('pipeline: reports the point reduction', r.stats.pointsBefore >= r.stats.pointsAfter && r.stats.pointsAfter === 4,
     r.stats.pointsBefore + '->' + r.stats.pointsAfter);
  // widthInches overrides dpi
  const r2 = T.traceImage(im, { widthInches: 8, tol: 0.5, smooth: 0 });
  const b2 = bboxOf(r2.loops[0].pts);
  ok('pipeline: widthInches overrides dpi', near(b2.maxX - b2.minX, 6, 1e-6), b2.maxX - b2.minX);
  // origin offset
  const r3 = T.traceImage(im, { dpi: 20, originX: 5, originY: 2, tol: 0.5, smooth: 0 });
  const b3 = bboxOf(r3.loops[0].pts);
  ok('pipeline: origin offsets the result', near(b3.minX, 5.5) && near(b3.minY, 2.4), JSON.stringify(b3));
  ok('pipeline: an empty image traces to nothing',
     T.traceImage({ width: 4, height: 4, data: new Uint8Array(64).fill(255) }, {}).loops.length === 0);
}

// ---- traced loops feed straight into the CAD/CAM chain ----
{
  const rows = ['........', '..####..', '..#..#..', '..#..#..', '..####..', '........'];
  const r = T.traceImage(img(rows), { dpi: 4, tol: 0.4, smooth: 0, despeckle: 0 });
  ok('integration: ring traces to 2 loops', r.loops.length === 2, r.loops.length);
  const shapes = r.loops.map(l => C.mkPoly(l.pts, true, 'trace'));
  ok('integration: becomes CAD shapes on their own layer', shapes.every(s => s.type === 'path' && s.closed && s.layer === 'trace'));
  const prof = CAM.profileOp(CAM.assembleContours(C.shapesToContoursInput(shapes)),
    { side: 'outside', toolDia: 0.05, cutDepth: 0.2, passDepth: 0.2 });
  ok('integration: traced shapes profile', prof.ops[0].passes.length > 0, JSON.stringify(prof.warnings));
  const g = CAM.postProcess({ name: 'TRACE', units: 'inch', ops: prof.ops }, CAM.POSTS.shopsabre);
  ok('integration: traced shapes post to G-code', g.length > 200 && /G1|G01/.test(g));
  ok('integration: traced shapes export to DXF', C.toDXF(shapes).indexOf('LWPOLYLINE') > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
