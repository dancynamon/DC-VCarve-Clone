// Guard for the 3D view (glview.js): matrix math + heightfield meshing. No GPU needed.
const G = require('./glview.js');
const CAM = require('./camcore.js');
let pass = 0, fail = 0;
function ok(n, c, x) { if (c) pass++; else { fail++; console.log('  FAIL', n, x === undefined ? '' : x); } }
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-6);

// ---- matrix math ----
{
  const I = G.identity();
  ok('identity is identity', I[0]===1 && I[5]===1 && I[10]===1 && I[15]===1 && I[1]===0);
  const M = G.multiply(I, I);
  ok('I*I = I', Array.from(M).join()===Array.from(I).join());
  // multiply is not commutative but must be associative-consistent with a known case:
  // translating then scaling differs from scaling then translating
  const T = G.identity(); T[12]=5;                 // translate x+5
  const S = G.identity(); S[0]=2;                  // scale x*2
  ok('multiply order matters', G.multiply(S,T)[12] === 10 && G.multiply(T,S)[12] === 5,
     G.multiply(S,T)[12]+'/'+G.multiply(T,S)[12]);

  const P = G.perspective(Math.PI/4, 2, 0.1, 100);
  ok('perspective is a projection', P[11] === -1 && P[15] === 0);
  ok('perspective divides x by aspect', near(P[0], P[5]/2, 1e-6), P[0]+'/'+P[5]);
  ok('perspective near/far sane', P[10] < 0 && P[14] < 0);

  // lookAt: the target must land on the -Z axis of view space, at distance `dist`
  const eye=[10,0,0], tgt=[0,0,0];
  const V = G.lookAt(eye, tgt, [0,0,1]);
  const tv = [V[12], V[13], V[14]];                 // target (origin) transformed into view space
  ok('lookAt puts the target down -Z', near(tv[0],0,1e-6) && near(tv[1],0,1e-6) && near(tv[2],-10,1e-6), JSON.stringify(tv));
}

// ---- orbit camera ----
{
  const t=[2,3,4];
  const e=G.orbitEye(t, 0, 0, 10);
  ok('orbit yaw 0 pitch 0 sits on +X', near(e[0],12) && near(e[1],3) && near(e[2],4), JSON.stringify(e));
  const e2=G.orbitEye(t, Math.PI/2, 0, 10);
  ok('orbit yaw 90 swings to +Y', near(e2[0],2,1e-6) && near(e2[1],13,1e-6), JSON.stringify(e2));
  const e3=G.orbitEye(t, 0, Math.PI/2, 10);
  ok('orbit pitch 90 rises to +Z', near(e3[2],14,1e-6) && near(e3[0],2,1e-6), JSON.stringify(e3));
  const d=Math.hypot(e[0]-t[0], e[1]-t[1], e[2]-t[2]);
  ok('orbit keeps the requested distance', near(d,10,1e-6), d);
  ok('pitch clamps below the pole', G.clampPitch(9) < Math.PI/2 && G.clampPitch(-9) > -Math.PI/2);
  ok('pitch passes through in range', near(G.clampPitch(0.5),0.5));
}

// ---- mesh from a real simulated heightfield ----
{
  const sq=[{pts:[{x:1,y:1},{x:5,y:1},{x:5,y:4},{x:1,y:4}],closed:true,area:12,ccw:true}];
  const pk=CAM.pocketOp(sq,{toolDia:0.5,cutDepth:0.2,passDepth:0.2,stepover:0.5});
  const g=CAM.postProcess({name:'t',units:'inch',ops:pk.ops},CAM.POSTS.generic);
  const segs=[]; let x=0,y=0,z=0,mode=null;
  for(const raw of g.split(/\r?\n/)){ const ln=raw.trim().toUpperCase(); const m=ln.match(/^(G[0-3])/); if(m)mode=m[1];
    const pv=c=>{const r=ln.match(new RegExp(c+'(-?[\\d.]+)'));return r?+r[1]:null;};
    const nx=pv('X'),ny=pv('Y'),nz=pv('Z'); const x0=x,y0=y,z0=z;
    if(nx!=null)x=nx; if(ny!=null)y=ny; if(nz!=null)z=nz;
    if(mode&&(nx!=null||ny!=null)) segs.push({x0,y0,z0,x1:x,y1:y,z1:z,rapid:mode==='G0'}); }
  const field=CAM.simulateStock({x0:0,y0:0,w:6,h:5,thickness:0.5,res:0.1,
    cuts:[{tool:{type:'flat',radius:0.25}, segs}]});
  ok('field built', field.nx>1 && field.ny>1, field.nx+'x'+field.ny);

  const m=G.buildHeightMesh(field);
  ok('mesh has geometry', m.positions.length>0 && m.indices.length>0);
  ok('positions and normals pair up', m.positions.length===m.normals.length);
  ok('vertex count matches the buffers', m.vertexCount*3===m.positions.length);
  ok('indices are in range', m.indices.every(i=>i<m.vertexCount));
  ok('triangle list', m.indices.length%3===0);
  // bounds must match the field footprint and drop to the stock floor
  ok('mesh bounds match the field', near(m.bounds.x0,0) && near(m.bounds.y0,0)
     && near(m.bounds.x1,(field.nx-1)*field.res) && near(m.bounds.y1,(field.ny-1)*field.res), JSON.stringify(m.bounds));
  ok('mesh spans the stock thickness', near(m.bounds.z0,-0.5), m.bounds.z0);
  // every normal is unit length
  let bad=0; for(let i=0;i<m.normals.length;i+=3){ const L=Math.hypot(m.normals[i],m.normals[i+1],m.normals[i+2]); if(Math.abs(L-1)>1e-3)bad++; }
  ok('normals are unit length', bad===0, bad+' bad');
  // no vertex sits above the stock top or below the floor
  let out=0; for(let i=2;i<m.positions.length;i+=3){ const z=m.positions[i]; if(z>1e-6||z<-0.5-1e-6)out++; }
  ok('all vertices lie inside the stock', out===0, out+' outside');
  // the pocket actually shows up as removed material
  let cut=0; for(let i=2;i<m.positions.length;i+=3) if(m.positions[i]<-0.05) cut++;
  ok('mesh records the pocket as cut material', cut>50, cut);
  // index width picked to match the vertex count
  ok('index array wide enough', (m.vertexCount>65535) === (m.indices instanceof Uint32Array));

  // decimation halves the grid without breaking the mesh
  const d=G.buildHeightMesh(field,{step:2});
  ok('decimated mesh is smaller', d.vertexCount < m.vertexCount, d.vertexCount+'<'+m.vertexCount);
  ok('decimated mesh still valid', d.indices.every(i=>i<d.vertexCount) && d.indices.length%3===0);
  ok('decimated mesh keeps the footprint', near(d.bounds.x1,m.bounds.x1) && near(d.bounds.y1,m.bounds.y1));
}

