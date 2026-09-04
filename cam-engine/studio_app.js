/* ===================== Aquamentor CAD/CAM Studio app ===================== */
'use strict';
const TAU = Math.PI*2;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const overlay = document.getElementById('hud');

// ---- document & state ----
let doc = { shapes: [], layers: new Map([['0',{visible:true,color:'#9fe7ff'}]]) };
let activeLayer = '0';
let sel = new Set();
let tool = 'select';
let view = { ppi: 18, ox: 80, oy: 0 };   // oy set on resize
let grid = { on:true, step:0.5, snap:true, objSnap:true, ortho:false, rotSnap:5 };   // rotSnap = Shift rotate increment (deg)
function snapGridPt(p){ return grid.snap&&grid.on ? { x:Math.round(p.x/grid.step)*grid.step, y:Math.round(p.y/grid.step)*grid.step } : { x:p.x, y:p.y }; }
let history = [], future = [];
let toolpaths = null;     // generated g-code segments overlay
let drillMarks = null;    // drill hole centers overlay [{x,y}]
let drillDia = 0.25;      // tool dia for drill marker size
let lastGcode = '';
let msg = '';
let job = { w:24, h:18, thickness:0.5, origin:'bl', show:true };
let measure = null;   // persisted measurement {a,b}
let viewMode = '2d';  // '2d' design canvas | 'preview' machining backplot (VCarve-style view tabs)
let simField = null;  // {canvas, field, x0,y0,x1,y1} — shaded material-removal heightfield for Preview
let orbit = { yaw:0, pitch:90 };   // 3D cut camera: yaw about Z (deg), pitch = elevation (90 = straight down = matches 2D view)
let pendingRestore = null;   // parsed autosave awaiting the non-blocking Restore banner
function fmtTime(s){ s=Math.round(s||0); if(s<=0)return '—'; if(s<60)return s+'s'; const m=Math.floor(s/60); return m+':'+String(s%60).padStart(2,'0'); }
let ttFont = null;        // loaded opentype.js font (for TTF outline text)
let textOutline = false;  // text tool mode: true=TTF outline contours, false=single-stroke

// ---- transforms ----
function W2S(p){ return { x: view.ox + p.x*view.ppi, y: view.oy - p.y*view.ppi }; }
function S2W(p){ return { x: (p.x - view.ox)/view.ppi, y: (view.oy - p.y)/view.ppi }; }
function pxTol(px){ return px/view.ppi; }

// ---- history ----
function snapshot(){ return { shapes: JSON.parse(JSON.stringify(doc.shapes)), sel:[...sel], queue: JSON.parse(JSON.stringify(opsQueue)) }; }
function pushHistory(){ history.push(snapshot()); if(history.length>100)history.shift(); future=[]; scheduleAutosave(); }
function undo(){ if(!history.length)return; future.push(snapshot()); const s=history.pop(); doc.shapes=s.shapes; sel=new Set(s.sel); if(s.queue)opsQueue=s.queue; editingIdx=null; render(); syncPanels(); buildQueueList(); }
function redo(){ if(!future.length)return; history.push(snapshot()); const s=future.pop(); doc.shapes=s.shapes; sel=new Set(s.sel); if(s.queue)opsQueue=s.queue; editingIdx=null; render(); syncPanels(); buildQueueList(); }

// ---- shape mgmt ----
function addShapes(arr){ for(const s of arr){ s.layer = s.layer||activeLayer; doc.shapes.push(s); } }
function shapeById(id){ return doc.shapes.find(s=>s.id===id); }
function selectedShapes(){ return doc.shapes.filter(s=>sel.has(s.id)); }
function deleteSelected(){ if(!sel.size)return; pushHistory(); doc.shapes=doc.shapes.filter(s=>!sel.has(s.id)); sel.clear(); render(); syncPanels(); }
function layerVisible(name){ const l=doc.layers.get(name); return !l || l.visible!==false; }

// ---- snapping ----
function snapWorld(scr){
  let w = S2W(scr);
  let best=null, bestD=pxTol(11);
  if(grid.objSnap){
    // job/material corners, edge midpoints, and center are snap targets
    if(job.show){ const r=jobRect(); for(const sp of CADCORE.rectSnapPoints(r.x0,r.y0,r.x1,r.y1)){ const d=Math.hypot(sp.x-w.x, sp.y-w.y); if(d<bestD){bestD=d; best={x:sp.x,y:sp.y,kind:sp.kind};} } }
    for(const s of doc.shapes){ if(!layerVisible(s.layer))continue;
      for(const sp of CADCORE.snapPoints(s)){ const d=Math.hypot(sp.x-w.x, sp.y-w.y); if(d<bestD){bestD=d; best={x:sp.x,y:sp.y,kind:sp.kind};} } }
  }
  if(best) return best;
  if(grid.snap && grid.on){ return { x: Math.round(w.x/grid.step)*grid.step, y: Math.round(w.y/grid.step)*grid.step, kind:'grid' }; }
  return { x:w.x, y:w.y, kind:null };
}

// ---- rendering ----
function resize(){ const r=cv.parentElement.getBoundingClientRect(); cv.width=r.width; cv.height=r.height; if(!view._init){ view.oy=cv.height-60; view._init=true; } render(); }
function render(){
  const pv = viewMode==='preview';
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.fillStyle='#0c0f14'; ctx.fillRect(0,0,cv.width,cv.height);
  if(pv && simField){ if(GL3D.ok) drawSim3D(); else drawSimField(); updateHud(); return; }   // solid material-removal view
  if(!pv) drawGrid();          // Preview: clean material, no grid
  drawJob();
  // shapes — dimmed reference lines in Preview, no selection colour
  for(const s of doc.shapes){
    if(!layerVisible(s.layer))continue;
    drawShape(s, !pv && sel.has(s.id), pv);
  }
  // toolpaths overlay (the machining backplot — always shown)
  if(toolpaths) drawToolpaths();
  if(drillMarks) drawDrillMarks();
  if(!pv){   // editing affordances only in 2D Design
    if(sel.size && tool==='select') drawSelectionHandles();
    if(tool==='node' && sel.size===1) drawNodes(selectedShapes()[0]);
    if(draft) drawDraft();
    if(measure) drawMeasure(measure.a, measure.b, true);
    if(snapMark) drawSnapMark(snapMark);
  }
  updateHud();
}
function drawGrid(){
  const w0=S2W({x:0,y:cv.height}), w1=S2W({x:cv.width,y:0});
  let step=grid.step; const px=step*view.ppi; while(step*view.ppi<8) step*=2; 
  ctx.lineWidth=1;
  ctx.strokeStyle='rgba(255,255,255,0.045)';
  ctx.beginPath();
  for(let x=Math.floor(w0.x/step)*step; x<=w1.x; x+=step){ const sx=W2S({x,y:0}).x; ctx.moveTo(sx,0); ctx.lineTo(sx,cv.height); }
  for(let y=Math.floor(w0.y/step)*step; y<=w1.y; y+=step){ const sy=W2S({x:0,y}).y; ctx.moveTo(0,sy); ctx.lineTo(cv.width,sy); }
  ctx.stroke();
  // axes
  ctx.strokeStyle='rgba(90,130,255,0.35)'; ctx.beginPath();
  const o=W2S({x:0,y:0}); ctx.moveTo(o.x,0);ctx.lineTo(o.x,cv.height); ctx.moveTo(0,o.y);ctx.lineTo(cv.width,o.y); ctx.stroke();
}
function drawSimField(){
  const a=W2S({x:simField.x0,y:simField.y1}), b=W2S({x:simField.x1,y:simField.y0});
  ctx.save(); ctx.imageSmoothingEnabled=true;
  ctx.drawImage(simField.canvas, a.x, a.y, b.x-a.x, b.y-a.y);
  ctx.strokeStyle='rgba(20,30,45,0.55)'; ctx.lineWidth=1; ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
  ctx.restore();
}
// ---- 3D cut view (WebGL, orbitable) ----
// Orthographic camera that coincides with the 2D view at yaw 0 / pitch 90, so pan + zoom (view.ox/oy/ppi) carry over
// unchanged and orbiting just tilts the same picture. Rotation is about the screen-center world point at mid-thickness.
const GL3D = { ok:false, gl:null, cv:null, prog:null, mesh:null, lines:null, tried:false };
const GL_VS=`attribute vec3 aPos; attribute vec3 aNrm; attribute vec3 aCol;
uniform mat3 uRot; uniform vec3 uCenter; uniform vec2 uScale; uniform float uDepth; uniform float uLit; uniform float uNudge;
varying vec3 vCol;
void main(){ vec3 q=uRot*(aPos-uCenter); gl_Position=vec4(q.x*uScale.x, q.y*uScale.y, -(q.z+uNudge)*uDepth, 1.0);
  vec3 n=normalize(uRot*aNrm); float lam=clamp(dot(n, normalize(vec3(-0.5,-0.55,0.67))),0.35,1.15);
  vCol = uLit>0.5 ? aCol*(0.55+0.45*lam) : aCol; }`;
const GL_FS=`precision mediump float; varying vec3 vCol; void main(){ gl_FragColor=vec4(vCol,1.0); }`;
function glInit(){ if(GL3D.tried) return GL3D.ok; GL3D.tried=true;
  try{ const c=document.createElement('canvas'); let gl=c.getContext('webgl2',{antialias:true,alpha:false,preserveDrawingBuffer:true}); let idx32=true;
    if(!gl){ gl=c.getContext('webgl',{antialias:true,alpha:false,preserveDrawingBuffer:true}); idx32=!!(gl&&gl.getExtension('OES_element_index_uint')); }
    if(!gl||!idx32) return false;
    const sh=(t,src)=>{ const o=gl.createShader(t); gl.shaderSource(o,src); gl.compileShader(o); if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const pr=gl.createProgram(); gl.attachShader(pr,sh(gl.VERTEX_SHADER,GL_VS)); gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,GL_FS)); gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    GL3D.gl=gl; GL3D.cv=c; GL3D.prog=pr; GL3D.ok=true;
    GL3D.a={pos:gl.getAttribLocation(pr,'aPos'),nrm:gl.getAttribLocation(pr,'aNrm'),col:gl.getAttribLocation(pr,'aCol')};
    GL3D.u={}; for(const n of ['uRot','uCenter','uScale','uDepth','uLit','uNudge']) GL3D.u[n]=gl.getUniformLocation(pr,n);
  }catch(e){ GL3D.ok=false; console.warn('WebGL 3D view unavailable:',e); }
  return GL3D.ok; }
function glBuffer(gl, data, target){ const b=gl.createBuffer(); gl.bindBuffer(target||gl.ARRAY_BUFFER,b); gl.bufferData(target||gl.ARRAY_BUFFER,data,gl.STATIC_DRAW); return b; }
// Heightfield -> lit triangle mesh (top surface + 4 side walls + bottom). Colors = wood depth ramp; normals from the z gradient.
function buildSimMesh(field){ const gl=GL3D.gl; const {nx,ny,res,x0,y0,w,h,floor,z}=field;
  let maxD=1e-4; for(let i=0;i<z.length;i++){ const d=-z[i]; if(d>maxD)maxD=d; }
  const at=(i,j)=>z[Math.min(ny-1,Math.max(0,j))*nx+Math.min(nx-1,Math.max(0,i))];
  const nv=nx*ny; const pos=new Float32Array(nv*3), nrm=new Float32Array(nv*3), col=new Float32Array(nv*3);
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){ const k=j*nx+i, o=k*3; const zz=z[k];
    pos[o]=x0+Math.min(w,(i+0.5)*res); pos[o+1]=y0+Math.min(h,(j+0.5)*res); pos[o+2]=zz;
    const gx=(at(i+1,j)-at(i-1,j))/(2*res), gy=(at(i,j+1)-at(i,j-1))/(2*res); const nz=1/Math.sqrt(gx*gx+gy*gy+1);
    nrm[o]=-gx*nz; nrm[o+1]=-gy*nz; nrm[o+2]=nz;
    const frac=Math.min(1,(-zz)/maxD); col[o]=(198-frac*120)/255; col[o+1]=(168-frac*118)/255; col[o+2]=(120-frac*82)/255; }
  const idx=new Uint32Array((nx-1)*(ny-1)*6); let q=0;
  for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){ const a=j*nx+i,b=a+1,c=a+nx,d=c+1; idx[q++]=a;idx[q++]=b;idx[q++]=d; idx[q++]=a;idx[q++]=d;idx[q++]=c; }
  const mesh={ vbo:glBuffer(gl,pos), nbo:glBuffer(gl,nrm), cbo:glBuffer(gl,col), ibo:glBuffer(gl,idx,gl.ELEMENT_ARRAY_BUFFER), n:idx.length };
  // stock walls + bottom: true stock boundary, top edge follows the perimeter heights, darker wood tone
  const wp=[], wn=[], wc=[]; const tone=[0.62,0.50,0.34];
  const push=(x,y,zz,n)=>{ wp.push(x,y,zz); wn.push(n[0],n[1],n[2]); wc.push(tone[0],tone[1],tone[2]); };
  const quad=(a,b,c,d,n)=>{ push(...a,n);push(...b,n);push(...c,n); push(...a,n);push(...c,n);push(...d,n); };
  const x1=x0+w, y1=y0+h;
  const edge=(fn,count,n)=>{ for(let k=0;k<count;k++){ const [ax,ay,az]=fn(k), [bx,by,bz]=fn(k+1); quad([ax,ay,az],[bx,by,bz],[bx,by,floor],[ax,ay,floor],n); } };
  const ex=(j,yy)=>k=>[Math.min(x1,x0+k*res), yy, at(Math.min(nx-1,k),j)];   // walls along X (front j=0, back j=ny-1)
  const ey=(i,xx)=>k=>[xx, Math.min(y1,y0+k*res), at(i,Math.min(ny-1,k))];   // walls along Y (left i=0, right i=nx-1)
  edge(ex(0,y0),nx,[0,-1,0]); edge(ex(ny-1,y1),nx,[0,1,0]); edge(ey(0,x0),ny,[-1,0,0]); edge(ey(nx-1,x1),ny,[1,0,0]);
  quad([x0,y0,floor],[x1,y0,floor],[x1,y1,floor],[x0,y1,floor],[0,0,-1]);
  mesh.walls={ vbo:glBuffer(gl,new Float32Array(wp)), nbo:glBuffer(gl,new Float32Array(wn)), cbo:glBuffer(gl,new Float32Array(wc)), n:wp.length/3 };
  return mesh; }
