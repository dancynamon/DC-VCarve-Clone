/* camcore.js - Aquamentor 2D CAD/CAM core (pure, no DOM). Node + browser. */
(function (root, factory) {
  const Clip = (typeof require === 'function') ? require('./package/clipper.js') : root.ClipperLib;
  const mod = factory(Clip);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.CAM = mod;
})(typeof self !== 'undefined' ? self : this, function (ClipperLib) {
'use strict';
const SCALE = 100000, TOL = 1e-4;
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function near(a,b,t){return dist(a,b)<=(t==null?TOL:t);}
function signedArea(pts){let s=0;for(let i=0,n=pts.length;i<n;i++){const a=pts[i],b=pts[(i+1)%n];s+=a.x*b.y-b.x*a.y;}return s/2;}
function isCCW(pts){return signedArea(pts)>0;}
function reversed(pts){return pts.slice().reverse();}
function ensureCCW(pts){return isCCW(pts)?pts.slice():reversed(pts);}
function ensureCW(pts){return isCCW(pts)?reversed(pts):pts.slice();}
function boundsOf(loops){let b={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};for(const lp of loops)for(const p of (lp.pts||lp)){if(p.x<b.minX)b.minX=p.x;if(p.y<b.minY)b.minY=p.y;if(p.x>b.maxX)b.maxX=p.x;if(p.y>b.maxY)b.maxY=p.y;}return b;}

function assembleContours(polys, tol){
  tol = tol||TOL;
  const closed=[], openSegs=[];
  for(const poly of polys){
    const pts = poly.pts||poly;
    if(!pts||pts.length<2) continue;
    const first=pts[0], last=pts[pts.length-1];
    if(poly.closed || near(first,last,tol)){
      const c=(pts.length>1 && near(first,last,tol))?pts.slice(0,-1):pts.slice();
      if(c.length>=3) closed.push(c);
    } else openSegs.push(pts.slice());
  }
  const used=new Array(openSegs.length).fill(false);
  for(let i=0;i<openSegs.length;i++){
    if(used[i])continue; used[i]=true;
    let chain=openSegs[i].slice(), extended=true;
    while(extended){
      extended=false;
      const head=chain[0], tail=chain[chain.length-1];
      for(let j=0;j<openSegs.length;j++){
        if(used[j])continue;
        const s=openSegs[j], sh=s[0], st=s[s.length-1];
        if(near(tail,sh,tol)){chain=chain.concat(s.slice(1));used[j]=true;extended=true;}
        else if(near(tail,st,tol)){chain=chain.concat(reversed(s).slice(1));used[j]=true;extended=true;}
        else if(near(head,st,tol)){chain=s.slice(0,-1).concat(chain);used[j]=true;extended=true;}
        else if(near(head,sh,tol)){chain=reversed(s).slice(0,-1).concat(chain);used[j]=true;extended=true;}
        if(extended)break;
      }
    }
    const h=chain[0], t=chain[chain.length-1];
    if(chain.length>=3 && near(h,t,tol)) closed.push(chain.slice(0,-1));
    else closed.push({open:true,pts:chain});
  }
  return closed.map(c=>{
    if(c.open) return {pts:c.pts,closed:false,area:0,ccw:null};
    const a=signedArea(c);
    return {pts:c,closed:true,area:Math.abs(a),ccw:a>0};
  });
}

function offsetLoop(loop, delta, joinType){
  const co=new ClipperLib.ClipperOffset(2, 0.003*SCALE);
  const path=loop.map(p=>new ClipperLib.IntPoint(Math.round(p.x*SCALE),Math.round(p.y*SCALE)));
  const jt = joinType==='miter'?ClipperLib.JoinType.jtMiter : joinType==='square'?ClipperLib.JoinType.jtSquare : ClipperLib.JoinType.jtRound;
  co.AddPath(path, jt, ClipperLib.EndType.etClosedPolygon);
  const sol=new ClipperLib.Paths();
  co.Execute(sol, delta*SCALE);
  return sol.map(p=>p.map(pt=>({x:pt.X/SCALE,y:pt.Y/SCALE})));
}

function withTabs(loop, count, tabLen){
  if(!count||count<1||!tabLen) return loop.map(p=>({x:p.x,y:p.y,tab:false}));
  const n=loop.length, segLen=[]; let total=0;
  for(let i=0;i<n;i++){const a=loop[i],b=loop[(i+1)%n];const L=dist(a,b);segLen.push(L);total+=L;}
  if(total===0) return loop.map(p=>({x:p.x,y:p.y,tab:false}));
  const centers=[]; for(let k=0;k<count;k++) centers.push((k+0.5)/count*total);
  const half=Math.min(tabLen, total/count*0.9)/2;
  const iv=centers.map(c=>[c-half,c+half]);
  function inTab(pos){for(const [s,e] of iv){let a=((s%total)+total)%total,b=((e%total)+total)%total;if(a<=b){if(pos>=a&&pos<=b)return true;}else{if(pos>=a||pos<=b)return true;}}return false;}
  const out=[]; let acc=0;
  for(let i=0;i<n;i++){
    const a=loop[i],b=loop[(i+1)%n],L=segLen[i];
    out.push({x:a.x,y:a.y,tab:inTab(acc)});
    const steps=Math.max(1,Math.ceil(L/0.02));
    for(let s=1;s<steps;s++){
      const t=s/steps,pos=acc+L*t,cur=inTab(pos),prev=inTab(acc+L*(s-1)/steps);
      if(cur!==prev) out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,tab:cur});
    }
    acc+=L;
  }
  return out;
}

