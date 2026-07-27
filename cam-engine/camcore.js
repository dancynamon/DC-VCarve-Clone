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
// Clipper's offset output begins at an arbitrary vertex, so without this the entry
// point - and with it the plunge, the lead-in and the tab phase - lands somewhere
// unrelated to the vector the operator actually drew. Rotate a closed loop to start
// at the point nearest `ref`, which is what Vectric does and what the operator expects.
// Snapping to the nearest existing vertex cannot land on the true entry point: the
// offset loop is a chorded approximation, so its vertices straddle it. Project onto the
// nearest SEGMENT and insert that point, so we enter where Vectric does rather than up
// to half a chord away.
function rotateLoopTo(loop, ref){
  if(!loop || loop.length<2 || !ref) return loop;
  const n=loop.length;
  let bi=0, bt=0, bd=Infinity;
  for(let i=0;i<n;i++){
    const a=loop[i], b=loop[(i+1)%n];
    const dx=b.x-a.x, dy=b.y-a.y, L2=dx*dx+dy*dy;
    let t = L2>1e-18 ? ((ref.x-a.x)*dx+(ref.y-a.y)*dy)/L2 : 0;
    t = t<0?0:(t>1?1:t);
    const px=a.x+dx*t-ref.x, py=a.y+dy*t-ref.y, d=px*px+py*py;
    if(d<bd){ bd=d; bi=i; bt=t; }
  }
  const a=loop[bi], b=loop[(bi+1)%n];
  const P={x:a.x+(b.x-a.x)*bt, y:a.y+(b.y-a.y)*bt};
  const out=[P];
  for(let k=1;k<=n;k++){                      // loop[bi+1] .. loop[bi], wrapping
    const p=loop[(bi+k)%n];
    if(Math.hypot(p.x-P.x,p.y-P.y)>1e-9) out.push(p);
  }
  return out;
}
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
  const co=new ClipperLib.ClipperOffset(2, 0.0005*SCALE);
  const path=loop.map(p=>new ClipperLib.IntPoint(Math.round(p.x*SCALE),Math.round(p.y*SCALE)));
  const jt = joinType==='miter'?ClipperLib.JoinType.jtMiter : joinType==='square'?ClipperLib.JoinType.jtSquare : ClipperLib.JoinType.jtRound;
  co.AddPath(path, jt, ClipperLib.EndType.etClosedPolygon);
  const sol=new ClipperLib.Paths();
  co.Execute(sol, delta*SCALE);
  return sol.map(p=>p.map(pt=>({x:pt.X/SCALE,y:pt.Y/SCALE})));
}

// Offset an OPEN path to one side. Clipper's offsetter only closes open paths into a
// ribbon, so profileOp fell back to cutting every open contour ON the line regardless of
// side - which is wrong for a separation cut, where Vectric offsets by the tool radius so
// the kerf falls on the waste side. delta>0 offsets to the RIGHT of travel.
// Vertices are mitred: the offset point sits on the bisector at 1/cos(half-angle).
function offsetOpenPath(pts, delta){
  const n=pts.length;
  if(n<2 || !delta) return pts.map(p=>({x:p.x,y:p.y}));
  const seg=[], dir=[];
  for(let i=0;i<n-1;i++){
    const dx=pts[i+1].x-pts[i].x, dy=pts[i+1].y-pts[i].y, L=Math.hypot(dx,dy)||1;
    dir.push({x:dx/L, y:dy/L});
    seg.push({x:dy/L, y:-dx/L});                     // right-hand normal of this segment
  }
  const r=Math.abs(delta);
  // sagitta-limited step for the round joins below, so fitArcs can recover them as one arc
  const step=r>0.0005 ? 2*Math.acos(Math.max(-1,Math.min(1,1-0.0005/r))) : Math.PI;
  const out=[];
  out.push({x:pts[0].x+seg[0].x*delta, y:pts[0].y+seg[0].y*delta});
  for(let i=1;i<n-1;i++){
    const a=seg[i-1], b=seg[i];
    // On the OUTSIDE of a turn the two offset segments pull apart, and the tool sweeps an arc
    // about the vertex to get from one to the other. Mitring instead runs the tool out to a
    // sharp point the cutter never actually traces - lgc-50-board-3's first cross-cut came out
    // 5.92" long where Vectric's is 5.84", and Vectric emits that corner as a G3. Closed
    // contours already get round joins (Clipper joinType 'round'); this matches open ones.
    const cross=dir[i-1].x*dir[i].y - dir[i-1].y*dir[i].x;
    const outward = delta>0 ? cross>1e-12 : cross<-1e-12;
    if(outward){
      const a0=Math.atan2(a.y*delta, a.x*delta), a1=Math.atan2(b.y*delta, b.x*delta);
      let sweep=a1-a0;
      while(sweep>Math.PI) sweep-=2*Math.PI;
      while(sweep<-Math.PI) sweep+=2*Math.PI;
      const k=Math.max(1, Math.ceil(Math.abs(sweep)/step));
      for(let q=0;q<=k;q++){ const t=a0+sweep*q/k;
        out.push({x:pts[i].x+r*Math.cos(t), y:pts[i].y+r*Math.sin(t)}); }
    } else {
      const sx=a.x+b.x, sy=a.y+b.y, L2=sx*sx+sy*sy;
      if(L2<1e-12) out.push({x:pts[i].x+b.x*delta, y:pts[i].y+b.y*delta});   // 180 deg reversal
      else out.push({x:pts[i].x+2*sx/L2*delta, y:pts[i].y+2*sy/L2*delta});   // mitre on the inside
    }
  }
  out.push({x:pts[n-1].x+seg[n-2].x*delta, y:pts[n-1].y+seg[n-2].y*delta});
  return out;
}