function hexRGB(c){ const m=/^#?([0-9a-f]{6})$/i.exec(c); if(!m){ const r=/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return r?[+r[1]/255,+r[2]/255,+r[3]/255]:[0.3,0.9,0.5]; } const v=parseInt(m[1],16); return [((v>>16)&255)/255,((v>>8)&255)/255,(v&255)/255]; }
// Toolpath backplot as 3D lines at their real Z (depth-tinted like the 2D backplot; rapids grey).
function buildLineMesh(segs){ const gl=GL3D.gl; if(!segs||!segs.length) return null;
  let zTop=-Infinity, zBot=Infinity; for(const s of segs){ if(s.rapid)continue; zTop=Math.max(zTop,s.z0,s.z1); zBot=Math.min(zBot,s.z0,s.z1); }
  const hasRange=isFinite(zTop)&&isFinite(zBot)&&(zTop-zBot)>1e-6; const pos=[], col=[];
  for(const s of segs){ const c=s.rapid?[0.47,0.47,0.47]:(hasRange?hexRGB(depthColor(((s.z0+s.z1)/2-zBot)/(zTop-zBot))):[0.22,0.85,0.54]);
    pos.push(s.x0,s.y0,s.z0, s.x1,s.y1,s.z1); col.push(...c,...c); }
  const nrm=new Float32Array(pos.length); return { vbo:glBuffer(gl,new Float32Array(pos)), nbo:glBuffer(gl,nrm), cbo:glBuffer(gl,new Float32Array(col)), n:pos.length/3, zTop, zBot, hasRange }; }
function orbitMatrix(){ const yw=orbit.yaw*Math.PI/180, pt=orbit.pitch*Math.PI/180; const c=Math.cos(yw), s=Math.sin(yw), sp=Math.sin(pt), cp=Math.cos(pt);
  // M = Tilt(pitch) * Rz(yaw); rows: X_view=[c,-s,0]  Y_view=[s*sp, c*sp, cp]  Z_view(toward viewer)=[-s*cp, -c*cp, sp]
  const r=[ c,-s,0,  s*sp,c*sp,cp,  -s*cp,-c*cp,sp ];
  return new Float32Array([ r[0],r[3],r[6], r[1],r[4],r[7], r[2],r[5],r[8] ]); }   // column-major for GLSL
// Project a world point with the current orbit (for 2D overlays drawn on top of the GL image).
function P3(x,y,zz){ const f=simField.field; const C=S2W({x:cv.width/2,y:cv.height/2}); const cz=(f.floor||0)/2;
  const yw=orbit.yaw*Math.PI/180, pt=orbit.pitch*Math.PI/180; const c=Math.cos(yw), s=Math.sin(yw), sp=Math.sin(pt), cp=Math.cos(pt);
  const qx=x-C.x, qy=y-C.y, qz=zz-cz; const vx=c*qx-s*qy, vy=(s*qx+c*qy)*sp+qz*cp;
  return { x:cv.width/2+vx*view.ppi, y:cv.height/2-vy*view.ppi }; }
function drawSim3D(){ const gl=GL3D.gl, g=GL3D.cv; if(g.width!==cv.width||g.height!==cv.height){ g.width=cv.width; g.height=cv.height; }
  if(!simField.mesh) simField.mesh=buildSimMesh(simField.field);
  if(simField.linesFor!==toolpaths){ simField.lines=buildLineMesh(toolpaths); simField.linesFor=toolpaths; }
  const f=simField.field; const C=S2W({x:cv.width/2,y:cv.height/2}); const diag=Math.hypot(f.w,f.h,f.thickness)*2+1;
  gl.viewport(0,0,g.width,g.height); gl.clearColor(0.047,0.059,0.078,1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.useProgram(GL3D.prog); const u=GL3D.u, a=GL3D.a;
  gl.uniformMatrix3fv(u.uRot,false,orbitMatrix()); gl.uniform3f(u.uCenter,C.x,C.y,f.floor/2);
  gl.uniform2f(u.uScale, 2*view.ppi/g.width, 2*view.ppi/g.height); gl.uniform1f(u.uDepth, 1/diag);
  const bind=(m)=>{ gl.bindBuffer(gl.ARRAY_BUFFER,m.vbo); gl.enableVertexAttribArray(a.pos); gl.vertexAttribPointer(a.pos,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.nbo); gl.enableVertexAttribArray(a.nrm); gl.vertexAttribPointer(a.nrm,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.cbo); gl.enableVertexAttribArray(a.col); gl.vertexAttribPointer(a.col,3,gl.FLOAT,false,0,0); };
  gl.uniform1f(u.uLit,1); gl.uniform1f(u.uNudge,0);
  const m=simField.mesh; bind(m); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.ibo); gl.drawElements(gl.TRIANGLES,m.n,gl.UNSIGNED_INT,0);
  bind(m.walls); gl.drawArrays(gl.TRIANGLES,0,m.walls.n);
  if(simField.lines){ gl.uniform1f(u.uLit,0); gl.uniform1f(u.uNudge,0.004); bind(simField.lines); gl.drawArrays(gl.LINES,0,simField.lines.n); }
  ctx.drawImage(g,0,0);
  // overlays: origin axes (X red, Y green, Z blue), depth legend, orbit readout
  ctx.save(); ctx.lineWidth=1.5; const o=P3(0,0,0), L=Math.max(0.5,Math.min(f.w,f.h)*0.12);
  [[L,0,0,'#ff6b6b','X'],[0,L,0,'#5ce38a','Y'],[0,0,L,'#6fa8ff','Z']].forEach(([x,y,zz,c,t])=>{ const p=P3(x,y,zz); ctx.strokeStyle=c; ctx.fillStyle=c; ctx.beginPath(); ctx.moveTo(o.x,o.y); ctx.lineTo(p.x,p.y); ctx.stroke(); ctx.font='10px monospace'; ctx.fillText(t,p.x+3,p.y-3); });
  ctx.restore();
  if(simField.lines&&simField.lines.hasRange) drawDepthLegend(simField.lines.zTop, simField.lines.zBot);
  ctx.save(); ctx.fillStyle='#8fa2ba'; ctx.font='10px monospace'; ctx.textAlign='right';
  ctx.fillText('orbit '+Math.round(((orbit.yaw%360)+360)%360)+'° / tilt '+Math.round(90-orbit.pitch)+'°  ·  drag = pan · Option/Alt-drag = orbit · wheel = zoom', cv.width-12, cv.height-10); ctx.restore();
}
function setOrbit(yaw,pitch){ orbit.yaw=yaw; orbit.pitch=Math.max(2,Math.min(90,pitch)); render(); }
function drawShape(s, selected, dim){
  const col = selected ? '#ff9a3c' : (doc.layers.get(s.layer)?.color || '#9fe7ff');
  ctx.save();
  if(dim) ctx.globalAlpha=0.28;   // Preview: faint reference outline under the toolpaths
  ctx.strokeStyle=col; ctx.lineWidth=selected?2:1.3;
  for(const loop of CADCORE.flatten(s)){
    ctx.beginPath();
    loop.pts.forEach((p,i)=>{ const q=W2S(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y); });
    ctx.stroke();
  }
  ctx.restore();
}
function drawNodes(s){
  if(!s||s.type==='text')return;
  if(s.prim&&s.prim.kind==='bezier'){ return drawBezierNodes(s); }
  ctx.fillStyle='#ffcf6b';
  for(const p of s.pts){ const q=W2S(p); ctx.fillRect(q.x-3,q.y-3,6,6); }
}
function drawBezierNodes(s){
  ctx.strokeStyle='rgba(127,208,255,0.75)'; ctx.lineWidth=1;
  for(const nd of s.prim.nodes){ const a=W2S(nd);
    [[nd.hx0,nd.hy0],[nd.hx1,nd.hy1]].forEach(h=>{ if(Math.hypot(h[0]-nd.x,h[1]-nd.y)>1e-6){ const hs=W2S({x:h[0],y:h[1]}); ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(hs.x,hs.y);ctx.stroke(); ctx.fillStyle='#7fd0ff'; ctx.beginPath();ctx.arc(hs.x,hs.y,3.5,0,TAU);ctx.fill(); } });
  }
  for(const nd of s.prim.nodes){ const a=W2S(nd); ctx.fillStyle = nd.type==='smooth' ? '#39d98a' : '#ffcf6b'; ctx.fillRect(a.x-3.5,a.y-3.5,7,7); }
}
function bboxScreen(shapes){ const b=CADCORE.bboxAll(shapes); const a=W2S({x:b.minX,y:b.maxY}), c=W2S({x:b.maxX,y:b.minY}); return {x0:a.x,y0:a.y,x1:c.x,y1:c.y,b}; }
function rotateGripPts(bs){ const d=13; return [
  {x:bs.x0-d,y:bs.y0-d,k:'nw'},{x:bs.x1+d,y:bs.y0-d,k:'ne'},
  {x:bs.x0-d,y:bs.y1+d,k:'sw'},{x:bs.x1+d,y:bs.y1+d,k:'se'} ]; }
function drawSelectionHandles(){
  const bs=bboxScreen(selectedShapes()); ctx.strokeStyle='rgba(255,154,60,0.7)'; ctx.setLineDash([4,3]);
  ctx.strokeRect(bs.x0,bs.y0,bs.x1-bs.x0,bs.y1-bs.y0); ctx.setLineDash([]);
  ctx.fillStyle='#ff9a3c';
  handlePts(bs).forEach(h=>ctx.fillRect(h.x-4,h.y-4,8,8));
  // rotation grips just outside each corner — drag any to rotate about the center
  ctx.strokeStyle='#ffcf6b'; ctx.lineWidth=1.5;
  for(const g of rotateGripPts(bs)){ ctx.beginPath(); ctx.arc(g.x,g.y,5,Math.PI*0.35,Math.PI*1.85); ctx.stroke(); }
}
function handlePts(bs){ return [
  {x:bs.x0,y:bs.y0,k:'nw'},{x:bs.x1,y:bs.y0,k:'ne'},{x:bs.x0,y:bs.y1,k:'sw'},{x:bs.x1,y:bs.y1,k:'se'},
  {x:(bs.x0+bs.x1)/2,y:bs.y0,k:'n'},{x:(bs.x0+bs.x1)/2,y:bs.y1,k:'s'},{x:bs.x0,y:(bs.y0+bs.y1)/2,k:'w'},{x:bs.x1,y:(bs.y0+bs.y1)/2,k:'e'} ]; }
function depthColor(t){ t=Math.max(0,Math.min(1,t));   // t=1 shallow, t=0 deep
  const deep=[22,96,122], shallow=[140,255,192], c=i=>Math.round(deep[i]+(shallow[i]-deep[i])*t);
  return 'rgb('+c(0)+','+c(1)+','+c(2)+')'; }
function drawToolpaths(){
  // depth range across cut (non-rapid) segments
  let zTop=-Infinity, zBot=Infinity;
  for(const s of toolpaths){ if(s.rapid)continue; zTop=Math.max(zTop,s.z0,s.z1); zBot=Math.min(zBot,s.z0,s.z1); }
  const hasRange=isFinite(zTop)&&isFinite(zBot)&&(zTop-zBot)>1e-6;
  ctx.lineWidth=1;
  for(const seg of toolpaths){
    if(seg.rapid){ ctx.strokeStyle='rgba(120,120,120,0.5)'; ctx.setLineDash([3,3]); }
    else { ctx.setLineDash([]); const zm=(seg.z0+seg.z1)/2; ctx.strokeStyle = hasRange ? depthColor((zm-zBot)/(zTop-zBot)) : '#39d98a'; }
    const a=W2S({x:seg.x0,y:seg.y0}), b=W2S({x:seg.x1,y:seg.y1}); ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  if(hasRange) drawDepthLegend(zTop,zBot);
}
function drawDepthLegend(zTop,zBot){
  const w=12, h=110, x=14, y=cv.height-h-22;
  ctx.save();
  const grad=ctx.createLinearGradient(0,y,0,y+h); grad.addColorStop(0,depthColor(1)); grad.addColorStop(1,depthColor(0));
  ctx.fillStyle=grad; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1; ctx.strokeRect(x+0.5,y+0.5,w,h);
  ctx.fillStyle='#cdd6e2'; ctx.font='10px monospace'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('Z '+zTop.toFixed(2)+'"', x+w+5, y+5);
  ctx.fillText(zBot.toFixed(2)+'"', x+w+5, y+h-5);
  ctx.textBaseline='alphabetic'; ctx.fillStyle='#7f93ad'; ctx.fillText('depth', x-1, y-6);
  ctx.restore();
}
function drawDrillMarks(){ const rpx=Math.max(3,drillDia/2*view.ppi); ctx.lineWidth=1.4; ctx.strokeStyle='#39d98a';
  for(const m of drillMarks){ const q=W2S(m); ctx.beginPath(); ctx.arc(q.x,q.y,rpx,0,TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(q.x-rpx-3,q.y); ctx.lineTo(q.x+rpx+3,q.y); ctx.moveTo(q.x,q.y-rpx-3); ctx.lineTo(q.x,q.y+rpx+3); ctx.stroke(); } }
function drawSnapMark(m){ const q=W2S(m); ctx.strokeStyle='#ffe27a'; ctx.lineWidth=1.2;
  if(m.kind==='center'){ ctx.beginPath();ctx.arc(q.x,q.y,5,0,TAU);ctx.stroke(); }
  else if(m.kind==='corner'){ ctx.beginPath();ctx.moveTo(q.x,q.y-6);ctx.lineTo(q.x+6,q.y);ctx.lineTo(q.x,q.y+6);ctx.lineTo(q.x-6,q.y);ctx.closePath();ctx.stroke(); }
  else { ctx.strokeRect(q.x-4,q.y-4,8,8); } }
let snapMark=null;

// ---- HUD / status ----
function updateHud(){ document.getElementById('zoomlbl').textContent = Math.round(view.ppi)+' px/in · '+doc.shapes.length+' obj · '+sel.size+' sel'; }
function setMsg(m){ msg=m; document.getElementById('msg').textContent=m; }
function updateCursor(scr){ const w=S2W(scr); document.getElementById('coords').textContent = w.x.toFixed(3)+', '+w.y.toFixed(3)+' in'; }
// hover feedback for the Select tool: rotate icon over a corner grip, resize arrows over a scale handle, move over a shape
const ROTATE_CURSOR="url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'><path d='M11 3a8 8 0 1 1-7.4 4.9' fill='none' stroke='white' stroke-width='4'/><path d='M11 3a8 8 0 1 1-7.4 4.9' fill='none' stroke='%23222' stroke-width='2'/><path d='M2 3v6h6' fill='none' stroke='white' stroke-width='4'/><path d='M2 3v6h6' fill='none' stroke='%23222' stroke-width='2'/></svg>\") 11 11, alias";
const SCALE_CURSORS={nw:'nwse-resize',se:'nwse-resize',ne:'nesw-resize',sw:'nesw-resize',n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize'};
function hoverCursor(scr){ if(tool!=='select'||viewMode==='preview'){ cv.style.cursor=''; return; }
  const h=hitHandle(scr); let c='';
  if(h&&h.type==='rotate') c=ROTATE_CURSOR; else if(h&&h.type==='scale') c=SCALE_CURSORS[h.k]||'move';
  else { const w=S2W(scr); if(pickShapeAt(w)) c='move'; }
  cv.style.cursor=c; }

// ---- tools / interaction ----
let draft=null;        // in-progress geometry
let drag=null;         // active drag state
function setTool(t){ if(t!=='measure') measure=null; tool=t; sel=(t==='node')?sel:sel; draft=null; document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));
  const active=document.querySelector('.tool[data-tool="'+t+'"]'); if(active){ const grp=active.closest('.tgrp'); if(grp)grp.classList.remove('collapsed'); }   // keep the active tool visible
  cv.style.cursor='';
  setMsg((TOOLMSG[t]||'')+(CREATE_KINDS.has(t)?'  ·  Enter = create by numbers (anchor + size)':'')); render(); }
const TOOLMSG={ select:'Click to select · drag to move · handles to scale/rotate · marquee to box-select',
  node:'Select one shape, drag its nodes · dbl-click segment adds node · dbl-click node deletes',
  line:'Click start, click end', polyline:'Click points · Enter/double-click to finish · Esc cancel',
  rect:'Click-drag opposite corners', circle:'Click center, drag radius', ellipse:'Click-drag bounding box',
  arc:'Click center, click start, click end', polygon:'Click center, drag radius (sides in panel)', star:'Click center, drag radius',
  text:'Click placement point, type in panel', measure:'Click two points', pan:'Drag to pan',
  bezier:'Click anchors, drag to shape handles · Enter to finish · click start to close',
  fillet:'Click a corner to round it (set radius in "Fillet r")',
  trim:'Click the part of an open vector to cut back to where it crosses another',
  extend:'Click near an open vector endpoint to stretch it to the next vector ahead' };

function evScr(e){ const r=cv.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }

cv.addEventListener('mousedown', e=>{
  if(e.button===2) return;   // right-click handled by contextmenu
  const scr=evScr(e); const snap=snapWorld(scr); const w={x:snap.x,y:snap.y};
  if(viewMode==='preview'){   // Preview is read-only: left-drag pans; Option/Alt-drag (or middle button) orbits the 3D cut
    if(simField && GL3D.ok && (e.altKey || e.button===1)){ drag={kind:'orbit', sx:scr.x, sy:scr.y, yaw:orbit.yaw, pitch:orbit.pitch}; e.preventDefault(); return; }
    drag={kind:'pan', sx:scr.x, sy:scr.y, ox:view.ox, oy:view.oy}; return; }
  if(e.button===1 || tool==='pan' || e.altKey){ drag={kind:'pan', sx:scr.x, sy:scr.y, ox:view.ox, oy:view.oy}; return; }
  if(tool==='select'){ return selectDown(scr,w,e); }
  if(tool==='node'){ return nodeDown(scr,w,e); }
  if(tool==='fillet'){ return filletAt(w); }
  if(tool==='trim'){ return trimAt(w); }
  if(tool==='extend'){ return extendAt(w); }
  // drawing tools
  if(tool==='line'){ draft={kind:'line', a:w, b:w}; drag={kind:'draw'}; }
  else if(tool==='rect'){ draft={kind:'rect', a:w, b:w}; drag={kind:'draw'}; }
  else if(tool==='rrect'){ draft={kind:'rrect', a:w, b:w}; drag={kind:'draw'}; }
  else if(tool==='circle'){ draft={kind:'circle', c:w, r:0}; drag={kind:'draw'}; }
  else if(tool==='ellipse'){ draft={kind:'ellipse', a:w, b:w}; drag={kind:'draw'}; }
  else if(tool==='polygon'){ draft={kind:'polygon', c:w, r:0}; drag={kind:'draw'}; }
  else if(tool==='star'){ draft={kind:'star', c:w, r:0}; drag={kind:'draw'}; }
  else if(tool==='polyline'){ if(!draft){draft={kind:'polyline',pts:[w]};} draft.pts.push(w); }
  else if(tool==='bezier'){
    if(draft&&draft.kind==='bezier'&&draft.nodes.length>=2&&CADCORE.dist(w,draft.nodes[0])<pxTol(9)){ commitBezier(true); return; }  // click start -> close
    if(!draft||draft.kind!=='bezier'){ draft={kind:'bezier',nodes:[],closed:false}; }
    const nd={x:w.x,y:w.y,hx0:w.x,hy0:w.y,hx1:w.x,hy1:w.y,type:'corner'};
    draft.nodes.push(nd); drag={kind:'bezierhandle',node:nd};
  }
  else if(tool==='arc'){ if(!draft){draft={kind:'arc',c:w,p1:null,p2:null};} else if(!draft.p1){draft.p1=w;} else {draft.p2=w; commitArc();} }
  else if(tool==='text'){ placeText(w); }
  else if(tool==='measure'){ if(!draft){ measure=null; draft={kind:'measure',a:w,b:w}; } else { measure={a:draft.a,b:w}; draft=null; } }
  render();
});
cv.addEventListener('mousemove', e=>{
  const scr=evScr(e);
  if(viewMode==='preview'){ updateCursor(scr); cv.style.cursor=(simField&&GL3D.ok&&e.altKey)?'grab':'';
    if(drag&&drag.kind==='pan'){ view.ox=drag.ox+(scr.x-drag.sx); view.oy=drag.oy+(scr.y-drag.sy); render(); }
    else if(drag&&drag.kind==='orbit'){ setOrbit(drag.yaw+(scr.x-drag.sx)*0.4, drag.pitch+(scr.y-drag.sy)*0.4); }   // 0.4°/px
    return; }
  updateCursor(scr); if(!drag) hoverCursor(scr); const snap=snapWorld(scr); snapMark = snap.kind?{x:snap.x,y:snap.y,kind:snap.kind}:null; const w={x:snap.x,y:snap.y};
  if(drag&&drag.kind==='pan'){ view.ox=drag.ox+(scr.x-drag.sx); view.oy=drag.oy+(scr.y-drag.sy); render(); return; }
  if(drag&&drag.kind==='move'){ doMove(S2W(scr), e.ctrlKey||e.metaKey); render(); return; }
  if(drag&&drag.kind==='scale'){ doScale(w); render(); return; }
  if(drag&&drag.kind==='rotate'){ doRotate(S2W(scr), e.shiftKey); render(); return; }
  if(drag&&drag.kind==='marquee'){ drag.b=scr; render(); drawMarquee(drag.a,drag.b); return; }
  if(drag&&drag.kind==='bezierhandle'){ const nd=drag.node; nd.hx1=w.x; nd.hy1=w.y; nd.type='smooth'; nd.hx0=2*nd.x-w.x; nd.hy0=2*nd.y-w.y; render(); return; }
  if(drag&&drag.kind==='bznode'){ const s=shapeById(drag.id); if(s&&s.prim&&s.prim.kind==='bezier'){ const nd=s.prim.nodes[drag.idx];
      if(drag.part==='anchor'){ const dx=w.x-nd.x,dy=w.y-nd.y; nd.x=w.x;nd.y=w.y; nd.hx0+=dx;nd.hy0+=dy; nd.hx1+=dx;nd.hy1+=dy; }
      else if(drag.part==='out'){ nd.hx1=w.x;nd.hy1=w.y; if(nd.type==='smooth')CADCORE.mirrorSmoothHandle(nd,'out'); }
      else { nd.hx0=w.x;nd.hy0=w.y; if(nd.type==='smooth')CADCORE.mirrorSmoothHandle(nd,'in'); }
      CADCORE.reflowBezier(s); } render(); return; }
  if(drag&&drag.kind==='nodemove'){ const s=shapeById(drag.id); if(s){ s.pts[drag.idx]={x:w.x,y:w.y}; s.prim={kind:'poly'}; } render(); return; }
  if(draft){ updateDraft(w, e.shiftKey); render(); }
  else if(snapMark) render();
});
window.addEventListener('mouseup', e=>{
  if(drag&&drag.kind==='draw'){ commitDraft(); }
  if(drag&&drag.kind==='marquee'){ marqueeSelect(drag.a,drag.b,e.shiftKey); }
  if(drag&&['move','scale','rotate','nodemove','bznode'].includes(drag.kind)){ /* already mutated; history pushed on down */ syncPanels(); }
  drag=null; render();
});
cv.addEventListener('contextmenu', shapeContextMenu);
window.addEventListener('mousedown', e=>{ if(ctxEl && !ctxEl.contains(e.target)) hideCtxMenu(); }, true);
window.addEventListener('wheel', hideCtxMenu, {passive:true});
window.addEventListener('blur', hideCtxMenu);
cv.addEventListener('dblclick', e=>{
  if(viewMode==='preview') return;
  if(tool==='polyline'&&draft){ if(draft.pts.length>=2){ draft.pts.pop(); commitPolyline(); } return; }
  if(tool==='node'&&sel.size===1){ nodeDblClick(snapWorld(evScr(e))); return; }
  if(tool==='select'){ const w=snapWorld(evScr(e)); const s=pickShapeAt({x:w.x,y:w.y}); if(s){ sel=new Set([s.id]); openShapeModal(s); } }
});
cv.addEventListener('wheel', e=>{ e.preventDefault(); const scr=evScr(e); const before=S2W(scr);
  const f=Math.exp(-e.deltaY*0.0015); view.ppi=Math.max(2,Math.min(800,view.ppi*f));
  const after=S2W(scr); view.ox += (after.x-before.x)*0 + (scr.x-(view.ox+before.x*view.ppi)); // recompute properly below
  // recompute offset so 'before' world stays under cursor
  view.ox = scr.x - before.x*view.ppi; view.oy = scr.y + before.y*view.ppi; render(); }, {passive:false});

// ---- select tool helpers ----
function shapeInside(s,w){ for(const loop of CADCORE.flatten(s)){ if(loop.pts.length>=3 && CADCORE.pointInPoly(w,loop.pts)) return true; } return false; }
function pickShapeAt(w){ const tol=pxTol(6);
  for(let i=doc.shapes.length-1;i>=0;i--){ const s=doc.shapes[i]; if(!layerVisible(s.layer))continue; if(CADCORE.hitTest(s,w,tol)) return s; }
  for(let i=doc.shapes.length-1;i>=0;i--){ const s=doc.shapes[i]; if(!layerVisible(s.layer)||!s.closed)continue; if(shapeInside(s,w)) return s; }
  return null; }

// ---- shape properties modal (numeric edit, VCarve-style) ----
// field spec per primitive kind: [paramKey, label, step]  (step 'text' = text input; *Deg keys are angle-in-degrees views)
const MODAL_SPECS={
  rect:[['ax','X',0.05],['ay','Y',0.05],['w','Width',0.05],['h','Height',0.05],['r','Corner radius',0.05],['rotDeg','Rotation°',1]],
  roundrect:[['ax','X',0.05],['ay','Y',0.05],['w','Width',0.05],['h','Height',0.05],['r','Corner radius',0.05],['rotDeg','Rotation°',1]],
  circle:[['ax','X',0.05],['ay','Y',0.05],['r','Radius',0.05],['rotDeg','Rotation°',1]],
  ellipse:[['ax','X',0.05],['ay','Y',0.05],['rx','Radius X',0.05],['ry','Radius Y',0.05],['rotDeg','Rotation°',1]],
  polygon:[['ax','X',0.05],['ay','Y',0.05],['r','Radius',0.05],['n','Sides',1],['rotDeg','Rotation°',1]],
  star:[['ax','X',0.05],['ay','Y',0.05],['rO','Outer radius',0.05],['rI','Inner radius',0.05],['n','Points',1],['rotDeg','Rotation°',1]],
  line:[['x1','Start X',0.05],['y1','Start Y',0.05],['x2','End X',0.05],['y2','End Y',0.05],['rotDeg','Rotation°',1]],
  arc:[['cx','Center X',0.05],['cy','Center Y',0.05],['r','Radius',0.05],['a0Deg','Start angle°',1],['a1Deg','End angle°',1]],
  text:[['text','Text','text'],['ax','X',0.05],['ay','Y',0.05],['h','Height',0.05]],
  generic:[['ax','X',0.05],['ay','Y',0.05],['w','Width',0.05],['h','Height',0.05],['rotDeg','Rotation°',1]]
};
// ---- anchor (9-box position reference, VCarve-style) ----
// 'ax'/'ay' fields are the world position of the chosen anchor point on the shape's bounding box:
// lower/center/upper × left/middle/right. Persisted so the next dialog opens with the same reference.
const ANCHOR_ROWS=[['tl','tm','tr'],['cl','c','cr'],['bl','bm','br']];   // drawn top row first (screen order)
let modalAnchor=(function(){ try{ const a=localStorage.getItem('aqcam.anchor'); if(a&&CADCORE.ANCHORS[a]) return a; }catch(e){} return 'bl'; })();
function anchorGridHTML(cur, cls){ return '<div class="agrid '+(cls||'')+'">'+ANCHOR_ROWS.map(r=>r.map(a=>'<button type="button" class="ab'+(a===cur?' on':'')+'" data-a="'+a+'" title="'+CADCORE.ANCHORS[a].label+'"></button>').join('')).join('')+'</div>'; }
function wireAnchorGrid(host, onPick){ host.querySelectorAll('.agrid .ab').forEach(b=>{ b.onclick=e=>{ e.preventDefault(); host.querySelectorAll('.agrid .ab').forEach(x=>x.classList.toggle('on',x===b)); onPick(b.dataset.a); }; }); }
function setModalAnchor(a){ if(!CADCORE.ANCHORS[a]) return;
  const host=document.getElementById('modalFields'); const ix=host.querySelector('input[data-k="ax"]'), iy=host.querySelector('input[data-k="ay"]');
  if(modalOrig && ix && iy){ const cur=buildShapeFromFields();   // re-express the SAME shape's position by the new anchor (nothing moves)
    modalAnchor=a; const pt=CADCORE.anchorPoint(cur, a); ix.value=(+pt.x.toFixed(3)); iy.value=(+pt.y.toFixed(3)); }
  else modalAnchor=a;
  try{ localStorage.setItem('aqcam.anchor', a); }catch(e){}
  const hint=host.querySelector('.ahint'); if(hint) hint.textContent='X / Y = '+CADCORE.ANCHORS[a].label+' of the shape';
}
const CREATE_KINDS=new Set(['rect','rrect','circle','ellipse','polygon','star','text']);
let modalCreate=false;   // true while the dialog is creating a new shape (preview lives in doc.shapes until Create/Cancel)
// Create-by-numbers: open the dialog on a fresh default shape parked at the job's matching anchor point.
function openCreateModal(kind){ if(!CREATE_KINDS.has(kind)) kind='rect';
  const gv=(id,d)=>{ const el=document.getElementById(id); const v=el?parseFloat(el.value):NaN; return isFinite(v)?v:d; };
  const r=jobRect(); const jp=CADCORE.bboxAnchor({minX:r.x0,minY:r.y0,maxX:r.x1,maxY:r.y1}, modalAnchor);
  const n=Math.max(3,Math.round(gv('polyN',6))); let s;
  switch(kind){
    case 'rect': s=CADCORE.mkRect(0,0,4,3,activeLayer); break;
    case 'rrect': s=CADCORE.mkRoundRect(0,0,4,3,Math.max(0.01,gv('rrectR',0.25)),activeLayer); break;
    case 'circle': s=CADCORE.mkCircle({x:0,y:0},1,activeLayer); break;
    case 'ellipse': s=CADCORE.mkEllipse({x:0,y:0},2,1,0,activeLayer); break;
    case 'polygon': s=CADCORE.mkPolygon({x:0,y:0},1.5,n,undefined,activeLayer); break;
    case 'star': s=CADCORE.mkStar({x:0,y:0},1.5,0.675,n,undefined,activeLayer); break;
    case 'text': { const t=document.getElementById('txtVal'); s=CADCORE.mkText(0,0,gv('txtH',1),(t&&t.value)||'TEXT',activeLayer); break; }
  }
  s=CADCORE.moveAnchorTo(s, modalAnchor, jp.x, jp.y);
  modalCreate=true; doc.shapes.push(s); sel=new Set([s.id]); render();
  openShapeModal(s);
}
let modalShape=null, modalOrig=null;   // modalOrig = pristine clone (live-preview baseline / revert target)
function openShapeModal(shape){ if(!shape)return; modalShape=shape; modalOrig=CADCORE.clone(shape);
  let p=CADCORE.primParams(shape), kind;
  if(p){ kind=p.kind; } else { const b=CADCORE.bbox(shape); p={x:b.minX,y:b.minY,w:b.maxX-b.minX,h:b.maxY-b.minY}; kind='generic'; }
  const host=document.getElementById('modalFields'); host.innerHTML=''; host.dataset.kind=kind;
  const kname=(kind==='generic'?(shape.type==='text'?'text':'shape'):kind);
  document.getElementById('modalTitle').textContent=(modalCreate?'Create ':'Edit ')+kname;
  const ab=document.getElementById('modalApply'); if(ab) ab.textContent=modalCreate?'Create':'Apply';
  const hasAnchor=MODAL_SPECS[kind].some(f=>f[0]==='ax');
  if(hasAnchor){ const row=document.createElement('div'); row.className='mfield arow';
    row.innerHTML='<span>Anchor<br><small class="ahint">X / Y = '+CADCORE.ANCHORS[modalAnchor].label+' of the shape</small></span>'+anchorGridHTML(modalAnchor);
    host.appendChild(row); wireAnchorGrid(row, setModalAnchor); }
  const apt=hasAnchor?CADCORE.anchorPoint(shape, modalAnchor):null;
  for(const [key,label,step] of MODAL_SPECS[kind]){
    let val = key==='ax'?apt.x : key==='ay'?apt.y : key==='rotDeg'?(p.rot||0)*180/Math.PI : key==='a0Deg'?(p.a0||0)*180/Math.PI : key==='a1Deg'?(p.a1||0)*180/Math.PI : p[key];
    const row=document.createElement('label'); row.className='mfield';
    let inp;
    if(step==='text') inp='<input type="text" data-k="'+key+'" value="'+String(val==null?'':val).replace(/"/g,'&quot;')+'">';
    else { const dp=(key==='rotDeg'||key==='a0Deg'||key==='a1Deg')?1:(key==='n'?0:3);   // angles 0.1°, counts integer, lengths/positions 0.001"
      const dv=(typeof val==='number'&&isFinite(val))?+val.toFixed(dp):0;
      inp='<input type="number" data-k="'+key+'" step="'+step+'" value="'+dv+'">'; }
    row.innerHTML='<span>'+label+'</span>'+inp; host.appendChild(row);
  }
  const card=document.querySelector('#shapeModal .modal'); if(card){ card.style.left='96px'; card.style.top='70px'; }
  document.getElementById('shapeModal').style.display='block';
  const f=host.querySelector('input'); if(f){ f.focus(); f.select&&f.select(); }
}
function modalAnchorXY(vals){ return { x: isFinite(vals.ax)?vals.ax:0, y: isFinite(vals.ay)?vals.ay:0 }; }
// rebuild the edited shape from the current field values (always from the pristine baseline, so previews don't drift)
function buildShapeFromFields(){ const host=document.getElementById('modalFields'); const kind=host.dataset.kind; const vals={};
  host.querySelectorAll('input').forEach(inp=>{ vals[inp.dataset.k]= inp.type==='number'?(parseFloat(inp.value)||0):inp.value; });
  const hasAnchor=('ax' in vals)&&('ay' in vals); const A=modalAnchorXY(vals);
  if(kind==='generic'){ let s=CADCORE.fitShapeTo(modalOrig, null, null, vals.w, vals.h);   // size first (position kept)...
    if(vals.rotDeg){ const b=CADCORE.bbox(s); s=CADCORE.rotate(s,(b.minX+b.maxX)/2,(b.minY+b.maxY)/2, vals.rotDeg*Math.PI/180); }
    if(hasAnchor) s=CADCORE.moveAnchorTo(s, modalAnchor, A.x, A.y);   // ...then park the chosen anchor at X/Y
    s.id=modalOrig.id; return s; }
  const p=Object.assign({}, CADCORE.primParams(modalOrig)||{kind});
  for(const k in vals){ if(k==='ax'||k==='ay')continue; if(k==='rotDeg')p.rot=vals.rotDeg*Math.PI/180; else if(k==='a0Deg')p.a0=vals.a0Deg*Math.PI/180; else if(k==='a1Deg')p.a1=vals.a1Deg*Math.PI/180; else p[k]=vals[k]; }
  if(p.kind==='rect' && p.r>0) p.kind='roundrect';   // entering a corner radius makes it a rounded rect
  let s=CADCORE.applyPrimParams(modalOrig, p);
  if(hasAnchor) s=CADCORE.moveAnchorTo(s, modalAnchor, A.x, A.y);   // anchor stays put while size/rotation change
  return s;
}
function previewShapeModal(){ if(!modalOrig)return; const ns=buildShapeFromFields();
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?ns:s); sel=new Set([modalOrig.id]); render(); }   // live, no history
function applyShapeModal(){ if(!modalOrig){ hideModal(); return; } const ns=buildShapeFromFields();
  if(modalCreate){   // new shape: drop the preview, snapshot, then add for real (one undo step)
    doc.shapes=doc.shapes.filter(s=>s.id!==modalOrig.id); pushHistory();
    let out=[ns];
    if(ns.type==='text' && textOutline && ttFont){   // TTF outline text: trace glyphs, then park the group's anchor where the preview's was
      try{ const d=ttFont.getPath(ns.text,0,0,1000).toPathData(4); const shapes=CADCORE.outlineTextShapes(d,0,0,ns.h,activeLayer);
        if(shapes.length){ const a=CADCORE.anchorPoint(ns, modalAnchor); out=CADCORE.moveGroupAnchorTo(shapes, modalAnchor, a.x, a.y); } }
      catch(err){ setMsg('Font render failed: '+err.message+' — placed single-stroke text'); }
    }
    addShapes(out); sel=new Set(out.map(s=>s.id)); const kind=ns.prim?ns.prim.kind:ns.type;
    hideModal(); render(); syncPanels(); setMsg('Created '+kind+' · '+CADCORE.ANCHORS[modalAnchor].label+' at '+(+CADCORE.anchorPoint(out[0],modalAnchor).x.toFixed(3))+', '+(+CADCORE.anchorPoint(out[0],modalAnchor).y.toFixed(3)));
    return; }
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?modalOrig:s); pushHistory();   // baseline = original, one undo step
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?ns:s); sel=new Set([modalOrig.id]);
  hideModal(); render(); syncPanels(); }