// ---- lead-in / lead-out (tangential arc or line) for closed cut loops ----
function _unit(v){ const m=Math.hypot(v.x,v.y)||1; return {x:v.x/m,y:v.y/m}; }
function _rot(v,a){ const c=Math.cos(a),s=Math.sin(a); return {x:v.x*c-v.y*s, y:v.x*s+v.y*c}; }
// loop: ordered closed-loop points (no repeated closing pt). sideSign +1=left of travel, -1=right.
// returns {pre:[pts before loop start], post:[pts after loop close]} or null if it won't fit / type none.
function leadFor(loop, type, len, sideSign){
  if(type==='none' || !(len>0) || !loop || loop.length<3) return null;
  const bb=boundsOf([loop]); if(Math.min(bb.maxX-bb.minX, bb.maxY-bb.minY) < 2*len) return null;  // too small
  const P0=loop[0], P1=loop[1], Pn=loop[loop.length-1];
  const dirIn=_unit({x:P1.x-P0.x,y:P1.y-P0.y});      // cut direction leaving the start
  const dirOut=_unit({x:P0.x-Pn.x,y:P0.y-Pn.y});     // cut direction arriving back at the start
  const pre=[], post=[], N=10, Q=Math.PI/2;
  if(type==='line'){
    pre.push({x:P0.x-dirIn.x*len, y:P0.y-dirIn.y*len});      // tangential approach, collinear with first edge
    post.push({x:P0.x+dirOut.x*len, y:P0.y+dirOut.y*len});   // tangential departure
  } else {  // arc: quarter circle tangent to the path, curving to side sideSign
    const nIn=_rot(dirIn, sideSign*Q), C=({x:P0.x+nIn.x*len, y:P0.y+nIn.y*len});
    const aEnd=Math.atan2(P0.y-C.y,P0.x-C.x), aStart=aEnd-sideSign*Q;
    for(let i=0;i<N;i++){ const a=aStart+sideSign*Q*(i/N); pre.push({x:C.x+len*Math.cos(a), y:C.y+len*Math.sin(a)}); }
    const nOut=_rot(dirOut, sideSign*Q), C2=({x:P0.x+nOut.x*len, y:P0.y+nOut.y*len});
    const a0=Math.atan2(P0.y-C2.y,P0.x-C2.x);
    for(let i=1;i<=N;i++){ const a=a0+sideSign*Q*(i/N); post.push({x:C2.x+len*Math.cos(a), y:C2.y+len*Math.sin(a)}); }
  }
  return {pre, post};
}
// wrap a tabbed closed loop with leads. sideSign chosen by caller (non-gouging side).
// rampLen>0 tags lead-in points with a ramp fraction (0=clearZ .. 1=cutZ) for a Z ramp-in (postProcess interpolates).
// Returns {path, closed, skipped}.
function wrapLead(orientedLoop, tabbedPts, type, len, sideSign, rampLen){
  if(type==='none' || !(len>0)) return {path:tabbedPts, closed:true};
  const lead=leadFor(orientedLoop, type, len, sideSign);
  if(!lead) return {path:tabbedPts, closed:true, skipped:true};
  const tag=p=>({x:p.x,y:p.y,tab:false});
  let pre;
  if(rampLen>0){
    // tag each lead-in point with a ramp fraction (0=clearZ .. 1=cutZ) over rampLen; clamped to 1 (descent done).
    // If rampLen >= the lead-in length, no point reaches 1 -> the ramp spans the whole lead-in (single descending helix).
    const cum=[0]; for(let i=1;i<lead.pre.length;i++) cum[i]=cum[i-1]+Math.hypot(lead.pre[i].x-lead.pre[i-1].x, lead.pre[i].y-lead.pre[i-1].y);
    pre = lead.pre.map((p,i)=>({x:p.x,y:p.y,tab:false, ramp:Math.min(1, cum[i]/rampLen)}));
  } else pre=lead.pre.map(tag);
  const close0={x:tabbedPts[0].x, y:tabbedPts[0].y, tab:tabbedPts[0].tab};   // re-close the loop, then lead out
  return {path: pre.concat(tabbedPts, [close0], lead.post.map(tag)), closed:false};
}

function profileOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.25,side:'outside',climb:true,topZ:0,cutDepth:0.25,passDepth:0.125,safeZ:0.25,feed:120,plunge:40,rpm:18000,tabs:{count:0,length:0.4,height:0.06},joinType:'round',leadType:'none',leadLen:0.25,rampLen:0},opts||{});
  const r=o.toolDia/2, warnings=[], passesAll=[]; let leadSkipped=false;
  const depths=[]; let d=Math.min(o.passDepth,o.cutDepth);
  while(d<o.cutDepth-1e-9){depths.push(d);d+=o.passDepth;} depths.push(o.cutDepth);
  for(const c of contours){
    let loops;
    if(o.side==='on'||!c.closed) loops=[c.pts];
    else{
      const base=ensureCCW(c.pts);
      const delta=o.side==='outside'?+r:-r;
      loops=offsetLoop(base,delta,o.joinType);
      if(!loops.length){warnings.push('Inside profile collapsed (tool too big) on a contour');continue;}
    }
    for(let lp of loops){
      if(c.closed && o.side!=='on'){
        const wantCCW=(o.side==='outside')?!o.climb:o.climb;
        lp=wantCCW?ensureCCW(lp):ensureCW(lp);
      }
      const tabbed=(c.closed && o.tabs && o.tabs.count>0)?withTabs(lp,o.tabs.count,o.tabs.length):lp.map(p=>({x:p.x,y:p.y,tab:false}));
      let path=tabbed, closed=c.closed&&o.side!=='on';
      if(closed && o.leadType && o.leadType!=='none'){
        const interiorSign=signedArea(lp)>0?1:-1;                       // left normal = interior when CCW
        const sideSign=(o.side==='outside')?-interiorSign:interiorSign; // outside profile leads away from part; inside leads into the hole
        const wl=wrapLead(lp,tabbed,o.leadType,o.leadLen,sideSign,o.rampLen);
        path=wl.path; closed=wl.closed; if(wl.skipped) leadSkipped=true;
      }
      depths.forEach(depth=>passesAll.push({z:o.topZ-depth,tabHeight:(o.tabs&&o.tabs.height)||0,closed,path}));
    }
  }
  if(leadSkipped) warnings.push('Lead-in/out skipped on a contour too small for the lead length');
  return {ops:[{kind:'profile',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:passesAll}],warnings};
}

