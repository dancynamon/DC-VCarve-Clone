/* ===================== Aquamentor CAD/CAM Studio app ===================== */
'use strict';
const TAU = Math.PI*2;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const overlay = document.getElementById('hud');

// ---- document & state ----
let doc = { shapes: [], layers: new Map([['0',{visible:true,color:'#1b2b3f'}]]) };
let activeLayer = '0';
let sel = new Set();
let tool = 'select';
let view = { ppi: 18, ox: 80, oy: 0 };   // oy set on resize
let grid = { on:true, step:0.5, snap:true, objSnap:true, ortho:false };
let history = [], future = [];
let toolpaths = null;     // generated g-code segments overlay
let drillMarks = null;    // drill hole centers overlay [{x,y}]
let drillDia = 0.25;      // tool dia for drill marker size
let lastGcode = '';
let msg = '';
let job = { w:48.5, h:97, thickness:1.5, origin:'bl', show:true };   // Dan's standard sheet
let measure = null;   // persisted measurement {a,b}
let viewMode = '2d';  // '2d' design canvas | 'preview' machining backplot (VCarve-style view tabs)
let simField = null;  // {canvas, x0,y0,x1,y1} — shaded material-removal heightfield for Preview
let pendingRestore = null;   // parsed autosave awaiting the non-blocking Restore banner
function fmtTime(s){ s=Math.round(s||0); if(s<=0)return '—'; if(s<60)return s+'s'; const m=Math.floor(s/60); return m+':'+String(s%60).padStart(2,'0'); }
let ttFont = null;        // loaded opentype.js font (for TTF outline text)
let textOutline = false;  // text tool mode: true=TTF outline contours, false=single-stroke

// ---- transforms ----
// ---- canvas theme ----------------------------------------------------------
// 2D View: a near-white ground with dark ink, like Aspire's drawing view.
// 3D View: the lavender gradient + blue material sampled straight out of Dan's
// Aspire screenshots (docs/vcarve-reference) — bg #babbf4 -> #e0e0f8, stock #3843f5.
const INK={ ink:'#1b2b3f', sel:'#e8590c', annot:'#0f7a46',
  node:'#b86a12', nodeSmooth:'#0f9d58', handle:'#2b7fd0',
  snap:'#b06a00', draft:'#b06a00', marquee:'rgba(232,89,12,0.85)',
  measure:'#2b7fd0', measureBg:'rgba(255,255,255,0.92)', measureInk:'#1b2b3f',
  drill:'#0f7a46', cut:'#0f7a46', rapid:'rgba(110,110,110,0.55)',
  legendBd:'rgba(20,40,70,0.22)', legendInk:'#33414f', legendSub:'#5c6a7c',
  origin:'#d63a3a', dimLbl:'#3a5f8f', simBd:'rgba(30,45,70,0.4)' };
const THEMES={
  '2d': Object.assign({}, INK, { bg:'#fbfbfd', gradTop:null,
    grid:'rgba(30,45,70,0.08)', axis:'rgba(60,90,200,0.28)',
    jobFace:'rgba(255,255,255,0.96)', jobShadow:'rgba(30,45,70,0.28)',
    jobEdge:'#5c7ea8', jobKey:'rgba(30,45,70,0.35)', jobCorner:'#3f6fa0',
    labelBg:'rgba(244,248,252,0.96)', labelBd:'#8fb0d4', labelInk:'#22384f' }),
  preview: Object.assign({}, INK, { bg:'#c9cbf4', gradTop:'#babbf4', gradBot:'#e0e0f8',
    stockTop:[56,67,245], stockDeep:[14,18,104],   // measured Aspire material blue, darkened with depth
    grid:'rgba(30,45,70,0.06)', axis:'rgba(60,90,200,0.22)',
    jobFace:'rgba(56,67,245,0.92)', jobShadow:'rgba(30,40,90,0.35)',
    jobEdge:'#2732c8', jobKey:'rgba(20,28,90,0.45)', jobCorner:'#8f97ff',
    labelBg:'rgba(238,240,255,0.96)', labelBd:'#8b93e0', labelInk:'#1e2350' })
};
function TH(){ return viewMode==='preview' ? THEMES.preview : THEMES['2d']; }
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
function resize(){ const r=cv.parentElement.getBoundingClientRect(); cv.width=r.width; cv.height=r.height;
  if(gl3d){ gl3d.resize(); gl3d.draw(); } if(!view._init){ view.oy=cv.height-60; view._init=true; } render(); }
function render(){
  const pv = viewMode==='preview';
  ctx.clearRect(0,0,cv.width,cv.height);
  const th=TH();
  if(th.gradTop){ const g=ctx.createLinearGradient(0,0,0,cv.height); g.addColorStop(0,th.gradTop); g.addColorStop(1,th.gradBot); ctx.fillStyle=g; }
  else ctx.fillStyle=th.bg;
  ctx.fillRect(0,0,cv.width,cv.height);
  if(pv && simField){ drawSimField(); updateHud(); return; }   // solid material-removal view
  if(!pv) drawGrid();          // Preview: clean material, no grid
  drawJob();
  if(bgImage) drawBgImage();   // reference bitmap over the stock panel, under the vectors
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
    if(tracePreview) drawTracePreview();
    if(measure) drawMeasure(measure.a, measure.b, true);
    if(snapMark) drawSnapMark(snapMark);
  }
  updateHud();
}
function drawGrid(){
  const w0=S2W({x:0,y:cv.height}), w1=S2W({x:cv.width,y:0});
  let step=grid.step; const px=step*view.ppi; while(step*view.ppi<8) step*=2; 
  ctx.lineWidth=1;
  ctx.strokeStyle=TH().grid;
  ctx.beginPath();
  for(let x=Math.floor(w0.x/step)*step; x<=w1.x; x+=step){ const sx=W2S({x,y:0}).x; ctx.moveTo(sx,0); ctx.lineTo(sx,cv.height); }
  for(let y=Math.floor(w0.y/step)*step; y<=w1.y; y+=step){ const sy=W2S({x:0,y}).y; ctx.moveTo(0,sy); ctx.lineTo(cv.width,sy); }
  ctx.stroke();
  // axes
  ctx.strokeStyle=TH().axis; ctx.beginPath();
  const o=W2S({x:0,y:0}); ctx.moveTo(o.x,0);ctx.lineTo(o.x,cv.height); ctx.moveTo(0,o.y);ctx.lineTo(cv.width,o.y); ctx.stroke();
}
function drawBgImage(){
  const a=W2S({x:bgImage.x,y:bgImage.y+bgImage.h}), b=W2S({x:bgImage.x+bgImage.w,y:bgImage.y});
  ctx.save(); ctx.globalAlpha=bgImage.alpha; ctx.imageSmoothingEnabled=true;
  ctx.drawImage(bgImage.canvas, a.x, a.y, b.x-a.x, b.y-a.y);
  ctx.restore();
}
function drawTracePreview(){
  ctx.save(); ctx.strokeStyle=TH().draft; ctx.lineWidth=1.4;
  for(const l of tracePreview){ ctx.beginPath(); l.pts.forEach((p,i)=>{const q=W2S(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);}); ctx.closePath(); ctx.stroke(); }
  ctx.restore();
}
function drawSimField(){
  const a=W2S({x:simField.x0,y:simField.y1}), b=W2S({x:simField.x1,y:simField.y0});
  ctx.save(); ctx.imageSmoothingEnabled=true;
  ctx.drawImage(simField.canvas, a.x, a.y, b.x-a.x, b.y-a.y);
  ctx.strokeStyle=TH().simBd; ctx.lineWidth=1; ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
  ctx.restore();
}
function drawShape(s, selected, dimmed){
  const isDim = s.type==='dim';   // annotation: own colour, solid arrowheads, never cut
  const th=TH();
  const col = selected ? th.sel : (isDim ? th.annot : (doc.layers.get(s.layer)?.color || th.ink));
  ctx.save();
  if(dimmed) ctx.globalAlpha=0.28;   // Preview: faint reference outline under the toolpaths
  ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineWidth=selected?2:(isDim?1.1:1.3);
  for(const loop of CADCORE.flatten(s)){
    ctx.beginPath();
    loop.pts.forEach((p,i)=>{ const q=W2S(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y); });
    if(isDim && loop.closed) ctx.fill(); else ctx.stroke();
  }
  ctx.restore();
}
function drawNodes(s){
  if(!s||s.type==='text')return;
  if(s.prim&&s.prim.kind==='bezier'){ return drawBezierNodes(s); }
  ctx.fillStyle=TH().node;
  for(const p of s.pts){ const q=W2S(p); ctx.fillRect(q.x-3,q.y-3,6,6); }
}
function drawBezierNodes(s){
  ctx.strokeStyle=TH().handle; ctx.lineWidth=1;
  for(const nd of s.prim.nodes){ const a=W2S(nd);
    [[nd.hx0,nd.hy0],[nd.hx1,nd.hy1]].forEach(h=>{ if(Math.hypot(h[0]-nd.x,h[1]-nd.y)>1e-6){ const hs=W2S({x:h[0],y:h[1]}); ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(hs.x,hs.y);ctx.stroke(); ctx.fillStyle=TH().handle; ctx.beginPath();ctx.arc(hs.x,hs.y,3.5,0,TAU);ctx.fill(); } });
  }
  for(const nd of s.prim.nodes){ const a=W2S(nd); ctx.fillStyle = nd.type==='smooth' ? TH().nodeSmooth : TH().node; ctx.fillRect(a.x-3.5,a.y-3.5,7,7); }
}
function bboxScreen(shapes){ const b=CADCORE.bboxAll(shapes); const a=W2S({x:b.minX,y:b.maxY}), c=W2S({x:b.maxX,y:b.minY}); return {x0:a.x,y0:a.y,x1:c.x,y1:c.y,b}; }
function rotateGripPts(bs){ const d=13; return [
  {x:bs.x0-d,y:bs.y0-d,k:'nw'},{x:bs.x1+d,y:bs.y0-d,k:'ne'},
  {x:bs.x0-d,y:bs.y1+d,k:'sw'},{x:bs.x1+d,y:bs.y1+d,k:'se'} ]; }
function drawSelectionHandles(){
  const bs=bboxScreen(selectedShapes()); ctx.strokeStyle=TH().sel; ctx.setLineDash([4,3]);
  ctx.strokeRect(bs.x0,bs.y0,bs.x1-bs.x0,bs.y1-bs.y0); ctx.setLineDash([]);
  ctx.fillStyle=TH().sel;
  handlePts(bs).forEach(h=>ctx.fillRect(h.x-4,h.y-4,8,8));
  // rotation grips just outside each corner — drag any to rotate about the center
  ctx.strokeStyle=TH().node; ctx.lineWidth=1.5;
  for(const g of rotateGripPts(bs)){ ctx.beginPath(); ctx.arc(g.x,g.y,5,Math.PI*0.35,Math.PI*1.85); ctx.stroke(); }
}
function handlePts(bs){ return [
  {x:bs.x0,y:bs.y0,k:'nw'},{x:bs.x1,y:bs.y0,k:'ne'},{x:bs.x0,y:bs.y1,k:'sw'},{x:bs.x1,y:bs.y1,k:'se'},
  {x:(bs.x0+bs.x1)/2,y:bs.y0,k:'n'},{x:(bs.x0+bs.x1)/2,y:bs.y1,k:'s'},{x:bs.x0,y:(bs.y0+bs.y1)/2,k:'w'},{x:bs.x1,y:(bs.y0+bs.y1)/2,k:'e'} ]; }
function depthColor(t){ t=Math.max(0,Math.min(1,t));   // t=1 shallow, t=0 deep
  const deep=[12,60,80], shallow=[64,190,130], c=i=>Math.round(deep[i]+(shallow[i]-deep[i])*t);
  return 'rgb('+c(0)+','+c(1)+','+c(2)+')'; }