function closeShapeModal(){ if(modalOrig){ doc.shapes=modalCreate ? doc.shapes.filter(s=>s.id!==modalOrig.id) : doc.shapes.map(s=>s.id===modalOrig.id?modalOrig:s); if(modalCreate) sel.clear(); } hideModal(); render(); syncPanels(); }   // revert preview
function hideModal(){ document.getElementById('shapeModal').style.display='none'; modalShape=null; modalOrig=null; modalCreate=false; }

// ---- rotate dialog (angle + direction + pivot, live preview) ----
let rotBase=null, rotIds=null, rotAnchor='c';
function rotateShapeAbout(o, cx, cy, d){   // parametric prims accumulate prim.rot (stay editable) and orbit the pivot; others rotate points
  if(o.prim && ROT_PARAM_KINDS.has(o.prim.kind)){
    const p=CADCORE.primParams(o); const c0 = ('cx' in p) ? {x:p.cx,y:p.cy} : {x:p.x+p.w/2,y:p.y+p.h/2};
    p.rot=(p.rot||0)+d; let ns=CADCORE.applyPrimParams(o, p);
    const ca=Math.cos(d), sa=Math.sin(d); const c1={ x: cx+(c0.x-cx)*ca-(c0.y-cy)*sa, y: cy+(c0.x-cx)*sa+(c0.y-cy)*ca };
    if(Math.hypot(c1.x-c0.x,c1.y-c0.y)>1e-12){ ns=CADCORE.translate(ns, c1.x-c0.x, c1.y-c0.y); ns.id=o.id; }
    return ns; }
  return CADCORE.rotate(o, cx, cy, d);
}
function rotDeltaFromDialog(){ const g=id=>document.getElementById(id); const deg=parseFloat(g('rotAngle').value)||0; const dir=g('rotDir').value;
  return (dir==='cw'?-1:1)*deg*Math.PI/180; }
function previewRotateModal(){ if(!rotBase)return; const d=rotDeltaFromDialog(); const b=CADCORE.bboxAll(rotBase); const pv=CADCORE.bboxAnchor(b, rotAnchor);
  const map=new Map(rotBase.map(o=>[o.id,o])); doc.shapes=doc.shapes.map(s=>map.has(s.id)?rotateShapeAbout(map.get(s.id),pv.x,pv.y,d):s); render(); }
function openRotateModal(){ const sh=selectedShapes(); if(!sh.length){ setMsg('Select something to rotate'); return; }
  rotBase=CADCORE.clone(sh); rotIds=sh.map(s=>s.id);
  const grid=document.getElementById('rotAnchorHost'); grid.innerHTML=anchorGridHTML(rotAnchor,'small'); wireAnchorGrid(grid, a=>{ rotAnchor=a; previewRotateModal(); });
  const hint=document.getElementById('rotHint'); if(hint) hint.textContent=sh.length+' shape'+(sh.length>1?'s':'')+' · pivot = '+CADCORE.ANCHORS[rotAnchor].label+' of selection';
  const m=document.getElementById('rotModal'); m.style.display='block'; const a=document.getElementById('rotAngle'); a.focus(); a.select();
  previewRotateModal(); }
function applyRotateModal(){ if(!rotBase){ hideRotateModal(); return; }
  const map=new Map(rotBase.map(o=>[o.id,o])); doc.shapes=doc.shapes.map(s=>map.has(s.id)?map.get(s.id):s); pushHistory();   // baseline = original
  previewRotateModal(); const d=rotDeltaFromDialog(); hideRotateModal(); syncPanels(); setMsg('Rotated '+(+Math.abs(d*180/Math.PI).toFixed(2))+'° '+(d<0?'CW':'CCW')); }
function closeRotateModal(){ if(rotBase){ const map=new Map(rotBase.map(o=>[o.id,o])); doc.shapes=doc.shapes.map(s=>map.has(s.id)?map.get(s.id):s); } hideRotateModal(); render(); }
function hideRotateModal(){ document.getElementById('rotModal').style.display='none'; rotBase=null; rotIds=null; }

// ---- job size & position dialog (Edit menu) ----
function openJobModal(){ applyJobInputs(); document.getElementById('jobModal').style.display='block'; const w=document.getElementById('jobW'); if(w){ w.focus(); w.select(); } }
function closeJobModal(){ document.getElementById('jobModal').style.display='none'; }

// ---- z-order ----
function bringToFront(){ if(!sel.size)return; pushHistory(); const a=doc.shapes.filter(s=>sel.has(s.id)), rest=doc.shapes.filter(s=>!sel.has(s.id)); doc.shapes=rest.concat(a); render(); syncPanels(); }
function sendToBack(){ if(!sel.size)return; pushHistory(); const a=doc.shapes.filter(s=>sel.has(s.id)), rest=doc.shapes.filter(s=>!sel.has(s.id)); doc.shapes=a.concat(rest); render(); syncPanels(); }

// ---- right-click context menu ----
let ctxEl=null;
function hideCtxMenu(){ if(ctxEl){ ctxEl.remove(); ctxEl=null; } }
function showCtxMenu(x,y,items){ hideCtxMenu();
  const m=document.createElement('div'); m.className='ctxmenu';
  for(const it of items){
    if(it.sep){ const s=document.createElement('div'); s.className='sep'; m.appendChild(s); continue; }
    if(it.title){ const t=document.createElement('div'); t.className='ttl'; t.textContent=it.title; m.appendChild(t); continue; }
    const d=document.createElement('div'); d.className='ci'+(it.disabled?' disabled':'');
    d.innerHTML='<span>'+it.label+'</span>'+(it.key?'<span class="k">'+it.key+'</span>':'');
    if(!it.disabled) d.onclick=()=>{ hideCtxMenu(); it.fn(); };
    m.appendChild(d);
  }
  document.body.appendChild(m);
  const r=m.getBoundingClientRect(); let px=x, py=y;
  if(px+r.width>window.innerWidth) px=window.innerWidth-r.width-4;
  if(py+r.height>window.innerHeight) py=window.innerHeight-r.height-4;
  m.style.left=Math.max(2,px)+'px'; m.style.top=Math.max(2,py)+'px'; ctxEl=m;
}
function shapeContextMenu(e){
  e.preventDefault();
  const w=snapWorld(evScr(e)); const s=pickShapeAt({x:w.x,y:w.y});
  if(!s){ hideCtxMenu(); return; }
  if(!sel.has(s.id)){ sel=new Set([s.id]); syncPanels(); render(); }   // keep an existing multi-selection
  const single=sel.size===1, multi=sel.size>=2;
  const items=[
    { title: multi ? sel.size+' shapes' : (s.prim?s.prim.kind:s.type) },
    { label:'Edit dimensions…', key:'dbl-click', fn:()=>openShapeModal(selectedShapes()[0]), disabled:!single },
    { sep:true },
    { label:'Duplicate', fn:opDuplicate },
    { label:'Delete', key:'Del', fn:deleteSelected },
    { sep:true },
    { label:'Mirror horizontal', fn:()=>opMirror('x') },
    { label:'Mirror vertical', fn:()=>opMirror('y') },
    { label:'Rotate 90°', fn:opRotate90 },
    { label:'Offset…', fn:opOffset },
    { label:'Array…', fn:opArray }
  ];
  if(multi) items.push({ sep:true }, { label:'Weld (union)', fn:()=>opBool('union') }, { label:'Subtract', fn:()=>opBool('diff') }, { label:'Intersect', fn:()=>opBool('intersect') });
  items.push({ label:'Rotate…', fn:openRotateModal });
  items.push({ sep:true }, { label:'Bring to front', fn:bringToFront }, { label:'Send to back', fn:sendToBack });
  showCtxMenu(e.clientX, e.clientY, items);
}
function hitHandle(scr){ if(!sel.size)return null; const bs=bboxScreen(selectedShapes());
  for(const g of rotateGripPts(bs)) if(Math.hypot(scr.x-g.x,scr.y-g.y)<11) return {type:'rotate',k:g.k};
  for(const h of handlePts(bs)) if(Math.abs(scr.x-h.x)<6&&Math.abs(scr.y-h.y)<6) return {type:'scale',k:h.k,bs};
  return null; }