// ---- tool database (presets) ----
function defaultTools(){ return [
  {id:'flat-250', name:'1/4" Flat',  op:'profile', toolNum:1, dia:0.25,  angle:90,  feed:120, plunge:40, rpm:18000},
  {id:'flat-125', name:'1/8" Flat',  op:'pocket',  toolNum:2, dia:0.125, angle:90,  feed:90,  plunge:30, rpm:18000},
  {id:'vbit-60',  name:'60° V-bit',  op:'vcarve',  toolNum:3, dia:0.5,   angle:60,  feed:80,  plunge:25, rpm:18000},
  {id:'vbit-90',  name:'90° V-bit',  op:'vcarve',  toolNum:4, dia:0.5,   angle:90,  feed:80,  plunge:25, rpm:18000},
  {id:'drill-125',name:'1/8" Drill', op:'drill',   toolNum:5, dia:0.125, angle:118, feed:20,  plunge:20, rpm:12000}
]; }
function upsertTool(list, t){ const out=(list||[]).filter(x=>x.id!==t.id); out.push(t); return out; }
function removeTool(list, id){ return (list||[]).filter(x=>x.id!==id); }
function slugId(name){ return String(name||'tool').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'tool'; }

// ---- pocket: clear a closed region with concentric offset stepover passes ----
function toIntPath(pts){ return pts.map(p=>new ClipperLib.IntPoint(Math.round(p.x*SCALE),Math.round(p.y*SCALE))); }
function fromIntPath(path){ return path.map(pt=>({x:pt.X/SCALE,y:pt.Y/SCALE})); }
// union of closed loops into a clean region (outer + holes, oriented by Clipper), even-odd so nested loops read as holes
function regionFromLoops(loops){
  const c=new ClipperLib.Clipper();
  for(const lp of loops) if(lp&&lp.length>=3) c.AddPath(toIntPath(lp), ClipperLib.PolyType.ptSubject, true);
  const sol=new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  return sol;
}
// offset an oriented region (IntPoint paths) by delta inches; returns array of point-loops
function offsetRegion(region, delta){
  const co=new ClipperLib.ClipperOffset(2, 0.003*SCALE);
  for(const path of region) co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol=new ClipperLib.Paths(); co.Execute(sol, delta*SCALE);
  return sol.map(fromIntPath);
}
// point-in-region test honoring holes: a point is inside an even-odd region when an odd number of its loops contain it.
function pointInRegion(p, regionPaths){
  const ip=new ClipperLib.IntPoint(Math.round(p.x*SCALE), Math.round(p.y*SCALE));
  let parity=0;
  for(const path of regionPaths){ if(ClipperLib.Clipper.PointInPolygon(ip, path)!==0) parity^=1; }
  return parity===1;
}
// Build a descending helical entry: a single circular arc (<=270deg) tangent to the first clearing ring at its
// start point, curving into the cleared interior, with each point ramp-tagged 0..(<1) so postProcess descends
// clearZ->cutZ across it (its helical G2/G3+Z path; the untagged ring start lands at full depth). The arc + ring
// start share one circle so fitSingleArc accepts it. Tries radii largest-first; returns the tagged pre-points, or
// null if no radius keeps every helix point inside the region (caller falls back to a straight plunge).
function helixEntry(ring, regionPaths, radii){
  if(!ring || ring.length<3) return null;
  const r0=ring[0], r1=ring[1];
  const dx=r1.x-r0.x, dy=r1.y-r0.y, dl=Math.hypot(dx,dy)||1, ux=dx/dl, uy=dy/dl;   // unit cut direction at the start
  const interiorSign = signedArea(ring)>0?1:-1;                                     // +1 CCW (interior=left), -1 CW (interior=right)
  const inx = interiorSign>0 ? -uy : uy, iny = interiorSign>0 ? ux : -ux;           // inward (interior) normal
  const N=12, sweep=260*Math.PI/180, dir=interiorSign;                              // 12 steps ~21.7deg (<35 cap); <270 so it posts as one arc
  for(const hr of radii){
    if(!(hr>1e-4)) continue;
    const C={x:r0.x+inx*hr, y:r0.y+iny*hr};                                         // center hr inside the boundary -> arc is tangent to the ring at r0
    const aEnd=Math.atan2(r0.y-C.y, r0.x-C.x);                                       // r0 sits on this circle (|r0-C|=hr)
    const pre=[]; let ok=true;
    for(let k=0;k<N;k++){
      const a=aEnd - dir*sweep + dir*sweep*(k/N);                                    // k=0..N-1 sweep up to (but excluding) r0 at k=N
      const p={x:C.x+hr*Math.cos(a), y:C.y+hr*Math.sin(a)};
      if(!pointInRegion(p, regionPaths)){ ok=false; break; }
      pre.push({x:p.x, y:p.y, tab:false, ramp:k/N});                                 // ramp 0..(N-1)/N (<1); r0 (full depth) stays untagged
    }
    if(ok) return pre;
  }
  return null;
}
// intersect one horizontal scan line (at height y) with a clearing region (scaled IntPoint paths, holes honored).
// Models the line as a thin horizontal strip and Clipper-intersects it; returns x-spans [[xmin,xmax],...] sorted ascending.
function scanLineSegs(fillPaths, y, xLo, xHi){
  const eps=0.0005;   // strip half-height in inches — thin enough to read as a line, thick enough to survive integer rounding
  const strip=[
    new ClipperLib.IntPoint(Math.round((xLo-1)*SCALE), Math.round((y-eps)*SCALE)),
    new ClipperLib.IntPoint(Math.round((xHi+1)*SCALE), Math.round((y-eps)*SCALE)),
    new ClipperLib.IntPoint(Math.round((xHi+1)*SCALE), Math.round((y+eps)*SCALE)),
    new ClipperLib.IntPoint(Math.round((xLo-1)*SCALE), Math.round((y+eps)*SCALE)),
  ];
  const c=new ClipperLib.Clipper();
  c.AddPath(strip, ClipperLib.PolyType.ptSubject, true);
  for(const fp of fillPaths) c.AddPath(fp, ClipperLib.PolyType.ptClip, true);
  const sol=new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctIntersection, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd);
  const segs=[];
  for(const path of sol){ let xmin=Infinity,xmax=-Infinity;
    for(const pt of path){ const x=pt.X/SCALE; if(x<xmin)xmin=x; if(x>xmax)xmax=x; }
    if(xmax-xmin>1e-6) segs.push([xmin,xmax]); }
  segs.sort((a,b)=>a[0]-b[0]);
  return segs;
}
function pocketOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.25,climb:true,topZ:0,cutDepth:0.25,passDepth:0.125,safeZ:0.25,feed:120,plunge:40,rpm:18000,stepover:0.4,pocketStyle:'offset',leadType:'none',leadLen:0.25,rampLen:0,rampEntry:false},opts||{});
  const r=o.toolDia/2, warnings=[];
  const loops=contours.filter(c=>c.closed && c.pts && c.pts.length>=3).map(c=>c.pts);
  if(!loops.length){ warnings.push('Pocket needs at least one closed contour'); return {ops:[{kind:'pocket',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:[]}],warnings}; }
  // stepover as fraction of dia (clamp 5%..90%) -> inches
  const so=Math.max(0.001, o.toolDia*Math.min(Math.max(o.stepover,0.05),0.9));
  const region=regionFromLoops(loops);
  const depths=[]; let d=Math.min(o.passDepth,o.cutDepth);
  while(d<o.cutDepth-1e-9){depths.push(d);d+=o.passDepth;} depths.push(o.cutDepth);
  const passes=[];
  if(o.pocketStyle==='raster'){
    // fill boundary = region pulled one tool-radius inside the wall (the XY region is depth-independent, so compute rows once)
    const fillLoops=offsetRegion(region, -r).filter(lp=>lp.length>=3);
    if(!fillLoops.length){ warnings.push('Tool too large to enter the pocket region'); }
    const fillPaths=fillLoops.map(toIntPath);
    const b=boundsOf(fillLoops);
    const rows=[];   // [{y, segs}] for non-empty scan lines, computed once
    if(fillLoops.length){
      for(let y=b.minY; y<=b.maxY+1e-9; y+=so){ const segs=scanLineSegs(fillPaths,y,b.minX,b.maxX); if(segs.length) rows.push({y,segs}); }
    }
    depths.forEach(depth=>{
      rows.forEach((row,i)=>{
        const reverse=(i%2)===1;   // lace: alternate the cut direction each row so the tool snakes back and forth
        const ordered=reverse?row.segs.slice().reverse():row.segs;
        ordered.forEach(([xmin,xmax])=>{
          const path=reverse?[{x:xmax,y:row.y,tab:false},{x:xmin,y:row.y,tab:false}]
                            :[{x:xmin,y:row.y,tab:false},{x:xmax,y:row.y,tab:false}];
          passes.push({z:o.topZ-depth,tabHeight:0,closed:false,path});
        });
      });
    });
    return {ops:[{kind:'pocket',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes}],warnings};
  }
  // --- offset (concentric) style: rings from one tool-radius inside the wall, stepping inward until the region closes up ---
  const rings=[]; let delta=-r, guard=0;
  while(guard++<5000){
    const off=offsetRegion(region, delta);
    if(!off.length) break;
    for(const lp of off) if(lp.length>=3) rings.push(lp);
    delta-=so;
  }
  if(!rings.length){ warnings.push('Tool too large to enter the pocket region'); }
  let rampEntrySkipped=false;
  depths.forEach(depth=>{
    rings.forEach((lp,ri)=>{ const oriented=o.climb?ensureCW(lp):ensureCCW(lp);
      const tabbed=oriented.map(p=>({x:p.x,y:p.y,tab:false}));
      let path=tabbed, closed=true;
      if(ri===0 && o.rampEntry){
        // helical descent into the outer ring at each depth level (no straight plunge); shrink radius until it fits
        const pre=helixEntry(oriented, region, [r, so, so*0.5]);
        if(pre){ const close0={x:tabbed[0].x,y:tabbed[0].y,tab:false};
          path=pre.concat(tabbed, [close0]); closed=false; }
        else rampEntrySkipped=true;       // too tight for a helix -> straight plunge for this pass
      } else if(o.leadType && o.leadType!=='none'){
        const interiorSign=signedArea(oriented)>0?1:-1;                 // pocket: lead into the cleared interior
        const wl=wrapLead(oriented, tabbed, o.leadType, o.leadLen, interiorSign, o.rampLen);
        path=wl.path; closed=wl.closed;   // small inner rings just skip the lead silently
      }
      passes.push({z:o.topZ-depth,tabHeight:0,closed,path}); });
  });
  if(rampEntrySkipped) warnings.push('Helical entry skipped on a pocket too tight for the tool — straight plunge used');
  return {ops:[{kind:'pocket',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes}],warnings};
}