function drawToolpaths(){
  // depth range across cut (non-rapid) segments
  let zTop=-Infinity, zBot=Infinity;
  for(const s of toolpaths){ if(s.rapid)continue; zTop=Math.max(zTop,s.z0,s.z1); zBot=Math.min(zBot,s.z0,s.z1); }
  const hasRange=isFinite(zTop)&&isFinite(zBot)&&(zTop-zBot)>1e-6;
  ctx.lineWidth=1;
  for(const seg of toolpaths){
    if(seg.rapid){ ctx.strokeStyle=TH().rapid; ctx.setLineDash([3,3]); }
    else { ctx.setLineDash([]); const zm=(seg.z0+seg.z1)/2; ctx.strokeStyle = hasRange ? depthColor((zm-zBot)/(zTop-zBot)) : TH().cut; }
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
  ctx.strokeStyle=TH().legendBd; ctx.lineWidth=1; ctx.strokeRect(x+0.5,y+0.5,w,h);
  ctx.fillStyle=TH().legendInk; ctx.font='10px monospace'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('Z '+zTop.toFixed(2)+'"', x+w+5, y+5);
  ctx.fillText(zBot.toFixed(2)+'"', x+w+5, y+h-5);
  ctx.textBaseline='alphabetic'; ctx.fillStyle=TH().legendSub; ctx.fillText('depth', x-1, y-6);
  ctx.restore();
}
function drawDrillMarks(){ const rpx=Math.max(3,drillDia/2*view.ppi); ctx.lineWidth=1.4; ctx.strokeStyle=TH().drill;
  for(const m of drillMarks){ const q=W2S(m); ctx.beginPath(); ctx.arc(q.x,q.y,rpx,0,TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(q.x-rpx-3,q.y); ctx.lineTo(q.x+rpx+3,q.y); ctx.moveTo(q.x,q.y-rpx-3); ctx.lineTo(q.x,q.y+rpx+3); ctx.stroke(); } }
function drawSnapMark(m){ const q=W2S(m); ctx.strokeStyle=TH().snap; ctx.lineWidth=1.2;
  if(m.kind==='center'){ ctx.beginPath();ctx.arc(q.x,q.y,5,0,TAU);ctx.stroke(); }
  else if(m.kind==='corner'){ ctx.beginPath();ctx.moveTo(q.x,q.y-6);ctx.lineTo(q.x+6,q.y);ctx.lineTo(q.x,q.y+6);ctx.lineTo(q.x-6,q.y);ctx.closePath();ctx.stroke(); }
  else { ctx.strokeRect(q.x-4,q.y-4,8,8); } }
let snapMark=null;

// ---- HUD / status ----
function updateHud(){ document.getElementById('zoomlbl').textContent = Math.round(view.ppi)+' px/in · '+doc.shapes.length+' obj · '+sel.size+' sel'; }
function setMsg(m){ msg=m; document.getElementById('msg').textContent=m; }
function updateCursor(scr){ const w=S2W(scr); document.getElementById('coords').textContent = w.x.toFixed(3)+', '+w.y.toFixed(3)+' in'; }

// ---- tools / interaction ----
let draft=null;        // in-progress geometry
let drag=null;         // active drag state
function setTool(t){ if(t!=='measure') measure=null; tool=t; sel=(t==='node')?sel:sel; draft=null; document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));
  const active=document.querySelector('.tool[data-tool="'+t+'"]'); if(active){ const grp=active.closest('.tgrp'); if(grp)grp.classList.remove('collapsed'); }   // keep the active tool visible
  const form=TOOL_FORMS[t];
  if(form) showForm(form,'drawing');            // the tool's options take over the dock
  else if(formOpen() && t!=='clipart' && t!=='select') setCmdTab(cmdTab);
  setMsg(TOOLMSG[t]||''); render(); }
const TOOLMSG={ select:'Click to select · drag to move · handles to scale/rotate · marquee to box-select',
  node:'Select one shape, drag its nodes · dbl-click segment adds node · dbl-click node deletes',
  line:'Click start, click end', polyline:'Click points · Enter/double-click to finish · Esc cancel',
  rect:'Click-drag opposite corners', circle:'Click center, drag radius', ellipse:'Click-drag bounding box',
  arc:'Click center, click start, click end', polygon:'Click center, drag radius (sides in panel)', star:'Click center, drag radius',
  text:'Click placement point, type in panel', measure:'Click two points', pan:'Drag to pan',
  clipart:'Clipart — drag a box on the canvas to place the selected shape (a single click drops it at 2")',
  dim:'Dimension — click the two measured points, then click to place the line (radius/Ø: centre then edge · angle: vertex, ray, ray, radius)',
  bezier:'Click anchors, drag to shape handles · Enter to finish · click start to close',
  fillet:'Click a corner to round it (set radius in "Fillet r")',
  trim:'Click the part of an open vector to cut back to where it crosses another',
  extend:'Click near an open vector endpoint to stretch it to the next vector ahead' };

// ---- VCarve-style command dock: tab strip + form-in-panel ----
// Picking a tool does not open a floating dialog; its options REPLACE the dock contents, with
// Close (and Calculate / OK where it applies) at the bottom. Everything lives in one place.
const TOOL_FORMS={rect:'rect',rrect:'rrect',circle:'circle',ellipse:'ellipse',polygon:'polygon',star:'star',text:'text',dim:'dim',fillet:'fillet'};
const CAM_TITLES={profile:'Profile Toolpath',pocket:'Pocket Toolpath',drill:'Drilling Toolpath',
  vcarve:'V-Carve / Engraving Toolpath',inlay:'Inlay Toolpath'};
const ORIGIN_LABEL={bl:'bottom-left',br:'bottom-right',tl:'top-left',tr:'top-right',center:'centre'};
let cmdTab='drawing';
// LEFT dock = Drawing / Clipart / Layers (tabs at the bottom, Aspire-style).
// RIGHT dock = Toolpaths: Material Setup + Toolpath Operations, swapped for a toolpath form,
// with the Toolpath List always visible underneath.
function setCmdTab(name){
  cmdTab=name;
  document.querySelectorAll('.dtab').forEach(b=>b.classList.toggle('active',b.dataset.ctab===name));
  document.querySelectorAll('#paneForm .tform').forEach(f=>f.classList.remove('active'));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.remove('active'));
  const pane=document.getElementById('pane'+name.charAt(0).toUpperCase()+name.slice(1));
  if(pane) pane.classList.add('active');
  const t=document.getElementById('ldockTitle'); if(t) t.textContent=name.charAt(0).toUpperCase()+name.slice(1);
}
function showForm(name, tab){
  document.querySelectorAll('#paneForm .tform').forEach(f=>f.classList.toggle('active',f.dataset.form===name));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.remove('active'));
  const host=document.getElementById('paneForm'); if(host) host.classList.add('active');
  if(tab) cmdTab=tab;
  const body=document.querySelector('.dockbody'); if(body) body.scrollTop=0;
}
function closeForm(){ setCmdTab(cmdTab); }
function formOpen(){ const h=document.getElementById('paneForm'); return !!(h&&h.classList.contains('active')); }
function showCamForm(){
  document.querySelectorAll('.rpane').forEach(p=>p.classList.remove('active'));
  const f=document.getElementById('paneCamForm'); if(f) f.classList.add('active');
  const tf=document.querySelector('#paneCamForm .tform'); if(tf) tf.classList.add('active');
  const rt=document.querySelector('.rtop'); if(rt) rt.scrollTop=0;
}
function closeCamForm(){
  document.querySelectorAll('.rpane').forEach(p=>p.classList.remove('active'));
  const o=document.getElementById('paneOps'); if(o) o.classList.add('active');
}
function openCamForm(op){
  const el=document.getElementById('camOp'); if(!el)return;
  el.value=op||'profile'; el.dispatchEvent(new Event('change',{bubbles:true}));
  const t=document.getElementById('camFormTitle'); if(t) t.textContent=CAM_TITLES[el.value]||'Toolpath';
  document.querySelectorAll('.opbtn').forEach(b=>b.classList.toggle('active',b.dataset.op===el.value));
  showCamForm();
}
function updateMatSummary(){
  const set=(id,txt)=>{const el=document.getElementById(id); if(el) el.textContent=txt;};
  set('matSummary', job.w.toFixed(2)+'" \u00d7 '+job.h.toFixed(2)+'"  \u00b7  Z0 top, '+job.thickness.toFixed(3)+'" thick');
  set('matDatum', 'XY Datum: '+(ORIGIN_LABEL[job.origin]||job.origin));
  set('jobDims', 'Job Dimensions\n  Width  (X): '+job.w.toFixed(3)+' inches\n  Height (Y): '+job.h.toFixed(3)+' inches\n  Depth  (Z): '+job.thickness.toFixed(3)+' inches');
}
// ---- menu bar ----
const MENU_ACTIONS={
  'new':()=>document.getElementById('btnNew').click(),
  'open':()=>document.getElementById('btnImport').click(),
  'save':()=>document.getElementById('btnSaveProj').click(),
  'expdxf':()=>exportDXF(), 'expsvg':()=>exportSVG(),
  'trace':()=>openTraceModal(),
  'undo':()=>undo(), 'redo':()=>redo(), 'dup':()=>opDuplicate(), 'del':()=>deleteSelected(),
  'check':()=>document.getElementById('btnCheckVec').click(),
  'recalc':()=>recalcAll(), 'post':()=>postJob(),
  'v2d':()=>setView('2d'), 'v3d':()=>setView('preview'),
  'fit':()=>fitAll(), 'fitjob':()=>fitJob(),
  'keys':()=>{document.getElementById('keysModal').style.display='block';},
  'selftest':()=>selfTest()
};
function closeMenus(){ document.querySelectorAll('.menu.open').forEach(m=>m.classList.remove('open')); }
function initMenuBar(){
  document.querySelectorAll('.menu').forEach(m=>{
    m.addEventListener('mousedown',e=>{
      if(e.target.closest('.mdrop')) return;
      e.stopPropagation(); const was=m.classList.contains('open'); closeMenus(); if(!was) m.classList.add('open');
    });
    m.addEventListener('mouseenter',()=>{ if(document.querySelector('.menu.open')){ closeMenus(); m.classList.add('open'); } });
  });
  document.querySelectorAll('.mdrop button').forEach(b=>{
    b.onmousedown=e=>e.stopPropagation();
    b.onclick=()=>{ closeMenus(); const a=b.dataset.act;
      if(a&&a.indexOf('op:')===0) return openCamForm(a.slice(3));
      const fn=MENU_ACTIONS[a]; if(fn) try{ fn(); }catch(err){ setMsg('Menu action failed: '+err.message); } };
  });
  window.addEventListener('mousedown',e=>{ if(!e.target.closest('.menu')) closeMenus(); });
}
// Create a shape straight from its form's numeric fields — Aspire lets you type it, not just drag it.
function createFromForm(kind){
  const n=(id,d)=>{const el=document.getElementById(id); const v=el?parseFloat(el.value):NaN; return isFinite(v)?v:d;};
  const K=kind.charAt(0).toUpperCase()+kind.slice(1);
  const x=n('f'+K+'X',6), y=n('f'+K+'Y',6);
  let sh=null;
  if(kind==='rect'){ const w=n('fRectW',4),h=n('fRectH',3); if(w>0&&h>0) sh=CADCORE.mkRect(x-w/2,y-h/2,w,h,activeLayer); }
  else if(kind==='rrect'){ const w=n('fRrectW',4),h=n('fRrectH',3),r=n('rrectR',0.25);
    if(w>0&&h>0) sh=CADCORE.mkRoundRect(x-w/2,y-h/2,w,h,Math.min(r,Math.min(w,h)/2),activeLayer); }
  else if(kind==='circle'){ const d=n('fCircleD',2); if(d>0) sh=CADCORE.mkCircle({x,y},d/2,activeLayer); }
  else if(kind==='ellipse'){ const w=n('fEllipseW',4),h=n('fEllipseH',2); if(w>0&&h>0) sh=CADCORE.mkEllipse({x,y},w/2,h/2,0,activeLayer); }
  else if(kind==='polygon'){ const d=n('fPolygonD',3),k=Math.max(3,Math.round(n('polyN',6))); if(d>0) sh=CADCORE.mkPolygon({x,y},d/2,k,undefined,activeLayer); }
  else if(kind==='star'){ const d=n('fStarD',3),k=Math.max(3,Math.round(n('fStarN',5))),ip=Math.min(95,Math.max(5,n('fStarInner',45)))/100;
    if(d>0) sh=CADCORE.mkStar({x,y},d/2,d/2*ip,k,undefined,activeLayer); }
  else if(kind==='text'){ const el=document.getElementById('txtVal');
    if(!el||!el.value.trim()) return setMsg('Type some text first');
    placeText({x:n('fTextX',2),y:n('fTextY',6)}); return; }
  if(!sh) return setMsg('Check the size values');
  pushHistory(); addShapes([sh]); sel=new Set([sh.id]); render(); syncPanels();
  setMsg('Created '+kind+' at '+x.toFixed(2)+', '+y.toFixed(2));
}
// ---- tool icon set ------------------------------------------------------------
// Hand-drawn 24x24 stroke glyphs on one weight, inheriting currentColor so they pick up the
// button's hover/active state. Each one shows what the tool DOES (profile = an offset path around a
// shape; pocket = concentric clearing rings; v-carve = a V groove section), rather than a letterform.
// Icons carry their own colour on the <svg>, so currentColor inside resolves to it and the
// button's active/hover background still reads underneath.
const ICON_COL={
  'new':'#2f7d32','open':'#2f7d32','save':'#2f7d32','tracebmp':'#7b52c9','expdxf':'#b06a00','expsvg':'#b06a00',
  fit:'#1d6fb8', fitjob:'#1d6fb8',
  line:'#1d6fb8',polyline:'#1d6fb8',bezier:'#1d6fb8',rect:'#1d6fb8',rrect:'#1d6fb8',circle:'#1d6fb8',
  ellipse:'#1d6fb8',arc:'#1d6fb8',polygon:'#1d6fb8',star:'#c9971d',text:'#1d6fb8',dim:'#0f8a8a',
  measure:'#0f8a8a',pan:'#4a6a8a',select:'#7b52c9',
  mirrorh:'#7b52c9',mirrorv:'#7b52c9',rot90:'#7b52c9',duplicate:'#7b52c9',array:'#7b52c9',nest:'#b8501d',
  node:'#0f8a8a',fillet:'#0f8a8a',trim:'#c0392b',extend:'#0f8a8a',
  offset:'#b8501d',join:'#0f8a8a',weld:'#2f7d32',subtract:'#c0392b',intersect:'#1d6fb8',
  del:'#c0392b',validate:'#2f7d32',
  alignL:'#4a6a8a',alignHC:'#4a6a8a',alignR:'#4a6a8a',alignT:'#4a6a8a',alignVC:'#4a6a8a',alignB:'#4a6a8a',
  profile:'#b8501d',pocket:'#1d6fb8',drill:'#2f7d32',vcarve:'#7b52c9',inlay:'#b8901d'
};
// Accent hue per icon: elements marked stroke/fill="var(--a)" pick it up, so each glyph reads
// as two tones instead of one flat colour.
const ICON_ACC={
  'new':'#1d6fb8','open':'#c9971d','save':'#1d6fb8','tracebmp':'#1d6fb8','expdxf':'#2f7d32','expsvg':'#2f7d32',
  fit:'#c9971d', fitjob:'#c9971d',
  line:'#c9971d',polyline:'#c9971d',bezier:'#c9971d',rect:'#7b52c9',rrect:'#7b52c9',circle:'#7b52c9',
  ellipse:'#7b52c9',arc:'#c9971d',polygon:'#7b52c9',star:'#b8501d',text:'#c9971d',dim:'#c0392b',
  measure:'#c9971d',pan:'#1d6fb8',select:'#c9971d',
  mirrorh:'#1d6fb8',mirrorv:'#1d6fb8',rot90:'#c9971d',duplicate:'#1d6fb8',array:'#1d6fb8',nest:'#2f7d32',
  node:'#c9971d',fillet:'#c9971d',trim:'#4a6a8a',extend:'#c9971d',
  offset:'#1d6fb8',join:'#c9971d',weld:'#1d6fb8',subtract:'#c0392b',intersect:'#2f7d32',
  del:'#c0392b',validate:'#1d6fb8',
  alignL:'#1d6fb8',alignHC:'#1d6fb8',alignR:'#1d6fb8',alignT:'#1d6fb8',alignVC:'#1d6fb8',alignB:'#1d6fb8',
  profile:'#1d6fb8',pocket:'#c9971d',drill:'#c0392b',vcarve:'#c9971d',inlay:'#2f7d32'
};
const ICON_SVG=(inner,name,size)=>'<svg viewBox="0 0 24 24" width="'+(size||28)+'" height="'+(size||28)+'" fill="none" '+
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" '+
  'style="color:'+((ICON_COL[name])||'#33414f')+';--a:'+((ICON_ACC[name])||'#c9971d')+'" aria-hidden="true">'+inner+'</svg>';