function selectDown(scr,w,e){
  const h=hitHandle(scr);
  if(h){ pushHistory(); const bs=bboxScreen(selectedShapes());
    if(h.type==='rotate'){ const c=S2W({x:(bs.x0+bs.x1)/2,y:(bs.y0+bs.y1)/2}); const rw=S2W(scr); drag={kind:'rotate',c,last:Math.atan2(rw.y-c.y,rw.x-c.x),base:JSON.parse(JSON.stringify(selectedShapes())),ids:[...sel]}; }
    else { const b=CADCORE.bboxAll(selectedShapes()); drag={kind:'scale',k:h.k,b0:b,start:w,base:JSON.parse(JSON.stringify(selectedShapes())),ids:[...sel]}; }
    return; }
  // hit a shape? edge first, then interior of a closed contour (single-click pick like VCarve)
  let hitId=null; const tol=pxTol(6);
  for(let i=doc.shapes.length-1;i>=0;i--){ const s=doc.shapes[i]; if(!layerVisible(s.layer))continue; if(CADCORE.hitTest(s,w,tol)){ hitId=s.id; break; } }
  if(!hitId){ for(let i=doc.shapes.length-1;i>=0;i--){ const s=doc.shapes[i]; if(!layerVisible(s.layer)||!s.closed)continue; if(shapeInside(s,w)){ hitId=s.id; break; } } }
  if(hitId){ if(e.shiftKey){ sel.has(hitId)?sel.delete(hitId):sel.add(hitId); } else if(!sel.has(hitId)){ sel=new Set([hitId]); }
    pushHistory(); const base=JSON.parse(JSON.stringify(selectedShapes())); const raw=S2W(scr); const a0=CADCORE.bboxAnchor(CADCORE.bboxAll(base), modalAnchor);
    drag={kind:'move',grab:raw,a0,base,ids:[...sel]}; }
  else { if(!e.shiftKey) sel.clear(); drag={kind:'marquee',a:scr,b:scr}; }
  syncPanels();
}
// Move drag: the selection's ANCHOR point (same 9-box choice as the dialogs) is what snaps — to the grid, and to object/job
// snap points when Obj-snap is on — so a shape lands exactly on a grid line or a corner. Ctrl = free move (no snap).
function doMove(raw, free){ const {grab,a0,base}=drag; let tx=a0.x+(raw.x-grab.x), ty=a0.y+(raw.y-grab.y); let kind=null;
  if(!free){ const g=snapGridPt({x:tx,y:ty}); if(grid.snap&&grid.on){ tx=g.x; ty=g.y; kind='grid'; }
    if(grid.objSnap){ let best=null,bestD=pxTol(11); const ids=new Set(drag.ids); const cand=[];
      if(job.show){ const r=jobRect(); cand.push(...CADCORE.rectSnapPoints(r.x0,r.y0,r.x1,r.y1)); }
      for(const s of doc.shapes){ if(ids.has(s.id)||!layerVisible(s.layer))continue; cand.push(...CADCORE.snapPoints(s)); }
      const want={x:a0.x+(raw.x-grab.x),y:a0.y+(raw.y-grab.y)};
      for(const sp of cand){ const d=Math.hypot(sp.x-want.x,sp.y-want.y); if(d<bestD){bestD=d;best=sp;} }
      if(best){ tx=best.x; ty=best.y; kind=best.kind||'obj'; } } }
  snapMark = kind?{x:tx,y:ty,kind}:null;
  const dx=tx-a0.x, dy=ty-a0.y; const map=new Map(base.map(o=>[o.id,o]));
  doc.shapes=doc.shapes.map(s=>{ const o=map.get(s.id); if(!o)return s; const t=CADCORE.translate(o,dx,dy); t.id=o.id; return t; });
  setMsg('Move '+(dx>=0?'+':'')+dx.toFixed(3)+', '+(dy>=0?'+':'')+dy.toFixed(3)+'  ·  '+CADCORE.ANCHORS[modalAnchor].label+(kind?' snapped to '+kind:'')+'  ·  Ctrl = no snap');
}
function doScale(w){ const {k,b0,base}=drag;
  const ax = k.includes('w')?b0.maxX : k.includes('e')?b0.minX : (b0.minX+b0.maxX)/2;
  const ay = k.includes('n')?b0.minY : k.includes('s')?b0.maxY : (b0.minY+b0.maxY)/2;
  const hx = k.includes('w')?b0.minX : k.includes('e')?b0.maxX : (b0.minX+b0.maxX)/2;
  const hy = k.includes('n')?b0.maxY : k.includes('s')?b0.minY : (b0.minY+b0.maxY)/2;
  let sx = (hx-ax)?(w.x-ax)/(hx-ax):1;
  let sy = (hy-ay)?(w.y-ay)/(hy-ay):1;
  if(k==='n'||k==='s') sx=1;
  if(k==='e'||k==='w') sy=1;
  if(!isFinite(sx)||Math.abs(sx)<1e-4) sx=1e-4; if(!isFinite(sy)||Math.abs(sy)<1e-4) sy=1e-4;
  // single unrotated rect/round/circle/ellipse: resize the prim (keeps it editable) instead of dropping to poly
  if(base.length===1 && base[0].prim && !base[0].prim.rot){
    const o=base[0];
    const X0=ax+(b0.minX-ax)*sx, X1=ax+(b0.maxX-ax)*sx, Y0=ay+(b0.minY-ay)*sy, Y1=ay+(b0.maxY-ay)*sy;
    const nx=Math.min(X0,X1), ny=Math.min(Y0,Y1), nw=Math.abs(X1-X0), nh=Math.abs(Y1-Y0);
    const uniform=Math.abs(Math.abs(sx)-Math.abs(sy))<1e-6;
    const ns=CADCORE.fitPrimTo(o, nx, ny, nw, nh, uniform);
    if(ns){ doc.shapes=doc.shapes.map(s=>s.id===o.id?ns:s); return; }
  }
  doc.shapes = doc.shapes.map(s=>{ const o=base.find(x=>x.id===s.id); return o?CADCORE.scale(o,ax,ay,sx,sy):s; });
}
const ROT_PARAM_KINDS=new Set(['rect','roundrect','circle','ellipse','polygon','star']);  // rotate-in-place about prim center, keeps prim
function doRotate(w, shift){ const {c,base,last}=drag; let d=Math.atan2(w.y-c.y,w.x-c.x)-last;
  const stepDeg=Math.max(0.1,grid.rotSnap||5);
  if(shift){ const step=stepDeg*Math.PI/180; d=Math.round(d/step)*step; }   // Shift = snap to rotSnap° increments (topbar "Rot °")
  let deg=d*180/Math.PI; deg=((deg+180)%360+360)%360-180;
  setMsg('Rotate '+(deg>=0?'+':'')+deg.toFixed(shift?1:2)+'° '+(deg<0?'CW':'CCW')+(shift?' ('+stepDeg+'° snap)':'  ·  hold Shift = '+stepDeg+'° steps'));
  const map=new Map(base.map(o=>[o.id,o]));
  doc.shapes = doc.shapes.map(s=>{ const o=map.get(s.id); return o?rotateShapeAbout(o,c.x,c.y,d):s; });   // parametric shapes stay editable
}
function drawMarquee(a,b){ ctx.strokeStyle='rgba(255,154,60,0.8)'; ctx.setLineDash([4,3]); ctx.strokeRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y)); ctx.setLineDash([]); }
function marqueeSelect(a,b,add){ const w0=S2W({x:Math.min(a.x,b.x),y:Math.max(a.y,b.y)}), w1=S2W({x:Math.max(a.x,b.x),y:Math.min(a.y,b.y)});
  if(!add) sel.clear();
  for(const s of doc.shapes){ if(!layerVisible(s.layer))continue; const bb=CADCORE.bbox(s); if(bb.minX>=w0.x&&bb.maxX<=w1.x&&bb.minY>=w0.y&&bb.maxY<=w1.y) sel.add(s.id); }
  syncPanels();
}
// ---- node edit ----
function nodeDown(scr,w,e){ if(sel.size!==1){ const tol=pxTol(6); for(let i=doc.shapes.length-1;i>=0;i--){ if(CADCORE.hitTest(doc.shapes[i],w,tol)){ sel=new Set([doc.shapes[i].id]); break; } } syncPanels(); render(); return; }
  const s=selectedShapes()[0]; if(s.type==='text')return; const tol=pxTol(8);
  if(s.prim&&s.prim.kind==='bezier'){ return bezierNodeDown(s,w,tol); }
  for(let i=0;i<s.pts.length;i++){ if(Math.hypot(s.pts[i].x-w.x,s.pts[i].y-w.y)<=tol){ pushHistory(); drag={kind:'nodemove',id:s.id,idx:i}; return; } } }
function bezierNodeDown(s,w,tol){ const nodes=s.prim.nodes;
  for(let i=0;i<nodes.length;i++){ const nd=nodes[i];   // handles first (they sit outside the anchor)
    if(Math.hypot(nd.hx0-nd.x,nd.hy0-nd.y)>1e-6 && Math.hypot(nd.hx0-w.x,nd.hy0-w.y)<=tol){ pushHistory(); drag={kind:'bznode',id:s.id,idx:i,part:'in'}; return; }
    if(Math.hypot(nd.hx1-nd.x,nd.hy1-nd.y)>1e-6 && Math.hypot(nd.hx1-w.x,nd.hy1-w.y)<=tol){ pushHistory(); drag={kind:'bznode',id:s.id,idx:i,part:'out'}; return; } }
  for(let i=0;i<nodes.length;i++){ if(Math.hypot(nodes[i].x-w.x,nodes[i].y-w.y)<=tol){ pushHistory(); drag={kind:'bznode',id:s.id,idx:i,part:'anchor'}; return; } } }
function nodeDblClick(w){ const s=selectedShapes()[0]; if(!s||s.type==='text')return; const tol=pxTol(8);
  if(s.prim&&s.prim.kind==='bezier'){ const nodes=s.prim.nodes;   // dbl-click an anchor toggles smooth <-> corner
    for(let i=0;i<nodes.length;i++){ if(Math.hypot(nodes[i].x-w.x,nodes[i].y-w.y)<=tol){ pushHistory(); const nd=nodes[i];
      if(nd.type==='smooth'){ nd.type='corner'; } else { nd.type='smooth'; CADCORE.mirrorSmoothHandle(nd,'out'); } CADCORE.reflowBezier(s); render(); return; } } return; }
  for(let i=0;i<s.pts.length;i++){ if(Math.hypot(s.pts[i].x-w.x,s.pts[i].y-w.y)<=tol){ if(s.pts.length>2){pushHistory(); s.pts.splice(i,1); s.prim={kind:'poly'}; render();} return; } }
  for(let i=0;i+1<s.pts.length;i++){ if(CADCORE.distToSeg(w,s.pts[i],s.pts[i+1])<=tol){ pushHistory(); s.pts.splice(i+1,0,{x:w.x,y:w.y}); s.prim={kind:'poly'}; render(); return; } } }

// ---- draft preview / commit ----
function updateDraft(w, shift){ if(!draft)return;
  if(draft.kind==='line'){ draft.b=ortho(draft.a,w,shift); }
  else if(draft.kind==='rect'||draft.kind==='ellipse'||draft.kind==='rrect'){ draft.b=w; }
  else if(draft.kind==='circle'||draft.kind==='polygon'||draft.kind==='star'){ draft.r=Math.hypot(w.x-draft.c.x,w.y-draft.c.y); draft.rot=Math.atan2(w.y-draft.c.y,w.x-draft.c.x); }
  else if(draft.kind==='polyline'){ draft.cur=ortho(draft.pts[draft.pts.length-1],w,shift); }
  else if(draft.kind==='arc'){ draft.cur=w; }
  else if(draft.kind==='bezier'){ draft.cur=w; }
  else if(draft.kind==='measure'){ draft.b=w; }
}
function ortho(a,b,shift){ if(!shift&&!grid.ortho)return b; const dx=b.x-a.x,dy=b.y-a.y; if(Math.abs(dx)>Math.abs(dy))return {x:b.x,y:a.y}; return {x:a.x,y:b.y}; }
function drawDraft(){ ctx.strokeStyle='#ffd27a'; ctx.lineWidth=1.3; ctx.setLineDash([5,3]);
  const d=draft;
  if(d.kind==='line'){ line(d.a,d.b); }
  else if(d.kind==='rect'){ const a=d.a,b=d.b; poly([{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}],true); }
  else if(d.kind==='rrect'){ const a=d.a,b=d.b; const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y); const rr=Math.min(parseFloat(document.getElementById('rrectR').value)||0.25,Math.min(w,h)/2); poly(CADCORE.mkRoundRect(x,y,w,h,rr).pts,true); }
  else if(d.kind==='circle'){ circ(d.c,d.r); }
  else if(d.kind==='polygon'){ const s=CADCORE.mkPolygon(d.c,d.r||0.01,parseInt(document.getElementById('polyN').value)||5,d.rot); poly(s.pts,true); }
  else if(d.kind==='star'){ const s=CADCORE.mkStar(d.c,d.r||0.01,(d.r||0.01)*0.45,parseInt(document.getElementById('polyN').value)||5,d.rot); poly(s.pts,true); }
  else if(d.kind==='ellipse'){ const a=d.a,b=d.b; const e=CADCORE.mkEllipse({x:(a.x+b.x)/2,y:(a.y+b.y)/2},Math.abs(b.x-a.x)/2,Math.abs(b.y-a.y)/2); poly(e.pts,true); }
  else if(d.kind==='polyline'){ poly(d.cur?d.pts.concat([d.cur]):d.pts,false); }
  else if(d.kind==='arc'){ if(d.p1&&d.cur){ const r=Math.hypot(d.p1.x-d.c.x,d.p1.y-d.c.y); const a0=Math.atan2(d.p1.y-d.c.y,d.p1.x-d.c.x), a1=Math.atan2(d.cur.y-d.c.y,d.cur.x-d.c.x); poly(CADCORE.arcPolyline(d.c.x,d.c.y,r,a0,a1,true),false);} else if(d.cur){ line(d.c,d.cur);} }
  else if(d.kind==='bezier'){ drawBezierDraft(d); }
  else if(d.kind==='measure'){ ctx.setLineDash([]); drawMeasure(d.a,d.b,false); }
  ctx.setLineDash([]);
}
function drawBezierDraft(d){
  let previewNodes=d.nodes;
  if(d.cur&&d.nodes.length){ previewNodes=d.nodes.concat([{x:d.cur.x,y:d.cur.y,hx0:d.cur.x,hy0:d.cur.y,hx1:d.cur.x,hy1:d.cur.y,type:'corner'}]); }
  if(previewNodes.length>=2){ poly(CADCORE.flattenBezier(previewNodes,false),false); }
  ctx.setLineDash([]);
  for(const nd of d.nodes){ const a=W2S(nd);
    ctx.strokeStyle='rgba(127,208,255,0.6)';
    [[nd.hx0,nd.hy0],[nd.hx1,nd.hy1]].forEach(h=>{ if(Math.hypot(h[0]-nd.x,h[1]-nd.y)>1e-6){ const hs=W2S({x:h[0],y:h[1]}); ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(hs.x,hs.y);ctx.stroke(); ctx.fillStyle='#7fd0ff'; ctx.beginPath();ctx.arc(hs.x,hs.y,3,0,TAU);ctx.fill(); } });
    ctx.fillStyle='#ffd27a'; ctx.fillRect(a.x-3,a.y-3,6,6);
  }
  ctx.strokeStyle='#ffd27a'; ctx.setLineDash([5,3]);
}
function commitBezier(closed){ if(draft&&draft.kind==='bezier'&&draft.nodes.length>=2){ pushHistory(); const s=CADCORE.mkBezier(draft.nodes,!!closed,activeLayer); addShapes([s]); sel=new Set([s.id]); } draft=null; render(); syncPanels(); }
function line(a,b){ const p=W2S(a),q=W2S(b); ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke(); }
function circ(c,r){ const o=W2S(c); ctx.beginPath();ctx.arc(o.x,o.y,r*view.ppi,0,TAU);ctx.stroke(); }
function poly(pts,closed){ ctx.beginPath(); pts.forEach((p,i)=>{const q=W2S(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);}); if(closed)ctx.closePath(); ctx.stroke(); }
function commitDraft(){ const d=draft; if(!d)return; let s=null;
  if(d.kind==='line'){ if(CADCORE.dist(d.a,d.b)>1e-4) s=CADCORE.mkLine(d.a,d.b,activeLayer); }
  else if(d.kind==='rect'){ const x=Math.min(d.a.x,d.b.x),y=Math.min(d.a.y,d.b.y),w=Math.abs(d.b.x-d.a.x),h=Math.abs(d.b.y-d.a.y); if(w>1e-4&&h>1e-4) s=CADCORE.mkRect(x,y,w,h,activeLayer); }
  else if(d.kind==='circle'){ if(d.r>1e-4) s=CADCORE.mkCircle(d.c,d.r,activeLayer); }
  else if(d.kind==='ellipse'){ const rx=Math.abs(d.b.x-d.a.x)/2,ry=Math.abs(d.b.y-d.a.y)/2; if(rx>1e-4&&ry>1e-4) s=CADCORE.mkEllipse({x:(d.a.x+d.b.x)/2,y:(d.a.y+d.b.y)/2},rx,ry,0,activeLayer); }
  else if(d.kind==='polygon'){ if(d.r>1e-4) s=CADCORE.mkPolygon(d.c,d.r,parseInt(document.getElementById('polyN').value)||5,d.rot,activeLayer); }
  else if(d.kind==='star'){ if(d.r>1e-4) s=CADCORE.mkStar(d.c,d.r,d.r*0.45,parseInt(document.getElementById('polyN').value)||5,d.rot,activeLayer); }
  else if(d.kind==='rrect'){ const x=Math.min(d.a.x,d.b.x),y=Math.min(d.a.y,d.b.y),w=Math.abs(d.b.x-d.a.x),h=Math.abs(d.b.y-d.a.y); if(w>1e-4&&h>1e-4){ const rr=Math.min(parseFloat(document.getElementById('rrectR').value)||0.25,Math.min(w,h)/2); s=CADCORE.mkRoundRect(x,y,w,h,rr,activeLayer); } }
  if(s){ pushHistory(); addShapes([s]); sel=new Set([s.id]); }
  draft=null; syncPanels();
}
function commitPolyline(){ if(draft&&draft.pts.length>=2){ pushHistory(); const closed=CADCORE.dist(draft.pts[0],draft.pts[draft.pts.length-1])<pxTol(8);
  if(closed)draft.pts.pop(); const s=CADCORE.mkPoly(draft.pts,closed,activeLayer); addShapes([s]); sel=new Set([s.id]); } draft=null; render(); syncPanels(); }