// ---- drill: peck-drill at the centroid of each closed contour ----
function centroid(pts){
  let A=0,cx=0,cy=0; for(let i=0,n=pts.length;i<n;i++){const a=pts[i],b=pts[(i+1)%n];const cr=a.x*b.y-b.x*a.y;A+=cr;cx+=(a.x+b.x)*cr;cy+=(a.y+b.y)*cr;}
  A/=2; if(Math.abs(A)<1e-9){ let sx=0,sy=0; for(const p of pts){sx+=p.x;sy+=p.y;} return {x:sx/pts.length,y:sy/pts.length}; }
  return {x:cx/(6*A), y:cy/(6*A)};
}
function drillOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.25,topZ:0,cutDepth:0.25,peck:0,safeZ:0.25,feed:120,plunge:40,rpm:18000},opts||{});
  const points=contours.filter(c=>c.closed && c.pts && c.pts.length>=3).map(c=>centroid(c.pts));
  const warnings=[]; if(!points.length) warnings.push('Drill needs closed contour(s) — drills one hole at each centroid');
  const depths=[];
  if(o.peck&&o.peck>0){ let d=Math.min(o.peck,o.cutDepth); while(d<o.cutDepth-1e-9){depths.push(d); d+=o.peck;} depths.push(o.cutDepth); }
  else depths.push(o.cutDepth);
  const passes=[];
  for(const p of points) depths.forEach(depth=>passes.push({z:o.topZ-depth,tabHeight:0,closed:false,path:[{x:p.x,y:p.y,tab:false}]}));
  return {ops:[{kind:'drill',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes}],warnings,points};
}