const DOT=(x,y)=>'<circle cx="'+x+'" cy="'+y+'" r="1.7" fill="var(--a)" stroke="none"/>';
const ICONS={
  select:  '<path d="M6 3 L6 18 L10 14.2 L12.6 20 L15 19 L12.4 13.4 L17.5 13.4 Z" fill="currentColor" stroke="none"/>',
  node:    '<path d="M4 17 C 8 7, 15 7, 20 13"/><rect x="2.4" y="15.4" width="3.2" height="3.2" fill="currentColor" stroke="none"/><rect x="18.4" y="11.4" width="3.2" height="3.2" fill="currentColor" stroke="none"/><rect x="10.4" y="7.6" width="3.2" height="3.2" fill="none"/>',
  fillet:  '<path d="M4 20 V11 A7 7 0 0 1 11 4 H20"/><path d="M4 4 H11 M4 4 V11" stroke-dasharray="2 2" opacity=".5"/>',
  trim:    '<path d="M6.5 3.5 L16.8 16.2"/><path d="M17.5 3.5 L7.2 16.2"/><circle cx="5.6" cy="18.6" r="2.5" fill="var(--a)" fill-opacity=".32" stroke="var(--a)"/><circle cx="18.4" cy="18.6" r="2.5" fill="var(--a)" fill-opacity=".32" stroke="var(--a)"/>',
  extend:  '<path d="M3 12 H14"/><path d="M11 9 L14.5 12 L11 15"/><path d="M19 5 V19"/>',
  line:    '<path d="M5.5 18.5 L18.5 5.5"/>'+DOT(5.5,18.5)+DOT(18.5,5.5),
  polyline:'<path d="M4 18 L9 8.5 L14.5 14 L20 5.5"/>'+DOT(4,18)+DOT(20,5.5),
  bezier:  '<path d="M4 18 C 8 7, 16 7, 20 13"/><path d="M4 18 L8.5 11" opacity=".5"/><path d="M20 13 L15.5 8" opacity=".5"/>'+DOT(4,18)+DOT(20,13)+DOT(8.5,11)+DOT(15.5,8),
  rect:    '<rect x="3.5" y="6" width="17" height="12" fill="var(--a)" fill-opacity=".16"/>',
  rrect:   '<rect x="3.5" y="6" width="17" height="12" rx="3.5" fill="var(--a)" fill-opacity=".16"/>',
  circle:  '<circle cx="12" cy="12" r="8.2" fill="var(--a)" fill-opacity=".16"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6" fill="var(--a)" fill-opacity=".16"/>',
  arc:     '<path d="M3.5 17.5 A 9.5 9.5 0 0 1 20.5 17.5"/>'+DOT(3.5,17.5)+DOT(20.5,17.5),
  polygon: '<path d="M12 3.4 L20 8 L20 16 L12 20.6 L4 16 L4 8 Z" fill="var(--a)" fill-opacity=".16"/>',
  star:    '<path d="M12 3 L14.5 9.4 L21.3 9.8 L16 14 L17.8 20.6 L12 16.8 L6.2 20.6 L8 14 L2.7 9.8 L9.5 9.4 Z" fill="currentColor" fill-opacity=".3"/>',
  text:    '<path d="M4.5 6 H19.5"/><path d="M12 6 V19"/><path d="M9 19 H15"/>',
  dim:     '<path d="M5 5.5 V13.5 M19 5.5 V13.5"/><path d="M5 18 H19"/><path d="M8 15.6 L5 18 L8 20.4 Z" fill="currentColor"/><path d="M16 15.6 L19 18 L16 20.4 Z" fill="currentColor"/>',
  measure: '<rect x="2.6" y="9" width="18.8" height="6" rx="1"/><path d="M7 9 V12 M12 9 V13 M17 9 V12"/>',
  pan:     '<path d="M12 3.5 V20.5 M3.5 12 H20.5"/><path d="M12 3.5 L9.6 6.4 M12 3.5 L14.4 6.4 M12 20.5 L9.6 17.6 M12 20.5 L14.4 17.6 M3.5 12 L6.4 9.6 M3.5 12 L6.4 14.4 M20.5 12 L17.6 9.6 M20.5 12 L17.6 14.4"/>',
  // toolpath operations
  profile: '<rect x="7" y="8" width="10" height="8" rx="1" fill="currentColor" fill-opacity=".2"/><rect x="3.6" y="4.6" width="16.8" height="14.8" rx="2.6" stroke-dasharray="3 2.2" stroke="var(--a)"/>',
  pocket:  '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="1.4" fill="currentColor" fill-opacity=".16"/><rect x="6.3" y="8.3" width="11.4" height="7.4" rx="1" stroke="var(--a)"/><rect x="9.2" y="11.2" width="5.6" height="1.6" rx=".8" stroke="var(--a)"/>',
  drill:   '<circle cx="12" cy="12" r="7.6" fill="currentColor" fill-opacity=".14"/><circle cx="12" cy="12" r="2.8" fill="var(--a)" stroke="none"/><path d="M12 1.8 V5 M12 19 V22.2 M1.8 12 H5 M19 12 H22.2" stroke="var(--a)"/>',
  vcarve:  '<path d="M2.6 7 V17 H21.4 V7 Z" fill="currentColor" fill-opacity=".16"/><path d="M7.4 7 L12 15.6 L16.6 7 Z" fill="var(--a)" fill-opacity=".55" stroke="var(--a)"/>',
  inlay:   '<path d="M2.8 18.4 V9 H8 L11 13.4 L14 9 H19.2 V18.4 Z" fill="currentColor" fill-opacity=".18"/><path d="M8 5.6 L11 1.6 L14 5.6 Z" fill="var(--a)" fill-opacity=".6" stroke="var(--a)"/>',
  // ---- command buttons (File Operations / View / Transform / Edit / Align / Layout) ----
  'new':     '<path d="M6 3.2 H14 L18.6 8 V20.8 H6 Z" fill="currentColor" fill-opacity=".12"/><path d="M14 3.2 V8 H18.6" stroke="var(--a)"/><path d="M9 13.4 H15.6 M12.3 10.1 V16.7" stroke="var(--a)"/>',
  'open':    '<path d="M2.8 18.6 V6.4 H9.4 L11.4 8.8 H17.6 V11"/><path d="M2.8 18.6 L6.2 11 H21.6 L18.2 18.6 Z" fill="var(--a)" fill-opacity=".28" stroke="var(--a)"/>',
  'save':    '<path d="M4 4.4 H17.2 L20 7.2 V19.6 H4 Z" fill="currentColor" fill-opacity=".12"/><path d="M7.4 4.4 V10 H15.6 V4.4" stroke="var(--a)"/><rect x="7.4" y="13.4" width="8.2" height="6.2" fill="var(--a)" fill-opacity=".3" stroke="var(--a)"/>',
  'tracebmp':'<rect x="2.8" y="4.6" width="10.6" height="10.6" rx="1"/><path d="M5 12.6 L7.6 9.4 L9.6 11.6 L11.4 9.6" opacity=".65"/><path d="M9.6 20.4 C 13 20.4, 13.6 12.4, 21 12.4"/>'+DOT(9.6,20.4)+DOT(21,12.4),
  'expdxf':  '<path d="M5 3.4 H12.6 L16.6 7.4 V13"/><path d="M12.6 3.4 V7.4 H16.6"/><path d="M5 3.4 V16.6 H10"/><path d="M13.6 20.2 L17.4 16.4 L21.2 20.2 Z"/><path d="M13.6 20.2 H21.2" opacity=".6"/>',
  'expsvg':  '<path d="M5 3.4 H12.6 L16.6 7.4 V12"/><path d="M12.6 3.4 V7.4 H16.6"/><path d="M5 3.4 V16.6 H9.4"/><path d="M12 20.4 C 15 14.6, 18.6 20.4, 21.4 15"/>'+DOT(12,20.4)+DOT(21.4,15),
  'fit':     '<rect x="3.2" y="5.4" width="17.6" height="13.2" rx="1.4" stroke-dasharray="2.6 2"/><path d="M8.6 10 L11.4 12.8 M8.6 14 V10 H12.6"/><path d="M15.4 14 L12.6 11.2 M15.4 10 V14 H11.4"/>',
  'fitjob':  '<rect x="2.8" y="5" width="18.4" height="14" rx="1.4" stroke-dasharray="2.6 2"/><rect x="7.4" y="9" width="9.2" height="6" fill="currentColor" fill-opacity=".2"/>',
  'mirrorh': '<path d="M12 2.6 V21.4" stroke-dasharray="2.4 2.2"/><path d="M9.4 6.4 L2.8 12 L9.4 17.6 Z"/><path d="M14.6 6.4 L21.2 12 L14.6 17.6 Z" fill="var(--a)" fill-opacity=".4" stroke="var(--a)"/>',
  'mirrorv': '<path d="M2.6 12 H21.4" stroke-dasharray="2.4 2.2"/><path d="M6.4 9.4 L12 2.8 L17.6 9.4 Z"/><path d="M6.4 14.6 L12 21.2 L17.6 14.6 Z" fill="var(--a)" fill-opacity=".4" stroke="var(--a)"/>',
  'rot90':   '<path d="M12 4.2 A7.8 7.8 0 1 1 4.6 14.6"/><path d="M8.4 2.2 L12 4.2 L8.4 6.6"/><rect x="9" y="9" width="6" height="6" fill="currentColor" fill-opacity=".22"/>',
  'duplicate':'<rect x="3.2" y="7.4" width="11.6" height="11.6" rx="1"/><path d="M7.6 7.4 V4 H20.8 V17.2 H17.4" opacity=".7"/>',
  'array':   '<rect x="3" y="3" width="6.4" height="6.4" fill="currentColor" fill-opacity=".28"/><rect x="14.6" y="3" width="6.4" height="6.4" fill="var(--a)" fill-opacity=".28" stroke="var(--a)"/><rect x="3" y="14.6" width="6.4" height="6.4" fill="var(--a)" fill-opacity=".28" stroke="var(--a)"/><rect x="14.6" y="14.6" width="6.4" height="6.4" fill="currentColor" fill-opacity=".28"/>',
  'nest':    '<rect x="2.6" y="4" width="18.8" height="16" rx="1" stroke-dasharray="2.6 2"/><rect x="4.6" y="6" width="7.4" height="5.4" fill="currentColor" fill-opacity=".18"/><circle cx="17" cy="9.2" r="3.2" fill="currentColor" fill-opacity=".18"/><rect x="4.6" y="13.4" width="12" height="4.6" fill="currentColor" fill-opacity=".18"/>',
  'offset':  '<rect x="7.6" y="8.6" width="8.8" height="6.8" rx="1"/><rect x="3.6" y="4.6" width="16.8" height="14.8" rx="3" stroke-dasharray="3 2.2" opacity=".8"/>',
  'join':    '<path d="M3 17.4 C 6.4 17.4, 8.4 12, 11.6 12"/><path d="M21 17.4 C 17.6 17.4, 15.6 12, 12.4 12"/>'+DOT(12,12)+DOT(3,17.4)+DOT(21,17.4),
  'weld':    '<circle cx="9.4" cy="12" r="5.6" fill="currentColor" fill-opacity=".34"/><circle cx="14.6" cy="12" r="5.6" fill="var(--a)" fill-opacity=".34" stroke="var(--a)"/>',
  'subtract':'<circle cx="9.4" cy="12" r="5.6" fill="#1d6fb8" fill-opacity=".32" stroke="#1d6fb8"/><circle cx="14.6" cy="12" r="5.6" stroke-dasharray="2.4 2" stroke="var(--a)" fill="none"/>',
  'intersect':'<circle cx="9.5" cy="12" r="5.5"/><circle cx="14.5" cy="12" r="5.5" stroke="var(--a)"/><path d="M12 7.1 A5.5 5.5 0 0 0 12 16.9 A5.5 5.5 0 0 0 12 7.1 Z" fill="var(--a)" fill-opacity=".6" stroke="none"/>',
  'del':     '<path d="M4.4 6.6 H19.6"/><path d="M9.6 6.6 V4.2 H14.4 V6.6"/><path d="M6.4 6.6 L7.4 20.4 H16.6 L17.6 6.6" fill="currentColor" fill-opacity=".16"/><path d="M10.4 10 V17 M13.6 10 V17"/>',
  'validate':'<path d="M2.8 16.6 C 6.6 16.6, 8.2 7.4, 12 7.4 C 14.6 7.4, 15.8 11, 17 13" opacity=".9"/><circle cx="16.4" cy="15.6" r="4.6"/><path d="M14.4 15.6 L15.9 17.1 L18.6 13.9"/>',
  'alignL':  '<path d="M3.6 3.4 V20.6"/><rect x="6.6" y="6" width="13.4" height="4.4" fill="var(--a)" fill-opacity=".28"/><rect x="6.6" y="13.6" width="8.4" height="4.4" fill="currentColor" fill-opacity=".22"/>',
  'alignR':  '<path d="M20.4 3.4 V20.6"/><rect x="4" y="6" width="13.4" height="4.4" fill="var(--a)" fill-opacity=".28"/><rect x="9" y="13.6" width="8.4" height="4.4" fill="currentColor" fill-opacity=".22"/>',
  'alignHC': '<path d="M12 3.4 V20.6" stroke-dasharray="2.4 2"/><rect x="5.3" y="6" width="13.4" height="4.4" fill="var(--a)" fill-opacity=".28"/><rect x="7.8" y="13.6" width="8.4" height="4.4" fill="currentColor" fill-opacity=".22"/>',
  'alignT':  '<path d="M3.4 3.6 H20.6"/><rect x="6" y="6.6" width="4.4" height="13.4" fill="var(--a)" fill-opacity=".28"/><rect x="13.6" y="6.6" width="4.4" height="8.4" fill="currentColor" fill-opacity=".22"/>',
  'alignB':  '<path d="M3.4 20.4 H20.6"/><rect x="6" y="4" width="4.4" height="13.4" fill="var(--a)" fill-opacity=".28"/><rect x="13.6" y="9" width="4.4" height="8.4" fill="currentColor" fill-opacity=".22"/>',
  'alignVC': '<path d="M3.4 12 H20.6" stroke-dasharray="2.4 2"/><rect x="6" y="5.3" width="4.4" height="13.4" fill="var(--a)" fill-opacity=".28"/><rect x="13.6" y="7.8" width="4.4" height="8.4" fill="currentColor" fill-opacity=".22"/>',
};
// Left-dock command buttons become icon buttons too, the way Aspire lays them out.
// Their data-tip tooltips carry the naming, so nothing becomes unguessable.
const ICON_BTNS={ btnNew:'new', btnImport:'open', btnSaveProj:'save', btnTrace:'tracebmp',
  btnExpDXF:'expdxf', btnExpSVG:'expsvg', btnFit:'fit', btnFitJob:'fitjob',
  btnMirrorH:'mirrorh', btnMirrorV:'mirrorv', btnRot90:'rot90', btnDup:'duplicate',
  btnArray:'array', btnNestForm:'nest', btnOffset:'offset', btnJoin:'join', btnUnion:'weld',
  btnDiff:'subtract', btnInt:'intersect', btnDelete:'del', btnCheckVec:'validate',
  btnAlignL:'alignL', btnAlignHC:'alignHC', btnAlignR:'alignR',
  btnAlignT:'alignT', btnAlignVC:'alignVC', btnAlignB:'alignB' };