function commitArc(){ if(draft&&draft.p1&&draft.p2){ pushHistory(); const c=draft.c, r=Math.hypot(draft.p1.x-c.x,draft.p1.y-c.y);
  const a0=Math.atan2(draft.p1.y-c.y,draft.p1.x-c.x), a1=Math.atan2(draft.p2.y-c.y,draft.p2.x-c.x); const s=CADCORE.mkArc(c,r,a0,a1,true,activeLayer); addShapes([s]); sel=new Set([s.id]); } draft=null; render(); syncPanels(); }

// ---- text placement (single-stroke or TTF outline) ----
function placeText(w){
  const h=parseFloat(document.getElementById('txtH').value)||1;
  const str=document.getElementById('txtVal').value||'TEXT';
  if(textOutline && ttFont){
    let d; try{ d=ttFont.getPath(str,0,0,1000).toPathData(4); }
    catch(err){ setMsg('Font render failed: '+err.message); return; }
    const shapes=CADCORE.outlineTextShapes(d, w.x, w.y, h, activeLayer);
    if(!shapes.length){ setMsg('No outline geometry for that text.'); return; }
    pushHistory(); addShapes(shapes); sel=new Set(shapes.map(s=>s.id)); render(); syncPanels();
    setMsg('Placed TTF outline text · '+shapes.length+' contour(s)');
  } else {
    if(textOutline && !ttFont) setMsg('No font loaded — placed single-stroke text. Use "Load font…" for TTF outlines.');
    pushHistory(); const t=CADCORE.mkText(w.x,w.y,h,str,activeLayer); addShapes([t]); sel=new Set([t.id]); render(); syncPanels();
  }
}
function loadFontFile(file){
  const rd=new FileReader();
  rd.onload=ev=>{ try{ ttFont=opentype.parse(ev.target.result);
      const nm=(ttFont.names&&ttFont.names.fullName&&(ttFont.names.fullName.en||Object.values(ttFont.names.fullName)[0]))||file.name;
      const fh=document.getElementById('fontHint'); if(fh){ fh.textContent='Font: '+nm+' — outline text ready.'; fh.style.color='#5ad19a'; }
      const ob=document.getElementById('txtOutline'); if(ob&&!ob.checked){ ob.checked=true; textOutline=true; }
      setMsg('Loaded font: '+nm);
    }catch(err){ ttFont=null; const fh=document.getElementById('fontHint'); if(fh){ fh.textContent='Could not parse font: '+err.message; fh.style.color='#e0a020'; } setMsg('Font parse failed: '+err.message); } };
  rd.readAsArrayBuffer(file);
}

// ---- edit ops ----
function opNest(){
  const gv=id=>{const el=document.getElementById(id); return el?el.value:null;};
  const gc=id=>{const el=document.getElementById(id); return el?el.checked:false;};
  const sheetW=Math.abs(parseFloat(gv('nestW'))||job.w);
  const sheetH=Math.abs(parseFloat(gv('nestH'))||job.h);
  const margin=Math.abs(parseFloat(gv('nestMargin'))||0);
  const spacing=Math.abs(parseFloat(gv('nestSpacing'))||0);
  const allowRotate=gc('nestRotate');
  const visible=doc.shapes.filter(s=>layerVisible(s.layer));
  const targets=sel.size?selectedShapes():visible;
  if(!targets.length)return setMsg('Nothing to nest — draw some shapes first');
  const result=CADCORE.nestShapes(targets,{sheetW,sheetH,margin,spacing,allowRotate});
  if(!result.placements.length)return setMsg('All parts too large for '+sheetW+'"×'+sheetH+'" sheet — check Nest W/H');
  pushHistory();
  const spread={sheetW,gap:2};
  for(const pl of result.placements){
    const orig=targets[pl.idx];
    const placed=CADCORE.placeShape(orig,pl,spread);
    const i=doc.shapes.findIndex(s=>s.id===orig.id);
    if(i>=0)doc.shapes[i]=placed;
  }
  sel.clear(); render(); syncPanels();
  const pct=(result.utilization*100).toFixed(0);
  let m=result.placements.length+' part'+(result.placements.length!==1?'s':'')+' on '+result.sheets+' sheet'+(result.sheets!==1?'s':'')+', '+pct+'% used';
  if(result.unplaced.length)m+=' · WARN: '+result.unplaced.length+' part(s) too large for sheet — excluded';
  setMsg(m);
}
function opOffset(){ const sh=selectedShapes(); if(!sh.length)return setMsg('Select shapes to offset'); const d=parseFloat(prompt('Offset distance (in, + outward, - inward):','0.25')); if(!d&&d!==0)return; pushHistory(); const res=CADCORE.offsetShapes(sh,d); res.forEach(r=>r.layer=activeLayer); addShapes(res); sel=new Set(res.map(r=>r.id)); render(); syncPanels(); }
function opBool(op){ const sh=selectedShapes(); if(sh.length<2)return setMsg('Select 2+ shapes'); pushHistory();
  let res; if(op==='union') res=CADCORE.booleanOp(sh,[],'union'); else { res=CADCORE.booleanOp([sh[0]],sh.slice(1),op==='diff'?'diff':'intersect'); }
  doc.shapes=doc.shapes.filter(s=>!sel.has(s.id)); res.forEach(r=>r.layer=activeLayer); addShapes(res); sel=new Set(res.map(r=>r.id)); render(); syncPanels(); }
function opMirror(axis){ const sh=selectedShapes(); if(!sh.length)return; pushHistory(); const b=CADCORE.bboxAll(sh); const at=axis==='x'?(b.minX+b.maxX)/2:(b.minY+b.maxY)/2;
  const res=sh.map(s=>{const m=CADCORE.mirror(s,axis,at);m.id=CADCORE.uid();return m;}); addShapes(res); sel=new Set(res.map(r=>r.id)); render(); syncPanels(); }
function opDuplicate(){ const sh=selectedShapes(); if(!sh.length)return; pushHistory(); const res=sh.map(s=>{const c=CADCORE.translate(s,0.25,-0.25);c.id=CADCORE.uid();return c;}); addShapes(res); sel=new Set(res.map(r=>r.id)); render(); syncPanels(); }
function opArray(){ const sh=selectedShapes(); if(!sh.length)return; const cols=parseInt(prompt('Columns:','3'))||1, rows=parseInt(prompt('Rows:','1'))||1; const dx=parseFloat(prompt('X spacing (in):','2'))||0, dy=parseFloat(prompt('Y spacing (in):','2'))||0;
  pushHistory(); const news=[]; for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ if(!r&&!c)continue; sh.forEach(s=>{const n=CADCORE.translate(s,c*dx,r*dy);n.id=CADCORE.uid();news.push(n);}); } addShapes(news); render(); syncPanels(); }
function opRotate90(){ const sh=selectedShapes(); if(!sh.length)return; pushHistory(); const b=CADCORE.bboxAll(sh); const cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2;
  const map=new Map(sh.map(s=>[s.id,s])); doc.shapes=doc.shapes.map(s=>sel.has(s.id)?CADCORE.rotate(s,cx,cy,Math.PI/2):s); render(); syncPanels(); }
function opAlign(how){ const sh=selectedShapes(); if(sh.length<2)return; pushHistory(); const b=CADCORE.bboxAll(sh);
  doc.shapes=doc.shapes.map(s=>{ if(!sel.has(s.id))return s; const sb=CADCORE.bbox(s); let dx=0,dy=0;
    if(how==='left')dx=b.minX-sb.minX; if(how==='right')dx=b.maxX-sb.maxX; if(how==='hcenter')dx=(b.minX+b.maxX)/2-(sb.minX+sb.maxX)/2;
    if(how==='top')dy=b.maxY-sb.maxY; if(how==='bottom')dy=b.minY-sb.minY; if(how==='vcenter')dy=(b.minY+b.maxY)/2-(sb.minY+sb.maxY)/2;
    return CADCORE.translate(s,dx,dy); }); render(); syncPanels(); }
function opJoin(){ const sh=selectedShapes().filter(s=>s.type==='path'); if(sh.length<1)return; pushHistory();
  const polys=sh.map(s=>({pts:s.pts,closed:s.closed})); const cs=CAM.assembleContours(polys);
  doc.shapes=doc.shapes.filter(s=>!sel.has(s.id)); const news=cs.map(c=>CADCORE.mkPoly(c.pts,c.closed,activeLayer)); addShapes(news); sel=new Set(news.map(n=>n.id)); render(); syncPanels(); }

// ---- import / export ----
function importText(name, text){
  if(/\.dxf$/i.test(name)){ const ents=parseDxf(text); const polys=[]; for(const e of ents){ for(const p of entityToPolys(e)) polys.push(p); } const shapes=CADCORE.dxfPolysToShapes(polys); pushHistory(); addShapes(shapes); fitAll(); }
  else if(/\.svg$/i.test(name)){ const shapes=CADCORE.svgToShapes(text); pushHistory(); addShapes(shapes); fitAll(); }
  else { setMsg('Unsupported file: '+name); }
  syncPanels(); render();
}
// PDF is binary — parse an ArrayBuffer into cuttable vector paths (logos/artwork).
function importPDF(name, buf){
  let loops;
  try{ loops = parsePDFVectors(new Uint8Array(buf)); }
  catch(err){ setMsg('PDF parse failed: '+err.message); return; }
  if(!loops || !loops.length){
    if(loops && loops.hasLiveText) setMsg('No cuttable paths in '+name+' — it is live text. Outline the fonts (Type → Create Outlines) and re-export as vector PDF.');
    else setMsg('No vector paths found in '+name+' — it may be raster/scanned. Re-export as a vector PDF.');
    return;
  }
  const shapes = loops.map(l=>CADCORE.mkPoly(l.pts, l.closed, activeLayer)).filter(s=>s.pts.length>=2);
  pushHistory(); addShapes(shapes); fitAll(); syncPanels(); render();
  let m='Imported '+shapes.length+' path'+(shapes.length!==1?'s':'')+' from PDF · '+name;
  if(loops.hasLiveText) m+='  ·  WARNING: this PDF also has live text that was NOT imported — outline the fonts to cut it.';
  setMsg(m);
}
function download(name, text, type){ const b=new Blob([text],{type:type||'text/plain'}); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
// ---- project save/load (.aqcam) ----
const AUTOSAVE_KEY='aqcam_autosave';
let autosaveTimer=null;
function projectJSON(metaName){ return CADCORE.projectToJSON(doc, job, opsQueue, {name:metaName||'aqcam job', savedAt:Date.now(), app:'Aquamentor CAD/CAM', view:viewMode}); }
// ---- 2D Design / Preview view tabs ----
function setView(mode){
  viewMode = (mode==='preview') ? 'preview' : '2d';
  document.querySelectorAll('.vtab').forEach(b=>b.classList.toggle('active', b.dataset.view===viewMode));
  const stage=document.querySelector('.stage'); if(stage)stage.classList.toggle('preview', viewMode==='preview');
  if(viewMode==='preview'){ const solid=document.getElementById('simSolid'); if(solid&&solid.checked) runSim(); else { simField=null; recalcAll(); } }
  else { simField=null; render(); }
}
// Build the tool profile + cut segments for one toolpath, for the material sim.
// One toolpath may post to multiple ops (vcarve flat-depth = endmill + V-bit) — build a sim cut per op.
function simCutFor(q){
  let res; try{ res=buildOpRes(q.p, contoursFromIds(q.ids)); }catch(e){ return []; }
  const cuts=[];
  for(const op of res.ops){ if(!op.passes||!op.passes.length)continue;
    const post=Object.assign({},CAM.POSTS[document.getElementById('camPost').value]); post.arcs=(op.kind!=='drill')&&document.getElementById('camArcs').checked;
    const g=CAM.postProcess({name:'tp',units:'inch',ops:[op]},post);
    const tool = op.toolProfile || (q.p.op==='vcarve'?{type:'v',radius:(q.p.toolDia||0.25)/2,angle:q.p.bitAngle||90}:{type:'flat',radius:(q.p.toolDia||0.25)/2});
    cuts.push({ tool, segs:toolpathSegs(g) }); }
  return cuts;
}
// Run the material-removal sim over every visible toolpath and shade the result.
function runSim(){
  const r=jobRect(); const w=r.x1-r.x0, h=r.y1-r.y0;
  const res=parseFloat((document.getElementById('simRes')||{}).value)||0.05;
  const cuts=[]; for(const q of opsQueue){ if(q.visible===false)continue; for(const c of simCutFor(q)) cuts.push(c); }
  const field=CAM.simulateStock({ x0:r.x0, y0:r.y0, w, h, thickness:job.thickness||0.5, res, cuts });
  const use3d=glInit();
  simField=use3d ? { field, x0:r.x0, y0:r.y0, x1:r.x1, y1:r.y1, mesh:null, lines:null, linesFor:null } : Object.assign(shadeHeightfield(field, r), {field});
  if(!toolpaths) recalcAll();   // backplot segments feed the 3D line overlay
  render();
  setMsg('3D sim: '+cuts.length+' toolpath(s) · '+field.nx+'×'+field.ny+' cells @ '+res+'"'+(use3d?'  ·  drag = pan · Option/Alt-drag = orbit · wheel = zoom':'  (WebGL unavailable: top-down only)'));
}
// Shade the heightfield into an offscreen canvas: wood-tone depth ramp + directional hillshade for a carved look.
function shadeHeightfield(field, r){
  const {nx,ny,z,res}=field; let maxD=1e-4; for(let i=0;i<z.length;i++){ const d=-z[i]; if(d>maxD)maxD=d; }
  const off=document.createElement('canvas'); off.width=nx; off.height=ny; const octx=off.getContext('2d');
  const img=octx.createImageData(nx,ny); const px=img.data;
  const L=[-0.5,-0.55,0.67]; const Ln=Math.hypot(L[0],L[1],L[2]); L[0]/=Ln;L[1]/=Ln;L[2]/=Ln;
  const at=(i,j)=>z[Math.min(ny-1,Math.max(0,j))*nx+Math.min(nx-1,Math.max(0,i))];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){ const h=z[j*nx+i]; const frac=Math.min(1,(-h)/maxD);
    // wood tone: top warm tan -> deep shadowed brown
    let R=198-frac*120, G=168-frac*118, B=120-frac*82;
    const gx=(at(i+1,j)-at(i-1,j))/(2*res), gy=(at(i,j+1)-at(i,j-1))/(2*res);
    let nz=1/Math.sqrt(gx*gx+gy*gy+1), nX=-gx*nz, nY=-gy*nz;
    let lam=nX*L[0]+nY*L[1]+nz*L[2]; lam=Math.max(0.35,Math.min(1.15,lam)); const s=0.55+0.45*lam;
    const o=((ny-1-j)*nx+i)*4;   // flip rows so image top = max Y
    px[o]=Math.max(0,Math.min(255,R*s)); px[o+1]=Math.max(0,Math.min(255,G*s)); px[o+2]=Math.max(0,Math.min(255,B*s)); px[o+3]=255; }
  octx.putImageData(img,0,0);
  return { canvas:off, x0:r.x0, y0:r.y0, x1:r.x1, y1:r.y1 };
}
// ---- Save / Save As ----
// Chrome/Edge: File System Access API — "Save As" opens a real save dialog (pick folder + name) and remembers the file
// handle, so "Save" afterwards writes straight back to that file. Other browsers: ask for a name, then download.
let projectFile = { handle:null, name:'design.aqcam' };
const FS_TYPES=[{ description:'Aquamentor CAD/CAM job', accept:{ 'application/json':['.aqcam'] } }];
function setProjectName(name){ if(name) projectFile.name=name; document.title=projectFile.name.replace(/\.aqcam$/i,'')+' — Aquamentor CAD/CAM'; }
async function writeHandle(handle, text){ const w=await handle.createWritable(); await w.write(text); await w.close(); }
function ensureExt(n){ n=(n||'').trim(); if(!n) return ''; return /\.aqcam$/i.test(n)?n:n+'.aqcam'; }
async function saveProjectAs(){ const text=projectJSON(projectFile.name.replace(/\.aqcam$/i,''));
  if(window.showSaveFilePicker){
    try{ const h=await window.showSaveFilePicker({ suggestedName:projectFile.name, types:FS_TYPES }); await writeHandle(h,text); projectFile.handle=h; setProjectName(h.name);
      setMsg('Saved as '+h.name+' ('+doc.shapes.length+' shapes, '+opsQueue.length+' toolpaths) — Ctrl+S now saves back to this file'); return true; }
    catch(err){ if(err&&err.name==='AbortError'){ setMsg('Save as cancelled'); return false; } setMsg('Save failed: '+err.message+' — downloading instead'); }
  }
  const n=ensureExt(prompt('Save job as (file name):', projectFile.name)); if(!n){ setMsg('Save as cancelled'); return false; }
  setProjectName(n); download(n, text, 'application/json'); setMsg('Saved '+n+' to your Downloads folder ('+doc.shapes.length+' shapes, '+opsQueue.length+' toolpaths)'); return true; }
async function saveProject(){ if(!projectFile.handle) return saveProjectAs();
  try{ await writeHandle(projectFile.handle, projectJSON(projectFile.name.replace(/\.aqcam$/i,''))); setMsg('Saved '+projectFile.name+' ('+doc.shapes.length+' shapes, '+opsQueue.length+' toolpaths)'); return true; }
  catch(err){ setMsg('Save to '+projectFile.name+' failed ('+err.message+') — choose a location'); projectFile.handle=null; return saveProjectAs(); } }
// Open: native picker when available (keeps the handle so Save writes back); falls back to the <input type=file>.
async function openProjectDialog(){ if(!window.showOpenFilePicker){ document.getElementById('fileInput').click(); return; }
  let hs; try{ hs=await window.showOpenFilePicker({ multiple:false, types:[{ description:'Job or vector file', accept:{ 'application/json':['.aqcam'], 'image/vnd.dxf':['.dxf'], 'image/svg+xml':['.svg'], 'application/pdf':['.pdf'] } }] }); }
  catch(err){ if(!(err&&err.name==='AbortError')) document.getElementById('fileInput').click(); return; }
  const h=hs[0], f=await h.getFile();
  if(/\.aqcam$/i.test(f.name)){ openProject(await f.text(), f.name); projectFile.handle=h; setProjectName(f.name); }
  else if(/\.pdf$/i.test(f.name)) importPDF(f.name, await f.arrayBuffer());
  else importText(f.name, await f.text()); }