// ---- V-carve / engrave: medial-axis V-groove via the grassfire (distance-transform) skeleton ----
// The medial axis is the ridge of the distance-to-boundary field: a point's inscribed radius is its
// distance to the nearest wall, and a V-bit (half-angle a) touching both walls there sits at depth
// radius/tan(a). We sweep that field by offsetting the boundary inward in `step` increments — each
// offset ring lies at a constant inscribed distance d, so it cuts at depth d/tan(a) (capped at maxDepth
// for a flat-bottomed groove; maxDepth 0 = full sharp V). The grassfire "quench line" where the region
// finally collapses IS the medial axis / Voronoi skeleton; we binary-search that exact collapse distance
// (the true global max inscribed radius) and trace it as a finishing spine pass, so the groove bottom
// reaches the real medial-axis depth instead of falling up to step/tan(a) short.
function vcarveOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.5,bitAngle:90,topZ:0,maxDepth:0.25,step:0.02,safeZ:0.25,feed:80,plunge:30,rpm:18000,climb:true,flatDepth:0,clearDia:0,clearNum:2,passDepth:0,stepover:0.4,pocketStyle:'offset'},opts||{});
  const half=(Math.max(1,Math.min(179,o.bitAngle))/2)*Math.PI/180; const t=Math.tan(half)||1e-6;
  const warnings=[];
  const loops=contours.filter(c=>c.closed && c.pts && c.pts.length>=3).map(c=>c.pts);
  if(!loops.length){ warnings.push('V-carve needs closed contour(s)'); return {ops:[{kind:'vcarve',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:[]}],warnings}; }
  const region=regionFromLoops(loops);
  const flat=o.flatDepth>0?o.flatDepth:0;
  const maxD=flat>0?flat:(o.maxDepth>0?o.maxDepth:Infinity);   // V-bit capped at the flat depth when set
  const step=Math.max(0.002,o.step);
  const inset=d=>offsetRegion(region, -d).filter(lp=>lp.length>=3);   // boundary offset inward by d (>=3-pt loops only)
  const passes=[];
  const emit=(lp,depth)=>{ const path=o.climb?ensureCW(lp):ensureCCW(lp); passes.push({z:o.topZ-depth,tabHeight:0,closed:true,path:path.map(p=>({x:p.x,y:p.y,tab:false}))}); };
  // (1) concentric grassfire rings, shallow -> deep, until the region collapses (or guard)
  let k=1, guard=0, lastGoodD=0;
  while(guard++<20000){
    const d=k*step, depth=Math.min(d/t, maxD);
    const off=inset(d);
    if(!off.length) break;
    for(const lp of off) emit(lp, depth);
    lastGoodD=d; k++;
  }
  // (2) medial-axis finishing pass: binary-search the exact collapse distance (true max inscribed radius)
  //     and trace the near-collapse spine at its real depth, so the V-bottom isn't left a step short.
  if(passes.length){
    let lo=lastGoodD, hi=lastGoodD+step;            // collapse occurs in (lo, hi]
    for(let i=0;i<30;i++){ const mid=(lo+hi)/2; if(inset(mid).length) lo=mid; else hi=mid; }
    const dMax=lo, spine=inset(dMax);               // deepest non-empty offset = the skeleton neighborhood
    if(dMax>lastGoodD+1e-9) for(const lp of spine) emit(lp, Math.min(dMax/t, maxD));
  } else warnings.push('Region too small for the chosen step');
  const vOp={kind:'vcarve',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes,
    toolProfile:{type:'v',radius:Math.max(o.toolDia/2, flat>0?flat*t:o.toolDia/2),angle:o.bitAngle}};
  const ops=[vOp];
  // (3) flat-depth area clearance: rough the deep "core" (where the groove would exceed flatDepth) with a flat
  //     endmill down to flatDepth FIRST, so the V-bit only finishes the tapered walls + detail it can reach.
  if(flat>0 && o.clearDia>0){
    const core=offsetRegion(region, -(flat*t)).filter(lp=>lp.length>=3);   // region inset to where depth == flatDepth
    if(core.length){
      const pk=pocketOp(core.map(lp=>({closed:true,pts:lp.map(p=>({x:p.x,y:p.y}))})),
        {toolNum:o.clearNum,toolDia:o.clearDia,climb:o.climb,topZ:o.topZ,cutDepth:flat,passDepth:o.passDepth>0?o.passDepth:flat,
         safeZ:o.safeZ,feed:o.clearFeed||o.feed,plunge:o.plunge,rpm:o.rpm,stepover:o.stepover,pocketStyle:o.pocketStyle});
      for(const op of pk.ops){ if(op.passes && op.passes.length){ op.kind='pocket'; op.toolProfile={type:'flat',radius:o.clearDia/2}; ops.unshift(op); } }
      if(pk.warnings) for(const w of pk.warnings) warnings.push('clearance: '+w);
    }
  }
  return {ops,warnings};
}