function paintIcons(){
  for(const id in ICON_BTNS){
    const b=document.getElementById(id), g=ICONS[ICON_BTNS[id]];
    if(!b||!g) continue;
    if(!b.dataset.tip && b.textContent.trim()) b.dataset.tip=b.textContent.trim();
    b.classList.add('iconbtn'); b.innerHTML=ICON_SVG(g, ICON_BTNS[id], 24);
  }
  document.querySelectorAll('.tool[data-tool]').forEach(b=>{
    const g=ICONS[b.dataset.tool]; if(g) b.innerHTML=ICON_SVG(g, b.dataset.tool);
  });
  document.querySelectorAll('.opbtn[data-op]').forEach(b=>{
    const g=ICONS[b.dataset.op]; if(g) b.innerHTML=ICON_SVG(g, b.dataset.op, 30);
  });
}
function initCmdDock(){
  paintIcons();
  const jd=document.getElementById('jobDims'); if(jd) jd.style.whiteSpace='pre';
  document.querySelectorAll('[data-create]').forEach(b=>b.onclick=()=>createFromForm(b.dataset.create));
  document.querySelectorAll('.dtab').forEach(b=>b.onclick=()=>setCmdTab(b.dataset.ctab));
  initMenuBar();
  document.querySelectorAll('[data-formclose]').forEach(b=>b.onclick=e=>{
    if(e.target.closest('#paneCamForm')) closeCamForm(); else closeForm(); });
  document.querySelectorAll('.opbtn').forEach(b=>b.onclick=()=>openCamForm(b.dataset.op));
  const jf=()=>showForm('job','drawing');
  const a=document.getElementById('btnJobForm'); if(a)a.onclick=jf;
  const b=document.getElementById('btnJobForm2'); if(b)b.onclick=jf;
  const n=document.getElementById('btnNestForm'); if(n)n.onclick=()=>showForm('nest','drawing');
  updateMatSummary();
}

function evScr(e){ const r=cv.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }

cv.addEventListener('mousedown', e=>{
  if(e.button===2) return;   // right-click handled by contextmenu
  const scr=evScr(e); const snap=snapWorld(scr); const w={x:snap.x,y:snap.y};
  if(e.button===1 || tool==='pan' || e.altKey){ drag={kind:'pan', sx:scr.x, sy:scr.y, ox:view.ox, oy:view.oy}; return; }
  if(viewMode==='preview') return;   // Preview is read-only (pan/zoom only)
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
  else if(tool==='dim'){ dimDown(w); }
  else if(tool==='clipart'){ if(!clipArmed){ setMsg('Pick a clipart shape in the CLIPART panel first'); } else { draft={kind:'clip',a:w,b:w}; drag={kind:'draw'}; } }
  else if(tool==='measure'){ if(!draft){ measure=null; draft={kind:'measure',a:w,b:w}; } else { measure={a:draft.a,b:w}; draft=null; } }
  render();
});
cv.addEventListener('mousemove', e=>{
  const scr=evScr(e);
  if(viewMode==='preview'){ updateCursor(scr); if(drag&&drag.kind==='pan'){ view.ox=drag.ox+(scr.x-drag.sx); view.oy=drag.oy+(scr.y-drag.sy); render(); } return; }
  updateCursor(scr); const snap=snapWorld(scr); snapMark = snap.kind?{x:snap.x,y:snap.y,kind:snap.kind}:null; const w={x:snap.x,y:snap.y};
  if(drag&&drag.kind==='pan'){ view.ox=drag.ox+(scr.x-drag.sx); view.oy=drag.oy+(scr.y-drag.sy); render(); return; }
  if(drag&&drag.kind==='move'){ const dx=w.x-drag.last.x, dy=w.y-drag.last.y; drag.last=w;
    doc.shapes=doc.shapes.map(s=> sel.has(s.id)?CADCORE.translate(s,dx,dy):s); render(); return; }
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
  rect:[['x','X',0.05],['y','Y',0.05],['w','Width',0.05],['h','Height',0.05],['r','Corner radius',0.05],['rotDeg','Rotation°',1]],
  roundrect:[['x','X',0.05],['y','Y',0.05],['w','Width',0.05],['h','Height',0.05],['r','Corner radius',0.05],['rotDeg','Rotation°',1]],
  circle:[['cx','Center X',0.05],['cy','Center Y',0.05],['r','Radius',0.05],['rotDeg','Rotation°',1]],
  ellipse:[['cx','Center X',0.05],['cy','Center Y',0.05],['rx','Radius X',0.05],['ry','Radius Y',0.05],['rotDeg','Rotation°',1]],
  polygon:[['cx','Center X',0.05],['cy','Center Y',0.05],['r','Radius',0.05],['n','Sides',1],['rotDeg','Rotation°',1]],
  star:[['cx','Center X',0.05],['cy','Center Y',0.05],['rO','Outer radius',0.05],['rI','Inner radius',0.05],['n','Points',1],['rotDeg','Rotation°',1]],
  line:[['x1','Start X',0.05],['y1','Start Y',0.05],['x2','End X',0.05],['y2','End Y',0.05],['rotDeg','Rotation°',1]],
  arc:[['cx','Center X',0.05],['cy','Center Y',0.05],['r','Radius',0.05],['a0Deg','Start angle°',1],['a1Deg','End angle°',1]],
  text:[['text','Text','text'],['x','X',0.05],['y','Y (baseline)',0.05],['h','Height',0.05]],
  dim:[['style','Style',['aligned','horizontal','vertical','radius','diameter','angle']],
    ['x1','From X',0.05],['y1','From Y',0.05],['x2','To X',0.05],['y2','To Y',0.05],
    ['off','Offset / arc r',0.05],['textH','Text height',0.02],['prec','Decimals',1],
    ['unit','Units',['in','mm','none']],['label','Label override','text']],
  generic:[['x','X',0.05],['y','Y',0.05],['w','Width',0.05],['h','Height',0.05],['rotDeg','Rotation°',1]]
};
let modalShape=null, modalOrig=null;   // modalOrig = pristine clone (live-preview baseline / revert target)
function openShapeModal(shape){ if(!shape)return; modalShape=shape; modalOrig=CADCORE.clone(shape);
  let p=CADCORE.primParams(shape), kind;
  if(p){ kind=p.kind; } else { const b=CADCORE.bbox(shape); p={x:b.minX,y:b.minY,w:b.maxX-b.minX,h:b.maxY-b.minY}; kind='generic'; }
  const host=document.getElementById('modalFields'); host.innerHTML=''; host.dataset.kind=kind;
  document.getElementById('modalTitle').textContent='Edit '+(kind==='generic'?(shape.type==='text'?'text':'shape'):kind);
  for(const [key,label,step] of MODAL_SPECS[kind]){
    let val = key==='rotDeg'?(p.rot||0)*180/Math.PI : key==='a0Deg'?(p.a0||0)*180/Math.PI : key==='a1Deg'?(p.a1||0)*180/Math.PI : p[key];
    const row=document.createElement('label'); row.className='mfield';
    let inp;
    if(Array.isArray(step)) inp='<select data-k="'+key+'">'+step.map(o=>'<option value="'+o+'"'+(String(val)===o?' selected':'')+'>'+o+'</option>').join('')+'</select>';
    else if(step==='text') inp='<input type="text" data-k="'+key+'" value="'+String(val==null?'':val).replace(/"/g,'&quot;')+'">';
    else { const dp=(key==='rotDeg'||key==='a0Deg'||key==='a1Deg')?1:(key==='n'?0:3);   // angles 0.1°, counts integer, lengths/positions 0.001"
      const dv=(typeof val==='number'&&isFinite(val))?+val.toFixed(dp):0;
      inp='<input type="number" data-k="'+key+'" step="'+step+'" value="'+dv+'">'; }
    row.innerHTML='<span>'+label+'</span>'+inp; host.appendChild(row);
  }
  const card=document.querySelector('#shapeModal .modal'); if(card){ card.style.left='96px'; card.style.top='70px'; }
  document.getElementById('shapeModal').style.display='block';
  const f=host.querySelector('input'); if(f){ f.focus(); f.select&&f.select(); }
}
// rebuild the edited shape from the current field values (always from the pristine baseline, so previews don't drift)
function buildShapeFromFields(){ const host=document.getElementById('modalFields'); const kind=host.dataset.kind; const vals={};
  host.querySelectorAll('input').forEach(inp=>{ vals[inp.dataset.k]= inp.type==='number'?(parseFloat(inp.value)||0):inp.value; });
  host.querySelectorAll('select').forEach(sl=>{ vals[sl.dataset.k]=sl.value; });
  if(kind==='generic'){ let s=CADCORE.fitShapeTo(modalOrig, vals.x, vals.y, vals.w, vals.h);
    if(vals.rotDeg){ const b=CADCORE.bbox(s); s=CADCORE.rotate(s,(b.minX+b.maxX)/2,(b.minY+b.maxY)/2, vals.rotDeg*Math.PI/180); s.id=modalOrig.id; }
    return s; }
  const p=Object.assign({}, CADCORE.primParams(modalOrig)||{kind});
  for(const k in vals){ if(k==='rotDeg')p.rot=vals.rotDeg*Math.PI/180; else if(k==='a0Deg')p.a0=vals.a0Deg*Math.PI/180; else if(k==='a1Deg')p.a1=vals.a1Deg*Math.PI/180; else p[k]=vals[k]; }
  if(p.kind==='rect' && p.r>0) p.kind='roundrect';   // entering a corner radius makes it a rounded rect
  return CADCORE.applyPrimParams(modalOrig, p);
}
function previewShapeModal(){ if(!modalOrig)return; const ns=buildShapeFromFields();
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?ns:s); sel=new Set([modalOrig.id]); render(); }   // live, no history
function applyShapeModal(){ if(!modalOrig){ hideModal(); return; } const ns=buildShapeFromFields();
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?modalOrig:s); pushHistory();   // baseline = original, one undo step
  doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?ns:s); sel=new Set([modalOrig.id]);
  hideModal(); render(); syncPanels(); }