// open=true distributes tabs along an unclosed path (a separation cut still needs holding
// tabs); the segment walk then stops at the last vertex instead of wrapping to the first.
function withTabs(loop, count, tabLen, open){
  if(!count||count<1||!tabLen) return loop.map(p=>({x:p.x,y:p.y,tab:false}));
  const n=loop.length, segLen=[]; let total=0;
  const segs = open ? n-1 : n;
  for(let i=0;i<segs;i++){const a=loop[i],b=loop[(i+1)%n];const L=dist(a,b);segLen.push(L);total+=L;}
  if(total===0) return loop.map(p=>({x:p.x,y:p.y,tab:false}));
  const centers=[]; for(let k=0;k<count;k++) centers.push((k+0.5)/count*total);
  const half=Math.min(tabLen, total/count*0.9)/2;
  const iv=centers.map(c=>[c-half,c+half]);
  function inTab(pos){for(const [s,e] of iv){let a=((s%total)+total)%total,b=((e%total)+total)%total;if(a<=b){if(pos>=a&&pos<=b)return true;}else{if(pos>=a||pos<=b)return true;}}return false;}
  const out=[]; let acc=0;
  for(let i=0;i<segs;i++){
    const a=loop[i],b=loop[(i+1)%n],L=segLen[i];
    out.push({x:a.x,y:a.y,tab:inTab(acc)});
    const steps=Math.max(1,Math.ceil(L/0.02));
    for(let s=1;s<steps;s++){
      const t=s/steps,pos=acc+L*t,cur=inTab(pos),prev=inTab(acc+L*(s-1)/steps);
      if(cur!==prev) out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,tab:cur});
    }
    acc+=L;
  }
  if(open) out.push({x:loop[n-1].x, y:loop[n-1].y, tab:false});   // segment walk stops one short
  return out;
}