// ---- arc fitting: turn a dense polyline into line + G2/G3 arc moves ----
function circleFrom3(a,b,c){
  const ax=a.x,ay=a.y,bx=b.x,by=b.y,cx=c.x,cy=c.y;
  const d=2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by));
  if(Math.abs(d)<1e-12) return null;
  const ux=((ax*ax+ay*ay)*(by-cy)+(bx*bx+by*by)*(cy-ay)+(cx*cx+cy*cy)*(ay-by))/d;
  const uy=((ax*ax+ay*ay)*(cx-bx)+(bx*bx+by*by)*(ax-cx)+(cx*cx+cy*cy)*(bx-ax))/d;
  const r=Math.hypot(ax-ux,ay-uy);
  return {cx:ux,cy:uy,r};
}
function arcCovers(P,i,j,arc,tol,maxStep){
  const {cx,cy,r}=arc;
  if(r>1e5||r<1e-4) return false;          // essentially straight / degenerate
  maxStep = maxStep || (35*Math.PI/180);   // max angle between consecutive samples
  let prevAng=null, dir=0;
  for(let k=i;k<=j;k++){
    const dd=Math.hypot(P[k].x-cx,P[k].y-cy);
    if(Math.abs(dd-r)>tol) return false;     // off the circle
    const ang=Math.atan2(P[k].y-cy,P[k].x-cx);
    if(prevAng!==null){
      let da=ang-prevAng;
      while(da>Math.PI) da-=2*Math.PI; while(da<-Math.PI) da+=2*Math.PI;
      if(Math.abs(da)>maxStep) return false;      // samples too sparse -> treat as straight, not an arc
      if(Math.abs(da)<1e-9){} else if(dir===0) dir=Math.sign(da);
      else if(Math.sign(da)!==dir) return false;  // must not reverse direction
    }
    prevAng=ang;
  }
  return true;
}
// returns true if arc i..j sweeps clockwise (screen/math XY, Y up) -> G2
function arcSweep(P,i,j,arc){
  let sweep=0, prev=Math.atan2(P[i].y-arc.cy,P[i].x-arc.cx);
  for(let k=i+1;k<=j;k++){const a=Math.atan2(P[k].y-arc.cy,P[k].x-arc.cx);let da=a-prev;while(da>Math.PI)da-=2*Math.PI;while(da<-Math.PI)da+=2*Math.PI;sweep+=da;prev=a;}
  return sweep;
}
function arcIsCW(P,i,j,arc){
  let sweep=0, prev=Math.atan2(P[i].y-arc.cy,P[i].x-arc.cx);
  for(let k=i+1;k<=j;k++){
    const a=Math.atan2(P[k].y-arc.cy,P[k].x-arc.cx);
    let da=a-prev; while(da>Math.PI) da-=2*Math.PI; while(da<-Math.PI) da+=2*Math.PI;
    sweep+=da; prev=a;
  }
  return sweep<0; // negative sweep = clockwise
}
// Fit points P[i..j] to ONE arc (for a helical lead-in). Returns {cx,cy,r} or null if they aren't co-circular / sweep too big.
function fitSingleArc(P, i, j, tol){
  if(j-i<2) return null;                       // need >=3 points
  const arc=circleFrom3(P[i], P[(i+j)>>1], P[j]);
  if(!arc || !arcCovers(P,i,j,arc,tol||0.0015)) return null;
  if(Math.abs(arcSweep(P,i,j,arc))>270*Math.PI/180) return null;
  return arc;
}
// P: array of {x,y}. Emits moves from P[0] to P[n-1]: {type:'line',x,y} | {type:'arc',x,y,cx,cy,cw}
function fitArcs(P, tol){
  tol = tol||0.0015;
  const moves=[]; const n=P.length; let i=0;
  while(i<n-1){
    let bestJ=-1, bestArc=null;
    for(let j=i+2;j<n;j++){
      // limit arc sweep to < 350deg to stay unambiguous
      const arc=circleFrom3(P[i],P[Math.floor((i+j)/2)],P[j]);
      if(!arc){ break; }
      if(arcCovers(P,i,j,arc,tol) && Math.abs(arcSweep(P,i,j,arc))<=(270*Math.PI/180)){ bestJ=j; bestArc=arc; }
      else break;
    }
    if(bestArc && bestJ>=i+3){
      moves.push({type:'arc', x:P[bestJ].x, y:P[bestJ].y, cx:bestArc.cx, cy:bestArc.cy, cw:arcIsCW(P,i,bestJ,bestArc)});
      i=bestJ;
    } else {
      moves.push({type:'line', x:P[i+1].x, y:P[i+1].y}); i++;
    }
  }
  return moves;
}

function fmtNum(n,dp){return Number((Math.abs(n)<1e-9?0:n).toFixed(dp));}
function fmtF(n,dp){return (Math.abs(n)<1e-9?0:n).toFixed(dp==null?4:dp);}

// Greedy nearest-neighbor reorder of passes to minimize rapid (G0) travel between contour starts.
// Builds one global tour over every pass (start point = path[0] or pts[0]), beginning at `start`
// (default 0,0), always hopping to the nearest unvisited start; then reorders each op's passes to
// follow that tour. Op boundaries (tool changes) stay intact — passes only move within their own op.
// Multipass groups of one contour share a start point, so distance-0 ties keep them together & in
// depth order (stable: strict < tie-break favors the earlier-indexed pass). Returns a NEW job.
function orderPasses(job, start){
  start = start || {x:0,y:0};
  const items=[];
  (job.ops||[]).forEach((op,oi)=>(op.passes||[]).forEach((pass)=>{
    const src=(pass.path&&pass.path.length)?pass.path:((pass.pts&&pass.pts.length)?pass.pts:null);
    const sp=src?src[0]:{x:0,y:0};
    items.push({opIdx:oi, startPt:{x:sp.x||0,y:sp.y||0}, pass});
  }));
  const n=items.length, visited=new Array(n).fill(false), tour=[];
  let cx=start.x, cy=start.y;
  for(let k=0;k<n;k++){
    let best=-1,bd=Infinity;
    for(let i=0;i<n;i++){ if(visited[i])continue;
      const dx=items[i].startPt.x-cx, dy=items[i].startPt.y-cy, d=dx*dx+dy*dy;
      if(d<bd){bd=d;best=i;} }
    if(best<0)break;
    visited[best]=true; tour.push(items[best]); cx=items[best].startPt.x; cy=items[best].startPt.y;
  }
  const newJob=Object.assign({},job);
  newJob.ops=(job.ops||[]).map((op,oi)=>Object.assign({},op,{passes:tour.filter(it=>it.opIdx===oi).map(it=>it.pass)}));
  return newJob;
}

