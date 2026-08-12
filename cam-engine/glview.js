/* glview.js — real 3D view of the machined stock. Pure math + mesh building (unit-tested headless),
 * with a thin WebGL layer on top. No external libraries: the studio must stay one offline file.
 *
 * The 3D View used to be a top-down shaded heightfield — informative, but you could not look at the
 * job from an angle. This turns the same heightfield into an actual solid: a triangulated top
 * surface, perimeter walls dropping to the stock floor, and a base, lit by a single directional
 * light so pocket walls and V-groove flanks read as geometry rather than as shading tricks.
 *
 * Split so the interesting parts are testable without a GPU:
 *   buildHeightMesh(field)  -> {positions, normals, indices, bounds}   pure
 *   perspective/lookAt/orbitEye/multiply                                pure
 *   createRenderer(canvas)  -> WebGL plumbing, or null when unavailable thin
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.GLVIEW = mod;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------- 4x4 matrix math (column-major, WebGL order) ----------
function identity() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
function multiply(a, b) {                      // returns a*b
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
  const o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
  return o;
}
function _sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function _norm(v) { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/m, v[1]/m, v[2]/m]; }
function _dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function lookAt(eye, center, up) {
  const f = _norm(_sub(center, eye));
  let s = _cross(f, up);
  if (Math.hypot(s[0], s[1], s[2]) < 1e-8) s = _cross(f, [0, 1, 0]);   // eye looking straight down the up axis
  s = _norm(s);
  const u = _cross(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -_dot(s, eye), -_dot(u, eye), _dot(f, eye), 1
  ]);
}
// Camera position for an orbit: yaw about +Z, pitch up from the XY plane, at `dist` from target.
function orbitEye(target, yaw, pitch, dist) {
  const cp = Math.cos(pitch);
  return [ target[0] + dist * cp * Math.cos(yaw),
           target[1] + dist * cp * Math.sin(yaw),
           target[2] + dist * Math.sin(pitch) ];
}
const PITCH_LIMIT = Math.PI / 2 - 0.02;   // never let the camera cross the pole (flips the up vector)
function clampPitch(p) { return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p)); }

// ---------- mesh from a simulateStock heightfield ----------
// field: {nx,ny,res,x0,y0,w,h,thickness,floor,z}. z is the machined SURFACE height (0 = stock top,
// negative = cut down). Emits the top surface + perimeter walls + a base, so it reads as a solid.
function buildHeightMesh(field, opts) {
  const o = opts || {};
  const nx = field.nx, ny = field.ny, res = field.res, z = field.z;
  const x0 = field.x0, y0 = field.y0;
  const bottom = -Math.abs(field.thickness == null ? 0.5 : field.thickness);
  const step = Math.max(1, Math.floor(o.step || 1));                    // decimation for huge fields
  const gx = Math.floor((nx - 1) / step) + 1, gy = Math.floor((ny - 1) / step) + 1;
  const at = (i, j) => z[Math.min(ny-1, Math.max(0, j)) * nx + Math.min(nx-1, Math.max(0, i))];

  const topCount = gx * gy;
  const sideCount = 2 * (gx * 2) + 2 * (gy * 2);        // 4 walls, 2 rings of verts each
  const total = topCount + sideCount + 4;               // + base quad
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const idx = [];
  let p = 0;
  const put = (x, y, zz, nxv, nyv, nzv) => { const k = p * 3;
    positions[k] = x; positions[k+1] = y; positions[k+2] = zz;
    normals[k] = nxv; normals[k+1] = nyv; normals[k+2] = nzv; return p++; };

  // top surface
  for (let jj = 0; jj < gy; jj++) for (let ii = 0; ii < gx; ii++) {
    const i = Math.min(nx - 1, ii * step), j = Math.min(ny - 1, jj * step);
    const h = at(i, j);
    const dzx = (at(i + step, j) - at(i - step, j)) / (2 * res * step);
    const dzy = (at(i, j + step) - at(i, j - step)) / (2 * res * step);
    const n = _norm([-dzx, -dzy, 1]);
    put(x0 + i * res, y0 + j * res, h, n[0], n[1], n[2]);
  }
  for (let jj = 0; jj < gy - 1; jj++) for (let ii = 0; ii < gx - 1; ii++) {
    const a = jj * gx + ii, b = a + 1, c = a + gx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // perimeter walls: top edge at the machined height, bottom edge at the stock floor
  const wall = (pts, nrm) => {
    const base = p;
    for (const q of pts) put(q[0], q[1], q[2], nrm[0], nrm[1], nrm[2]);
    for (const q of pts) put(q[0], q[1], bottom, nrm[0], nrm[1], nrm[2]);
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
      const a = base + i, b = base + i + 1, c = base + n + i, d = base + n + i + 1;
      idx.push(a, c, b, b, c, d);
    }
  };
  const edgeS = [], edgeN = [], edgeW = [], edgeE = [];
  for (let ii = 0; ii < gx; ii++) { const i = Math.min(nx - 1, ii * step);
    edgeS.push([x0 + i * res, y0, at(i, 0)]);
    edgeN.push([x0 + i * res, y0 + (ny - 1) * res, at(i, ny - 1)]); }
  for (let jj = 0; jj < gy; jj++) { const j = Math.min(ny - 1, jj * step);
    edgeW.push([x0, y0 + j * res, at(0, j)]);
    edgeE.push([x0 + (nx - 1) * res, y0 + j * res, at(nx - 1, j)]); }
  wall(edgeS, [0, -1, 0]); wall(edgeN.slice().reverse(), [0, 1, 0]);
  wall(edgeW.slice().reverse(), [-1, 0, 0]); wall(edgeE, [1, 0, 0]);
  // base
  const bx = x0 + (nx - 1) * res, by = y0 + (ny - 1) * res, b0 = p;
  put(x0, y0, bottom, 0, 0, -1); put(bx, y0, bottom, 0, 0, -1);
  put(bx, by, bottom, 0, 0, -1); put(x0, by, bottom, 0, 0, -1);
  idx.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2);

  const IndexArray = (p > 65535) ? Uint32Array : Uint16Array;
  return { positions, normals, indices: IndexArray.from(idx), vertexCount: p,
    bounds: { x0: x0, y0: y0, x1: bx, y1: by, z0: bottom, z1: 0 } };
}

// ---------- WebGL renderer (thin) ----------
const VS = `attribute vec3 aPos; attribute vec3 aNrm;
uniform mat4 uProj, uView; varying vec3 vN; varying float vD;
uniform float uDepth;
void main(){ vN = aNrm; vD = uDepth > 0.0 ? clamp(-aPos.z / uDepth, 0.0, 1.0) : 0.0;
  gl_Position = uProj * uView * vec4(aPos, 1.0); }`;
const FS = `precision mediump float; varying vec3 vN; varying float vD;
uniform vec3 uTop, uDeep, uLight;
void main(){ vec3 n = normalize(vN);
  float lam = max(dot(n, normalize(uLight)), 0.0);
  float shade = 0.34 + 0.66 * lam;
  vec3 base = mix(uTop, uDeep, vD);
  gl_FragColor = vec4(base * shade, 1.0); }`;

function createRenderer(canvas) {
  let gl = null;
  try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); }
  catch (e) { return null; }
  if (!gl) return null;
  const isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
  if (!isGL2 && !gl.getExtension('OES_element_index_uint')) { /* fall back to decimation below */ }
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { return null; }
  gl.useProgram(prog);
  const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'),
    proj: gl.getUniformLocation(prog, 'uProj'), view: gl.getUniformLocation(prog, 'uView'),
    top: gl.getUniformLocation(prog, 'uTop'), deep: gl.getUniformLocation(prog, 'uDeep'),
    light: gl.getUniformLocation(prog, 'uLight'), depth: gl.getUniformLocation(prog, 'uDepth') };
  const bufP = gl.createBuffer(), bufN = gl.createBuffer(), bufI = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  let mesh = null, indexType = gl.UNSIGNED_SHORT, indexCount = 0;
  const cam = { target: [0,0,0], yaw: -Math.PI/2, pitch: 0.62, dist: 30 };
  let clear = [0.79, 0.79, 0.96], top = [0.22, 0.26, 0.96], deep = [0.055, 0.07, 0.41], depth = 0.5;

  function setMesh(m, thickness) {
    mesh = m; depth = Math.abs(thickness || 0.5);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufP); gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufI); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    indexType = (m.indices instanceof Uint32Array) ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    indexCount = m.indices.length;
    const b = m.bounds;
    cam.target = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
  }
  function frameAll() {
    if (!mesh) return;
    const b = mesh.bounds;
    cam.dist = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 1.55 + 4;
    cam.yaw = -Math.PI / 2; cam.pitch = 0.62;
  }
  function setColors(c) {
    if (c.clear) clear = c.clear; if (c.top) top = c.top; if (c.deep) deep = c.deep;
  }
  function resize() {
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number') ? devicePixelRatio : 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  function draw() {
    resize();
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!mesh || !indexCount) return;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(42 * Math.PI / 180, aspect, 0.1, cam.dist * 8 + 100);
    const eye = orbitEye(cam.target, cam.yaw, cam.pitch, cam.dist);
    const view = lookAt(eye, cam.target, [0, 0, 1]);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(loc.proj, false, proj);
    gl.uniformMatrix4fv(loc.view, false, view);
    gl.uniform3fv(loc.top, top); gl.uniform3fv(loc.deep, deep);
    gl.uniform3fv(loc.light, [-0.45, -0.5, 0.74]); gl.uniform1f(loc.depth, depth);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufP); gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.enableVertexAttribArray(loc.nrm); gl.vertexAttribPointer(loc.nrm, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufI);
    gl.drawElements(gl.TRIANGLES, indexCount, indexType, 0);
  }
  return {
    gl: gl, cam: cam, setMesh: setMesh, setColors: setColors, frameAll: frameAll, draw: draw, resize: resize,
    orbit(dx, dy) { cam.yaw -= dx; cam.pitch = clampPitch(cam.pitch + dy); },
    pan(dx, dy) {   // screen-space pan, in world units
      const right = [Math.sin(cam.yaw) , -Math.cos(cam.yaw), 0];
      const upv = [ -Math.cos(cam.yaw) * Math.sin(cam.pitch), -Math.sin(cam.yaw) * Math.sin(cam.pitch), Math.cos(cam.pitch)];
      for (let i = 0; i < 3; i++) cam.target[i] += right[i] * dx + upv[i] * dy;
    },
    zoom(f) { cam.dist = Math.max(0.5, Math.min(5000, cam.dist * f)); }
  };
}

return { identity, multiply, perspective, lookAt, orbitEye, clampPitch, PITCH_LIMIT,
  buildHeightMesh, createRenderer };
});