function applyProject(proj, srcName){
  doc.shapes=proj.shapes;
  doc.layers=new Map(proj.layers.map(l=>[l.name,{visible:l.visible,color:l.color}]));
  activeLayer=(proj.layers[0]&&proj.layers[0].name)||'0';
  job.w=proj.job.w; job.h=proj.job.h; job.thickness=proj.job.thickness; job.origin=proj.job.origin; job.show=proj.job.show;
  opsQueue=(proj.opsQueue||[]).map(normalizeOp); editingIdx=null;
  applyJobInputs(); toolpaths=null; drillMarks=null; sel.clear();
  history=[]; future=[];
  buildQueueList(); syncPanels(); (doc.shapes.length?fitAll():fitJob());
  setView((proj.meta&&proj.meta.view==='preview')?'preview':'2d');   // restore saved view (renders)
  setMsg('Opened project'+(srcName?' · '+srcName:'')+' — '+doc.shapes.length+' shape(s), '+opsQueue.length+' op(s)');
}
function openProject(text, srcName){
  let proj; try{ proj=CADCORE.projectFromJSON(text); }
  catch(err){ setMsg('Open failed: '+err.message); return false; }
  applyProject(proj, srcName); return true;
}
function applyJobInputs(){ const g=id=>document.getElementById(id);
  if(g('jobW'))g('jobW').value=job.w; if(g('jobH'))g('jobH').value=job.h; if(g('jobT'))g('jobT').value=job.thickness;
  if(g('jobOrigin'))g('jobOrigin').value=job.origin; if(g('jobShow'))g('jobShow').checked=job.show!==false;
  const nw=g('nestW'),nh=g('nestH'); if(nw)nw.value=job.w; if(nh)nh.value=job.h; }
function autosaveNow(){ try{ localStorage.setItem(AUTOSAVE_KEY, projectJSON('autosave')); }catch(e){} }
function scheduleAutosave(){ if(autosaveTimer)clearTimeout(autosaveTimer); autosaveTimer=setTimeout(autosaveNow, 1500); }
function exportDXF(){ if(!doc.shapes.length)return; download('design.dxf', CADCORE.toDXF(doc.shapes)); }
function exportSVG(){ if(!doc.shapes.length)return; download('design.svg', CADCORE.toSVG(doc.shapes),'image/svg+xml'); }
function fitAll(){ if(!doc.shapes.length)return; const b=CADCORE.bboxAll(doc.shapes); const pad=0.5; const w=(b.maxX-b.minX)+2*pad||1,h=(b.maxY-b.minY)+2*pad||1;
  view.ppi=Math.min(cv.width/w, cv.height/h); view.ox=cv.width/2-(b.minX+b.maxX)/2*view.ppi; view.oy=cv.height/2+(b.minY+b.maxY)/2*view.ppi; render(); }

// ---- CAM ----
function camContours(){ const sh=sel.size?selectedShapes():doc.shapes.filter(s=>layerVisible(s.layer)); const polys=CADCORE.shapesToContoursInput(sh); return CAM.assembleContours(polys); }
function contoursFromIds(ids){ const sh=(ids&&ids.length)?doc.shapes.filter(s=>ids.indexOf(s.id)>=0&&layerVisible(s.layer)):doc.shapes.filter(s=>layerVisible(s.layer)); return CAM.assembleContours(CADCORE.shapesToContoursInput(sh)); }
// run one CAM op from params + contours -> {ops,warnings,points}. Shared by single-op build and the multi-op job.
function buildOpRes(p, contours){
  const res=(p.op==='pocket')?CAM.pocketOp(contours,p)
    :(p.op==='drill')?CAM.drillOp(contours,p)
    :(p.op==='vcarve')?CAM.vcarveOp(contours,Object.assign({},p,{maxDepth:p.cutDepth,step:p.vstep}))
    :CAM.profileOp(contours,p);
  for(const op of res.ops) op.clearZ=p.clearZ;   // vcarve flat-depth returns 2 ops (endmill + V-bit)
  return res;
}
function camParams(){ const g=id=>document.getElementById(id); const tabsN=parseInt(g('camTabN').value,10)||0;
  return { op:(g('camOp')&&g('camOp').value)||'profile', toolNum:parseInt(g('camTool').value,10)||1, toolDia:parseFloat(g('camDia').value)||0.25, side:g('camSide').value, climb:g('camDir').value==='climb',
    cutDepth:Math.abs(parseFloat(g('camDepth').value)||0.25), passDepth:Math.abs(parseFloat(g('camPass').value)||0.125), feed:parseFloat(g('camFeed').value)||120,
    plunge:parseFloat(g('camPlunge').value)||40, rpm:parseFloat(g('camRpm').value)||18000, topZ:parseFloat(g('camTopZ').value)||0, clearZ:0.25,
    stepover:((parseFloat(g('camStep')&&g('camStep').value)||40)/100),
    pocketStyle:(g('camPocketStyle')&&g('camPocketStyle').value)||'offset',
    rampEntry:!!(g('camHelixEntry')&&g('camHelixEntry').checked),
    finishDia:Math.abs(parseFloat(g('camFinishDia')&&g('camFinishDia').value)||0),
    finishNum:(function(){ const fd=Math.abs(parseFloat(g('camFinishDia')&&g('camFinishDia').value)||0); const tn=parseInt(g('camTool').value,10)||1;
      if(fd<=0) return tn===1?2:1; const m=(typeof tools!=='undefined'&&tools)?tools.find(t=>Math.abs(t.dia-fd)<0.001):null; let n=m?m.toolNum:2; if(n===tn)n=tn===1?2:1; return n; })(),
    peck:Math.abs(parseFloat(g('camPeck')&&g('camPeck').value)||0),
    bitAngle:parseFloat(g('camVAngle')&&g('camVAngle').value)||90, vstep:Math.abs(parseFloat(g('camVStep')&&g('camVStep').value)||0.02),
    flatDepth:Math.abs(parseFloat(g('camVFlat')&&g('camVFlat').value)||0),
    clearDia:Math.abs(parseFloat(g('camVClearDia')&&g('camVClearDia').value)||0),
    clearNum:(function(){ const cd=Math.abs(parseFloat(g('camVClearDia')&&g('camVClearDia').value)||0); const vn=parseInt(g('camTool').value,10)||1;
      if(cd<=0) return vn===1?2:1; const m=(typeof tools!=='undefined'&&tools)?tools.find(t=>Math.abs(t.dia-cd)<0.001):null; let n=m?m.toolNum:2; if(n===vn)n=vn===1?2:1; return n; })(),
    leadType:(g('camLead')&&g('camLead').value)||'none', leadLen:Math.abs(parseFloat(g('camLeadLen')&&g('camLeadLen').value)||0.25),
    rampLen:Math.abs(parseFloat(g('camRampLen')&&g('camRampLen').value)||0),
    tabs:{count:tabsN,length:parseFloat(g('camTabL').value)||0.4,height:parseFloat(g('camTabH').value)||0.1} }; }
function camBuild(){ const contours=camContours(); const closedN=contours.filter(c=>c.closed).length; const p=camParams();
  const res=buildOpRes(p, contours);
  const post=Object.assign({},CAM.POSTS[document.getElementById('camPost').value]); post.arcs=(p.op!=='drill')&&document.getElementById('camArcs').checked;
  const label=p.op==='pocket'?'POCKET':p.op==='drill'?'DRILL':p.op==='vcarve'?'VCARVE':p.side.toUpperCase();
  const g=CAM.postProcess({name:'design - '+label,units:'inch',ops:res.ops},post); const arcN=(g.match(/^G[23] /gm)||[]).length;
  return {g,closedN,passes:res.ops.reduce((n,op)=>n+op.passes.length,0),warnings:res.warnings,arcN,op:p.op,points:res.points||null}; }
function toolpathSegs(g){ // parse to segments for overlay (tracks Z so the backplot can shade by depth)
  const segs=[]; let x=0,y=0,z=0,mode=null;
  for(const raw of g.split(/\r?\n/)){ const ln=raw.trim().toUpperCase(); if(!ln||ln[0]==='('||ln[0]==='%')continue; const m=ln.match(/^(G[0-3])/); if(m)mode=m[1];
    const pv=c=>{const r=ln.match(new RegExp(c+'(-?[\\d.]+)'));return r?+r[1]:null;}; const nx=pv('X'),ny=pv('Y'),ni=pv('I'),nj=pv('J'),nz=pv('Z'); const x0=x,y0=y,z0=z;
    if(nx!=null)x=nx; if(ny!=null)y=ny; if(nz!=null)z=nz;
    if(mode==='G0'){ if(nx!=null||ny!=null) segs.push({x0,y0,x1:x,y1:y,z0,z1:z,rapid:true}); }
    else if(mode==='G1'){ if(nx!=null||ny!=null) segs.push({x0,y0,x1:x,y1:y,z0,z1:z}); }  // ramp/plunge moves carry a Z change → z0!=z1
    else if((mode==='G2'||mode==='G3')&&ni!=null&&nj!=null){ const cx=x0+ni,cy=y0+nj,r=Math.hypot(ni,nj); let sa=Math.atan2(y0-cy,x0-cx),ea=Math.atan2(y-cy,x-cx);
      if(mode==='G2'){if(ea>=sa)ea-=TAU;}else{if(ea<=sa)ea+=TAU;} const n=24; let px=x0,py=y0;
      for(let s=1;s<=n;s++){const a=sa+(ea-sa)*s/n,ax=cx+r*Math.cos(a),ay=cy+r*Math.sin(a); segs.push({x0:px,y0:py,x1:ax,y1:ay,z0:z0+(z-z0)*(s-1)/n,z1:z0+(z-z0)*s/n}); px=ax;py=ay;} } }   // helical: interpolate Z (z0->z) along the arc
  return segs;
}
function camGenerate(){ const r=camBuild(); const hint=document.getElementById('camHint');
  if(r.passes===0){ hint.textContent=(r.warnings&&r.warnings.length)?r.warnings[0]:'No closed contours selected/visible.'; hint.className='cam-hint warn'; toolpaths=null; render(); return; }
  lastGcode=r.g; toolpaths=toolpathSegs(r.g); hint.className='cam-hint';
  if(r.op==='drill'){ drillMarks=r.points; drillDia=parseFloat(document.getElementById('camDia').value)||0.25; }
  else drillMarks=null;
  const noun=r.op==='drill'?'hole(s)':'contour(s)';
  hint.textContent='Generated '+r.passes+' pass(es), '+r.arcN+' arc move(s), '+(r.op==='drill'?(r.points?r.points.length:0):r.closedN)+' '+noun+'.'+(r.warnings.length?' WARN: '+r.warnings[0]:''); render(); }
function camExport(){ const r=camBuild(); if(r.passes===0){document.getElementById('camHint').textContent='Nothing to export.';return;} lastGcode=r.g; toolpaths=toolpathSegs(r.g);
  if(r.op==='drill'){ drillMarks=r.points; drillDia=parseFloat(document.getElementById('camDia').value)||0.25; } else drillMarks=null;
  render(); download('design.tap', r.g); }
function camClear(){ toolpaths=null; drillMarks=null; render(); }

// ---- editable named toolpath list (VCarve-style) ----
let opsQueue=[];       // [{p, ids, name, visible, label}]
let editingIdx=null;   // toolpath currently loaded into the CAM panel for editing (null = creating new)
const _esc=s=>String(s).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
function autoOpName(p){ p=p||{}; const op=p.op||'profile'; return op==='profile'?('Profile '+String(p.side||'outside').replace(/^./,c=>c.toUpperCase())):(op.charAt(0).toUpperCase()+op.slice(1)); }
function autoLabel(p,ids,match){ return autoOpName(p)+' · T'+p.toolNum+' Ø'+p.toolDia+'" · '+((ids&&ids.length)?ids.length+' sel':'all')+(match?' (lib)':''); }
function normalizeOp(q){ q=q||{}; return { p:q.p||{}, ids:Array.isArray(q.ids)?q.ids:[], name:q.name||q.label||autoOpName(q.p), label:q.label||'', visible:q.visible!==false }; }
function refreshAddBtn(){ const b=document.getElementById('btnAddOp'); if(b) b.textContent=(editingIdx!=null)?'✓ Update':'+ Toolpath'; }
function moveOp(i,dir){ const j=i+dir; if(j<0||j>=opsQueue.length)return; pushHistory(); const t=opsQueue[i]; opsQueue[i]=opsQueue[j]; opsQueue[j]=t;
  if(editingIdx===i)editingIdx=j; else if(editingIdx===j)editingIdx=i; buildQueueList(); }
function renameOp(i){ const q=opsQueue[i]; if(!q)return; const n=prompt('Toolpath name:', q.name||q.label||'Toolpath'); if(n==null)return; pushHistory(); q.name=n.trim()||q.name; buildQueueList(); }
function editOp(i){ const q=opsQueue[i]; if(!q)return; applyParamsToPanel(q.p); sel=new Set(q.ids); editingIdx=i; buildQueueList(); render(); setMsg('Editing "'+(q.name||q.label)+'" — adjust settings, then click ✓ Update'); }
function buildQueueList(){ const el=document.getElementById('opsQueue'); if(!el)return; el.innerHTML=''; refreshAddBtn();
  if(!opsQueue.length){ el.innerHTML='<div class="muted" style="font-size:10px">No toolpaths yet — set an Op + selection, then "+ Toolpath".</div>'; return; }
  opsQueue.forEach((q,i)=>{ const row=document.createElement('div'); row.className='qrow'+(i===editingIdx?' editing':'');
    row.innerHTML='<input type="checkbox" class="qv" '+(q.visible!==false?'checked':'')+' title="Show in preview">'+
      '<span class="ql" title="Click to rename">'+(i+1)+'. '+_esc(q.name||q.label||'Toolpath')+'</span>'+
      '<span class="qt" title="Estimated cut time">'+(q._time?fmtTime(q._time):'')+'</span>'+
      '<span class="qbtns"><button class="qmv qedit" title="Edit settings">✎</button><button class="qmv" title="Move up">↑</button><button class="qmv" title="Move down">↓</button><button class="qx" title="Delete">×</button></span>';
    row.querySelector('.qv').onchange=e=>{ q.visible=e.target.checked; recalcAll(); };
    row.querySelector('.ql').onclick=()=>renameOp(i);
    const b=row.querySelectorAll('.qmv'); b[0].onclick=()=>editOp(i); b[1].onclick=()=>moveOp(i,-1); b[2].onclick=()=>moveOp(i,1);
    row.querySelector('.qx').onclick=()=>{ pushHistory(); if(editingIdx===i)editingIdx=null; else if(editingIdx!=null&&editingIdx>i)editingIdx--; opsQueue.splice(i,1); buildQueueList(); recalcAll(); };
    el.appendChild(row); }); }
function addOp(){ const p=camParams(); const ids=[...sel];
  // auto-assign a consistent tool number from the saved library by diameter (prefer same op kind)
  const near=t=>Math.abs(t.dia-p.toolDia)<0.001; const match=tools.find(t=>t.op===p.op && near(t)) || tools.find(near); if(match) p.toolNum=match.toolNum;
  const label=autoLabel(p,ids,match); pushHistory();
  if(editingIdx!=null && opsQueue[editingIdx]){ const q=opsQueue[editingIdx]; q.p=p; q.ids=ids; q.label=label; const idx=editingIdx; editingIdx=null; buildQueueList(); recalcAll(); setMsg('Updated toolpath '+(idx+1)+': '+(q.name||label)); return; }
  const name=autoOpName(p); opsQueue.push({p,ids,name,label,visible:true}); buildQueueList(); recalcAll(); setMsg('Added toolpath '+opsQueue.length+': '+name); }
// Recompute the backplot for every VISIBLE toolpath and combine into one preview overlay.
function recalcAll(){ const allSegs=[], allMarks=[]; let total=0;
  for(const q of opsQueue){ if(q.visible===false)continue; let res; try{ res=buildOpRes(q.p, contoursFromIds(q.ids)); }catch(e){ continue; }
    if(!res.ops.some(op=>op.passes&&op.passes.length)){ q._time=0; continue; }
    const post=Object.assign({},CAM.POSTS[document.getElementById('camPost').value]); post.arcs=(q.p.op!=='drill')&&document.getElementById('camArcs').checked;
    const g=CAM.postProcess({name:'tp',units:'inch',ops:res.ops},post);   // all ops (vcarve flat-depth posts 2)
    const segs=toolpathSegs(g);
    q._time=CAM.estimateTime(segs,{feed:q.p.feed,plunge:q.p.plunge,rapid:300}).seconds; total+=q._time;
    for(const s of segs) allSegs.push(s);
    if(res.points) for(const pt of res.points) allMarks.push(pt); }
  toolpaths=allSegs.length?allSegs:null; drillMarks=allMarks.length?allMarks:null; if(allMarks.length)drillDia=0.25; buildQueueList(); render();
  const n=opsQueue.filter(q=>q.visible!==false).length; setMsg('Preview: '+n+'/'+opsQueue.length+' toolpath(s) · '+allSegs.length+' move(s) · est '+fmtTime(total)+' cut time'); }
// ---- fillet / trim / extend click tools ----
function filletAt(w){ const tol=pxTol(14); let best=null,bd=tol,bi=-1;
  for(const s of doc.shapes){ if(s.type!=='path'||!layerVisible(s.layer))continue;
    for(let i=0;i<s.pts.length;i++){ const dd=Math.hypot(s.pts[i].x-w.x,s.pts[i].y-w.y); if(dd<bd){bd=dd;best=s;bi=i;} } }
  if(!best){ setMsg('Fillet: click nearer a vector corner'); return; }
  const R=Math.abs(parseFloat((document.getElementById('filletR')||{}).value)||0.25);
  const np=CADCORE.filletPolyCorner(best.pts, best.closed, bi, R, 16);
  if(!np){ setMsg('Fillet: corner not fillettable (collinear, or an open endpoint)'); return; }
  pushHistory(); best.pts=np; best.prim={kind:'poly'}; sel=new Set([best.id]); render(); syncPanels(); setMsg('Filleted corner · r='+R+'"'); }
function trimAt(w){ const s=pickShapeAt(w);
  if(!s||s.type!=='path'||s.closed){ setMsg('Trim: click the dangling part of an OPEN vector to remove'); return; }
  const cutters=doc.shapes.filter(o=>o.id!==s.id && o.type==='path' && layerVisible(o.layer)).map(o=>({pts:o.pts,closed:o.closed}));
  const np=CADCORE.trimPolyline(s.pts, s.closed, cutters, w);
  if(!np){ setMsg('Trim: no crossing vector to trim back to'); return; }
  pushHistory(); s.pts=np; s.prim={kind:'poly'}; sel=new Set([s.id]); render(); syncPanels(); setMsg('Trimmed to intersection'); }
function extendAt(w){ const tol=pxTol(16); let best=null,which=null,bd=tol;
  for(const s of doc.shapes){ if(s.type!=='path'||s.closed||!layerVisible(s.layer)||s.pts.length<2)continue;
    const d0=Math.hypot(s.pts[0].x-w.x,s.pts[0].y-w.y), d1=Math.hypot(s.pts[s.pts.length-1].x-w.x,s.pts[s.pts.length-1].y-w.y);
    if(d0<bd){bd=d0;best=s;which='start';} if(d1<bd){bd=d1;best=s;which='end';} }
  if(!best){ setMsg('Extend: click near an open vector endpoint'); return; }
  const oldTip=which==='start'?best.pts[0]:best.pts[best.pts.length-1];
  let ext=null, extDist=Infinity;
  for(const o of doc.shapes){ if(o.id===best.id||o.type!=='path'||!layerVisible(o.layer))continue;
    const np=CADCORE.extendPolyline(best.pts, which, {pts:o.pts,closed:o.closed});
    if(np){ const tip=which==='start'?np[0]:np[np.length-1]; const dd=Math.hypot(tip.x-oldTip.x,tip.y-oldTip.y); if(dd<extDist){extDist=dd;ext=np;} } }
  if(!ext){ setMsg('Extend: no vector ahead of that endpoint to reach'); return; }
  pushHistory(); best.pts=ext; best.prim={kind:'poly'}; sel=new Set([best.id]); render(); syncPanels(); setMsg('Extended to intersection'); }