// job = { name, units, ops:[{toolNum,rpm,feed,plunge,clearZ,passes:[{z,tabHeight,closed,path}]}] }
function postProcess(job, post){
  const P=Object.assign({},POSTS.shopsabre,post||{});
  const dp=P.decimals;
  const X=v=>P.axisFmt('X',v,dp), Y=v=>P.axisFmt('Y',v,dp), Z=v=>P.axisFmt('Z',v,dp);
  const arcTol = P.arcTol!=null?P.arcTol:0.0015;
  const useArcs = !!P.arcs;
  const L=[];
  P.header(L,job,P);
  job.ops.forEach((op,oi)=>{
    const clear = op.clearZ!=null?op.clearZ:0.25;
    P.opStart(L, op, P, oi===0);
    op.passes.forEach(pass=>{
      const path=pass.path; if(!path.length)return;
      const cutZ=pass.z, tabZ=pass.z+(pass.tabHeight||0);
      // build full traversal: vertices in order, plus closing point if closed
      const pts = pass.closed ? path.concat([path[0]]) : path.slice();
      const start=pts[0];
      const ramped = start.ramp!=null;                  // lead-in tagged for a Z ramp-in
      let re=0; if(ramped){ while(re+1<pts.length && pts[re+1].ramp!=null) re++; }   // last ramped index
      L.push(`G0 ${X(start.x)} ${Y(start.y)} ${Z(fmtNum(clear,dp))}`);   // rapid above start
      let cur={x:start.x,y:start.y}, curTab=!!start.tab, firstFeed=true, runStart=0;
      function flushRun(a,b){
        // emit moves cur->pts[b] over pts[a..b] (a==current position index)
        const seg=pts.slice(a,b+1).map(p=>({x:p.x,y:p.y}));
        if(seg.length<2) return;
        const moves = useArcs ? fitArcs(seg, arcTol) : seg.slice(1).map(p=>({type:'line',x:p.x,y:p.y}));
        for(const m of moves){
          const f = firstFeed ? ` F${fmtF(op.feed,P.feedDecimals)}` : '';
          if(m.type==='arc'){
            const I=(m.cx-cur.x), J=(m.cy-cur.y);
            const g=m.cw?'G2':'G3';
            L.push(`${g} ${X(m.x)} ${Y(m.y)} I${(Math.abs(I)<1e-9?0:I).toFixed(dp)} J${(Math.abs(J)<1e-9?0:J).toFixed(dp)}${f}`);
          } else {
            L.push(`G1 ${X(m.x)} ${Y(m.y)}${f}`);
          }
          firstFeed=false; cur={x:m.x,y:m.y};
        }
      }
      if(ramped){
        const cs=pts[re+1];   // contour start (end of the lead-in)
        const ij=v=>(Math.abs(v)<1e-9?0:v).toFixed(dp);
        // if the lead-in points lie on one arc and the post supports helical, emit a helical G2/G3 with a Z word
        const helArc = (P.helical!==false && useArcs && re>=2) ? fitSingleArc(pts,0,re+1,arcTol) : null;
        let leadFirstFeed=true;   // does the contour still need an F(cut feed) on its first move?
        if(helArc){
          let split=-1; for(let i=1;i<=re;i++){ if(pts[i].ramp>=1-1e-9){ split=i; break; } }   // first point at full depth
          if(split>=2 && split<=re-1){
            // descending sub-arc clearZ->cutZ to the split point (plunge feed) + flat sub-arc at cutZ to the contour start (cut feed)
            const sp=pts[split];
            const g1=arcIsCW(pts,0,split,helArc)?'G2':'G3';
            L.push(`${g1} ${X(sp.x)} ${Y(sp.y)} ${Z(fmtNum(cutZ,dp))} I${ij(helArc.cx-start.x)} J${ij(helArc.cy-start.y)} F${fmtF(op.plunge,P.feedDecimals)}`);
            const g2=arcIsCW(pts,split,re+1,helArc)?'G2':'G3';
            L.push(`${g2} ${X(cs.x)} ${Y(cs.y)} I${ij(helArc.cx-sp.x)} J${ij(helArc.cy-sp.y)} F${fmtF(op.feed,P.feedDecimals)}`);
            leadFirstFeed=false;   // cut feed already established
          } else {
            // rampLen >= full lead-in arc: one descending helix over the whole arc
            const g=arcIsCW(pts,0,re+1,helArc)?'G2':'G3';
            L.push(`${g} ${X(cs.x)} ${Y(cs.y)} ${Z(fmtNum(cutZ,dp))} I${ij(helArc.cx-start.x)} J${ij(helArc.cy-start.y)} F${fmtF(op.plunge,P.feedDecimals)}`);
          }
          cur={x:cs.x,y:cs.y};
        } else {
          // straight-G1 fallback: descend clearZ->cutZ along the lead-in points at plunge feed
          let ff=true;
          for(let i=1;i<=re;i++){ const p=pts[i]; const z=clear+(cutZ-clear)*p.ramp;
            const f=ff?` F${fmtF(op.plunge,P.feedDecimals)}`:''; ff=false;
            L.push(`G1 ${X(p.x)} ${Y(p.y)} ${Z(fmtNum(z,dp))}${f}`); cur={x:p.x,y:p.y}; }
          const f=ff?` F${fmtF(op.plunge,P.feedDecimals)}`:'';   // move onto the contour start at full depth
          L.push(`G1 ${X(cs.x)} ${Y(cs.y)} ${Z(fmtNum(cutZ,dp))}${f}`); cur={x:cs.x,y:cs.y};
        }
        curTab=!!cs.tab; runStart=re+1; firstFeed=leadFirstFeed;   // resume at cut feed around the contour
        for(let i=re+2;i<pts.length;i++){ if(!!pts[i].tab!==curTab){ flushRun(runStart,i); L.push(`G1 ${Z(fmtNum(pts[i].tab?tabZ:cutZ,dp))}`); curTab=!!pts[i].tab; runStart=i; } }
        flushRun(runStart, pts.length-1);
      } else {
        L.push(`G1 ${Z(fmtNum(cutZ,dp))} F${fmtF(op.plunge,P.feedDecimals)}`); // plunge (FIRST_FEED_MOVE)
        for(let i=1;i<pts.length;i++){
          if(!!pts[i].tab!==curTab){
            // flush the run up to i at current Z, then change Z
            flushRun(runStart,i);
            L.push(`G1 ${Z(fmtNum(pts[i].tab?tabZ:cutZ,dp))}`);
            curTab=!!pts[i].tab; runStart=i;
          }
        }
        flushRun(runStart, pts.length-1);
      }
      L.push(`G0 ${Z(fmtNum(clear,dp))}`);   // retract
    });
  });
  P.footer(L,job,P);
  return L.join(P.eol);
}