function closeShapeModal(){ if(modalOrig){ doc.shapes=doc.shapes.map(s=>s.id===modalOrig.id?modalOrig:s); } hideModal(); render(); syncPanels(); }   // revert preview
function hideModal(){ document.getElementById('shapeModal').style.display='none'; modalShape=null; modalOrig=null; }

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
  items.push({ sep:true }, { label:'Bring to front', fn:bringToFront }, { label:'Send to back', fn:sendToBack });
  showCtxMenu(e.clientX, e.clientY, items);
}
function hitHandle(scr){ if(!sel.size)return null; const bs=bboxScreen(selectedShapes());
  for(const g of rotateGripPts(bs)) if(Math.hypot(scr.x-g.x,scr.y-g.y)<9) return {type:'rotate'};
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
    pushHistory(); drag={kind:'move',last:w}; }
  else { if(!e.shiftKey) sel.clear(); drag={kind:'marquee',a:scr,b:scr}; }
  syncPanels();
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
  if(shift){ const step=15*Math.PI/180; d=Math.round(d/step)*step; }   // Shift = snap to 15° increments
  setMsg('Rotate '+(d*180/Math.PI).toFixed(shift?0:1)+'°'+(shift?' (15° snap)':'  ·  hold Shift = 15° steps'));
  // single parametric shape: rebuild via applyPrimParams (accumulate prim.rot) so it stays editable; else generic rotate
  if(base.length===1 && base[0].prim && ROT_PARAM_KINDS.has(base[0].prim.kind)){
    const o=base[0]; const p=CADCORE.primParams(o); p.rot=(p.rot||0)+d;   // base rotation + drag delta, about the prim's own center
    const ns=CADCORE.applyPrimParams(o, p);
    doc.shapes = doc.shapes.map(s=>s.id===o.id?ns:s);
  } else {
    doc.shapes = doc.shapes.map(s=>{ const o=base.find(x=>x.id===s.id); return o?CADCORE.rotate(o,c.x,c.y,d):s; });
  }
}
function drawMarquee(a,b){ ctx.strokeStyle=TH().marquee; ctx.setLineDash([4,3]); ctx.strokeRect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(b.x-a.x),Math.abs(b.y-a.y)); ctx.setLineDash([]); }
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
  else if(draft.kind==='dim'){ updateDimDraft(w, shift); }
  else if(draft.kind==='clip'){ draft.b=w; }
}

// ---- dimension annotations (B3) ----
function dimUiOpts(){
  const g=id=>document.getElementById(id);
  return { style:(g('dimStyle')&&g('dimStyle').value)||'aligned',
    textH:parseFloat(g('dimTextH')&&g('dimTextH').value)||0.18,
    prec:(g('dimPrec')&&g('dimPrec').value!=='')?parseInt(g('dimPrec').value):3,
    unit:(g('dimUnit')&&g('dimUnit').value)||'in' };
}
// How far past the measured points the cursor is, along the dimension's normal (signed).
function dimSignedOff(d,w){
  let u;
  if(d.style==='horizontal') u={x:1,y:0};
  else if(d.style==='vertical') u={x:0,y:1};
  else { const L=CADCORE.dist(d.a,d.b)||1; u={x:(d.b.x-d.a.x)/L,y:(d.b.y-d.a.y)/L}; }
  const n={x:-u.y,y:u.x};
  const ta=d.a.x*n.x+d.a.y*n.y, tb=d.b.x*n.x+d.b.y*n.y, tw=w.x*n.x+w.y*n.y;
  const hi=Math.max(ta,tb), lo=Math.min(ta,tb);
  return tw>=(hi+lo)/2 ? tw-hi : tw-lo;
}
function dimDown(w){
  const st=dimUiOpts().style;
  if(!draft || draft.kind!=='dim' || draft.style!==st){ draft={kind:'dim',style:st,a:{x:w.x,y:w.y},b:{x:w.x,y:w.y},c:null,off:0.5,stage:1};
    setMsg(st==='angle'?'Click the first ray':'Click the second point'); return; }
  const d=draft;
  if(st==='radius'||st==='diameter'){ d.b={x:w.x,y:w.y}; return commitDim(); }
  if(st==='angle'){
    if(d.stage===1){ d.b={x:w.x,y:w.y}; d.stage=2; setMsg('Click the second ray'); return; }
    if(d.stage===2){ d.c={x:w.x,y:w.y}; d.stage=3; setMsg('Click to set the arc radius'); return; }
    d.off=Math.max(0.02,CADCORE.dist(d.a,w)); return commitDim();
  }
  if(d.stage===1){ d.b={x:w.x,y:w.y}; d.stage=2; setMsg('Click to place the dimension line'); return; }
  d.off=dimSignedOff(d,w); return commitDim();
}
function updateDimDraft(w, shift){
  const d=draft;
  if(d.stage===1){ d.b=(d.style==='angle')?{x:w.x,y:w.y}:ortho(d.a,w,shift); }
  else if(d.stage===2){ if(d.style==='angle') d.c={x:w.x,y:w.y}; else d.off=dimSignedOff(d,w); }
  else if(d.stage===3){ d.off=Math.max(0.02,CADCORE.dist(d.a,w)); }
}
function dimDraftPrim(d){ return Object.assign({kind:'dim'}, dimUiOpts(), {a:d.a,b:d.b,c:d.c,off:d.off,style:d.style}); }
function drawDimDraft(d){
  ctx.setLineDash([]); ctx.strokeStyle=TH().draft; ctx.fillStyle=TH().draft; ctx.lineWidth=1.1;
  let loops=[]; try{ loops=CADCORE.dimensionGeometry(dimDraftPrim(d)).loops; }catch(err){ return; }
  for(const l of loops){ ctx.beginPath(); l.pts.forEach((p,i)=>{const q=W2S(p); i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});
    if(l.closed) ctx.fill(); else ctx.stroke(); }
}
function commitDim(){
  const d=draft; draft=null;
  if(!d||!d.a||!d.b){ render(); return; }
  const degenerate = (d.style==='angle') ? (!d.c) : CADCORE.dist(d.a,d.b)<1e-4;
  if(degenerate){ setMsg('Dimension too small — cancelled'); render(); return; }
  pushHistory();
  const s=CADCORE.mkDimension(d.a,d.b,Object.assign(dimUiOpts(),{off:d.off,c:d.c}),activeLayer);
  addShapes([s]); sel=new Set([s.id]);
  setMsg('Dimension: '+CADCORE.dimensionGeometry(s.prim).text+' (annotation — not machined)');
  render(); syncPanels();
}
function ortho(a,b,shift){ if(!shift&&!grid.ortho)return b; const dx=b.x-a.x,dy=b.y-a.y; if(Math.abs(dx)>Math.abs(dy))return {x:b.x,y:a.y}; return {x:a.x,y:b.y}; }
function drawDraft(){ ctx.strokeStyle=TH().draft; ctx.lineWidth=1.3; ctx.setLineDash([5,3]);
  const d=draft;
  if(d.kind==='line'){ line(d.a,d.b); }
  else if(d.kind==='rect'){ const a=d.a,b=d.b; poly([{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}],true); }
  else if(d.kind==='rrect'){ const a=d.a,b=d.b; const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y); const rr=Math.min(parseFloat(document.getElementById('rrectR').value)||0.25,Math.min(w,h)/2); poly(CADCORE.mkRoundRect(x,y,w,h,rr).pts,true); }
  else if(d.kind==='circle'){ circ(d.c,d.r); }
  else if(d.kind==='polygon'){ const s=CADCORE.mkPolygon(d.c,d.r||0.01,parseInt(document.getElementById('polyN').value)||5,d.rot); poly(s.pts,true); }
  else if(d.kind==='star'){ const sn=parseInt((document.getElementById('fStarN')||{}).value)||5, ip=Math.min(95,Math.max(5,parseFloat((document.getElementById('fStarInner')||{}).value)||45))/100; const s=CADCORE.mkStar(d.c,d.r||0.01,(d.r||0.01)*ip,sn,d.rot); poly(s.pts,true); }
  else if(d.kind==='ellipse'){ const a=d.a,b=d.b; const e=CADCORE.mkEllipse({x:(a.x+b.x)/2,y:(a.y+b.y)/2},Math.abs(b.x-a.x)/2,Math.abs(b.y-a.y)/2); poly(e.pts,true); }
  else if(d.kind==='polyline'){ poly(d.cur?d.pts.concat([d.cur]):d.pts,false); }
  else if(d.kind==='arc'){ if(d.p1&&d.cur){ const r=Math.hypot(d.p1.x-d.c.x,d.p1.y-d.c.y); const a0=Math.atan2(d.p1.y-d.c.y,d.p1.x-d.c.x), a1=Math.atan2(d.cur.y-d.c.y,d.cur.x-d.c.x); poly(CADCORE.arcPolyline(d.c.x,d.c.y,r,a0,a1,true),false);} else if(d.cur){ line(d.c,d.cur);} }
  else if(d.kind==='bezier'){ drawBezierDraft(d); }
  else if(d.kind==='measure'){ ctx.setLineDash([]); drawMeasure(d.a,d.b,false); }
  else if(d.kind==='dim'){ drawDimDraft(d); }
  else if(d.kind==='clip'){ drawClipDraft(d); }
  ctx.setLineDash([]);
}
function drawBezierDraft(d){
  let previewNodes=d.nodes;
  if(d.cur&&d.nodes.length){ previewNodes=d.nodes.concat([{x:d.cur.x,y:d.cur.y,hx0:d.cur.x,hy0:d.cur.y,hx1:d.cur.x,hy1:d.cur.y,type:'corner'}]); }
  if(previewNodes.length>=2){ poly(CADCORE.flattenBezier(previewNodes,false),false); }
  ctx.setLineDash([]);
  for(const nd of d.nodes){ const a=W2S(nd);
    ctx.strokeStyle=TH().handle;
    [[nd.hx0,nd.hy0],[nd.hx1,nd.hy1]].forEach(h=>{ if(Math.hypot(h[0]-nd.x,h[1]-nd.y)>1e-6){ const hs=W2S({x:h[0],y:h[1]}); ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(hs.x,hs.y);ctx.stroke(); ctx.fillStyle=TH().handle; ctx.beginPath();ctx.arc(hs.x,hs.y,3,0,TAU);ctx.fill(); } });
    ctx.fillStyle=TH().draft; ctx.fillRect(a.x-3,a.y-3,6,6);
  }
  ctx.strokeStyle=TH().draft; ctx.setLineDash([5,3]);
}
function commitBezier(closed){ if(draft&&draft.kind==='bezier'&&draft.nodes.length>=2){ pushHistory(); const s=CADCORE.mkBezier(draft.nodes,!!closed,activeLayer); addShapes([s]); sel=new Set([s.id]); } draft=null; render(); syncPanels(); }
function line(a,b){ const p=W2S(a),q=W2S(b); ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke(); }
function circ(c,r){ const o=W2S(c); ctx.beginPath();ctx.arc(o.x,o.y,r*view.ppi,0,TAU);ctx.stroke(); }
function poly(pts,closed){ ctx.beginPath(); pts.forEach((p,i)=>{const q=W2S(p);i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);}); if(closed)ctx.closePath(); ctx.stroke(); }
function commitDraft(){ const d=draft; if(!d)return; let s=null;
  if(d.kind==='clip'){ commitClip(d); draft=null; syncPanels(); return; }
  if(d.kind==='line'){ if(CADCORE.dist(d.a,d.b)>1e-4) s=CADCORE.mkLine(d.a,d.b,activeLayer); }
  else if(d.kind==='rect'){ const x=Math.min(d.a.x,d.b.x),y=Math.min(d.a.y,d.b.y),w=Math.abs(d.b.x-d.a.x),h=Math.abs(d.b.y-d.a.y); if(w>1e-4&&h>1e-4) s=CADCORE.mkRect(x,y,w,h,activeLayer); }
  else if(d.kind==='circle'){ if(d.r>1e-4) s=CADCORE.mkCircle(d.c,d.r,activeLayer); }
  else if(d.kind==='ellipse'){ const rx=Math.abs(d.b.x-d.a.x)/2,ry=Math.abs(d.b.y-d.a.y)/2; if(rx>1e-4&&ry>1e-4) s=CADCORE.mkEllipse({x:(d.a.x+d.b.x)/2,y:(d.a.y+d.b.y)/2},rx,ry,0,activeLayer); }
  else if(d.kind==='polygon'){ if(d.r>1e-4) s=CADCORE.mkPolygon(d.c,d.r,parseInt(document.getElementById('polyN').value)||5,d.rot,activeLayer); }
  else if(d.kind==='star'){ if(d.r>1e-4){ const sn=parseInt((document.getElementById('fStarN')||{}).value)||5, ip=Math.min(95,Math.max(5,parseFloat((document.getElementById('fStarInner')||{}).value)||45))/100; s=CADCORE.mkStar(d.c,d.r,d.r*ip,sn,d.rot,activeLayer); } }
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
// ---- 3D view (orbit / pan / zoom) ---------------------------------------------
// The heightfield becomes a real solid in WebGL: drag to orbit, shift- or right-drag to pan,
// wheel to zoom, double-click to reframe. Falls back to the flat top-down shading when the
// browser has no usable WebGL, so the 3D tab always shows something.
let gl3d = null, gl3dMesh = null, gl3dFail = false, gl3dSegs = [];
function hex3(h){ return [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255]; }
function gl3dInit(){
  if(gl3d || gl3dFail) return gl3d;
  const c=document.getElementById('gl'); if(!c){ gl3dFail=true; return null; }
  gl3d = (typeof GLVIEW!=='undefined') ? GLVIEW.createRenderer(c) : null;
  if(!gl3d){ gl3dFail=true; setMsg('3D view: WebGL unavailable — falling back to the flat preview'); return null; }
  const th=THEMES.preview;
  gl3d.setColors({ clear:hex3(th.gradBot), top:[th.stockTop[0]/255,th.stockTop[1]/255,th.stockTop[2]/255],
    deep:[th.stockDeep[0]/255,th.stockDeep[1]/255,th.stockDeep[2]/255] });
  bindGL3D(c);
  return gl3d;
}
function gl3dShow(on){
  const c=document.getElementById('gl'), h=document.getElementById('glHint');
  if(c) c.classList.toggle('on', !!on);
  if(h) h.classList.toggle('on', !!on);
}
function gl3dSetLines(segs){
  if(!gl3d) return;
  const show=document.getElementById('glLines');
  if(show && !show.checked){ gl3d.setLines(null); return; }
  const rapids=!!(document.getElementById('glRapids')||{}).checked;
  const lift=Math.max(0.003,(job.thickness||0.5)*0.008);
  gl3d.setLines(GLVIEW.buildToolpathLines(segs,{lift:lift,rapids:rapids,
    cutColor:[1,0.82,0.29], rapidColor:[0.66,0.70,0.80]}));
}
function gl3dSetField(field){
  if(!gl3dInit()) return false;
  // keep the mesh under ~1.2M verts; decimate rather than choke on a fine sim
  const step=Math.max(1, Math.ceil(Math.sqrt((field.nx*field.ny)/1200000)));
  gl3dMesh=GLVIEW.buildHeightMesh(field,{step});
  gl3d.setMesh(gl3dMesh, field.thickness);
  gl3d.frameAll(); gl3d.resize(); gl3d.draw();
  requestAnimationFrame(()=>{ if(gl3d){ gl3d.resize(); gl3d.draw(); } });   // after layout settles
  return true;
}
function bindGL3D(c){
  let drag=null;
  const stop=e=>{ e.preventDefault(); e.stopPropagation(); };
  c.addEventListener('contextmenu', e=>e.preventDefault());
  c.addEventListener('mousedown', e=>{
    stop(e); c.classList.add('drag');
    drag={ x:e.clientX, y:e.clientY, pan:(e.button===2||e.button===1||e.shiftKey) };
  });
  window.addEventListener('mousemove', e=>{
    if(!drag||!gl3d) return;
    const dx=e.clientX-drag.x, dy=e.clientY-drag.y; drag.x=e.clientX; drag.y=e.clientY;
    if(drag.pan){ const k=gl3d.cam.dist*0.00075; gl3d.pan(-dx*k, dy*k); }   // model follows the cursor
    else gl3d.orbit(dx*0.008, dy*0.008);
    gl3d.draw();
  });
  window.addEventListener('mouseup', ()=>{ drag=null; c.classList.remove('drag'); });
  c.addEventListener('wheel', e=>{ stop(e); if(!gl3d)return; gl3d.zoom(Math.exp(e.deltaY*0.0012)); gl3d.draw(); }, {passive:false});
  c.addEventListener('dblclick', e=>{ stop(e); if(!gl3d)return; gl3d.frameAll(); gl3d.draw(); });
}
function setView(mode){
  viewMode = (mode==='preview') ? 'preview' : '2d';
  document.querySelectorAll('.vtab').forEach(b=>b.classList.toggle('active', b.dataset.view===viewMode));
  const stage=document.querySelector('.stage'); if(stage)stage.classList.toggle('preview', viewMode==='preview');
  if(viewMode==='preview'){ const solid=document.getElementById('simSolid');
    if(solid&&solid.checked) runSim(); else { gl3dShow(false); simField=null; recalcAll(); } }
  else { gl3dShow(false); simField=null; render(); }
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
  const has3d=!!gl3dInit();
  gl3dShow(has3d);                      // must be visible before we size the viewport
  const solid3d=has3d && gl3dSetField(field);
  if(solid3d){ gl3dSegs=cuts.reduce((a,c)=>a.concat(c.segs||[]),[]); gl3dSetLines(gl3dSegs); gl3d.draw(); }
  if(!solid3d) gl3dShow(false);
  simField = solid3d ? null : shadeHeightfield(field, r);
  render();
  setMsg('3D sim: '+cuts.length+' toolpath(s) · '+field.nx+'×'+field.ny+' cells @ '+res+'"'
    + (solid3d ? ' · '+gl3dMesh.vertexCount.toLocaleString()+' verts — drag to orbit' : ''));
}
// Shade the heightfield into an offscreen canvas: wood-tone depth ramp + directional hillshade for a carved look.
function shadeHeightfield(field, r){
  const {nx,ny,z,res}=field; let maxD=1e-4; for(let i=0;i<z.length;i++){ const d=-z[i]; if(d>maxD)maxD=d; }
  const off=document.createElement('canvas'); off.width=nx; off.height=ny; const octx=off.getContext('2d');
  const img=octx.createImageData(nx,ny); const px=img.data;
  const L=[-0.5,-0.55,0.67]; const Ln=Math.hypot(L[0],L[1],L[2]); L[0]/=Ln;L[1]/=Ln;L[2]/=Ln;
  const th=THEMES.preview, TOPC=th.stockTop, DEEPC=th.stockDeep;
  // normalise the shade so an uncut flat top lands exactly on the stock colour
  const SFLAT=0.55+0.45*Math.max(0.35,Math.min(1.15,L[2]));
  const at=(i,j)=>z[Math.min(ny-1,Math.max(0,j))*nx+Math.min(nx-1,Math.max(0,i))];
  for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){ const h=z[j*nx+i]; const frac=Math.min(1,(-h)/maxD);
    // Aspire material blue: uncut surface = the measured stock colour, darkening with cut depth so
    // the carve still reads as depth rather than a flat slab.
    let R=TOPC[0]+(DEEPC[0]-TOPC[0])*frac, G=TOPC[1]+(DEEPC[1]-TOPC[1])*frac, B=TOPC[2]+(DEEPC[2]-TOPC[2])*frac;
    const gx=(at(i+1,j)-at(i-1,j))/(2*res), gy=(at(i,j+1)-at(i,j-1))/(2*res);
    let nz=1/Math.sqrt(gx*gx+gy*gy+1), nX=-gx*nz, nY=-gy*nz;
    let lam=nX*L[0]+nY*L[1]+nz*L[2]; lam=Math.max(0.35,Math.min(1.15,lam)); const s=(0.55+0.45*lam)/SFLAT;
    const o=((ny-1-j)*nx+i)*4;   // flip rows so image top = max Y
    px[o]=Math.max(0,Math.min(255,R*s)); px[o+1]=Math.max(0,Math.min(255,G*s)); px[o+2]=Math.max(0,Math.min(255,B*s)); px[o+3]=255; }
  octx.putImageData(img,0,0);
  return { canvas:off, x0:r.x0, y0:r.y0, x1:r.x1, y1:r.y1 };
}
function saveProject(){ download('design.aqcam', projectJSON(), 'application/json'); setMsg('Saved project · design.aqcam ('+doc.shapes.length+' shapes, '+opsQueue.length+' ops)'); }
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
    :(p.op==='inlay')?CAM.inlayOp(contours,Object.assign({},p,{step:p.vstep}))
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
    // inlay (C5): a matched cavity + plug pair from one design
    style:(g('camInlayStyle')&&g('camInlayStyle').value)||'pocket',
    part:(g('camInlayPart')&&g('camInlayPart').value)||'both',
    clearance:Math.abs(parseFloat(g('camInlayGap')&&g('camInlayGap').value)||0),
    clearanceOn:(g('camInlayGapOn')&&g('camInlayGapOn').value)||'female',
    pocketDepth:Math.abs(parseFloat(g('camInlayPocketD')&&g('camInlayPocketD').value)||0.125),
    maleDepth:Math.abs(parseFloat(g('camInlayMaleD')&&g('camInlayMaleD').value)||0.125),
    startDepth:Math.abs(parseFloat(g('camInlayStartD')&&g('camInlayStartD').value)||0),
    maleMargin:Math.abs(parseFloat(g('camInlayMargin')&&g('camInlayMargin').value)||0.25),
    mirrorMale:!(g('camInlayMirror')&&!g('camInlayMirror').checked),
    tabs:{count:tabsN,length:parseFloat(g('camTabL').value)||0.4,height:parseFloat(g('camTabH').value)||0.1} }; }