// ---- lead-in / lead-out (tangential arc or line) for closed cut loops ----
function _unit(v){ const m=Math.hypot(v.x,v.y)||1; return {x:v.x/m,y:v.y/m}; }
function _rot(v,a){ const c=Math.cos(a),s=Math.sin(a); return {x:v.x*c-v.y*s, y:v.x*s+v.y*c}; }
// Walk forward along a closed loop from index 0 by `dist`, returning the points crossed
// (excluding the start) and the travel direction where it stops. Used for the lead-out
// overcut: Vectric carries on past the contour start before departing, so the entry mark
// is machined away by the finish of the same pass.
function walkLoop(loop, dist){
  const n=loop.length, pts=[]; let acc=0;
  for(let k=0;k<n;k++){
    const a=loop[k%n], b=loop[(k+1)%n];
    const L=Math.hypot(b.x-a.x,b.y-a.y);
    if(L<1e-12) continue;
    if(acc+L>=dist-1e-12){
      const t=(dist-acc)/L;
      pts.push({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
      return {pts, dir:_unit({x:b.x-a.x,y:b.y-a.y})};
    }
    acc+=L; pts.push({x:b.x,y:b.y});
  }
  const a=loop[0], b=loop[1%n];
  return {pts, dir:_unit({x:b.x-a.x,y:b.y-a.y})};
}
// loop: ordered closed-loop points (no repeated closing pt). sideSign +1=left of travel, -1=right.
// angleDeg tilts a LINE lead off the tangent (Vectric's linear leads come in at 15 deg, not
// collinear); overcut carries the cut past the start before the lead-out departs.
// returns {pre:[pts before loop start], over:[pts past the close], post:[pts after]} or null.
function leadFor(loop, type, len, sideSign, angleDeg, overcut){
  if(type==='none' || !(len>0) || !loop || loop.length<3) return null;
  const bb=boundsOf([loop]); if(Math.min(bb.maxX-bb.minX, bb.maxY-bb.minY) < 2*len) return null;  // too small
  const P0=loop[0], P1=loop[1], Pn=loop[loop.length-1];
  const dirIn=_unit({x:P1.x-P0.x,y:P1.y-P0.y});      // cut direction leaving the start
  const dirOut=_unit({x:P0.x-Pn.x,y:P0.y-Pn.y});     // cut direction arriving back at the start
  const pre=[], post=[], N=10, Q=Math.PI/2;
  // carry the cut past the start, then depart from wherever that lands
  let over=[], exit=P0, exitDir=dirOut;
  if(overcut>0){ const w=walkLoop(loop, overcut); over=w.pts; if(over.length){ exit=over[over.length-1]; exitDir=w.dir; } }
  if(type==='line'){
    const th=(angleDeg||0)*Math.PI/180;
    // tilt away from the material: -sideSign keeps the lead on the non-gouging side
    const aIn=_rot(dirIn, -sideSign*th), aOut=_rot(exitDir, sideSign*th);
    pre.push({x:P0.x-aIn.x*len, y:P0.y-aIn.y*len});
    post.push({x:exit.x+aOut.x*len, y:exit.y+aOut.y*len});
  } else {  // arc: quarter circle tangent to the path, curving to side sideSign
    const nIn=_rot(dirIn, sideSign*Q), C=({x:P0.x+nIn.x*len, y:P0.y+nIn.y*len});
    const aEnd=Math.atan2(P0.y-C.y,P0.x-C.x), aStart=aEnd-sideSign*Q;
    for(let i=0;i<N;i++){ const a=aStart+sideSign*Q*(i/N); pre.push({x:C.x+len*Math.cos(a), y:C.y+len*Math.sin(a)}); }
    const nOut=_rot(exitDir, sideSign*Q), C2=({x:exit.x+nOut.x*len, y:exit.y+nOut.y*len});
    const a0=Math.atan2(exit.y-C2.y,exit.x-C2.x);
    for(let i=1;i<=N;i++){ const a=a0+sideSign*Q*(i/N); post.push({x:C2.x+len*Math.cos(a), y:C2.y+len*Math.sin(a)}); }
  }
  return {pre, over, post};
}
// wrap a tabbed closed loop with leads. sideSign chosen by caller (non-gouging side).
// rampLen>0 tags lead-in points with a ramp fraction (0=clearZ .. 1=cutZ) for a Z ramp-in (postProcess interpolates).
// Returns {path, closed, skipped}.
function wrapLead(orientedLoop, tabbedPts, type, len, sideSign, rampLen, angleDeg, overcut){
  if(type==='none' || !(len>0)) return {path:tabbedPts, closed:true};
  const lead=leadFor(orientedLoop, type, len, sideSign, angleDeg, overcut);
  if(!lead) return {path:tabbedPts, closed:true, skipped:true};
  const tag=p=>({x:p.x,y:p.y,tab:false});
  let pre;
  if(rampLen>0){
    // tag each lead-in point with a ramp fraction (0=clearZ .. 1=cutZ) over rampLen; clamped to 1 (descent done).
    // If rampLen >= the lead-in length, no point reaches 1 -> the ramp spans the whole lead-in (single descending helix).
    const cum=[0]; for(let i=1;i<lead.pre.length;i++) cum[i]=cum[i-1]+Math.hypot(lead.pre[i].x-lead.pre[i-1].x, lead.pre[i].y-lead.pre[i-1].y);
    pre = lead.pre.map((p,i)=>({x:p.x,y:p.y,tab:false, ramp:Math.min(1, cum[i]/rampLen)}));
  } else pre=lead.pre.map(tag);
  const close0={x:tabbedPts[0].x, y:tabbedPts[0].y, tab:tabbedPts[0].tab};   // re-close the loop
  const over=(lead.over||[]).map(tag);                                       // carry past the start
  return {path: pre.concat(tabbedPts, [close0], over, lead.post.map(tag)), closed:false};
}

// Where the offset loop should be entered, given the source vector's start vertex.
// At a convex corner the offset is an arc centred on that vertex, so EVERY point of it is
// exactly one tool-radius away and "nearest point" is degenerate - picking by distance
// alone lands somewhere arbitrary on the arc. Vectric enters along the corner's outward
// bisector, which is also the plain normal on a smooth span, so this covers both.
function entryTarget(pts, delta){
  const n=pts.length; if(n<3) return pts[0];
  const v=pts[0], p=pts[n-1], q=pts[1];
  const d1=_unit({x:v.x-p.x,y:v.y-p.y}), d2=_unit({x:q.x-v.x,y:q.y-v.y});
  const ccw=signedArea(pts)>0;
  const nrm=d=>ccw?{x:d.y,y:-d.x}:{x:-d.y,y:d.x};      // outward = right of travel when CCW
  const s={x:nrm(d1).x+nrm(d2).x, y:nrm(d1).y+nrm(d2).y};
  if(Math.hypot(s.x,s.y)<1e-9) return v;               // 180 deg reversal: no meaningful bisector
  const b=_unit(s);
  return {x:v.x+b.x*delta, y:v.y+b.y*delta};
}
function pointInLoop(pt, loop){
  let inside=false;
  for(let i=0,j=loop.length-1;i<loop.length;j=i++){
    const a=loop[i], b=loop[j];
    if(((a.y>pt.y)!==(b.y>pt.y)) && (pt.x < (b.x-a.x)*(pt.y-a.y)/((b.y-a.y)||1e-18)+a.x)) inside=!inside;
  }
  return inside;
}
// Vectric cuts contained contours BEFORE the contour that holds them - cutting the sheet
// perimeter first would free the whole panel and every part with it - and then tours what
// is left nearest-neighbour to cut rapid travel. We did neither: passes came out in raw
// DXF order, which on the 20-piece jig put the outer boundary first.
// Vectric orders a set of parallel cuts as an ASCENDING SWEEP that wraps: sort by the
// cut's Y, start at one of them, run to the top, then wrap to the bottom and continue.
// Verified against all five LGC boards (4, 4, 5, 7 and 4 cuts). Nearest-neighbour was
// wrong in principle and only coincided on the 4-cut boards, where a mid-board start
// happens to tour the same way; with 5 and 7 cuts it diverges immediately.
// Only the wrap point is a free parameter - everything after it is determined.
function sweepContours(contours, start){
  const y0=(start&&start.y)||0;
  const keyed=contours.map((c,i)=>({c, y:centroid(c.pts).y, i}));
  keyed.sort((a,b)=>a.y-b.y || a.i-b.i);
  let k=0, bd=Infinity;
  for(let j=0;j<keyed.length;j++){ const d=Math.abs(keyed[j].y-y0); if(d<bd){ bd=d; k=j; } }
  return keyed.slice(k).concat(keyed.slice(0,k)).map(o=>o.c);
}
function orderContours(contours, start){
  const n=contours.length;
  const bb=contours.map(c=>boundsOf([c.pts]));
  const inside=(i,j)=>{
    if(i===j || !contours[j].closed) return false;
    const a=bb[i], b=bb[j];
    if(!(a.minX>=b.minX && a.maxX<=b.maxX && a.minY>=b.minY && a.maxY<=b.maxY)) return false;
    return pointInLoop(contours[i].pts[0], contours[j].pts);
  };
  const depth=[];
  for(let i=0;i<n;i++){ let d=0; for(let j=0;j<n;j++) if(inside(i,j)) d++; depth.push(d); }
  const out=[]; let cur=start||{x:0,y:0};
  for(const L of [...new Set(depth)].sort((a,b)=>b-a)){        // innermost first
    const pool=[]; for(let i=0;i<n;i++) if(depth[i]===L) pool.push(i);
    // Greedy nearest-neighbour, measured to the NEAREST POINT of each candidate contour
    // rather than to its first vertex - the entry point is free to be anywhere on the
    // loop, so first-vertex distance ranks candidates wrongly and ties break arbitrarily.
    while(pool.length){
      let bi=0, bd=Infinity, bp=null;
      for(let k=0;k<pool.length;k++){
        const pts=contours[pool[k]].pts;
        for(const p of pts){
          const d=(p.x-cur.x)*(p.x-cur.x)+(p.y-cur.y)*(p.y-cur.y);
          if(d<bd){ bd=d; bi=k; bp=p; }
        }
      }
      const pick=pool.splice(bi,1)[0];
      out.push(contours[pick]); if(bp) cur={x:bp.x,y:bp.y};
    }
  }
  return out;
}

/* serpentineDirs(contours) -> Map<contour, +1 | -1 | 0>

   Which way each open cut travels: +1 left-to-right, -1 right-to-left, 0 lengthwise
   (down the board). The kerf is always to the RIGHT of travel, so this also decides which
   side of the line the offset lands on - get it backwards and the cut is a full tool-width
   out of position.

   Measured across all 21 cross-cuts of the five LGC-50 boards, the rule is:

     the bottom-most cut runs LEFT TO RIGHT, and each successive cut UP THE BOARD reverses.

   The alternation is by POSITION UP THE BOARD, not by the order the cuts are made in.
   That distinction is the whole thing. The tour is an ascending-Y sweep that starts
   mid-board and wraps (see sweepContours), so cut order and bottom-to-top order are not the
   same list - and alternating in cut order gets boards 1, 2, 4 and 5 right by coincidence
   (their wraps happen to fall where the parity works out) while getting board 3's first two
   cuts backwards. Alternating by position is right on all five.

   A LENGTHWISE contour - one whose ends differ more in Y than in X - is not part of the
   serpentine at all. It is not a cross-cut, it has no left or right, and letting it consume
   an alternation slot shifts the parity of everything after it.

   Rank over the WHOLE DRAWING, not one toolpath's contours (`serpentineOver`). Direction
   belongs to where a cut sits on the board, not to which tool makes it: on lgc-50-board-4
   the shallow T5 op and the through-cutting T3 op both cut contours 4 and 5, and both run
   them right-to-left. Ranking within the T5 op alone would make its lower cut the
   bottom-most one and send it left-to-right - a cut a full tool-width off position. */
function serpentineDirs(contours){
  const dir = new Map();
  const ends = c => [c.pts[0], c.pts[c.pts.length-1]];
  const cross = [];
  for(const c of contours||[]){
    if(c.closed) continue;
    const [a,b]=ends(c);
    if(Math.abs(b.x-a.x) >= Math.abs(b.y-a.y)) cross.push(c); else dir.set(c,0);
  }
  const midY = c => { const bb=boundsOf([c.pts]); return (bb.minY+bb.maxY)/2; };
  cross.sort((u,v)=>midY(u)-midY(v));
  cross.forEach((c,i)=>dir.set(c, i%2===0 ? +1 : -1));
  return dir;
}

function profileOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.25,side:'outside',climb:true,topZ:0,cutDepth:0.25,passDepth:0.125,safeZ:0.25,feed:120,plunge:40,rpm:18000,tabs:{count:0,length:0.4,height:0.06},joinType:'round',leadType:'none',leadLen:0.25,rampLen:0,leadAngle:0,overcut:0,order:'source',entry:'source',openSide:'on',reverseOpen:false,serpentineOver:null,arcs:null},opts||{});
  const r=o.toolDia/2, warnings=[], passesAll=[]; let leadSkipped=false;
  const depths=[]; let d=Math.min(o.passDepth,o.cutDepth);
  while(d<o.cutDepth-1e-9){depths.push(d);d+=o.passDepth;} depths.push(o.cutDepth);
  const seq = o.order==='sweep' ? sweepContours(contours, o.orderStart)
            : o.order==='optimize' ? orderContours(contours, o.orderStart) : contours;
  let prevEntry = o.orderStart || {x:0,y:0}, prevDir = null;
  const serpDir = o.entry==='serpentine' ? serpentineDirs(o.serpentineOver||contours) : null;
  for(const c of seq){
    let loops;
    if(!c.closed){
      // Open contour: cut on the line, or offset to one side by the tool radius.
      // With entry:'nearest', travel runs from whichever END is closer to where the tool
      // just left - which makes consecutive cuts alternate direction (a serpentine) and
      // is exactly what Vectric does. Direction also decides which side the offset lands,
      // since the offset is always to the RIGHT of travel.
      let src = c.pts;
      if(o.entry==='serpentine'){
        const a=src[0], b=src[src.length-1], want=serpDir.get(c);
        if(want===0){ if(b.y>a.y) src=reversed(src); }            // lengthwise cut: runs down the board
        else if((b.x>=a.x) !== (want>0)) src=reversed(src);
      } else if(o.entry==='nearest'){
        const a=src[0], b=src[src.length-1];
        const da=(a.x-prevEntry.x)*(a.x-prevEntry.x)+(a.y-prevEntry.y)*(a.y-prevEntry.y);
        const db=(b.x-prevEntry.x)*(b.x-prevEntry.x)+(b.y-prevEntry.y)*(b.y-prevEntry.y);
        if(db<da) src=reversed(src);
      } else if(o.reverseOpen) src=reversed(src);
      prevDir={x:src[src.length-1].x-src[0].x, y:src[src.length-1].y-src[0].y};
      const s = o.openSide==='right' ? +r : o.openSide==='left' ? -r : 0;
      const off = s ? offsetOpenPath(src, s) : src.map(p=>({x:p.x,y:p.y}));
      prevEntry={x:off[off.length-1].x, y:off[off.length-1].y};   // an open cut ends at its far end
      loops=[off];
    }
    else if(o.side==='on') loops=[c.pts];
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
        // enter where the source vector starts, not where Clipper happened to begin
        lp=rotateLoopTo(lp, o.entry==='nearest' ? prevEntry : entryTarget(c.pts, o.side==='outside'?r:-r));
        prevEntry={x:lp[0].x,y:lp[0].y};
      }
      // tabs.spacing (VCarve's "constant spacing") sizes the count from the path length
      // instead of fixing it. lgc-50-board-3 uses it: cuts of 3.5/3.6/3.6/5.8/9.0" carry
      // 1/1/1/2/3 tabs, which is round(length / 3").
      let tabCount=(o.tabs&&o.tabs.count)||0;
      if(o.tabs && o.tabs.spacing>0){
        let L=0; for(let i=0;i<lp.length-(c.closed?0:1);i++){const a=lp[i],b=lp[(i+1)%lp.length];L+=Math.hypot(b.x-a.x,b.y-a.y);}
        tabCount=Math.max(1, Math.round(L/o.tabs.spacing));
      }
      const hasTabs=tabCount>0, tabH=(o.tabs&&o.tabs.height)||0;
      const plainPts=lp.map(p=>({x:p.x,y:p.y,tab:false}));
      const tabbed=hasTabs?withTabs(lp,tabCount,o.tabs.length,!c.closed):plainPts;
      let pathTab=tabbed, pathPlain=plainPts, closed=c.closed&&o.side!=='on';
      if(closed && o.leadType && o.leadType!=='none'){
        const interiorSign=signedArea(lp)>0?1:-1;                       // left normal = interior when CCW
        const sideSign=(o.side==='outside')?-interiorSign:interiorSign; // outside profile leads away from part; inside leads into the hole
        const wl=wrapLead(lp,tabbed,o.leadType,o.leadLen,sideSign,o.rampLen,o.leadAngle,o.overcut);
        pathTab=wl.path; if(wl.skipped) leadSkipped=true;
        const wp=wrapLead(lp,plainPts,o.leadType,o.leadLen,sideSign,o.rampLen,o.leadAngle,o.overcut);
        pathPlain=wp.path; closed=wp.closed;
      }
      // A tab only bites on a pass that would cut below the tab top; shallower passes are
      // still above it and Vectric emits them untabbed. Applying tabs to every depth pass
      // produced a spurious Z lift on each one.
      const tabTopZ=o.topZ-o.cutDepth+tabH;
      depths.forEach(depth=>{
        const z=o.topZ-depth;
        const useTabs=hasTabs && z < tabTopZ-1e-9;
        passesAll.push({z,tabHeight:useTabs?tabH:0,closed,path:useTabs?pathTab:pathPlain});
      });
    }
  }
  if(leadSkipped) warnings.push('Lead-in/out skipped on a contour too small for the lead length');
  const profOp={kind:'profile',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:passesAll};
  if(o.arcs!=null) profOp.arcs=o.arcs;
  return {ops:[profOp],warnings};
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
  const co=new ClipperLib.ClipperOffset(2, 0.0005*SCALE);
  for(const path of region) co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const sol=new ClipperLib.Paths(); co.Execute(sol, delta*SCALE);
  return sol.map(fromIntPath);
}
// Boolean difference a − b of two even-odd regions (world-space loop arrays). Used for rest machining.
function regionDifference(a, b){
  if(!a || !a.length) return [];
  if(!b || !b.length) return a.slice();
  const c=new ClipperLib.Clipper();
  c.AddPaths(a.map(toIntPath), ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(b.map(toIntPath), ClipperLib.PolyType.ptClip, true);
  const sol=new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
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
  const o=Object.assign({toolNum:1,toolDia:0.25,climb:true,topZ:0,cutDepth:0.25,passDepth:0.125,safeZ:0.25,feed:120,plunge:40,rpm:18000,stepover:0.4,stepoverIn:0,allowance:0,arcs:null,pocketStyle:'offset',leadType:'none',leadLen:0.25,rampLen:0,rampEntry:false,finishDia:0,finishNum:2},opts||{});
  const r=o.toolDia/2, warnings=[];
  const loops=contours.filter(c=>c.closed && c.pts && c.pts.length>=3).map(c=>c.pts);
  if(!loops.length){ warnings.push('Pocket needs at least one closed contour'); return {ops:[{kind:'pocket',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:[]}],warnings}; }
  // stepover as fraction of dia (clamp 5%..90%) -> inches, or given directly in inches
  const so=o.stepoverIn>0 ? o.stepoverIn : Math.max(0.001, o.toolDia*Math.min(Math.max(o.stepover,0.05),0.9));
  // allowance: stock deliberately left on the pocket wall for a later finishing pass, so the
  // first ring sits allowance further in than the tool radius alone would put it
  const wallOff = r + Math.max(0, o.allowance);
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
  } else {
    // --- offset (concentric) style: rings from one tool-radius inside the wall, stepping inward until the region closes up ---
    const rings=[]; let delta=-wallOff, guard=0;
    while(guard++<5000){
      const off=offsetRegion(region, delta);
      if(!off.length) break;
      for(const lp of off) if(lp.length>=3) rings.push(lp);
      delta-=so;
    }
    if(!rings.length){ warnings.push('Tool too large to enter the pocket region'); }
    let rampEntrySkipped=false;
    if(o.linkRings){
      // Vectric cuts a concentric pocket as ONE continuous pass per depth: innermost ring
      // first, stepping outward, with a short connecting move between rings. Emitting each
      // ring as its own pass (the previous behaviour) retracts and re-plunges between every
      // ring - slow, and it leaves an entry mark on each one. lgc-50-board-3's reference has
      // 2 passes where we produced 12.
      depths.forEach(depth=>{
        const path=[];
        const srcStart=loops[0][0];
        for(let i=rings.length-1;i>=0;i--){
          const oriented=o.climb?ensureCW(rings[i]):ensureCCW(rings[i]);
          // Every ring starts on the SAME ray as the source contour's own start point, so the
          // link between rings is a clean radial step. Measured on lgc-50-board-3 and -4: all
          // six rings of the reference start at exactly the circle's first vertex angle, and
          // each link move is purely radial. Entering "nearest to where the last ring ended"
          // (the previous behaviour) drifts the entry round the pocket instead.
          const lp=rotateLoopTo(oriented,srcStart);
          for(const p of lp) path.push({x:p.x,y:p.y,tab:false});
          path.push({x:lp[0].x,y:lp[0].y,tab:false});      // close this ring before stepping out
        }
        if(path.length) passes.push({z:o.topZ-depth,tabHeight:0,closed:false,path});
      });
    } else
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
  }
  // primary (rough) op; optionally add a small-tool REST-MACHINING op that only cuts what the big tool couldn't reach
  const bigOp={kind:'pocket',toolNum:o.toolNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes,toolProfile:{type:'flat',radius:r}};
  if(o.arcs!=null) bigOp.arcs=o.arcs;
  const ops=[bigOp];
  if(o.finishDia>0 && o.finishDia<o.toolDia){
    const rs=o.finishDia/2, soS=Math.max(0.001, o.finishDia*Math.min(Math.max(o.stepover,0.05),0.9));
    // NOTE: offsetRegion takes integer Clipper paths in but returns WORLD loops out, so chained calls must re-encode
    // world loops via toIntPath. offW() does that; regionDifference already toIntPaths its (world) inputs internally.
    const offW=(worldLoops, delta)=>offsetRegion(worldLoops.map(toIntPath), delta).filter(lp=>lp.length>=3);
    // Rest area in tool-CENTER space: inside inset(region, r_small) but outside inset( opening(region, r_big), r_small )
    // = the sharp corners / narrow necks the big tool's radius rounded off. Trace it directly (boundary IS the toolpath).
    const insetBig=offsetRegion(region, -r).filter(lp=>lp.length>=3);
    const opened=insetBig.length?offW(insetBig, r):[];                    // morphological opening by r_big
    const smallCenters=offsetRegion(region, -rs).filter(lp=>lp.length>=3);
    const bigEroded=opened.length?offW(opened, -rs):[];
    let restCenters=regionDifference(smallCenters, bigEroded).filter(lp=>lp.length>=3);
    // despeckle: an opening (in-out by ~2x the offset arc tolerance) drops hair-thin numeric slivers/annuli left by
    // reconstructing the morphological opening of curved walls, keeping only real corner/neck rest areas.
    if(restCenters.length){ const cl=offW(restCenters,-0.006); restCenters=cl.length?offW(cl,0.006):[]; }
    const restPasses=[];
    depths.forEach(depth=>{
      let dd=0, g2=0;
      while(g2++<5000){
        const off=(dd<1e-9)?restCenters:offW(restCenters, -dd);
        if(!off.length) break;
        for(const lp of off) if(lp.length>=3){ const oriented=o.climb?ensureCW(lp):ensureCCW(lp); restPasses.push({z:o.topZ-depth,tabHeight:0,closed:true,path:oriented.map(p=>({x:p.x,y:p.y,tab:false}))}); }
        dd+=soS;
      }
    });
    if(restPasses.length) ops.push({kind:'pocket',toolNum:o.finishNum,rpm:o.rpm,feed:o.feed,plunge:o.plunge,safeZ:o.safeZ,topZ:o.topZ,passes:restPasses,toolProfile:{type:'flat',radius:rs}});
    else warnings.push('Finish tool: the big tool already cleared everything — no rest pass');
  }
  return {ops,warnings};
}