const POSTS={
  // Exact match to Dan's Vectric post: ShopSabre_DC_ATC_speed_arc_inch.pp
  shopsabre:{
    name:'ShopSabre DC ATC Speed Arc (inch)', decimals:4, feedDecimals:1, eol:'\r\n',
    safeZ:2.0, parkX:0.0, parkY:115.0, warmupDwell:4, arcs:true, arcTol:0.0015, helical:true,
    axisFmt:(a,v,dp)=>`${a}${(Math.abs(v)<1e-9?0:v).toFixed(dp)}`,
    header(L){ L.push('G90'); L.push(''); },
    // HEADER tool block (isFirst, has Z2 + feed line) vs TOOLCHANGE (no Z2/feed)
    opStart(L,op,P,isFirst){
      L.push('M5'); L.push('M51');
      L.push(`T${op.toolNum}`);
      if(isFirst) L.push('Z2');
      L.push(`S${Math.round(op.rpm)}`);
      L.push('M3');
      L.push(`g4 x ${P.warmupDwell}`);
      L.push('M50');
      if(isFirst){ L.push(''); L.push(`F${(op.feed).toFixed(P.feedDecimals)}`); }
    },
    footer(L,job,P){
      L.push('');
      L.push(`G0 Z${P.safeZ.toFixed(P.decimals)}`);
      L.push(`G0 X${P.parkX.toFixed(P.decimals)} Y${P.parkY.toFixed(P.decimals)}`);
      L.push('');
      L.push('M5'); L.push('m51');
    }
  },
  // Generic ISO post (M6 tool change, M30 end) for other controllers.
  generic:{
    name:'Generic ISO (inch)', decimals:4, feedDecimals:1, eol:'\n', safeZ:0.5, helical:true,
    axisFmt:(a,v,dp)=>`${a}${(Math.abs(v)<1e-9?0:v).toFixed(dp)}`,
    header(L,job){L.push('%');if(job.name)L.push(`(${job.name})`);L.push('G20');L.push('G90');L.push('G17');L.push('G40');},
    opStart(L,op){L.push('');L.push(`T${op.toolNum} M6`);L.push(`S${Math.round(op.rpm)} M3`);L.push('G0 Z0.5000');},
    footer(L){L.push('');L.push('M5');L.push('M30');L.push('%');}
  }
};

// ---------- material-removal simulation (z-buffer heightfield) ----------
// Flat stock (top surface Z=0, bottom Z=-thickness) as a grid of surface heights; each cutting
// move subtracts a swept tool profile (flat/ball/V), lowering cells to min(current, tool surface).
// Pure + deterministic: the UI shades the returned heightfield; tests read it via stockHeightAt.
function _simKernel(tool, R, res) {
  const rad = Math.max(1, Math.round(R / res)), size = 2 * rad + 1;
  const off = new Float32Array(size * size), mask = new Uint8Array(size * size);
  const type = (tool && tool.type) || 'flat';
  const half = ((tool && tool.angle) || 90) * Math.PI / 360, tanh = Math.tan(half);
  for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
    const d = Math.hypot(di, dj) * res, idx = (dj + rad) * size + (di + rad);
    if (d > R + 1e-9) { mask[idx] = 0; continue; }
    mask[idx] = 1;
    if (type === 'ball') off[idx] = R - Math.sqrt(Math.max(0, R * R - d * d));   // hemisphere bottom
    else if (type === 'v') off[idx] = tanh > 1e-6 ? d / tanh : 0;                 // cone rises d/tan(half) above tip
    else off[idx] = 0;                                                            // flat bottom
  }
  return { rad: rad, size: size, off: off, mask: mask };
}
function simulateStock(o) {
  const res = o.res || 0.05, x0 = o.x0 || 0, y0 = o.y0 || 0, w = o.w || 1, h = o.h || 1;
  const thickness = o.thickness || 0.5, floor = -Math.abs(thickness);
  const nx = Math.max(1, Math.ceil(w / res)), ny = Math.max(1, Math.ceil(h / res));
  const z = new Float32Array(nx * ny);   // 0 = uncut top
  for (const cut of (o.cuts || [])) {
    const tool = cut.tool || { type: 'flat', radius: 0.125 };
    const R = Math.max(res, tool.radius || 0.125);
    const k = _simKernel(tool, R, res), rad = k.rad, size = k.size, off = k.off, mask = k.mask;
    for (const s of (cut.segs || [])) {
      if (s.z0 >= 0 && s.z1 >= 0) continue;                         // pure rapid above stock — no cut
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len / (res * 0.8)));
      for (let step = 0; step <= n; step++) {
        const t = n ? step / n : 0, px = s.x0 + dx * t, py = s.y0 + dy * t, pz = s.z0 + (s.z1 - s.z0) * t;
        if (pz >= 0) continue;
        const ci = Math.floor((px - x0) / res), cj = Math.floor((py - y0) / res);
        for (let dj = -rad; dj <= rad; dj++) { const jj = cj + dj; if (jj < 0 || jj >= ny) continue; const kr = (dj + rad) * size;
          for (let di = -rad; di <= rad; di++) { const ii = ci + di; if (ii < 0 || ii >= nx) continue; const ki = kr + (di + rad); if (!mask[ki]) continue;
            let surf = pz + off[ki]; if (surf < floor) surf = floor;
            const zi = jj * nx + ii; if (surf < z[zi]) z[zi] = surf; } }
      }
    }
  }
  return { nx: nx, ny: ny, res: res, x0: x0, y0: y0, w: w, h: h, thickness: thickness, floor: floor, z: z };
}
// Estimate machining time (seconds) from backplot segments {x0,y0,z0,x1,y1,z1,rapid} and rates (in/min).
// G0 rapids at `rapid`; pure Z-down moves at `plunge`; all other cutting moves at `feed`. 3D lengths.
function estimateTime(segs, rates) {
  rates = rates || {};
  const feed = rates.feed || 120, plunge = rates.plunge || 40, rapid = rates.rapid || 300;
  let min = 0, feedD = 0, plungeD = 0, rapidD = 0;
  for (const s of (segs || [])) {
    const dxy = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), dz = s.z1 - s.z0, d3 = Math.hypot(dxy, dz);
    if (s.rapid) { rapidD += d3; min += d3 / rapid; }
    else if (dxy < 1e-6 && dz < 0) { const dd = Math.abs(dz); plungeD += dd; min += dd / plunge; }
    else { feedD += d3; min += d3 / feed; }
  }
  return { seconds: min * 60, minutes: min, feedDist: feedD, plungeDist: plungeD, rapidDist: rapidD };
}
function stockHeightAt(field, x, y) {
  const i = Math.floor((x - field.x0) / field.res), j = Math.floor((y - field.y0) / field.res);
  if (i < 0 || i >= field.nx || j < 0 || j >= field.ny) return 0;
  return field.z[j * field.nx + i];
}

return {SCALE,TOL,dist,signedArea,isCCW,ensureCCW,ensureCW,boundsOf,assembleContours,offsetLoop,withTabs,fitArcs,profileOp,pocketOp,drillOp,vcarveOp,centroid,defaultTools,upsertTool,removeTool,slugId,orderPasses,postProcess,POSTS,simulateStock,stockHeightAt,estimateTime};
});