function camBuild(){ const contours=camContours(); const closedN=contours.filter(c=>c.closed).length; const p=camParams();
  const res=buildOpRes(p, contours);
  const post=Object.assign({},CAM.POSTS[document.getElementById('camPost').value]); post.arcs=(p.op!=='drill')&&document.getElementById('camArcs').checked;
  const label=p.op==='pocket'?'POCKET':p.op==='drill'?'DRILL':p.op==='vcarve'?'VCARVE'
    :p.op==='inlay'?('INLAY '+p.style.toUpperCase()+' '+p.part.toUpperCase()):p.side.toUpperCase();
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
function autoOpName(p){ p=p||{}; const op=p.op||'profile';
  if(op==='profile') return 'Profile '+String(p.side||'outside').replace(/^./,c=>c.toUpperCase());
  if(op==='inlay') return 'Inlay '+(p.style==='vcarve'?'V':'straight')+' · '+String(p.part||'both');
  return op.charAt(0).toUpperCase()+op.slice(1); }
function autoLabel(p,ids,match){ return autoOpName(p)+' · T'+p.toolNum+' Ø'+p.toolDia+'" · '+((ids&&ids.length)?ids.length+' sel':'all')+(match?' (lib)':''); }
function normalizeOp(q){ q=q||{}; return { p:q.p||{}, ids:Array.isArray(q.ids)?q.ids:[], name:q.name||q.label||autoOpName(q.p), label:q.label||'', visible:q.visible!==false }; }
function refreshAddBtn(){ const b=document.getElementById('btnAddOp'); if(b) b.textContent=(editingIdx!=null)?'✓ Update':'+ Toolpath'; }
function moveOp(i,dir){ const j=i+dir; if(j<0||j>=opsQueue.length)return; pushHistory(); const t=opsQueue[i]; opsQueue[i]=opsQueue[j]; opsQueue[j]=t;
  if(editingIdx===i)editingIdx=j; else if(editingIdx===j)editingIdx=i; buildQueueList(); }
function renameOp(i){ const q=opsQueue[i]; if(!q)return; const n=prompt('Toolpath name:', q.name||q.label||'Toolpath'); if(n==null)return; pushHistory(); q.name=n.trim()||q.name; buildQueueList(); }
function editOp(i){ const q=opsQueue[i]; if(!q)return; applyParamsToPanel(q.p); openCamForm(q.p&&q.p.op); sel=new Set(q.ids); editingIdx=i; buildQueueList(); render(); setMsg('Editing "'+(q.name||q.label)+'" — adjust settings, then click ✓ Update'); }
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
  set('camInlayStyle',p.style); set('camInlayPart',p.part); set('camInlayGap',p.clearance); set('camInlayGapOn',p.clearanceOn);
  set('camInlayPocketD',p.pocketDepth); set('camInlayMaleD',p.maleDepth); set('camInlayStartD',p.startDepth);
  set('camInlayMargin',p.maleMargin); if(p.op==='inlay')chk('camInlayMirror',p.mirrorMale);
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
  run('Inlay','inlay',[rect.id], gg=>{ gg('camInlayStyle').value='pocket'; gg('camInlayPart').value='both'; gg('camInlayGap').value='0.005'; gg('camInlayPocketD').value='0.12'; gg('camInlayMaleD').value='0.12'; gg('camPass').value='0.12'; });
  sel.clear(); fitJob(); syncPanels(); render();
  setMsg('Self-test: '+okN+'/'+results.length+' ops OK  ·  '+results.join('  '));
}