function opCheckVectors(){
  const shapes=doc.shapes.filter(s=>layerVisible(s.layer));
  const res=CADCORE.validateShapes(shapes);
  const bad=[...new Set([...res.open,...res.duplicate,...res.selfIntersect])];
  if(!bad.length){ setMsg('Vectors OK — no open, duplicate, or self-intersecting contours.'); return; }
  sel=new Set(bad); render(); syncPanels();
  setMsg('Check vectors: '+res.open.length+' open · '+res.duplicate.length+' duplicate · '+res.selfIntersect.length+' self-intersect — '+bad.length+' selected.'); }
// Load a saved params object back into the CAM panel inputs (inverse of camParams; used by Edit).
function applyParamsToPanel(p){ if(!p)return; const g=id=>document.getElementById(id); const set=(id,v)=>{const el=g(id); if(el&&v!=null)el.value=v;}; const chk=(id,v)=>{const el=g(id); if(el)el.checked=!!v;};
  set('camOp',p.op); set('camTool',p.toolNum); set('camDia',p.toolDia); set('camSide',p.side); set('camDir',p.climb?'climb':'conv');
  set('camDepth',p.cutDepth); set('camPass',p.passDepth); set('camFeed',p.feed); set('camPlunge',p.plunge); set('camRpm',p.rpm); set('camTopZ',p.topZ);
  if(p.stepover!=null)set('camStep',Math.round(p.stepover*100)); set('camPocketStyle',p.pocketStyle); chk('camHelixEntry',p.rampEntry); set('camFinishDia',p.finishDia);
  set('camPeck',p.peck); set('camVAngle',p.bitAngle); set('camVStep',p.vstep); set('camVFlat',p.flatDepth); set('camVClearDia',p.clearDia);
  set('camLead',p.leadType); set('camLeadLen',p.leadLen); set('camRampLen',p.rampLen);
  if(p.tabs){ set('camTabN',p.tabs.count); set('camTabL',p.tabs.length); set('camTabH',p.tabs.height); }
  const op=g('camOp'); if(op)op.dispatchEvent(new Event('change',{bubbles:true})); }
function postJob(){ if(!opsQueue.length){ setMsg('Job queue empty — "Add op" first.'); return; }
  // tool-consistency: the same tool number must use the same diameter across the job (incl. vcarve clearance endmill)
  const byTool={}; const addTool=(t,d)=>{ (byTool[t]=byTool[t]||[]); if(byTool[t].indexOf(d)<0) byTool[t].push(d); };
  for(const q of opsQueue){ addTool(q.p.toolNum, q.p.toolDia); if(q.p.op==='vcarve'&&q.p.clearDia>0) addTool(q.p.clearNum, q.p.clearDia); }
  for(const t in byTool){ if(byTool[t].length>1){ setMsg('T'+t+' used with Ø'+byTool[t].join(' and Ø')+' — fix tool numbers'); return; } }
  const allOps=[], dpts=[]; let warns=[];
  for(const q of opsQueue){ const res=buildOpRes(q.p, contoursFromIds(q.ids));
    for(const op of res.ops){ if(op.passes.length) allOps.push(op); }   // vcarve flat-depth adds its endmill op too
    if(res.points)dpts.push(...res.points);
    if(res.warnings) warns=warns.concat(res.warnings); }
  if(!allOps.length){ setMsg('Job produced no cuttable passes.'); return; }
  const post=Object.assign({},CAM.POSTS[document.getElementById('camPost').value]); post.arcs=document.getElementById('camArcs').checked;
  const ordered=CAM.orderPasses({name:'job - '+allOps.length+' ops',units:'inch',ops:allOps});   // nearest-neighbor sort to cut rapids
  const g=CAM.postProcess(ordered,post);
  lastGcode=g; toolpaths=toolpathSegs(g); drillMarks=dpts.length?dpts:null; if(dpts.length)drillDia=0.25;
  render(); download('job.tap', g);
  const arcN=(g.match(/^G[23] /gm)||[]).length, tools=allOps.map(o=>'T'+o.toolNum).join('→');
  setMsg('Posted job: '+allOps.length+' ops ('+tools+'), '+arcN+' arc move(s) → job.tap'+(warns.length?' · WARN: '+warns[0]:'')); }

// ---- self-test: build a sample design and run every CAM op (studio-only smoke test of the pure core) ----
function runSelfTest(){
  pushHistory();
  doc.shapes=[]; sel.clear(); toolpaths=null; drillMarks=null;
  const rect=CADCORE.mkRect(6,5,12,8,activeLayer);
  const circ=CADCORE.mkCircle({x:21,y:9},1.5,activeLayer);
  const text=CADCORE.mkText(7.5,8,3,'AQ',activeLayer);   // single-stroke (no TTF loaded)
  addShapes([rect,circ,text]);
  const g=id=>document.getElementById(id);
  const setOp=v=>{ g('camOp').value=v; g('camOp').dispatchEvent(new Event('change',{bubbles:true})); };
  const results=[]; let okN=0;
  const run=(label,v,ids,cfg)=>{
    try{ sel=new Set(ids); setOp(v); if(cfg)cfg(g);
      const r=camBuild();
      const good=!!(r && r.passes>0 && r.g && r.g.length>0);
      if(good){ okN++; toolpaths=toolpathSegs(r.g); drillMarks=(r.op==='drill')?r.points:null; if(r.op==='drill')drillDia=parseFloat(g('camDia').value)||0.25; }
      results.push((good?'OK':'FAIL')+':'+label);
    }catch(e){ results.push('ERR:'+label+'('+e.message+')'); }
  };
  g('camDia').value='0.25';
  run('Profile','profile',[rect.id], gg=>{ gg('camSide').value='outside'; gg('camDir').value='climb'; gg('camDepth').value='0.5'; gg('camPass').value='0.25'; gg('camLead').value='arc'; gg('camLeadLen').value='0.25'; gg('camRampLen').value='0.15'; });
  run('Pocket','pocket',[rect.id], gg=>{ gg('camStep').value='40'; gg('camDepth').value='0.3'; });
  run('Drill','drill',[circ.id], gg=>{ gg('camDia').value='0.25'; gg('camPeck').value='0.1'; gg('camDepth').value='0.4'; });
  // single-stroke text has no closed regions to V-carve, so verify the V-carve op on the closed rectangle
  run('V-Carve','vcarve',[rect.id], gg=>{ gg('camVAngle').value='90'; gg('camVStep').value='0.05'; gg('camDepth').value='0.3'; });
  sel.clear(); fitJob(); syncPanels(); render();
  setMsg('Self-test: '+okN+'/'+results.length+' ops OK  ·  '+results.join('  '));
}

// ---- tool database (presets, persisted to localStorage) ----
const TOOLS_KEY='aq_tools';
let tools=[];
function loadTools(){ try{ const s=localStorage.getItem(TOOLS_KEY); tools=s?JSON.parse(s):CAM.defaultTools(); }catch(e){ tools=CAM.defaultTools(); }
  if(!Array.isArray(tools)||!tools.length) tools=CAM.defaultTools(); }
function persistTools(){ try{ localStorage.setItem(TOOLS_KEY, JSON.stringify(tools)); }catch(e){} }
function buildToolLib(sel){ const el=document.getElementById('camToolLib'); if(!el)return; el.innerHTML='';
  for(const t of tools){ const o=document.createElement('option'); o.value=t.id; o.textContent=t.name; el.appendChild(o); } if(sel)el.value=sel; }
function applyTool(id){ const t=tools.find(x=>x.id===id); if(!t)return; const g=k=>document.getElementById(k);
  if(t.op){ const op=g('camOp'); op.value=t.op; op.dispatchEvent(new Event('change',{bubbles:true})); }
  if(t.toolNum!=null)g('camTool').value=t.toolNum; if(t.dia!=null)g('camDia').value=t.dia;
  if(t.feed!=null)g('camFeed').value=t.feed; if(t.plunge!=null)g('camPlunge').value=t.plunge; if(t.rpm!=null)g('camRpm').value=t.rpm;
  if(t.angle!=null && g('camVAngle'))g('camVAngle').value=t.angle; setMsg('Loaded tool: '+t.name); }
function saveTool(){ const g=k=>document.getElementById(k); const name=prompt('Save tool preset as:', 'Tool '+(tools.length+1)); if(!name)return;
  const t={ id:CAM.slugId(name), name, op:g('camOp').value, toolNum:parseInt(g('camTool').value,10)||1, dia:parseFloat(g('camDia').value)||0.25,
    angle:parseFloat(g('camVAngle').value)||90, feed:parseFloat(g('camFeed').value)||120, plunge:parseFloat(g('camPlunge').value)||40, rpm:parseFloat(g('camRpm').value)||18000 };
  tools=CAM.upsertTool(tools,t); persistTools(); buildToolLib(t.id); setMsg('Saved tool: '+name); }
function delTool(){ const el=document.getElementById('camToolLib'); if(!el||!el.value)return; const t=tools.find(x=>x.id===el.value);
  if(t&&!confirm('Delete preset "'+t.name+'"?'))return; tools=CAM.removeTool(tools,el.value); if(!tools.length)tools=CAM.defaultTools(); persistTools(); buildToolLib(); setMsg('Deleted preset'); }

// ---- job / material ----
function jobRect(){ const {w,h,origin}=job; let x0=0,y0=0;
  if(origin==='br'){x0=-w;} else if(origin==='tl'){y0=-h;} else if(origin==='tr'){x0=-w;y0=-h;} else if(origin==='center'){x0=-w/2;y0=-h/2;}
  return {x0,y0,x1:x0+w,y1:y0+h}; }
function drawJob(){ if(!job.show)return; const r=jobRect(); const a=W2S({x:r.x0,y:r.y1}), b=W2S({x:r.x1,y:r.y0});
  const x=a.x, y=a.y, w=b.x-a.x, h=b.y-a.y;
  ctx.save();
  // drop shadow so the stock reads as a solid panel sitting above the grid
  ctx.shadowColor='rgba(0,0,0,0.55)'; ctx.shadowBlur=14; ctx.shadowOffsetX=3; ctx.shadowOffsetY=4;
  ctx.fillStyle='rgba(26,37,51,0.93)'; ctx.fillRect(x,y,w,h);   // material face — clearly lighter than the #0c0f14 canvas, faint grid bleeds through
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
  // bright bordered edge (outer dark keyline + inner bright line for definition)
  ctx.strokeStyle='rgba(0,0,0,0.6)'; ctx.lineWidth=3; ctx.strokeRect(x,y,w,h);
  ctx.strokeStyle='#6fb6ff'; ctx.lineWidth=1.5; ctx.strokeRect(x,y,w,h);
  // corner L-brackets
  ctx.strokeStyle='#aee0ff'; ctx.lineWidth=2; const c=Math.min(16,Math.abs(w)/3,Math.abs(h)/3);
  const corner=(cx,cy,sx,sy)=>{ ctx.beginPath(); ctx.moveTo(cx+sx*c,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+sy*c); ctx.stroke(); };
  corner(x,y,1,1); corner(x+w,y,-1,1); corner(x,y+h,1,-1); corner(x+w,y+h,-1,-1);
  // size caption pill inside the top-left corner of the stock
  const cap=job.w+'" × '+job.h+'"  ·  '+job.thickness+'" thick';
  ctx.font='bold 13px monospace'; const cw=ctx.measureText(cap).width; const ch=20;
  if(w>cw+26 && h>ch+10){ const px=x+9, py=y+9;
    ctx.fillStyle='rgba(18,42,68,0.95)'; ctx.fillRect(px,py,cw+16,ch);
    ctx.strokeStyle='#4f8fd0'; ctx.lineWidth=1; ctx.strokeRect(px+0.5,py+0.5,cw+15,ch-1);
    ctx.fillStyle='#dfeeff'; ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillText(cap,px+8,py+ch/2+1); }
  ctx.textBaseline='alphabetic';
  // origin marker (X0 Y0)
  const o=W2S({x:0,y:0}); ctx.fillStyle='#ff5a5a'; ctx.beginPath(); ctx.arc(o.x,o.y,4,0,TAU); ctx.fill();
  ctx.strokeStyle='#ff5a5a'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(o.x,o.y); ctx.lineTo(o.x+18,o.y); ctx.moveTo(o.x,o.y); ctx.lineTo(o.x,o.y-18); ctx.stroke();
  // edge dimension labels
  ctx.fillStyle='#9fc4ff'; ctx.font='bold 12px monospace'; ctx.textAlign='center';
  ctx.fillText(job.w+'"', x+w/2, b.y+15);
  ctx.save(); ctx.translate(a.x-10,(a.y+b.y)/2); ctx.rotate(-Math.PI/2); ctx.fillText(job.h+'"',0,0); ctx.restore();
  ctx.restore();
}
function setJob(){ const g=id=>document.getElementById(id);
  job.w=Math.abs(parseFloat(g('jobW').value)||24); job.h=Math.abs(parseFloat(g('jobH').value)||18);
  job.thickness=Math.abs(parseFloat(g('jobT').value)||0.5); job.origin=g('jobOrigin').value; job.show=g('jobShow').checked;
  const ct=g('camTopZ'); if(ct&&!parseFloat(ct.value)) ct.value='0';
  fitJob(); }
function fitJob(){ const r=jobRect(); const pad=Math.max(r.x1-r.x0,r.y1-r.y0)*0.12+0.5; const w=(r.x1-r.x0)+2*pad, h=(r.y1-r.y0)+2*pad;
  view.ppi=Math.min(cv.width/w, cv.height/h); view.ox=cv.width/2-((r.x0+r.x1)/2)*view.ppi; view.oy=cv.height/2+((r.y0+r.y1)/2)*view.ppi; render(); }
function drawMeasure(a,b,persist){ ctx.save(); ctx.strokeStyle=persist?'#7fd0ff':'#ffd27a'; ctx.lineWidth=1.3; if(!persist)ctx.setLineDash([5,3]);
  const p=W2S(a),q=W2S(b); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke();
  // end ticks
  ctx.setLineDash([]); [p,q].forEach(pt=>{ ctx.beginPath(); ctx.arc(pt.x,pt.y,3,0,TAU); ctx.stroke(); });
  const dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI;
  const mid={x:(p.x+q.x)/2,y:(p.y+q.y)/2};
  const label=dist.toFixed(3)+'"  ('+dx.toFixed(3)+' x '+dy.toFixed(3)+')  '+ang.toFixed(1)+String.fromCharCode(176);
  ctx.font='11px monospace'; const wlab=ctx.measureText(label).width;
  ctx.fillStyle='rgba(10,16,24,0.85)'; ctx.fillRect(mid.x+8, mid.y-20, wlab+10, 16);
  ctx.fillStyle=persist?'#aee0ff':'#ffe27a'; ctx.textAlign='left'; ctx.fillText(label, mid.x+13, mid.y-8);
  ctx.restore();
}

// ---- panels ----
function syncPanels(){ buildLayers(); buildProps(); }
const LYR_PALETTE=['#9fe7ff','#ffb27a','#a8f0a8','#f7a8e0','#ffe27a','#c8b6ff','#8fd6c6','#ff9a9a'];
function addLayer(name){ name=(name||'').trim(); if(!name){ name=prompt('New layer name:', 'Layer '+(doc.layers.size+1)); if(!name)return; name=name.trim(); }
  if(!name||doc.layers.has(name)){ if(name) setMsg('Layer "'+name+'" already exists'); return; }
  doc.layers.set(name,{visible:true,color:LYR_PALETTE[doc.layers.size%LYR_PALETTE.length]}); activeLayer=name; buildLayers(); scheduleAutosave(); setMsg('Added layer "'+name+'" (active)'); }
function renameLayer(old){ const nn=prompt('Rename layer "'+old+'" to:', old); if(!nn||nn.trim()===old)return; const name=nn.trim(); if(doc.layers.has(name)){ setMsg('Layer "'+name+'" already exists'); return; }
  pushHistory(); const info=doc.layers.get(old); const entries=[...doc.layers].map(([k,v])=>[k===old?name:k,v]); doc.layers=new Map(entries);
  doc.shapes.forEach(s=>{ if(s.layer===old) s.layer=name; }); if(activeLayer===old)activeLayer=name; render(); syncPanels(); }
function deleteLayer(name){ if(doc.layers.size<=1){ setMsg('Cannot delete the last layer'); return; }
  const n=doc.shapes.filter(s=>s.layer===name).length; const fallback=[...doc.layers.keys()].find(k=>k!==name);
  if(n && !confirm('Delete layer "'+name+'"? Its '+n+' shape(s) move to "'+fallback+'".')) return;
  pushHistory(); doc.shapes.forEach(s=>{ if(s.layer===name) s.layer=fallback; }); doc.layers.delete(name); if(activeLayer===name)activeLayer=fallback; render(); syncPanels(); }
function moveSelToLayer(name){ const sh=selectedShapes(); if(!sh.length)return; pushHistory(); sh.forEach(s=>{ s.layer=name; }); render(); syncPanels(); setMsg('Moved '+sh.length+' shape(s) to layer "'+name+'"'); }
function buildLayers(){ const el=document.getElementById('layerList'); if(!el)return; el.innerHTML='';
  const hasSel=sel.size>0;
  for(const [name,info] of doc.layers){ const row=document.createElement('div'); row.className='lyr'+(name===activeLayer?' act':'');
    const cnt=doc.shapes.filter(s=>s.layer===name).length;
    row.innerHTML='<input type="checkbox" title="Show / hide" '+(info.visible!==false?'checked':'')+'><input type="color" class="swc" title="Layer color" value="'+(info.color||'#9fe7ff')+'"><span class="ln" title="Click = make active · double-click = rename">'+name+'</span><span class="lc">'+cnt+'</span>'
      +(hasSel&&name!==activeLayer?'<button class="lb" title="Move selected shapes to this layer">→</button>':'')+'<button class="lb lx" title="Delete layer">×</button>';
    row.querySelector('input[type=checkbox]').onchange=e=>{info.visible=e.target.checked; render();};
    row.querySelector('.swc').oninput=e=>{info.color=e.target.value; render(); scheduleAutosave();};
    const ln=row.querySelector('.ln'); ln.onclick=()=>{activeLayer=name; buildLayers();}; ln.ondblclick=()=>renameLayer(name);
    const mv=row.querySelector('.lb:not(.lx)'); if(mv) mv.onclick=()=>moveSelToLayer(name);
    row.querySelector('.lx').onclick=()=>deleteLayer(name);
    el.appendChild(row); }
  const add=document.createElement('button'); add.className='tb'; add.textContent='+ Add layer'; add.title='Create a new layer and make it active'; add.onclick=()=>addLayer(); el.appendChild(add);
  const hint=document.createElement('div'); hint.className='muted'; hint.style.width='100%'; hint.textContent='New shapes go on the active (highlighted) layer.'; el.appendChild(hint); }