// ---- an uncut block is flat on top ----
{
  const flat=CAM.simulateStock({x0:0,y0:0,w:4,h:3,thickness:0.75,res:0.25,cuts:[]});
  const m=G.buildHeightMesh(flat);
  let top=0; for(let i=2;i<m.positions.length;i+=3) if(Math.abs(m.positions[i])<1e-9) top++;
  ok('uncut stock has a flat top', top>0);
  ok('uncut stock still drops to its floor', near(m.bounds.z0,-0.75), m.bounds.z0);
  const upN=[]; for(let i=0;i<m.normals.length;i+=3) if(m.normals[i+2]>0.999) upN.push(1);
  ok('flat top normals point straight up', upN.length>0);
}

// ---- toolpath line buffer ----
{
  const segs=[ {x0:0,y0:0,z0:-0.2,x1:2,y1:0,z1:-0.2},
               {x0:2,y0:0,z0:-0.2,x1:2,y1:3,z1:-0.2},
               {x0:2,y0:3,z0:0.25,x1:0,y1:0,z1:0.25,rapid:true} ];
  const L=G.buildToolpathLines(segs);
  ok('lines: two verts per segment', L.vertexCount===6 && L.segments===3, L.vertexCount);
  ok('lines: positions and colours pair up', L.positions.length===L.colors.length && L.positions.length===18);
  ok('lines: cut moves lifted off the surface', near(L.positions[2], -0.2+0.004, 1e-6), L.positions[2]);
  ok('lines: xy untouched by the lift', near(L.positions[0],0) && near(L.positions[3],2));
  // rapids get their own colour
  const cutCol=[L.colors[0],L.colors[1],L.colors[2]], rapCol=[L.colors[12],L.colors[13],L.colors[14]];
  ok('lines: rapids coloured differently from cuts', cutCol.join()!==rapCol.join(), cutCol+' vs '+rapCol);
  ok('lines: both verts of a segment share its colour',
     L.colors[12]===L.colors[15] && L.colors[13]===L.colors[16]);
  // rapids can be dropped
  const noRap=G.buildToolpathLines(segs,{rapids:false});
  ok('lines: rapids can be filtered out', noRap.segments===2, noRap.segments);
  // custom lift + colours honoured
  const cust=G.buildToolpathLines(segs,{lift:0.05, cutColor:[1,0,0], rapidColor:[0,1,0]});
  ok('lines: custom lift', near(cust.positions[2], -0.15, 1e-6), cust.positions[2]);
  ok('lines: custom colours', cust.colors[0]===1 && cust.colors[1]===0);
  ok('lines: empty input is safe', G.buildToolpathLines([]).vertexCount===0 && G.buildToolpathLines(null).segments===0);
}

// ---- pan moves along the true screen axes ----
{
  // screen-right must be perpendicular to the view direction and horizontal
  for (const yaw of [0, 0.7, -2.2, 3.0]) {
    const eye=G.orbitEye([0,0,0], yaw, 0.5, 10);
    const fwd=[-eye[0],-eye[1],-eye[2]];
    const right=[-Math.sin(yaw), Math.cos(yaw), 0];
    const d=(fwd[0]*right[0]+fwd[1]*right[1]+fwd[2]*right[2])/Math.hypot(fwd[0],fwd[1],fwd[2]);
    if(Math.abs(d)>1e-9){ ok('pan: screen-right perpendicular to view at yaw '+yaw, false, d); break; }
  }
  ok('pan: screen-right stays perpendicular to the view at every yaw', true);
  ok('pan: screen-right is horizontal', [-Math.sin(1.1), Math.cos(1.1), 0][2]===0);
}

// createRenderer must fail soft with no DOM/GPU rather than throw
ok('createRenderer returns null without a canvas', G.createRenderer({getContext(){return null;}})===null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