// ---- clipart / shape library (D2) ----
// Built-in art is generated procedurally by CLIPART; the user's own pieces are made from the current
// selection and persisted to localStorage. Entries are stored normalized to a unit box, so placing
// one is just a scale into whatever box you drag.
const CLIP_KEY='aq_clipart';
let clipLib=[], clipArmed=null;
function loadClipart(){
  let user=[];
  try{ const s=localStorage.getItem(CLIP_KEY); user=s?JSON.parse(s).map(CLIPART.normalizeClipart):[]; }catch(e){ user=[]; }
  clipLib=user.reduce((L,u)=>CLIPART.upsertClipart(L,Object.assign({},u,{builtin:false})), CLIPART.builtinClipart());
}
function persistClipart(){ try{ localStorage.setItem(CLIP_KEY, JSON.stringify(clipLib.filter(e=>!e.builtin))); }catch(e){} }
function clipThumbSVG(e,size){
  const loops=CLIPART.clipartThumbnail(e,size);
  const d=loops.map(l=>l.pts.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+','+(size-p.y).toFixed(1)).join(' ')+' Z').join(' ');
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" aria-hidden="true"><path d="'+d+'" fill="#3c4a5a" fill-rule="evenodd"/></svg>';
}
function buildClipCats(){
  const el=document.getElementById('clipCat'); if(!el)return;
  const cats=['All'].concat(CLIPART.clipartCategories(clipLib)); const cur=el.value;
  el.innerHTML=cats.map(c=>'<option value="'+_esc(c)+'">'+_esc(c)+'</option>').join('');
  if(cats.indexOf(cur)>=0) el.value=cur;
}
function buildClipGrid(){
  const host=document.getElementById('clipGrid'); if(!host)return;
  const catEl=document.getElementById('clipCat'); const cat=(catEl&&catEl.value)||'All';
  host.innerHTML='';
  for(const e of clipLib){
    if(cat!=='All'&&e.category!==cat) continue;
    const b=document.createElement('button');
    b.className='clipcell'+(clipArmed&&clipArmed.id===e.id?' armed':'');
    b.title=e.name+' · '+e.category+' — click, then drag a box on the canvas (a single click drops it at 2")';
    b.innerHTML=clipThumbSVG(e,40)+'<span>'+_esc(e.name)+'</span>';
    b.onclick=()=>armClip(e.id);
    host.appendChild(b);
  }
  if(!host.children.length) host.innerHTML='<div class="muted">No shapes in this category</div>';
}
function armClip(id){
  clipArmed=clipLib.find(e=>e.id===id)||null;
  if(clipArmed){ setTool('clipart'); setMsg('Place "'+clipArmed.name+'" — drag a box on the canvas, or click once for a 2" piece'); }
  buildClipGrid();
}
function drawClipDraft(d){
  if(!clipArmed)return;
  const box=clipBox(d); if(!box)return;
  ctx.setLineDash([]); ctx.strokeStyle=TH().draft; ctx.lineWidth=1.3;
  for(const l of CLIPART.placeClipart(clipArmed,box)) poly(l.pts,true);
  ctx.setLineDash([4,3]); ctx.strokeStyle=TH().snap;
  poly([{x:box.x,y:box.y},{x:box.x+box.w,y:box.y},{x:box.x+box.w,y:box.y+box.h},{x:box.x,y:box.y+box.h}],true);
  ctx.setLineDash([]);
}
function clipBox(d){
  const w=Math.abs(d.b.x-d.a.x), h=Math.abs(d.b.y-d.a.y);
  if(w<0.02||h<0.02){ const s=2; return {x:d.a.x, y:d.a.y, w:s, h:s/(clipArmed?clipArmed.aspect:1)}; }  // plain click = 2" default
  return {x:Math.min(d.a.x,d.b.x), y:Math.min(d.a.y,d.b.y), w:w, h:h};
}
function commitClip(d){
  if(!clipArmed)return;
  const box=clipBox(d); const loops=CLIPART.placeClipart(clipArmed,box);
  if(!loops.length){ setMsg('That clipart has no geometry'); return; }
  pushHistory();
  if(!doc.layers.has('clipart')) doc.layers.set('clipart',{visible:true,color:'#6b3fa0'});
  const shapes=loops.map(l=>CADCORE.mkPoly(l.pts,true,'clipart'));
  addShapes(shapes); sel=new Set(shapes.map(s=>s.id));
  setMsg('Placed "'+clipArmed.name+'" — '+shapes.length+' contour(s), '+box.w.toFixed(2)+'" wide');
}
function addSelectionToClipart(){
  const sh=selectedShapes().filter(s=>!s.annotation && s.type!=='dim');
  const loops=[]; for(const s of sh) for(const l of CADCORE.flatten(s)) if(l.closed&&l.pts.length>=3) loops.push({pts:l.pts,closed:true});
  if(!loops.length) return setMsg('Select one or more CLOSED vectors to add to the clipart library');
  const name=prompt('Clipart name:','My shape'); if(name==null)return;
  const cat=prompt('Category:','My shapes'); if(cat==null)return;
  const e=CLIPART.clipartFromLoops(name.trim()||'My shape', cat.trim()||'My shapes', loops);
  clipLib=CLIPART.upsertClipart(clipLib,e); persistClipart();
  buildClipCats(); const ce=document.getElementById('clipCat'); if(ce)ce.value=e.category;
  buildClipGrid(); setMsg('Added "'+e.name+'" to the clipart library ('+e.loops.length+' contour(s))');
}
function delClipart(){
  if(!clipArmed) return setMsg('Click a clipart shape first');
  if(clipArmed.builtin) return setMsg('"'+clipArmed.name+'" is built in and cannot be deleted');
  if(!confirm('Delete clipart "'+clipArmed.name+'"?'))return;
  const n=clipArmed.name; clipLib=CLIPART.removeClipart(clipLib,clipArmed.id); clipArmed=null;
  persistClipart(); buildClipCats(); buildClipGrid(); setMsg('Deleted clipart "'+n+'"');
}
function exportClipart(){
  const mine=clipLib.filter(e=>!e.builtin);
  if(!mine.length) return setMsg('No custom clipart to export — add a selection first');
  download('clipart.aqclip', CLIPART.libraryToJSON(mine), 'application/json');
  setMsg('Exported '+mine.length+' clipart shape(s)');
}
function importClipText(text){
  try{ const entries=CLIPART.libraryFromJSON(text);
    clipLib=entries.reduce((L,e)=>CLIPART.upsertClipart(L,Object.assign({},e,{builtin:false})), clipLib);
    persistClipart(); buildClipCats(); buildClipGrid();
    setMsg('Imported '+entries.length+' clipart shape(s)'); }
  catch(e){ setMsg('Clipart import failed: '+e.message); }
}

// ---- bitmap import + trace (D1) ----
// The browser decodes the file (that's the only DOM-bound part); everything after it — threshold,
// despeckle, boundary trace, simplify, smooth, scale — is BMPTRACE, so it is unit-tested headless.
let bgImage=null;      // {canvas, imgData, x, y, w, h, name, alpha} — the reference bitmap under the vectors
let tracePreview=null; // [{pts,closed}] live preview shapes while the Trace dialog is open

function importBitmap(name, file){
  const url=URL.createObjectURL(file), im=new Image();
  im.onload=()=>{
    URL.revokeObjectURL(url);
    const MAXPX=1400;   // cap the working raster: past this the trace is slow and no more accurate
    const k=Math.min(1, MAXPX/Math.max(im.naturalWidth,im.naturalHeight));
    const w=Math.max(1,Math.round(im.naturalWidth*k)), h=Math.max(1,Math.round(im.naturalHeight*k));
    const cn=document.createElement('canvas'); cn.width=w; cn.height=h;
    const cx=cn.getContext('2d'); cx.drawImage(im,0,0,w,h);
    let data; try{ data=cx.getImageData(0,0,w,h); }catch(e){ setMsg('Could not read image pixels: '+e.message); return; }
    // place it filling the job width (keeping aspect), bottom-left at the job origin
    const jw=job.w||24, inW=Math.min(jw, jw), inH=inW*h/w;
    bgImage={canvas:cn, imgData:{width:w,height:h,data:data.data}, x:0, y:0, w:inW, h:inH, name:name, alpha:0.55};
    fitJob(); openTraceModal();
    setMsg('Loaded '+name+' — '+w+'×'+h+'px. Set the trace options, then Trace.');
  };
  im.onerror=()=>{ URL.revokeObjectURL(url); setMsg('Could not decode image: '+name); };
  im.src=url;
}
function traceOpts(){ const g=id=>document.getElementById(id); const n=(id,d)=>{const el=g(id); const v=el?parseFloat(el.value):NaN; return isFinite(v)?v:d;};
  return { threshold:n('trThresh',128), invert:!!(g('trInvert')&&g('trInvert').checked),
    despeckle:n('trSpeck',2), tol:n('trTol',1), smooth:n('trSmooth',0.5),
    widthInches:n('trWidth',bgImage?bgImage.w:12), originX:bgImage?bgImage.x:0, originY:bgImage?bgImage.y:0 }; }
function runTracePreview(){
  if(!bgImage) return;
  let r; try{ r=BMPTRACE.traceImage(bgImage.imgData, traceOpts()); }
  catch(e){ document.getElementById('trStats').textContent='Trace failed: '+e.message; return; }
  lastTrace=r; tracePreview=r.loops;
  // keep the reference bitmap boxed to the traced size so preview and image line up
  bgImage.w=r.stats.widthInches; bgImage.h=r.stats.heightInches;
  document.getElementById('trStats').textContent=
    r.stats.loops+' contour(s) · '+r.stats.outer+' outer / '+r.stats.holes+' hole(s) · '+
    r.stats.pointsAfter+' pts (from '+r.stats.pointsBefore+') · '+
    r.stats.widthInches.toFixed(2)+'" × '+r.stats.heightInches.toFixed(2)+'"'+
    (r.stats.specksRemoved?' · '+r.stats.specksRemoved+' speck(s) dropped':'');
  render();
}
let lastTrace=null;
function openTraceModal(){
  if(!bgImage) return setMsg('Import a PNG/JPG first (Open / Import, or drag one in)');
  const wEl=document.getElementById('trWidth'); if(wEl && !wEl.dataset.set){ wEl.value=bgImage.w.toFixed(2); wEl.dataset.set='1'; }
  document.getElementById('traceModal').style.display='block';
  runTracePreview();
}
function closeTraceModal(){ document.getElementById('traceModal').style.display='none'; tracePreview=null; render(); }
function commitTrace(){
  if(!lastTrace||!lastTrace.loops.length){ setMsg('Nothing to trace — adjust the threshold'); return; }
  pushHistory();
  if(!doc.layers.has('trace')) doc.layers.set('trace',{visible:true,color:'#b06a00'});
  const shapes=lastTrace.loops.map(l=>CADCORE.mkPoly(l.pts,true,'trace'));
  addShapes(shapes); sel=new Set(shapes.map(s=>s.id));
  closeTraceModal();
  setMsg('Traced '+shapes.length+' contour(s) onto the "trace" layer — ready to pocket, profile or V-carve');
  syncPanels(); render();
}
function clearBgImage(){ bgImage=null; tracePreview=null; lastTrace=null; closeTraceModal(); render(); setMsg('Reference bitmap removed'); }

// ---- toolpath templates (C6): reusable machining recipes, persisted to localStorage ----
// A template holds only the toolpath *settings*, never the geometry — so the same recipe (V-carve the
// text, then profile it out with tabs) drops onto whatever vectors you have selected in this job.
const TPL_KEY='aq_templates';
let templates=[];
function loadTemplates(){ try{ const s=localStorage.getItem(TPL_KEY); templates=s?JSON.parse(s).map(CAM.normalizeTemplate):CAM.defaultTemplates(); }
  catch(e){ templates=CAM.defaultTemplates(); }
  if(!Array.isArray(templates)||!templates.length) templates=CAM.defaultTemplates(); }
function persistTemplates(){ try{ localStorage.setItem(TPL_KEY, JSON.stringify(templates)); }catch(e){} }
function buildTplLib(selId){ const el=document.getElementById('tplLib'); if(!el)return; el.innerHTML='';
  for(const t of templates){ const o=document.createElement('option'); o.value=t.id;
    o.textContent=t.name+' ('+t.entries.length+')'; el.appendChild(o); }
  if(selId)el.value=selId; }
function currentTpl(){ const el=document.getElementById('tplLib'); return el?templates.find(t=>t.id===el.value):null; }
function applyTpl(){ const t=currentTpl(); if(!t)return setMsg('No template selected');
  const ids=[...sel]; const entries=CAM.applyTemplate(t, ids);
  if(!entries.length)return setMsg('Template "'+t.name+'" has no toolpaths');
  pushHistory();
  for(const e of entries){ e.label=autoLabel(e.p, e.ids, null); opsQueue.push(e); }
  editingIdx=null; buildQueueList(); recalcAll();
  setMsg('Applied "'+t.name+'" — '+entries.length+' toolpath(s) on '+(ids.length?ids.length+' selected':'all visible')+' vector(s)'); }
function saveTpl(){ if(!opsQueue.length)return setMsg('Add toolpaths first, then save them as a template');
  const n=prompt('Template name:', currentTpl()?currentTpl().name:'My recipe'); if(n==null)return;
  const t=CAM.templateFromQueue(n.trim()||'My recipe', opsQueue);
  templates=CAM.upsertTemplate(templates,t); persistTemplates(); buildTplLib(t.id);
  setMsg('Saved template "'+t.name+'" — '+t.entries.length+' toolpath(s), no geometry'); }
function delTpl(){ const t=currentTpl(); if(!t)return;
  if(!confirm('Delete template "'+t.name+'"?'))return;
  templates=CAM.removeTemplate(templates,t.id); if(!templates.length)templates=CAM.defaultTemplates();
  persistTemplates(); buildTplLib(); setMsg('Deleted template "'+t.name+'"'); }
function exportTpl(){ const t=currentTpl(); if(!t)return setMsg('No template selected');
  download(t.id+'.aqtpl', CAM.templateToJSON(t), 'application/json'); setMsg('Exported '+t.id+'.aqtpl'); }