function buildProps(){ const el=document.getElementById('props'); if(!el)return; const sh=selectedShapes();
  if(!sh.length){ el.innerHTML='<div class="muted">No selection</div>'; return; }
  if(sh.length>1){ const b=CADCORE.bboxAll(sh); el.innerHTML='<div class="muted">'+sh.length+' selected</div><div class="prow">W '+(b.maxX-b.minX).toFixed(3)+'"  H '+(b.maxY-b.minY).toFixed(3)+'"</div>'; return; }
  const s=sh[0]; const b=CADCORE.bbox(s); let h='<div class="prow">type: '+(s.prim?s.prim.kind:s.type)+'</div>';
  h+='<div class="prow">X '+b.minX.toFixed(3)+'  Y '+b.minY.toFixed(3)+'</div>';
  h+='<div class="prow">W '+(b.maxX-b.minX).toFixed(3)+'"  H '+(b.maxY-b.minY).toFixed(3)+'"</div>';
  h+='<div class="prow">closed: '+(s.closed?'yes':'no')+(s.type==='text'?(' · "'+s.text+'"'):'')+' · layer: '+s.layer+'</div>';
  h+='<button class="tb" id="btnEditShape" data-tip="Edit exact dimensions (or double-click the shape)" style="margin-top:5px">Edit…</button>';
  el.innerHTML=h;
  const eb=document.getElementById('btnEditShape'); if(eb)eb.onclick=()=>openShapeModal(s); }

// ---- keyboard ----
window.addEventListener('keydown', e=>{
  if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
  if((e.ctrlKey||e.metaKey)&&(e.key==='s'||e.key==='S')){ e.preventDefault(); if(e.shiftKey) saveProjectAs(); else saveProject(); return; }
  if((e.ctrlKey||e.metaKey)&&(e.key==='o'||e.key==='O')){ e.preventDefault(); openProjectDialog(); return; }
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){ e.preventDefault(); undo(); return; }
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){ e.preventDefault(); redo(); return; }
  if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); deleteSelected(); return; }
  if(e.key==='Escape'){ hideCtxMenu(); hideMenus(); if(modalOrig){ closeShapeModal(); return; } if(rotBase){ closeRotateModal(); return; } closeJobModal(); draft=null; render(); return; }
  if(e.key==='Enter'&&CREATE_KINDS.has(tool)&&!draft&&!modalOrig){ e.preventDefault(); openCreateModal(tool); return; }
  if((e.ctrlKey||e.metaKey)&&e.key==='a'){ e.preventDefault(); sel=new Set(doc.shapes.filter(s=>layerVisible(s.layer)).map(s=>s.id)); render(); syncPanels(); return; }
  if(e.key==='Enter'&&tool==='polyline'&&draft){ commitPolyline(); return; }
  if(e.key==='Enter'&&tool==='bezier'&&draft){ commitBezier(false); return; }
  const map={v:'select',n:'node',l:'line',p:'polyline',b:'bezier',r:'rect',c:'circle',e:'ellipse',a:'arc',g:'polygon',t:'text',m:'measure'};
  if(map[e.key]){ setTool(map[e.key]); }
  if(e.key==='f'){ fitAll(); }
});

// ---- collapsible right-panel sections ----
function initCollapsibles(){
  const DEFAULT_COLLAPSED = { 'Nest':1, 'Align':1 };   // others (Layers included) open by default
  document.querySelectorAll('.right .sectn').forEach(sec=>{
    const h=sec.querySelector('h3'); if(!h||h.dataset.coll)return;
    const title=h.textContent.trim();
    h.dataset.coll='1';
    h.innerHTML='<span class="caret">▾</span><span class="htext"></span>';
    h.querySelector('.htext').textContent=title;
    const key='aqsrc_sect_'+title;
    const saved=localStorage.getItem(key);
    const collapsed = saved===null ? !!DEFAULT_COLLAPSED[title] : saved==='1';
    sec.classList.toggle('collapsed', collapsed);
    h.onclick=()=>{ const c=sec.classList.toggle('collapsed'); try{localStorage.setItem(key, c?'1':'0');}catch(e){} };
  });
}
// ---- collapsible left tool groups (VCarve-style) ----
function initToolGroups(){
  document.querySelectorAll('.tools .tgrp').forEach(g=>{
    const h=g.querySelector('.tgrp-h'); if(!h||h.dataset.wired)return; h.dataset.wired='1';
    const key='aqsrc_tgrp_'+(g.dataset.grp||'');
    if(localStorage.getItem(key)==='1') g.classList.add('collapsed');   // default expanded
    h.onclick=()=>{ const c=g.classList.toggle('collapsed'); try{localStorage.setItem(key, c?'1':'0');}catch(e){} };
  });
}

// ---- wire UI ----
function wire(){
  document.querySelectorAll('.tool').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
  document.querySelectorAll('.vtab').forEach(b=>b.onclick=()=>setView(b.dataset.view));
  initToolGroups();
  const simSolid=document.getElementById('simSolid'), simRes=document.getElementById('simRes');
  if(simSolid)simSolid.onchange=()=>{ if(viewMode==='preview') setView('preview'); };
  if(simRes)simRes.onchange=()=>{ if(viewMode==='preview'&&simSolid&&simSolid.checked) runSim(); };
  initCollapsibles();
  const on=(id,fn)=>{const el=document.getElementById(id); if(el)el.onclick=fn;};
  on('btnUndo',undo); on('btnRedo',redo); on('btnFit',fitAll); on('btnDelete',deleteSelected);
  on('btnSelfTest',runSelfTest);
  on('btnKeys',()=>{ document.getElementById('keysModal').style.display='block'; });
  on('keysClose',()=>{ document.getElementById('keysModal').style.display='none'; });
  document.getElementById('keysModal').addEventListener('mousedown',e=>{ if(e.target===document.getElementById('keysModal')) document.getElementById('keysModal').style.display='none'; });
  on('btnNest',opNest);
  // init nest W/H from job panel defaults
  const nw=document.getElementById('nestW'), nh=document.getElementById('nestH');
  if(nw)nw.value=job.w; if(nh)nh.value=job.h;
  on('btnOffset',opOffset); on('btnUnion',()=>opBool('union')); on('btnDiff',()=>opBool('diff')); on('btnInt',()=>opBool('intersect'));
  on('btnMirrorH',()=>opMirror('x')); on('btnMirrorV',()=>opMirror('y')); on('btnDup',opDuplicate); on('btnArray',opArray); on('btnRotate',openRotateModal); on('btnJoin',opJoin);
  on('btnCreateNum',()=>openCreateModal(tool));
  const rs=document.getElementById('rotSnap'); if(rs)rs.onchange=e=>{ grid.rotSnap=Math.max(0.1,parseFloat(e.target.value)||5); };
  // rotate dialog
  on('rotApply',applyRotateModal); on('rotCancel',closeRotateModal); on('rotX',closeRotateModal);
  ['rotAngle','rotDir'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.addEventListener('input',previewRotateModal); el.addEventListener('change',previewRotateModal); } });
  const ra=document.getElementById('rotAngle'); if(ra) ra.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); applyRotateModal(); } });
  document.querySelectorAll('#rotModal .rq').forEach(b=>{ b.onclick=()=>{ document.getElementById('rotAngle').value=b.dataset.deg; previewRotateModal(); }; });
  // job size & position dialog
  on('jobOk',()=>{ setJob(); closeJobModal(); }); on('jobCancel',closeJobModal); on('jobX',closeJobModal);
  // menus (File / Edit / View / Help)
  initMenus();
  on('btnCheckVec',opCheckVectors);
  on('restoreYes',()=>dismissRestore(true)); on('restoreNo',()=>dismissRestore(false));
  on('btnAlignL',()=>opAlign('left')); on('btnAlignR',()=>opAlign('right')); on('btnAlignT',()=>opAlign('top')); on('btnAlignB',()=>opAlign('bottom')); on('btnAlignHC',()=>opAlign('hcenter')); on('btnAlignVC',()=>opAlign('vcenter'));
  on('simTop',()=>setOrbit(0,90)); on('simIso',()=>setOrbit(-30,50)); on('simFront',()=>setOrbit(0,20));
  on('btnSaveProj',saveProject); on('btnSaveAs',saveProjectAs); on('btnExpDXF',exportDXF); on('btnExpSVG',exportSVG); setProjectName();
  on('btnFitJob',fitJob);
  const js=document.getElementById('jobShow'); if(js)js.onchange=e=>{job.show=e.target.checked; render();};
  // live job dimension updates (no view refit — use "Set job"/"Fit job" to re-zoom)
  const jobLive=()=>{ const g=id=>document.getElementById(id); job.w=Math.abs(parseFloat(g('jobW').value)||24); job.h=Math.abs(parseFloat(g('jobH').value)||18); job.thickness=Math.abs(parseFloat(g('jobT').value)||0.5); job.origin=g('jobOrigin').value; render(); };
  ['jobW','jobH','jobT','jobOrigin'].forEach(id=>{ const el=document.getElementById(id); if(el)el.addEventListener('input',jobLive); });
  on('btnCamGen',camGenerate); on('btnCamExport',camExport); on('btnCamClear',camClear);
  on('btnAddOp',addOp); on('btnRecalcAll',recalcAll); on('btnPostJob',postJob); buildQueueList();
  // CAM op selector toggles profile-only / pocket-only controls
  const camOp=document.getElementById('camOp');
  const syncCamOp=()=>{ const v=(camOp&&camOp.value)||'profile';
    const show=(sel,on)=>document.querySelectorAll(sel).forEach(el=>el.style.display=on?'':'none');
    show('.profile-only', v==='profile');
    show('.pocket-only', v==='pocket');
    show('.drill-only', v==='drill');
    show('.vcarve-only', v==='vcarve');
    show('.profile-pocket', v==='profile'||v==='pocket');
    show('.not-drill', v!=='drill'); };
  if(camOp){ camOp.onchange=syncCamOp; syncCamOp(); }
  // tool library
  loadTools(); buildToolLib();
  const tl=document.getElementById('camToolLib'); if(tl)tl.onchange=()=>applyTool(tl.value);
  on('btnToolSave',saveTool); on('btnToolDel',delTool);
  // shape properties modal
  on('modalApply',applyShapeModal); on('modalCancel',closeShapeModal); on('modalX',closeShapeModal);
  const mb=document.getElementById('shapeModal');
  const mf=document.getElementById('modalFields'); if(mf){ mf.addEventListener('input', previewShapeModal);   // live preview as you type
    mf.addEventListener('keydown', e=>{ if(e.key==='Enter'&&e.target.tagName==='INPUT'){ e.preventDefault(); applyShapeModal(); } }); }
  if(mb){ mb.addEventListener('mousedown',e=>{ if(e.target===mb)closeShapeModal(); });
    mb.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();applyShapeModal();} else if(e.key==='Escape'){e.preventDefault();closeShapeModal();} });
    // drag the dialog by its header so it never hides the shape
    const card=mb.querySelector('.modal'), hdr=mb.querySelector('.modal-h'); let md=null;
    if(hdr&&card){ hdr.addEventListener('mousedown',e=>{ if(e.target.id==='modalX')return; const r=card.getBoundingClientRect(); md={dx:e.clientX-r.left,dy:e.clientY-r.top}; e.preventDefault(); });
      window.addEventListener('mousemove',e=>{ if(!md)return; card.style.left=Math.max(2,Math.min(window.innerWidth-60,e.clientX-md.dx))+'px'; card.style.top=Math.max(2,Math.min(window.innerHeight-30,e.clientY-md.dy))+'px'; });
      window.addEventListener('mouseup',()=>{ md=null; }); } }
  on('btnNew',()=>{ if(confirm('Clear design?')){ pushHistory(); doc.shapes=[]; sel.clear(); toolpaths=null; projectFile.handle=null; setProjectName('design.aqcam'); render(); syncPanels(); } });
  const fi=document.getElementById('fileInput'); document.getElementById('btnImport').onclick=openProjectDialog;
  fi.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const rd=new FileReader();
    if(/\.aqcam$/i.test(f.name)){ rd.onload=ev=>{ openProject(ev.target.result, f.name); projectFile.handle=null; setProjectName(f.name); }; rd.readAsText(f); }
    else if(/\.pdf$/i.test(f.name)){ rd.onload=ev=>importPDF(f.name,ev.target.result); rd.readAsArrayBuffer(f); }
    else { rd.onload=ev=>importText(f.name,ev.target.result); rd.readAsText(f); } fi.value=''; };
  const gs=document.getElementById('gridStep'); if(gs)gs.onchange=e=>{grid.step=parseFloat(e.target.value)||0.5; render();};
  const gg=document.getElementById('chkGrid'); if(gg)gg.onchange=e=>{grid.on=e.target.checked;render();};
  const sn=document.getElementById('chkSnap'); if(sn)sn.onchange=e=>{grid.snap=e.target.checked;};
  const os=document.getElementById('chkObjSnap'); if(os)os.onchange=e=>{grid.objSnap=e.target.checked;};
  // TTF outline text controls
  const to=document.getElementById('txtOutline'); if(to)to.onchange=e=>{textOutline=e.target.checked;};
  const ff=document.getElementById('fontInput'); const lf=document.getElementById('btnLoadFont');
  if(lf&&ff){ lf.onclick=()=>ff.click(); ff.onchange=e=>{ const f=e.target.files[0]; if(f)loadFontFile(f); ff.value=''; }; }
  // drag-drop
  document.body.addEventListener('dragover',e=>e.preventDefault());
  document.body.addEventListener('drop',e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(!f)return;
    if(/\.(ttf|otf|woff)$/i.test(f.name)){ loadFontFile(f); return; }
    const rd=new FileReader();
    if(/\.aqcam$/i.test(f.name)){ rd.onload=ev=>openProject(ev.target.result, f.name); rd.readAsText(f); }
    else if(/\.pdf$/i.test(f.name)){ rd.onload=ev=>importPDF(f.name,ev.target.result); rd.readAsArrayBuffer(f); }
    else { rd.onload=ev=>importText(f.name,ev.target.result); rd.readAsText(f); } });
  window.addEventListener('resize',resize);
  // autosave every 30s (backstop for the on-change debounce) + restore prompt on load
  setInterval(autosaveNow, 30000);
  offerRestore();
}
// Non-blocking restore prompt: show an in-canvas banner (never a native confirm that blocks page load).
function offerRestore(){
  let saved; try{ saved=localStorage.getItem(AUTOSAVE_KEY); }catch(e){ return; }
  if(!saved)return;
  let proj; try{ proj=CADCORE.projectFromJSON(saved); }catch(e){ return; }
  if(!(proj.shapes&&proj.shapes.length) && !(proj.opsQueue&&proj.opsQueue.length))return;   // nothing worth restoring
  pendingRestore=proj;
  const when=proj.meta&&proj.meta.savedAt?new Date(proj.meta.savedAt).toLocaleString():'a previous session';
  const bar=document.getElementById('restoreBar'), msg=document.getElementById('restoreMsg');
  if(!bar){ return; }
  if(msg)msg.textContent='Restore last session? ('+proj.shapes.length+' shapes, '+(proj.opsQueue?proj.opsQueue.length:0)+' toolpaths · '+when+')';
  bar.classList.add('show');
}
function dismissRestore(apply){
  const bar=document.getElementById('restoreBar'); if(bar)bar.classList.remove('show');
  if(apply&&pendingRestore) applyProject(pendingRestore,'autosave');
  pendingRestore=null;
}
// ---- menu bar (File / Edit / View / Help) ----
let menuOpen=null;
function hideMenus(){ if(menuOpen){ menuOpen.el.remove(); menuOpen.btn.classList.remove('open'); menuOpen=null; } }
function menuItems(name){
  const hasSel=sel.size>0;
  switch(name){
    case 'File': return [
      { label:'New', fn:()=>document.getElementById('btnNew').click() },
      { label:'Open / Import…', key:'Ctrl+O', fn:openProjectDialog }, { sep:true },
      { label:'Save', key:'Ctrl+S', fn:saveProject },
      { label:'Save As…', key:'Ctrl+Shift+S', fn:saveProjectAs }, { sep:true },
      { label:'Export DXF', fn:exportDXF, disabled:!doc.shapes.length }, { label:'Export SVG', fn:exportSVG, disabled:!doc.shapes.length } ];
    case 'Edit': return [
      { label:'Undo', key:'Ctrl+Z', fn:undo, disabled:!history.length }, { label:'Redo', key:'Ctrl+Y', fn:redo, disabled:!future.length }, { sep:true },
      { label:'Job Size and Position…', fn:openJobModal }, { sep:true },
      { label:'Select all', key:'Ctrl+A', fn:()=>{ sel=new Set(doc.shapes.filter(s=>layerVisible(s.layer)).map(s=>s.id)); render(); syncPanels(); }, disabled:!doc.shapes.length },
      { label:'Edit dimensions…', key:'dbl-click', fn:()=>openShapeModal(selectedShapes()[0]), disabled:sel.size!==1 },
      { label:'Rotate…', fn:openRotateModal, disabled:!hasSel },
      { label:'Duplicate', fn:opDuplicate, disabled:!hasSel }, { label:'Delete', key:'Del', fn:deleteSelected, disabled:!hasSel }, { sep:true },
      { label:'Create shape by numbers…', key:'Enter', fn:()=>openCreateModal(tool) } ];
    case 'View': return [
      { label:'Fit all', key:'F', fn:fitAll }, { label:'Fit job', fn:fitJob }, { sep:true },
      { label:'2D Design', fn:()=>setView('2d') }, { label:'Preview', fn:()=>setView('preview') } ];
    case 'Help': return [
      { label:'Keyboard shortcuts', fn:()=>{ document.getElementById('keysModal').style.display='block'; } },
      { label:'Self-test (CAM ops)', fn:runSelfTest }, { sep:true },
      { title:(document.getElementById('appVer')||{textContent:''}).textContent } ];
  }
  return []; }
function openMenu(btn){ hideMenus(); hideCtxMenu();
  const m=document.createElement('div'); m.className='ctxmenu menu';
  for(const it of menuItems(btn.dataset.menu)){
    if(it.sep){ const s=document.createElement('div'); s.className='sep'; m.appendChild(s); continue; }
    if(it.title!==undefined){ const t=document.createElement('div'); t.className='ttl'; t.textContent=it.title; m.appendChild(t); continue; }
    const d=document.createElement('div'); d.className='ci'+(it.disabled?' disabled':'');
    d.innerHTML='<span>'+it.label+'</span>'+(it.key?'<span class="k">'+it.key+'</span>':'');
    if(!it.disabled) d.onclick=()=>{ hideMenus(); it.fn(); };
    m.appendChild(d); }
  document.body.appendChild(m); const r=btn.getBoundingClientRect(); m.style.left=r.left+'px'; m.style.top=(r.bottom+2)+'px';
  btn.classList.add('open'); menuOpen={el:m,btn}; }
function initMenus(){ document.querySelectorAll('.menubtn').forEach(b=>{
    b.onclick=e=>{ e.stopPropagation(); if(menuOpen&&menuOpen.btn===b) hideMenus(); else openMenu(b); };
    b.onmouseenter=()=>{ if(menuOpen&&menuOpen.btn!==b) openMenu(b); }; });
  window.addEventListener('mousedown', e=>{ if(menuOpen && !menuOpen.el.contains(e.target) && !e.target.classList.contains('menubtn')) hideMenus(); }, true);
  window.addEventListener('blur', hideMenus); }
wire(); resize(); setTool('select'); syncPanels(); render();
window.AQ_STUDIO = { saveProjectAs, get projectFile(){return projectFile;}, get orbit(){return orbit;}, setOrbit, get gl3d(){return GL3D;}, get simField(){return simField;}, doc, get sel(){return sel;}, get view(){return viewMode;}, CADCORE, CAM, importText, importPDF, openProject, saveProject, projectJSON, setView, camBuild, setTool, addShapes, render,
  openCreateModal, openShapeModal, applyShapeModal, closeShapeModal, setModalAnchor, get anchor(){return modalAnchor;}, openRotateModal, applyRotateModal, openJobModal, addLayer, moveSelToLayer, get grid(){return grid;}, selectedShapes };
