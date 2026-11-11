/* view3d.js — the studio's 3D View, on the same engine as the Aquamentor 3D Product Viewer:
 * three.js r160 + OrbitControls + RoomEnvironment (package/aq3d-three.min.js, window.__AQ3D_LIBS__).
 *
 * The machined stock is one heightfield texture (camcore stockField: 0 = uncut top, down to -thickness).
 * A grid mesh samples it in the vertex shader for its shape and again per pixel for its normal and colour,
 * so V-carve flanks and pocket floors keep full simulation detail even when the grid is decimated, and the
 * carve updates live while a program plays: the playback carves into the same Float32Array and this only
 * re-uploads the texture. Walls round the perimeter follow the texture too, so a cut through an edge shows.
 *
 * Toolpaths are drawn twice — dim for the whole program, bright for what has run — with a cutter model
 * (flat / ball / V, sized from the tool) riding the current move, as in the Product Viewer's CNC panel.
 *
 * Machine -> world axes: X -> x, Y -> -z (away from the operator), Z -> y (up); stock centre at the origin.
 * Rotary jobs (setStock with wrap = radius): the same unwrapped heightfield is bent round the X axis — Y runs
 * round the circumference and a cut lowers the radius — and the toolpaths and cutter wrap with it.
 */
(function (root) {
'use strict';

function create(canvas, opts) {
  const L = root.__AQ3D_LIBS__; if (!L || !canvas) return null;
  const THREE = L.THREE;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, logarithmicDepthBuffer: true }); }
  catch (e) { return null; }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); return null; }   // float textures in the vertex shader need WebGL2
  renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 2000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899a0, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(-60, 120, 80); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45); fill.position.set(80, 40, -60); scene.add(fill);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new L.RoomEnvironment(), 0.04).texture;

  // Left-drag pans (as in the 2D view); Option/Alt-drag, middle or right button orbits; wheel zooms to the cursor.
  // Registered before OrbitControls so the button map is set before it reads the event.
  canvas.addEventListener('pointerdown', e => {
    controls.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    canvas.classList.toggle('orbit', e.altKey || e.button !== 0);
  });
  const controls = new L.OrbitControls(camera, canvas);
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
  controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true; controls.zoomToCursor = true;
  controls.addEventListener('change', () => { dirty = true; });

  const lin = (rgb) => new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const noLab = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); noLab.unpackAlignment = 1; noLab.needsUpdate = true;
  // colour uniforms are shared by every stock mesh; the heightfield ones are per mesh (a jig has one per board)
  const COL = { uTop: { value: lin([56, 67, 245]) }, uDeep: { value: lin([14, 18, 104]) }, uFloorCol: { value: lin([196, 170, 128]) }, uSide: { value: lin([40, 50, 200]) } };
  const perMesh = () => Object.assign({
    uHeight: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uCell: { value: new THREE.Vector2(0.05, 0.05) },
    uDepth: { value: 1 }, uFloor: { value: -1 }, uWrap: { value: 0 }, uOy: { value: 0 }, uLab: { value: noLab }, uLabOn: { value: 0 } }, COL);
  const U = perMesh();
  const stockMats = new Set();
  function makeStockMat(Uset) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, envMapIntensity: 0.35, side: THREE.DoubleSide });
    m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, Uset);
    sh.vertexShader = 'attribute float aKind;\nattribute float aDisp;\nattribute vec2 aH;\nuniform sampler2D uHeight;\nuniform float uWrap, uOy;\nvarying vec2 vH;\nvarying float vKind, vTh;\n' +
      sh.vertexShader
        .replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nfloat th = uWrap > 0.0 ? (uOy - position.z) / uWrap : 0.0; vTh = th;\n' +
          'if (uWrap > 0.0) objectNormal = vec3(objectNormal.x, objectNormal.y * cos(th) + objectNormal.z * sin(th), -objectNormal.y * sin(th) + objectNormal.z * cos(th));')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\nvH = aH; vKind = aKind;\nif (aDisp > 0.5) transformed.y = texture(uHeight, aH).r;\n' +
          'if (uWrap > 0.0) { float rr = uWrap + transformed.y; transformed = vec3(position.x, rr * cos(th), -rr * sin(th)); }');
    sh.fragmentShader = 'uniform sampler2D uHeight, uLab;\nuniform vec2 uTexel, uCell;\nuniform float uDepth, uFloor, uWrap, uLabOn;\nuniform vec3 uTop, uDeep, uFloorCol, uSide;\nvarying vec2 vH;\nvarying float vKind, vTh;\n' +
      sh.fragmentShader
        .replace('#include <color_fragment>',
          '#include <color_fragment>\nif (vKind > 0.5) { float h0 = texture(uHeight, vH).r;\n' +
          '  vec3 c = mix(uTop, uDeep, clamp(-h0 / uDepth, 0.0, 1.0));\n' +
          // cut-free parts: a subtle alternating tint per part (label texture: 0 none, 1..3)
          '  if (uLabOn > 0.5) { float l = floor(texture(uLab, vH).r * 255.0 + 0.5);\n' +
          '    if (l > 0.5 && l < 1.5) c = mix(c, vec3(1.0, 0.78, 0.25), 0.30); else if (l > 1.5 && l < 2.5) c = mix(c, vec3(0.15, 0.85, 0.75), 0.30); else if (l > 2.5) c = mix(c, vec3(0.95, 0.95, 1.0), 0.30); }\n' +
          '  if (h0 <= uFloor + 1e-4) c = uFloorCol;\n  diffuseColor.rgb = c; }\nelse diffuseColor.rgb = uSide;')
        .replace('#include <normal_fragment_begin>',
          '#include <normal_fragment_begin>\nif (vKind > 0.5) {\n' +
          '  float hL = texture(uHeight, vH - vec2(uTexel.x, 0.0)).r, hR = texture(uHeight, vH + vec2(uTexel.x, 0.0)).r;\n' +
          '  float hD = texture(uHeight, vH - vec2(0.0, uTexel.y)).r, hU = texture(uHeight, vH + vec2(0.0, uTexel.y)).r;\n' +
          '  vec3 nW = normalize(vec3(-(hR - hL) / (2.0 * uCell.x), 1.0, (hU - hD) / (2.0 * uCell.y)));\n' +
          '  if (uWrap > 0.0) nW = vec3(nW.x, nW.y * cos(vTh) + nW.z * sin(vTh), -nW.y * sin(vTh) + nW.z * cos(vTh));\n' +
          '  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);\n}');
    };
    stockMats.add(m); applyGhost(m);
    return m;
  }
  let ghost = false;
  function applyGhost(m) { m.transparent = ghost; m.opacity = ghost ? 0.35 : 1; m.depthWrite = !ghost; m.needsUpdate = true; }
  const stockMat = makeStockMat(U);

  let dirty = true, active = false, raf = 0;
  let stock = null, field = null, tex = null, ctr = { x: 0, y: 0 }, size = 10;
  let paths = null, tool = null, toolKey = '', wrapR = 0;

  // ---------- stock ----------
  // opts.wrap: cylinder radius for a rotary job (the field's h is the circumference, its thickness the radius)
  function heightTex(f) {
    const t = new THREE.DataTexture(f.z, f.nx, f.ny, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t;
  }
  function bindField(Uset, f, t) {
    Uset.uHeight.value = t; Uset.uTexel.value.set(1 / f.nx, 1 / f.ny); Uset.uCell.value.set(f.res, f.res);
    Uset.uDepth.value = Math.abs(f.thickness) || 1; Uset.uFloor.value = f.floor;
  }
  function setStock(f, opts) {
    clearBoards();
    if (stock) { scene.remove(stock); stock.geometry.dispose(); }
    if (tex) tex.dispose();
    wrapR = (opts && opts.wrap > 0) ? opts.wrap : 0; U.uWrap.value = wrapR; U.uOy.value = f.h / 2;
    field = f; ctr = { x: f.x0 + f.w / 2, y: f.y0 + f.h / 2 }; size = Math.max(f.w, f.h, f.thickness * 4);
    tex = heightTex(f); bindField(U, f, tex);
    const r = stockGeometry(f, wrapR);
    stock = new THREE.Mesh(r.geo, stockMat); stock.frustumCulled = false; scene.add(stock);
    dirty = true;
    return { vertices: r.vertices, step: r.step };
  }
  // The stock mesh for a field: a grid displaced by the heightfield texture, walls round it, a base.
  function stockGeometry(f, wrapR) {
    // grid: at most ~1.5M vertices; the per-pixel normal keeps full detail either way
    const step = Math.max(1, Math.ceil(Math.sqrt((f.nx * f.ny) / 1500000)));
    const gx = Math.ceil(f.nx / step) + 1, gy = Math.ceil(f.ny / step) + 1;
    const X = i => Math.min(f.w, i * step * f.res), Y = j => Math.min(f.h, j * step * f.res);
    const uOf = x => Math.min(1 - 0.5 / f.nx, Math.max(0.5 / f.nx, x / f.w)), vOf = y => Math.min(1 - 0.5 / f.ny, Math.max(0.5 / f.ny, y / f.h));
    const per = 2 * (gx + gy);                              // perimeter vertices (at most), each with a top and a bottom copy
    const nV = gx * gy + per * 2 + 4;
    const pos = new Float32Array(nV * 3), aH = new Float32Array(nV * 2), aKind = new Float32Array(nV), aDisp = new Float32Array(nV), nrm = new Float32Array(nV * 3);
    let v = 0;
    // k: 1 = top surface (shaded from the texture), 0 = wall / base; disp: the vertex takes its height from the texture
    const put = (x, y, z, u, w, k, nx, ny, nz, disp) => { pos[3 * v] = x; pos[3 * v + 1] = y; pos[3 * v + 2] = z; aH[2 * v] = u; aH[2 * v + 1] = w; aKind[v] = k; aDisp[v] = disp == null ? k : disp;
      nrm[3 * v] = nx; nrm[3 * v + 1] = ny; nrm[3 * v + 2] = nz; return v++; };
    const ox = f.w / 2, oy = f.h / 2;
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) put(X(i) - ox, 0, -(Y(j) - oy), uOf(X(i)), vOf(Y(j)), 1, 0, 1, 0);
    const idx = [];
    for (let j = 0; j < gy - 1; j++) for (let i = 0; i < gx - 1; i++) { const a = j * gx + i, b = a + 1, c = a + gx, d = c + 1; idx.push(a, b, d, a, d, c); }
    // perimeter, counter-clockwise from the lower-left corner: walls from the floor up to the (texture) top edge
    // wrapped, the ends of the cylinder are the two X edges (walls down to the axis close them like end caps);
    // the Y edges meet at the seam, so they get no wall and there is no base
    const walls = wrapR ? [[gx - 1, 1, 0], [0, -1, 0]] : null;
    const ring = [];
    if (!wrapR) for (let i = 0; i < gx - 1; i++) ring.push([i, 0, 0, 0, 1]);
    for (let j = 0; j < gy - 1 + (wrapR ? 1 : 0); j++) ring.push([gx - 1, j, 1, 0, 0]);
    if (!wrapR) for (let i = gx - 1; i > 0; i--) ring.push([i, gy - 1, 0, 0, -1]);
    const ring2 = []; for (let j = gy - 1; j > (wrapR ? -1 : 0); j--) ring2.push([0, j, -1, 0, 0]);
    const first = v;
    const strip = rs => { const s0 = v; for (const [i, j, nx, , nz] of rs) { const x = X(i) - ox, z = -(Y(j) - oy), u = uOf(X(i)), w = vOf(Y(j));
        put(x, 0, z, u, w, 0, nx, 0, nz, 1); put(x, f.floor, z, u, w, 0, nx, 0, nz); } return s0; };
    if (!wrapR) {
      strip(ring.concat(ring2)); const L = ring.length + ring2.length;
      for (let r = 0; r < L; r++) { const a = first + 2 * r, b = first + 2 * ((r + 1) % L); idx.push(a, a + 1, b + 1, a, b + 1, b); }
      const bl = put(-ox, f.floor, oy, 0, 0, 0, 0, -1, 0), br = put(ox, f.floor, oy, 0, 0, 0, 0, -1, 0), tr = put(ox, f.floor, -oy, 0, 0, 0, 0, -1, 0), tl = put(-ox, f.floor, -oy, 0, 0, 0, 0, -1, 0);
      idx.push(bl, tr, br, bl, tl, tr);
    } else for (const rs of [ring, ring2]) { const s0 = strip(rs); for (let r = 0; r < rs.length - 1; r++) { const a = s0 + 2 * r, b = a + 2; idx.push(a, a + 1, b + 1, a, b + 1, b); } }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aH', new THREE.BufferAttribute(aH, 2)); geo.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1)); geo.setAttribute('aDisp', new THREE.BufferAttribute(aDisp, 1));
    geo.setIndex(new THREE.BufferAttribute(v > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), 1));
    geo.boundingBox = wrapR ? new THREE.Box3(new THREE.Vector3(-ox, -wrapR, -wrapR), new THREE.Vector3(ox, wrapR, wrapR)) : new THREE.Box3(new THREE.Vector3(-ox, f.floor, -oy), new THREE.Vector3(ox, 0, oy)); geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    return { geo: geo, vertices: v, step: step };
  }
  function stockChanged() { if (tex) { tex.needsUpdate = true; dirty = true; } }

  // ---------- board jig: one heightfield per board, on a drawn fixture ----------
  // boards: [{ field, zTop, label }] (field from camcore stockField, zTop = machine Z of the board's top).
  // jig: { x0, x1, y0, y1, table, lanes: [{x0, x1}], stopY, rails } — drawn as the table, the fences between
  // the lanes and the end stop; gaps between boards show the jig, not material.
  let boards = [], jigGroup = null;
  const jigMat = { table: new THREE.MeshStandardMaterial({ color: 0xc9b48a, roughness: 0.9, metalness: 0, envMapIntensity: 0.25 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x7d8792, roughness: 0.45, metalness: 0.55, envMapIntensity: 0.6 }),
    stop: new THREE.MeshStandardMaterial({ color: 0xd2492a, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.5 }) };
  function clearBoards() {
    for (const b of boards) { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.tex.dispose(); if (b.lab) b.lab.dispose(); stockMats.delete(b.mesh.material); b.mesh.material.dispose(); }
    boards = [];
    if (jigGroup) { scene.remove(jigGroup); jigGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); jigGroup = null; }
  }
  function setBoards(list, jig) {
    clearBoards();
    if (stock) { scene.remove(stock); stock.geometry.dispose(); stock = null; }
    if (tex) { tex.dispose(); tex = null; }
    wrapR = 0; U.uWrap.value = 0;
    const W0 = jig ? jig.x0 : Math.min.apply(null, list.map(b => b.field.x0)), W1 = jig ? jig.x1 : Math.max.apply(null, list.map(b => b.field.x0 + b.field.w));
    const H0 = jig ? jig.y0 : Math.min.apply(null, list.map(b => b.field.y0)), H1 = jig ? jig.y1 : Math.max.apply(null, list.map(b => b.field.y0 + b.field.h));
    const T = jig ? -jig.table : 1.5;
    ctr = { x: (W0 + W1) / 2, y: (H0 + H1) / 2 };
    // `field` drives framing: the whole jig, top at Z0, down to the table
    field = { x0: W0, y0: H0, w: W1 - W0, h: H1 - H0, thickness: T, floor: -T, jig: true };
    let verts = 0;
    for (const b of list) {
      const f = b.field, Ub = perMesh(), t = heightTex(f); bindField(Ub, f, t);
      const lab = new THREE.DataTexture(new Uint8Array(f.nx * f.ny), f.nx, f.ny, THREE.RedFormat, THREE.UnsignedByteType);
      lab.minFilter = lab.magFilter = THREE.NearestFilter; lab.unpackAlignment = 1; lab.needsUpdate = true; Ub.uLab.value = lab;   // 1-byte rows are not 4-aligned
      const r = stockGeometry(f, 0); verts += r.vertices;
      const mesh = new THREE.Mesh(r.geo, makeStockMat(Ub)); mesh.frustumCulled = false;
      mesh.position.set(f.x0 + f.w / 2 - ctr.x, b.zTop, -(f.y0 + f.h / 2 - ctr.y));
      scene.add(mesh);
      boards.push({ mesh: mesh, tex: t, lab: lab, U: Ub, field: f, zTop: b.zTop, label: b.label });
    }
    if (jig) buildJig(jig);
    dirty = true;
    return { vertices: verts, boards: boards.length };
  }
  function buildJig(j) {
    jigGroup = new THREE.Group();
    const box = (x0, x1, y0, y1, z0, z1, m) => { const g = new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0);
      const o = new THREE.Mesh(g, m); o.position.set((x0 + x1) / 2 - ctr.x, (z0 + z1) / 2, -((y0 + y1) / 2 - ctr.y)); jigGroup.add(o); return o; };
    const tz = j.table - 0.004;   // a hair under the boards' bottoms, so a cut-through shows the table without z-fighting
    box(j.x0 - 1, j.x1 + 1, j.y0 - 2, j.y1 + 1.5, tz - 0.75, tz, jigMat.table);
    const rh = j.railH != null ? j.railH : 0.75, rw = j.railW != null ? j.railW : 0.75;
    // fences between the lanes (and outside the outer lanes), lower than the thinnest board so a profile never hits them
    const L = j.lanes; const gaps = [];
    if (L.length) { gaps.push([L[0].x0 - 1.0 - rw / 2]); for (let k = 0; k + 1 < L.length; k++) gaps.push([(L[k].x1 + L[k + 1].x0) / 2]); gaps.push([L[L.length - 1].x1 + 1.0 + rw / 2]); }
    for (const g of gaps) box(g[0] - rw / 2, g[0] + rw / 2, j.stopY, j.y1, j.table, j.table + rh, jigMat.rail);
    // the end stop every board loads against
    box(gaps.length ? gaps[0][0] - rw / 2 : j.x0, gaps.length ? gaps[gaps.length - 1][0] + rw / 2 : j.x1, j.stopY - 0.75, j.stopY, j.table, j.table + (j.stopH || 0.75), jigMat.stop);
    scene.add(jigGroup);
  }
  function boardsChanged(idx) { for (const k of (idx || boards.map((b, i) => i))) if (boards[k]) boards[k].tex.needsUpdate = true; dirty = true; }
  // per-cell part tint (0 none, 1..3) for board k
  function setBoardTint(k, tint) {
    const b = boards[k]; if (!b) return;
    const on = !!tint && tint.some(v => v > 0);
    if (on) { b.lab.image.data.set(tint); b.lab.needsUpdate = true; }
    b.U.uLabOn.value = on ? 1 : 0; dirty = true;
  }
  // The board under a screen point: { k, x, y } in machine units (the ray meets each board's top plane), or null.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickBoard(clientX, clientY) {
    if (!boards.length) return null;
    const r = canvas.getBoundingClientRect(); ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let best = null;
    boards.forEach((b, k) => {
      const pl = new THREE.Plane(new THREE.Vector3(0, 1, 0), -b.zTop), hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(pl, hit)) return;
      const x = hit.x + ctr.x, y = ctr.y - hit.z, f = b.field;
      if (x < f.x0 || x > f.x0 + f.w || y < f.y0 || y > f.y0 + f.h) return;
      const d = hit.distanceTo(ray.ray.origin); if (!best || d < best.d) best = { k: k, x: x, y: y, d: d };
    });
    return best;
  }

  // ---------- air-cut overlay: cutting moves that run over no material, drawn red on top ----------
  let air = null;
  function setAirCuts(p, moves) {
    if (air) { scene.remove(air); air.geometry.dispose(); air.material.dispose(); air = null; }
    if (!p || !moves || !moves.length) { dirty = true; return; }
    const pos = new Float32Array(moves.length * 6);
    moves.forEach((i, n) => { pos.set(W(p.x0[i], p.y0[i], p.z0[i], 0.01), 6 * n); pos.set(W(p.x1[i], p.y1[i], p.z1[i], 0.01), 6 * n + 3); });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    air = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff2020, depthTest: false, transparent: true, opacity: 0.95 }));
    air.renderOrder = 5; air.frustumCulled = false; scene.add(air); dirty = true;
  }

  // ---------- toolpaths ----------
  const W = (x, y, z, lift) => { if (wrapR) { const th = (y - field.y0) / wrapR, r = wrapR + z + (lift || 0); return [x - ctr.x, r * Math.cos(th), -r * Math.sin(th)]; }
    return [x - ctr.x, z + (lift || 0), -(y - ctr.y)]; };
  // wrapped: a move that turns the part is drawn as several short chords round the cylinder
  const piecesOf = (p, i) => wrapR ? Math.max(1, Math.ceil(Math.abs(p.y1[i] - p.y0[i]) / wrapR / 0.05)) : 1;
  function setPaths(p, o) {
    clearPaths(); if (!p || !p.n) return;
    o = o || {}; const lift = o.lift || 0.004, colorOf = o.colorOf || (() => [1, 0.75, 0.2]);
    let nc = 0, nr = 0; for (let i = 0; i < p.n; i++) { const k = piecesOf(p, i); if (p.kind[i] === 0) nr += k; else nc += k; }
    const cp = new Float32Array(nc * 6), cc = new Float32Array(nc * 6), rp = new Float32Array(nr * 6);
    const cutBefore = new Int32Array(p.n + 1), rapBefore = new Int32Array(p.n + 1);
    let a = 0, b = 0;
    for (let i = 0; i < p.n; i++) {
      cutBefore[i] = a; rapBefore[i] = b;
      const K = piecesOf(p, i), c = p.kind[i] === 0 ? null : colorOf(p.tool[i]);
      for (let q = 0; q < K; q++) {
        const at = u => W(p.x0[i] + (p.x1[i] - p.x0[i]) * u, p.y0[i] + (p.y1[i] - p.y0[i]) * u, p.z0[i] + (p.z1[i] - p.z0[i]) * u, lift);
        const s = at(q / K), e = at((q + 1) / K);
        if (!c) { rp.set(s, 6 * b); rp.set(e, 6 * b + 3); b++; }
        else { cp.set(s, 6 * a); cp.set(e, 6 * a + 3); cc.set(c, 6 * a); cc.set(c, 6 * a + 3); a++; } }
    }
    cutBefore[p.n] = a; rapBefore[p.n] = b;
    const mk = (posArr, colArr, opacity, color, dashed) => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      if (colArr) g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      const m = dashed ? new THREE.LineDashedMaterial({ color: color, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: opacity })
                       : new THREE.LineBasicMaterial({ color: colArr ? 0xffffff : color, vertexColors: !!colArr, transparent: true, opacity: opacity });
      const l = new THREE.LineSegments(g, m); if (dashed) l.computeLineDistances(); l.frustumCulled = false; scene.add(l); return l;
    };
    paths = { p: p, cutBefore: cutBefore, rapBefore: rapBefore,
      cutAll: mk(cp, cc, 0.22), cutDone: mk(cp, cc, 1), rapAll: mk(rp, null, 0.25, 0x8a9aa0, true), rapDone: mk(rp, null, 0.8, 0x6b7a90, true) };
    paths.cutDone.renderOrder = 2;
    setPathVisibility(o.cuts !== false, !!o.rapids);
    dirty = true;
  }
  function clearPaths() {
    if (!paths) return;
    for (const k of ['cutAll', 'cutDone', 'rapAll', 'rapDone']) { scene.remove(paths[k]); paths[k].geometry.dispose(); paths[k].material.dispose(); }
    paths = null; dirty = true;
  }
  let showCuts = true, showRapids = false;
  function setPathVisibility(cuts, rapids) {
    showCuts = !!cuts; showRapids = !!rapids;
    if (paths) { paths.cutAll.visible = paths.cutDone.visible = showCuts; paths.rapAll.visible = paths.rapDone.visible = showRapids; }
    dirty = true;
  }
  // Everything before move i has run (plus the part of move i the caller carved); the cutter sits at pt.
  function setProgress(i, pt, toolSpec) {
    if (paths) {
      const n = paths.p.n, k = Math.min(i + 1, n);   // light up the running move as well
      paths.cutDone.geometry.setDrawRange(0, 2 * paths.cutBefore[k]);
      paths.rapDone.geometry.setDrawRange(0, 2 * paths.rapBefore[k]);
    }
    if (pt) { ensureTool(toolSpec); const w = W(pt[0], pt[1], pt[2]); tool.position.set(w[0], w[1], w[2]); tool.rotation.x = wrapR ? -(pt[1] - field.y0) / wrapR : 0; tool.visible = toolVisible; }
    dirty = true;
  }

  // ---------- cutter model (tip at the tool point) ----------
  let toolVisible = true;
  const cutterMat = new THREE.MeshStandardMaterial({ color: 0xffb000, metalness: 0.55, roughness: 0.35, emissive: 0x332200, envMapIntensity: 0.6 });
  const shankMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.75, roughness: 0.3, envMapIntensity: 0.6 });
  function ensureTool(spec) {
    spec = spec || { type: 'flat', radius: 0.125 };
    const r = Math.max(0.01, spec.radius || 0.125), key = (spec.type || 'flat') + ':' + r + ':' + (spec.angle || 90);
    if (tool && key === toolKey) return;
    if (tool) { scene.remove(tool); tool.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    tool = new THREE.Group(); toolKey = key;
    const flute = Math.max(0.75, 4 * r), shankR = Math.max(r, 0.125);
    if (spec.type === 'v') {
      const half = (spec.angle || 90) * Math.PI / 360, hc = r / Math.max(0.05, Math.tan(half));
      tool.add(new THREE.Mesh(new THREE.ConeGeometry(r, hc, 40).rotateX(Math.PI).translate(0, hc / 2, 0), cutterMat));
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, flute * 0.4, 32).translate(0, hc + flute * 0.2, 0), cutterMat));
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, 1.25, 24).translate(0, hc + flute * 0.4 + 0.625, 0), shankMat));
    } else if (spec.type === 'ball') {
      tool.add(new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).translate(0, r, 0), cutterMat));
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, flute - r, 32).translate(0, r + (flute - r) / 2, 0), cutterMat));
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, 1.25, 24).translate(0, flute + 0.625, 0), shankMat));
    } else {
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, flute, 32).translate(0, flute / 2, 0), cutterMat));
      tool.add(new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, 1.25, 24).translate(0, flute + 0.625, 0), shankMat));
    }
    tool.visible = toolVisible; scene.add(tool);
  }
  function setToolVisible(on) { toolVisible = !!on; if (tool) tool.visible = toolVisible; dirty = true; }

  // ---------- look ----------
  function setColors(c) {
    if (c.top) COL.uTop.value = lin(c.top); if (c.deep) COL.uDeep.value = lin(c.deep); if (c.floor) COL.uFloorCol.value = lin(c.floor);
    if (c.side) COL.uSide.value = lin(c.side);
    if (c.background) canvas.style.background = c.background;
    dirty = true;
  }
  function setGhost(on) { ghost = !!on; stockMats.forEach(applyGhost); dirty = true; }

  // ---------- camera ----------
  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  }
  function frame(dir) {
    const f = !field ? { w: 10, h: 10, thickness: 1 } : wrapR ? { w: field.w, h: 2 * wrapR, thickness: 2 * wrapR, wrap: true } : field;
    dir = dir || [0.45, 0.95, 1.05];
    const fov = camera.fov * Math.PI / 180, aspect = camera.aspect || 1, n = Math.hypot(dir[0], dir[1], dir[2]);
    let d;
    if (dir[1] / n > 0.999) d = Math.max(f.h, f.w / aspect) * 0.5 * 1.08 / Math.tan(fov / 2) + f.thickness;   // straight down: fit the rectangle
    else {   // any other angle: fit the block's bounding sphere, so the near end never runs off the screen
      const r = 0.5 * Math.hypot(f.w, f.h, f.thickness), half = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect));
      d = r / Math.sin(half) * 0.92;
    }
    const ty = f.wrap ? 0 : -f.thickness / 2;
    controls.target.set(0, ty, 0);
    camera.position.set(dir[0] / n * d, dir[1] / n * d + ty, dir[2] / n * d);
    camera.near = Math.max(0.01, d / 400); camera.far = d * 20; camera.updateProjectionMatrix();
    controls.update(); dirty = true;
  }
  function preset(which) {
    if (which === 'top') frame([0, 1, 0.0001]);           // straight down, machine +Y up the screen (matches the 2D view)
    else if (which === 'front') frame([0, 0.32, 1]);
    else frame([0.55, 0.9, 1.0]);
  }

  // ---------- loop ----------
  function loop() {
    raf = 0; if (!active) return;
    if (controls.update()) dirty = true;
    if (dirty) { renderer.render(scene, camera); dirty = false; }
    raf = requestAnimationFrame(loop);
  }
  function setActive(on) { active = !!on; if (active && !raf) { resize(); raf = requestAnimationFrame(loop); } }
  function draw() { dirty = true; if (!active) renderer.render(scene, camera); }

  return { THREE: THREE, renderer: renderer, camera: camera, controls: controls, scene: scene,
    setStock: setStock, stockChanged: stockChanged, setBoards: setBoards, boardsChanged: boardsChanged, setBoardTint: setBoardTint, pickBoard: pickBoard, setAirCuts: setAirCuts, setPaths: setPaths, clearPaths: clearPaths, setPathVisibility: setPathVisibility,
    setProgress: setProgress, setToolVisible: setToolVisible, setColors: setColors, setGhost: setGhost,
    resize: resize, frame: frame, preset: preset, setActive: setActive, draw: draw,
    get field() { return field; } };
}

root.VIEW3D = { create: create };
})(typeof self !== 'undefined' ? self : this);