function importTplText(text){
  try{ const t=CAM.templateFromJSON(text); templates=CAM.upsertTemplate(templates,t); persistTemplates(); buildTplLib(t.id);
    setMsg('Imported template "'+t.name+'" — '+t.entries.length+' toolpath(s)'); }
  catch(e){ setMsg('Template import failed: '+e.message); } }

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
  ctx.shadowColor=TH().jobShadow; ctx.shadowBlur=14; ctx.shadowOffsetX=3; ctx.shadowOffsetY=4;
  ctx.fillStyle=TH().jobFace; ctx.fillRect(x,y,w,h);   // material face — clearly lighter than the #0c0f14 canvas, faint grid bleeds through
  ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetX=0; ctx.shadowOffsetY=0;
  // bright bordered edge (outer dark keyline + inner bright line for definition)
  ctx.strokeStyle=TH().jobKey; ctx.lineWidth=3; ctx.strokeRect(x,y,w,h);
  ctx.strokeStyle=TH().jobEdge; ctx.lineWidth=1.5; ctx.strokeRect(x,y,w,h);
  // corner L-brackets
  ctx.strokeStyle=TH().jobCorner; ctx.lineWidth=2; const c=Math.min(16,Math.abs(w)/3,Math.abs(h)/3);
  const corner=(cx,cy,sx,sy)=>{ ctx.beginPath(); ctx.moveTo(cx+sx*c,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+sy*c); ctx.stroke(); };
  corner(x,y,1,1); corner(x+w,y,-1,1); corner(x,y+h,1,-1); corner(x+w,y+h,-1,-1);
  // size caption pill inside the top-left corner of the stock
  const cap=job.w+'" × '+job.h+'"  ·  '+job.thickness+'" thick';
  ctx.font='bold 13px monospace'; const cw=ctx.measureText(cap).width; const ch=20;
  if(w>cw+26 && h>ch+10){ const px=x+9, py=y+9;
    ctx.fillStyle=TH().labelBg; ctx.fillRect(px,py,cw+16,ch);
    ctx.strokeStyle=TH().labelBd; ctx.lineWidth=1; ctx.strokeRect(px+0.5,py+0.5,cw+15,ch-1);
    ctx.fillStyle=TH().labelInk; ctx.textAlign='left'; ctx.textBaseline='middle'; ctx.fillText(cap,px+8,py+ch/2+1); }
  ctx.textBaseline='alphabetic';
  // origin marker (X0 Y0)
  const o=W2S({x:0,y:0}); ctx.fillStyle=TH().origin; ctx.beginPath(); ctx.arc(o.x,o.y,4,0,TAU); ctx.fill();
  ctx.strokeStyle=TH().origin; ctx.lineWidth=1.5; ctx.beginPath(); ctx.moveTo(o.x,o.y); ctx.lineTo(o.x+18,o.y); ctx.moveTo(o.x,o.y); ctx.lineTo(o.x,o.y-18); ctx.stroke();
  // edge dimension labels
  ctx.fillStyle=TH().dimLbl; ctx.font='bold 12px monospace'; ctx.textAlign='center';
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
function drawMeasure(a,b,persist){ ctx.save(); ctx.strokeStyle=persist?TH().measure:TH().draft; ctx.lineWidth=1.3; if(!persist)ctx.setLineDash([5,3]);
  const p=W2S(a),q=W2S(b); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y); ctx.stroke();
  // end ticks
  ctx.setLineDash([]); [p,q].forEach(pt=>{ ctx.beginPath(); ctx.arc(pt.x,pt.y,3,0,TAU); ctx.stroke(); });
  const dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy), ang=Math.atan2(dy,dx)*180/Math.PI;
  const mid={x:(p.x+q.x)/2,y:(p.y+q.y)/2};
  const label=dist.toFixed(3)+'"  ('+dx.toFixed(3)+' x '+dy.toFixed(3)+')  '+ang.toFixed(1)+String.fromCharCode(176);
  ctx.font='11px monospace'; const wlab=ctx.measureText(label).width;
  ctx.fillStyle=TH().measureBg; ctx.fillRect(mid.x+8, mid.y-20, wlab+10, 16);
  ctx.fillStyle=TH().measureInk; ctx.textAlign='left'; ctx.fillText(label, mid.x+13, mid.y-8);
  ctx.restore();
}

// ---- panels ----
function syncPanels(){ buildLayers(); buildProps(); }
function buildLayers(){ const el=document.getElementById('layerList'); if(!el)return; el.innerHTML='';
  for(const [name,info] of doc.layers){ const row=document.createElement('div'); row.className='lyr'+(name===activeLayer?' act':'');
    row.innerHTML='<input type="checkbox" '+(info.visible!==false?'checked':'')+'><span class="sw" style="background:'+(info.color||'#1b2b3f')+'"></span><span class="ln">'+name+'</span>';
    row.querySelector('input').onchange=e=>{info.visible=e.target.checked; render();}; row.querySelector('.ln').onclick=()=>{activeLayer=name; buildLayers();}; el.appendChild(row); } }
function buildProps(){ const el=document.getElementById('props'); if(!el)return; const sh=selectedShapes();
  if(!sh.length){ el.innerHTML='<div class="muted">No selection</div>'; return; }
  if(sh.length>1){ const b=CADCORE.bboxAll(sh); el.innerHTML='<div class="muted">'+sh.length+' selected</div><div class="prow">W '+(b.maxX-b.minX).toFixed(3)+'"  H '+(b.maxY-b.minY).toFixed(3)+'"</div>'; return; }
  const s=sh[0]; const b=CADCORE.bbox(s); let h='<div class="prow">type: '+(s.prim?s.prim.kind:s.type)+'</div>';
  if(s.type==='dim'){ const g=CADCORE.dimensionGeometry(s.prim);
    h+='<div class="prow">'+s.prim.style+': <b>'+g.text+'</b></div><div class="prow muted">annotation — not machined</div>'; }
  h+='<div class="prow">X '+b.minX.toFixed(3)+'  Y '+b.minY.toFixed(3)+'</div>';
  h+='<div class="prow">W '+(b.maxX-b.minX).toFixed(3)+'"  H '+(b.maxY-b.minY).toFixed(3)+'"</div>';
  h+='<div class="prow">closed: '+(s.closed?'yes':'no')+(s.type==='text'?(' · "'+s.text+'"'):'')+'</div>';
  h+='<button class="tb" id="btnEditShape" data-tip="Edit exact dimensions (or double-click the shape)" style="margin-top:5px">Edit…</button>';
  el.innerHTML=h;
  const eb=document.getElementById('btnEditShape'); if(eb)eb.onclick=()=>openShapeModal(s); }

// ---- keyboard ----
window.addEventListener('keydown', e=>{
  if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){ e.preventDefault(); undo(); return; }
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){ e.preventDefault(); redo(); return; }
  if(e.key==='Delete'||e.key==='Backspace'){ e.preventDefault(); deleteSelected(); return; }
  if(e.key==='Escape'){ hideCtxMenu(); draft=null; render(); return; }
  if(e.key==='Enter'&&tool==='polyline'&&draft){ commitPolyline(); return; }
  if(e.key==='Enter'&&tool==='bezier'&&draft){ commitBezier(false); return; }
  const map={v:'select',n:'node',l:'line',p:'polyline',b:'bezier',r:'rect',c:'circle',e:'ellipse',a:'arc',g:'polygon',t:'text',m:'measure',d:'dim'};
  if(map[e.key]){ setTool(map[e.key]); }
  if(e.key==='f'){ fitAll(); }
});

// ---- collapsible right-panel sections ----
function initCollapsibles(){
  const DEFAULT_COLLAPSED = {};   // everything open — the point of the dock is that nothing is hidden
  document.querySelectorAll('.cmd .sectn').forEach(sec=>{
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
  ['glLines','glRapids'].forEach(id=>{ const el=document.getElementById(id);
    if(el) el.onchange=()=>{ if(gl3d){ gl3dSetLines(gl3dSegs); gl3d.draw(); } }; });
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
  on('btnMirrorH',()=>opMirror('x')); on('btnMirrorV',()=>opMirror('y')); on('btnDup',opDuplicate); on('btnArray',opArray); on('btnRot90',opRotate90); on('btnJoin',opJoin);
  on('btnCheckVec',opCheckVectors);
  on('restoreYes',()=>dismissRestore(true)); on('restoreNo',()=>dismissRestore(false));
  on('btnAlignL',()=>opAlign('left')); on('btnAlignR',()=>opAlign('right')); on('btnAlignT',()=>opAlign('top')); on('btnAlignB',()=>opAlign('bottom')); on('btnAlignHC',()=>opAlign('hcenter')); on('btnAlignVC',()=>opAlign('vcenter'));
  on('btnSaveProj',saveProject); on('btnExpDXF',exportDXF); on('btnExpSVG',exportSVG);
  on('btnJobSet',setJob); on('btnFitJob',fitJob);
  const js=document.getElementById('jobShow'); if(js)js.onchange=e=>{job.show=e.target.checked; render();};
  // live job dimension updates (no view refit — use "Set job"/"Fit job" to re-zoom)
  const jobLive=()=>{ const g=id=>document.getElementById(id); job.w=Math.abs(parseFloat(g('jobW').value)||24); job.h=Math.abs(parseFloat(g('jobH').value)||18); job.thickness=Math.abs(parseFloat(g('jobT').value)||0.5); job.origin=g('jobOrigin').value; updateMatSummary(); render(); };
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
    show('.inlay-only', v==='inlay');
    show('.profile-pocket', v==='profile'||v==='pocket');
    show('.not-drill', v!=='drill'); };
  if(camOp){ camOp.onchange=syncCamOp; syncCamOp(); }
  initCmdDock();
  // clipart library (D2)
  loadClipart(); buildClipCats(); buildClipGrid();
  const cc=document.getElementById('clipCat'); if(cc)cc.onchange=buildClipGrid;
  on('btnClipAdd',addSelectionToClipart); on('btnClipDel',delClipart); on('btnClipExport',exportClipart);
  const ci=document.getElementById('clipInput'), cb=document.getElementById('btnClipImport');
  if(ci&&cb){ cb.onclick=()=>ci.click();
    ci.onchange=e=>{ const f=e.target.files[0]; if(f){ const rd=new FileReader(); rd.onload=ev=>importClipText(ev.target.result); rd.readAsText(f); } ci.value=''; }; }
  // bitmap trace (D1)
  on('btnTrace',openTraceModal); on('traceApply',commitTrace); on('traceCancel',closeTraceModal);
  on('traceX',closeTraceModal); on('traceClearBg',clearBgImage);
  ['trThresh','trInvert','trSpeck','trTol','trSmooth','trWidth'].forEach(id=>{ const el=document.getElementById(id);
    if(el) el.addEventListener('input',()=>{ if(document.getElementById('traceModal').style.display==='block') runTracePreview(); }); });
  // toolpath templates
  loadTemplates(); buildTplLib();
  on('btnTplApply',applyTpl); on('btnTplSave',saveTpl); on('btnTplDel',delTpl); on('btnTplExport',exportTpl);
  const ti=document.getElementById('tplInput'); const tb=document.getElementById('btnTplImport');
  if(ti&&tb){ tb.onclick=()=>ti.click();
    ti.onchange=e=>{ const f=e.target.files[0]; if(f){ const rd=new FileReader(); rd.onload=ev=>importTplText(ev.target.result); rd.readAsText(f); } ti.value=''; }; }
  // tool library
  loadTools(); buildToolLib();
  const tl=document.getElementById('camToolLib'); if(tl)tl.onchange=()=>applyTool(tl.value);
  on('btnToolSave',saveTool); on('btnToolDel',delTool);
  // shape properties modal
  on('modalApply',applyShapeModal); on('modalCancel',closeShapeModal); on('modalX',closeShapeModal);
  const mb=document.getElementById('shapeModal');
  const mf=document.getElementById('modalFields'); if(mf) mf.addEventListener('input', previewShapeModal);   // live preview as you type
  if(mb){ mb.addEventListener('mousedown',e=>{ if(e.target===mb)closeShapeModal(); });
    mb.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();applyShapeModal();} else if(e.key==='Escape'){e.preventDefault();closeShapeModal();} });
    // drag the dialog by its header so it never hides the shape
    const card=mb.querySelector('.modal'), hdr=mb.querySelector('.modal-h'); let md=null;
    if(hdr&&card){ hdr.addEventListener('mousedown',e=>{ if(e.target.id==='modalX')return; const r=card.getBoundingClientRect(); md={dx:e.clientX-r.left,dy:e.clientY-r.top}; e.preventDefault(); });
      window.addEventListener('mousemove',e=>{ if(!md)return; card.style.left=Math.max(2,Math.min(window.innerWidth-60,e.clientX-md.dx))+'px'; card.style.top=Math.max(2,Math.min(window.innerHeight-30,e.clientY-md.dy))+'px'; });
      window.addEventListener('mouseup',()=>{ md=null; }); } }
  on('btnNew',()=>{ if(confirm('Clear design?')){ pushHistory(); doc.shapes=[]; sel.clear(); toolpaths=null; render(); syncPanels(); } });
  const fi=document.getElementById('fileInput'); document.getElementById('btnImport').onclick=()=>fi.click();
  fi.onchange=e=>{ const f=e.target.files[0]; if(!f)return; const rd=new FileReader();
    if(/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)){ importBitmap(f.name, f); return; }
    if(/\.aqcam$/i.test(f.name)){ rd.onload=ev=>openProject(ev.target.result, f.name); rd.readAsText(f); }
    else if(/\.aqtpl$/i.test(f.name)){ rd.onload=ev=>importTplText(ev.target.result); rd.readAsText(f); }
    else if(/\.aqclip$/i.test(f.name)){ rd.onload=ev=>importClipText(ev.target.result); rd.readAsText(f); }
    else if(/\.pdf$/i.test(f.name)){ rd.onload=ev=>importPDF(f.name,ev.target.result); rd.readAsArrayBuffer(f); }
    else { rd.onload=ev=>importText(f.name,ev.target.result); rd.readAsText(f); } };
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
    if(/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)){ importBitmap(f.name, f); return; }
    if(/\.aqcam$/i.test(f.name)){ rd.onload=ev=>openProject(ev.target.result, f.name); rd.readAsText(f); }
    else if(/\.aqtpl$/i.test(f.name)){ rd.onload=ev=>importTplText(ev.target.result); rd.readAsText(f); }
    else if(/\.aqclip$/i.test(f.name)){ rd.onload=ev=>importClipText(ev.target.result); rd.readAsText(f); }
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
wire(); resize(); setTool('select'); syncPanels(); render();
window.AQ_STUDIO = { doc, get sel(){return sel;}, get view(){return viewMode;}, CADCORE, CAM, importText, importPDF, openProject, saveProject, projectJSON, setView, camBuild, setTool, addShapes, render };