// ---- drill: peck-drill at the centroid of each closed contour ----
function centroid(pts){
  let A=0,cx=0,cy=0; for(let i=0,n=pts.length;i<n;i++){const a=pts[i],b=pts[(i+1)%n];const cr=a.x*b.y-b.x*a.y;A+=cr;cx+=(a.x+b.x)*cr;cy+=(a.y+b.y)*cr;}
  A/=2; if(Math.abs(A)<1e-9){ let sx=0,sy=0; for(const p of pts){sx+=p.x;sy+=p.y;} return {x:sx/pts.length,y:sy/pts.length}; }
  return {x:cx/(6*A), y:cy/(6*A)};
}
function drillOp(contours, opts){
  const o=Object.assign({toolNum:1,toolDia:0.25,topZ:0,cutDepth:0.25,peck:0,safeZ:0.25,feed:120,plunge:40,rpm:18000},opts||{});
  let points=contours.filter(c=>c.closed && c.pts && c.pts.length>=3).map(c=>centroid(c.pts));
  // order:'optimize' visits holes nearest-neighbour from orderStart. Which corner the tour
  // begins at is a real property of the job, not a free choice: lgc-50-board-1 matches
  // Vectric exactly from the origin, lgc-50-board-5 from the park position (0,115).
  if(o.order==='optimize' && points.length){
    const pool=points.slice(), tour=[];
    let cur=o.orderStart||{x:0,y:0};
    while(pool.length){
      let bi=0, bd=Infinity;
      for(let i=0;i<pool.length;i++){
        const d=(pool[i].x-cur.x)*(pool[i].x-cur.x)+(pool[i].y-cur.y)*(pool[i].y-cur.y);
        if(d<bd){ bd=d; bi=i; }
      }
      cur=pool.splice(bi,1)[0]; tour.push(cur);
    }
    points=tour;
  }
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
// A straight run of points fits an enormous circle through every sample while bowing far
// off course BETWEEN them: a flat edge posted as `G3 ... J794.4170`, a radius-794" arc
// that cut 0.3" wide of the line Vectric (and any sane post) emits as G1. Testing the
// fitted circle is the wrong question - ask whether the POINTS are collinear. If they are,
// the run is a line no matter what circle happens to pass through them.
function runIsStraight(P,i,j,tol){
  const ax=P[i].x, ay=P[i].y, dx=P[j].x-ax, dy=P[j].y-ay;
  const L=Math.hypot(dx,dy);
  if(L<1e-12) return false;
  for(let k=i+1;k<j;k++){
    if(Math.abs((P[k].x-ax)*dy-(P[k].y-ay)*dx)/L > tol) return false;   // off the chord -> real curve
  }
  return true;
}
// An arc can pass through every sample and still bow far off course between them when the
// samples are sparse: a 43" gap on a 795" radius bows 0.3". Bound the sagitta of each
// sample-to-sample chord. Kept out of arcCovers on purpose - fitSingleArc shares that and
// fits deliberately coarse helical entries, where the arc, not the polyline, is the truth.
function arcFollowsPolyline(P,i,j,arc,tol){
  const r=Math.hypot(P[i].x-arc.cx, P[i].y-arc.cy);
  if(!(r>0)) return false;
  for(let k=i+1;k<=j;k++){
    const c=Math.hypot(P[k].x-P[k-1].x, P[k].y-P[k-1].y);
    if(c*c/(8*r) > tol) return false;
  }
  return true;
}
/* WE ARC-FIT THE TOOLPATH; VECTRIC APPEARS NOT TO. See fixtures/parity/ARC-FITTING.md - two
   plausible ways to close the gap were measured and both are dead ends, so do not re-run
   them: tightening `tol` makes it WORSE (a spline gets chopped into more, shorter arcs:
   4 -> 8 on lgc-50-board-4 as tol went 0.0015 -> 0.0001) while genuine arcs on xrt-50 and the
   print jig start dropping out; and a second, tighter "is it really a circle" threshold fails
   too, because a densely sampled spline IS locally circular to any precision you ask for -
   the fit just shortens. The difference is not tolerance and not fit quality. */
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
      if(!(arcCovers(P,i,j,arc,tol) && Math.abs(arcSweep(P,i,j,arc))<=(270*Math.PI/180))) break;
      // Too short a span cannot tell an arc from a line, so keep growing rather than
      // bailing - only a run that stays flat all the way out is really a line.
      if(runIsStraight(P,i,j,tol)) continue;
      // Samples this far apart let the arc wander off the polyline BETWEEN them, which is
      // how a straight edge became a radius-794" arc once the span reached the next corner.
      if(!arcFollowsPolyline(P,i,j,arc,tol)) break;
      bestJ=j; bestArc=arc;
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
  const postArcs = !!P.arcs;
  const L=[];
  P.header(L,job,P);
  job.ops.forEach((op,oi)=>{
    // A post that can emit arcs still may not for every op: Vectric tessellates its pocket
    // clearing paths into short G1 runs (~100 segments round a full circle) while keeping
    // real G2/G3 on profiles. `op.arcs===false` reproduces that per-op.
    const useArcs = postArcs && op.arcs!==false;
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

return {SCALE,TOL,dist,signedArea,sweepContours,offsetOpenPath,isCCW,ensureCCW,ensureCW,boundsOf,assembleContours,offsetLoop,withTabs,fitArcs,profileOp,pocketOp,drillOp,vcarveOp,centroid,defaultTools,upsertTool,removeTool,slugId,orderPasses,postProcess,POSTS,simulateStock,stockHeightAt,estimateTime};
});
