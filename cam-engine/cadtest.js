const C=require('./cadcore.js');
let pass=0,fail=0; const ok=(n,c,x)=>{c?pass++:(fail++,console.log('  FAIL',n,x===undefined?'':JSON.stringify(x)));};
const bb=s=>C.bbox(s); const close=(a,b,t)=>Math.abs(a-b)<=(t||1e-6);

// primitives
const r=C.mkRect(0,0,4,3); ok('rect bbox',close(bb(r).maxX,4)&&close(bb(r).maxY,3));
const ci=C.mkCircle({x:5,y:5},2); const cb=bb(ci); ok('circle bbox',close(cb.minX,3)&&close(cb.maxX,7));
const li=C.mkLine({x:0,y:0},{x:3,y:4}); ok('line len pts',li.pts.length===2);

// transforms
let t=C.translate(r,10,5); ok('translate',close(bb(t).minX,10)&&close(bb(t).minY,5));
ok('translate keeps prim rect',t.prim.kind==='rect'&&close(t.prim.x,10));
let rot=C.rotate(r,0,0,Math.PI/2); ok('rotate 90 bbox',close(bb(rot).minX,-3,1e-6)&&close(bb(rot).maxY,4,1e-6),bb(rot));
let sc=C.scale(ci,5,5,2,2); ok('uniform scale circle keeps prim',sc.prim.kind==='circle'&&close(sc.prim.r,4));
let mir=C.mirror(r,'x',2); ok('mirror about x=2 bbox same',close(bb(mir).minX,0)&&close(bb(mir).maxX,4));

// offset (outward by 0.5 grows rect bbox by 0.5 each side, rounded corners)
let off=C.offsetShapes([r],0.5); let ob=C.bboxAll(off);
ok('offset out 0.5',close(ob.minX,-0.5,2e-3)&&close(ob.maxX,4.5,2e-3),ob);
let offIn=C.offsetShapes([r],-0.5); let oib=C.bboxAll(offIn);
ok('offset in 0.5',close(oib.minX,0.5,2e-3)&&close(oib.maxX,3.5,2e-3),oib);

// boolean union of two overlapping rects -> one shape, bbox spans both
let u=C.booleanOp([C.mkRect(0,0,2,2)],[C.mkRect(1,1,2,2)],'union');
ok('union -> 1 shape',u.length===1,u.length);
ok('union bbox',close(C.bboxAll(u).maxX,3)&&close(C.bboxAll(u).maxY,3));
// difference: big minus small hole -> ring (clipper returns outer + inner path)
let d=C.booleanOp([C.mkRect(0,0,4,4)],[C.mkRect(1,1,2,2)],'diff');
ok('diff yields paths',d.length>=1,d.length);

// hit test
ok('hit on edge',C.hitTest(r,{x:2,y:0.02},0.05)===true);
ok('miss off edge',C.hitTest(r,{x:2,y:1.5},0.05)===false);

// snapping: rect has 4 nodes + 4 mids
let sp=C.snapPoints(r); ok('rect snaps>=8',sp.filter(s=>s.kind==='node').length===4 && sp.some(s=>s.kind==='mid'),sp.length);
ok('circle center snap',C.snapPoints(ci).some(s=>s.kind==='center'));

// job/material rect snap points: 4 corners + 4 edge mids + center
let js=C.rectSnapPoints(0,0,24,18);
ok('rect snap corners',js.filter(s=>s.kind==='corner').length===4,js.length);
ok('rect snap mids',js.filter(s=>s.kind==='mid').length===4);
ok('rect snap center',js.some(s=>s.kind==='center'&&close(s.x,12)&&close(s.y,9)));
ok('rect snap has TR corner',js.some(s=>s.kind==='corner'&&close(s.x,24)&&close(s.y,18)));

// SVG path import (a triangle, closed)
let sv=C.svgPathToShapes('M0,0 L4,0 L2,3 Z');
ok('svg triangle closed',sv.length===1&&sv[0].closed&&sv[0].pts.length>=3,sv.length);
ok('svg triangle bbox',close(C.bbox(sv[0]).maxX,4)&&close(C.bbox(sv[0]).maxY,3));
// SVG cubic produces many pts
let sc2=C.svgPathToShapes('M0,0 C0,5 5,5 5,0');
ok('svg cubic tessellated',sc2[0].pts.length>10,sc2[0].pts.length);

// SVG full doc with y-flip
let full=C.svgToShapes('<svg viewBox="0 0 10 10" height="10"><rect x="1" y="1" width="2" height="2"/></svg>');
ok('svg rect imported',full.length===1);

// DXF export round-trips a rect (4 pts, closed flag 1)
let dxf=C.toDXF([r]); ok('dxf has LWPOLYLINE',/LWPOLYLINE/.test(dxf)); ok('dxf closed flag',/\n70\r?\n1/.test(dxf));

// SVG export
let svg=C.toSVG([r,ci]); ok('svg export has paths',(svg.match(/<path/g)||[]).length>=2);

// text -> stroke shapes, bbox height ~ requested
let tx=C.mkText(0,0,1,'AB'); let ts=C.textShapes(tx); ok('text makes strokes',ts.length>0,ts.length);
let tb=C.bbox(tx); ok('text height ~1',close(tb.maxY-tb.minY,1,0.15),tb);

// TTF outline text: simulate opentype path data — a glyph (outer 14x14 box) with a hole (inner box).
// opentype font space is y-DOWN: caps sit above the baseline at negative y. Result must flip to
// CAD y-up, scale to height H, and place left edge at x / baseline at y.
let gd='M0 0 L14 0 L14 -14 L0 -14 Z M4 -4 L4 -10 L10 -10 L10 -4 Z';
let os=C.outlineTextShapes(gd, 5, 2, 3, '0');
ok('outline yields 2 closed contours (glyph+hole)',os.length===2&&os.every(s=>s.closed),os.length);
let ob2=C.bboxAll(os);
ok('outline height == H',close(ob2.maxY-ob2.minY,3,1e-3),ob2.maxY-ob2.minY);
ok('outline placed at x (left edge)',close(ob2.minX,5,1e-3),ob2.minX);
ok('outline baseline at y',close(ob2.minY,2,1e-3),ob2.minY);
ok('outline layer set',os.every(s=>s.layer==='0'));
ok('outline empty pathdata -> []',C.outlineTextShapes('',0,0,1,'0').length===0);

// parametric editing: primParams round-trips, applyPrimParams rebuilds with new values
let pr=C.mkRect(1,2,4,3); let pp=C.primParams(pr);
ok('primParams rect',pp.kind==='rect'&&close(pp.x,1)&&close(pp.w,4)&&close(pp.h,3),JSON.stringify(pp));
let pr2=C.applyPrimParams(pr,{kind:'rect',x:0,y:0,w:6,h:5}); let pb=bb(pr2);
ok('applyPrimParams rect resizes',close(pb.maxX,6)&&close(pb.maxY,5)&&pr2.id===pr.id,JSON.stringify(pb));
let rr=C.mkRoundRect(0,0,4,3,0.5); ok('primParams roundrect r',C.primParams(rr).r===0.5);
let ci2=C.mkCircle({x:2,y:2},1); let cp=C.primParams(ci2); ok('primParams circle',cp.kind==='circle'&&close(cp.r,1));
let ci3=C.applyPrimParams(ci2,{kind:'circle',cx:5,cy:5,r:2}); ok('applyPrimParams circle keeps prim+id',ci3.prim.kind==='circle'&&close(ci3.prim.r,2)&&ci3.id===ci2.id);
let pg=C.mkPolygon({x:0,y:0},2,6,0); ok('primParams polygon sides',C.primParams(pg).n===6);
let pg2=C.applyPrimParams(pg,{kind:'polygon',cx:0,cy:0,r:2,n:8,rot:0}); ok('applyPrimParams polygon resides',pg2.prim.n===8);
let tx2=C.mkText(0,0,1,'HI'); ok('primParams text',C.primParams(tx2).text==='HI');
let tx3=C.applyPrimParams(tx2,{kind:'text',x:1,y:1,h:2,text:'YO'}); ok('applyPrimParams text',tx3.text==='YO'&&tx3.h===2&&tx3.id===tx2.id);
ok('primParams null for poly',C.primParams(C.mkPoly([{x:0,y:0},{x:1,y:0},{x:1,y:1}],true))===null);
// rotation round-trip on rect/roundrect/circle (rot stored in prim, baked into geometry about center)
ok('rect default rot 0',C.primParams(C.mkRect(0,0,3,3)).rot===0);
let rrot=C.applyPrimParams(C.mkRect(0,0,4,2),{kind:'rect',x:0,y:0,w:4,h:2,rot:Math.PI/2});
let rrb=bb(rrot);
ok('rect rot90 bbox swaps to 2x4',close(rrb.maxX-rrb.minX,2,1e-6)&&close(rrb.maxY-rrb.minY,4,1e-6),JSON.stringify(rrb));
ok('rect rot90 center kept',close((rrb.minX+rrb.maxX)/2,2,1e-6)&&close((rrb.minY+rrb.maxY)/2,1,1e-6));
let rpp=C.primParams(rrot);
ok('rect rot round-trips params',close(rpp.w,4)&&close(rpp.h,2)&&close(rpp.rot,Math.PI/2,1e-9),JSON.stringify(rpp));
let rrot2=C.applyPrimParams(rrot,rpp); let rrb2=bb(rrot2);
ok('rect rot re-apply stable',close(rrb2.maxX-rrb2.minX,2,1e-6)&&close(rrb2.maxY-rrb2.minY,4,1e-6));
let rq=C.applyPrimParams(C.mkRoundRect(0,0,4,2,0.3),{kind:'roundrect',x:0,y:0,w:4,h:2,r:0.3,rot:Math.PI/2});
ok('roundrect rot round-trips',close(C.primParams(rq).rot,Math.PI/2,1e-9)&&close(C.primParams(rq).r,0.3));
let cq=C.applyPrimParams(C.mkCircle({x:5,y:5},2),{kind:'circle',cx:5,cy:5,r:2,rot:Math.PI/4}); let cqb=bb(cq);
ok('circle rot bbox unchanged',close(cqb.minX,3,2e-3)&&close(cqb.maxX,7,2e-3),JSON.stringify(cqb));
ok('circle rot round-trips',close(C.primParams(cq).rot,Math.PI/4,1e-9));
// line rotation is a delta baked into endpoints (about midpoint), not stored
let ln=C.mkLine({x:0,y:0},{x:4,y:0});
let lrot=C.applyPrimParams(ln,{kind:'line',x1:0,y1:0,x2:4,y2:0,rot:Math.PI/2});
let lpp=C.primParams(lrot);
ok('line rot90 about midpoint',close(lpp.x1,2,1e-6)&&close(lpp.y1,-2,1e-6)&&close(lpp.x2,2,1e-6)&&close(lpp.y2,2,1e-6),JSON.stringify(lpp));
// grip-style incremental rotation (what doRotate does): primParams -> rot += delta -> applyPrimParams, keeps prim + unrotated w/h
let gbase=C.applyPrimParams(C.mkRect(0,0,4,2),{kind:'rect',x:0,y:0,w:4,h:2,rot:Math.PI/6});  // start at 30°
let gp=C.primParams(gbase); gp.rot=(gp.rot||0)+Math.PI/9;                                     // +20° via grip drag
let ginc=C.applyPrimParams(gbase, gp);
ok('grip-rot keeps rect prim',ginc.prim.kind==='rect');
ok('grip-rot accumulates rot to 50°',close(C.primParams(ginc).rot, Math.PI/6+Math.PI/9, 1e-9),C.primParams(ginc).rot);
ok('grip-rot keeps unrotated w/h',close(C.primParams(ginc).w,4)&&close(C.primParams(ginc).h,2));
let gb=bb(ginc); ok('grip-rot center kept (2,1)',close((gb.minX+gb.maxX)/2,2,1e-6)&&close((gb.minY+gb.maxY)/2,1,1e-6));
// handle-scaling preserves parametric prim (fitPrimTo): resize to a new bbox, keep editable
let sr=C.fitPrimTo(C.mkRoundRect(0,0,4,2,0.5), 0,0, 8,3, true);
ok('scale keeps roundrect prim',sr.prim.kind==='roundrect');
let srp=C.primParams(sr); ok('scale updates w/h',close(srp.w,8)&&close(srp.h,3)); ok('scale preserves r',close(srp.r,0.5));
ok('roundrect r clamps to min(w,h)/2',close(C.primParams(C.fitPrimTo(C.mkRoundRect(0,0,4,2,0.5),0,0,0.6,3,true)).r,0.3));
let pr2s=C.fitPrimTo(C.mkRect(1,1,4,4),1,1,6,2,false);
ok('scale plain rect keeps rect',pr2s.prim.kind==='rect'&&close(C.primParams(pr2s).w,6)&&close(C.primParams(pr2s).h,2));
let cu=C.fitPrimTo(C.mkCircle({x:5,y:5},2), 3,3, 6,6, true);
ok('circle uniform stays circle',cu.prim.kind==='circle'&&close(C.primParams(cu).r,3));
let ce=C.fitPrimTo(C.mkCircle({x:5,y:5},2), 1,3, 8,4, false); let cep=C.primParams(ce);
ok('circle non-uniform -> ellipse',ce.prim.kind==='ellipse'&&close(cep.rx,4)&&close(cep.ry,2)&&close(cep.cx,5)&&close(cep.cy,5),JSON.stringify(cep));
let el=C.fitPrimTo(C.mkEllipse({x:0,y:0},3,1), -4,-3, 8,6, false);
ok('ellipse scales rx/ry',el.prim.kind==='ellipse'&&close(C.primParams(el).rx,4)&&close(C.primParams(el).ry,3));
let rotR=C.applyPrimParams(C.mkRect(0,0,4,2),{kind:'rect',x:0,y:0,w:4,h:2,rot:Math.PI/6});
ok('fitPrimTo null for rotated',C.fitPrimTo(rotR,0,0,8,4,true)===null);
ok('fitPrimTo null for polygon',C.fitPrimTo(C.mkPolygon({x:0,y:0},2,6,0),0,0,4,4,true)===null);
ok('fitPrimTo null for poly',C.fitPrimTo(C.mkPoly([{x:0,y:0},{x:1,y:0},{x:1,y:1}],true),0,0,2,2,true)===null);
// fitShapeTo: generic move+scale of a non-parametric poly
let poly=C.mkPoly([{x:0,y:0},{x:2,y:0},{x:2,y:1},{x:0,y:1}],true);
let fit=C.fitShapeTo(poly,10,5,4,2); let fb=bb(fit);
ok('fitShapeTo position',close(fb.minX,10)&&close(fb.minY,5),JSON.stringify(fb));
ok('fitShapeTo size',close(fb.maxX-fb.minX,4)&&close(fb.maxY-fb.minY,2),JSON.stringify(fb));

// ---------- nesting ----------
const rects=(n,w,h)=>Array.from({length:n},()=>C.mkRect(0,0,w,h));
const overlap=(a,b)=>!(a.x+a.w<=b.x+1e-9||b.x+b.w<=a.x+1e-9||a.y+a.h<=b.y+1e-9||b.y+b.h<=a.y+1e-9);
// four 10x10 on a 24x24 sheet -> all placed on one sheet, two shelves
let n1=C.nestShapes(rects(4,10,10),{sheetW:24,sheetH:24,margin:0,spacing:0,allowRotate:false});
ok('nest places all 4',n1.placements.length===4&&n1.unplaced.length===0,JSON.stringify(n1.placements.length));
ok('nest uses 1 sheet',n1.sheets===1,n1.sheets);
ok('nest within sheet bounds',n1.placements.every(p=>p.x>=-1e-9&&p.y>=-1e-9&&p.x+p.w<=24+1e-9&&p.y+p.h<=24+1e-9));
let noOv=true; for(let i=0;i<n1.placements.length;i++)for(let j=i+1;j<n1.placements.length;j++)if(n1.placements[i].sheet===n1.placements[j].sheet&&overlap(n1.placements[i],n1.placements[j]))noOv=false;
ok('nest no overlaps',noOv);
ok('nest utilization in (0,1]',n1.utilization>0&&n1.utilization<=1&&close(n1.utilization,400/576,1e-3),n1.utilization);
// oversize part is rejected to unplaced
let n2=C.nestShapes([C.mkRect(0,0,50,2)],{sheetW:24,sheetH:24,allowRotate:false});
ok('nest oversize -> unplaced',n2.unplaced.length===1&&n2.placements.length===0&&n2.sheets===0,JSON.stringify(n2));
// six 10x10 overflow to a 2nd sheet
let n3=C.nestShapes(rects(6,10,10),{sheetW:24,sheetH:24,margin:0,spacing:0,allowRotate:false});
ok('nest overflows to 2 sheets',n3.sheets===2&&n3.placements.length===6,JSON.stringify({s:n3.sheets,p:n3.placements.length}));
// rotation: a 5x20 tall part is laid landscape (20x5) when allowed
let n4=C.nestShapes([C.mkRect(0,0,5,20)],{sheetW:24,sheetH:24,allowRotate:true});
ok('nest rotates tall part',n4.placements[0].rot===true&&close(n4.placements[0].w,20)&&close(n4.placements[0].h,5),JSON.stringify(n4.placements[0]));
// spacing respected between parts on a shelf
let n5=C.nestShapes(rects(2,10,10),{sheetW:30,sheetH:30,margin:0,spacing:2,allowRotate:false});
let xs=n5.placements.map(p=>p.x).sort((a,b)=>a-b);
ok('nest honors spacing',close(xs[1]-xs[0],12),xs);
// placeShape positions a shape's bbox min at its placement
let ps=C.placeShape(C.mkRect(0,0,4,3),{idx:0,sheet:0,x:5,y:7,w:4,h:3,rot:false});
let psb=bb(ps); ok('placeShape positions bbox',close(psb.minX,5)&&close(psb.minY,7)&&close(psb.maxX,9)&&close(psb.maxY,10),JSON.stringify(psb));
// placeShape applies 90° rotation (5w x 20h -> 20w x 5h)
let pr90=C.placeShape(C.mkRect(0,0,5,20),{idx:0,sheet:0,x:0,y:0,w:20,h:5,rot:true});
let pr90b=bb(pr90); ok('placeShape rotates 90',close(pr90b.maxX-pr90b.minX,20)&&close(pr90b.maxY-pr90b.minY,5),JSON.stringify(pr90b));
// placeShape spreads sheets left-to-right
let psp=C.placeShape(C.mkRect(0,0,4,3),{idx:0,sheet:2,x:1,y:1,w:4,h:3,rot:false},{sheetW:24,gap:6});
ok('placeShape spreads sheets',close(bb(psp).minX,1+2*(24+6)),bb(psp).minX);

// ---------- project save/load (.aqcam) ----------
{
  const docP={ shapes:[ C.mkRect(1,2,4,3), C.mkText(0,0,1,'AQ') ], layers:new Map([['0',{visible:true,color:'#9fe7ff'}],['cut',{visible:false,color:'#ffcc00'}]]) };
  const jobP={ w:24, h:18, thickness:0.5, origin:'bl', show:true };
  const opsP=[ { p:{op:'profile', toolDia:0.25, cutDepth:0.5, side:'outside'}, ids:[docP.shapes[0].id], name:'Outer profile', label:'Profile 0.25', visible:false } ];
  const json=C.projectToJSON(docP, jobP, opsP, {name:'test job', savedAt:12345, view:'preview'});
  ok('project: serializes to string', typeof json==='string' && json.length>0);
  const back=C.projectFromJSON(json);
  ok('project: shape count round-trips', back.shapes.length===2, back.shapes.length);
  ok('project: rect prim preserved', back.shapes[0].prim && back.shapes[0].prim.kind==='rect', JSON.stringify(back.shapes[0].prim));
  ok('project: rect dims preserved', close(C.primParams(back.shapes[0]).w,4)&&close(C.primParams(back.shapes[0]).h,3));
  ok('project: text shape preserved', back.shapes[1].type==='text' && back.shapes[1].text==='AQ');
  ok('project: layers round-trip', back.layers.length===2 && back.layers[1].name==='cut' && back.layers[1].visible===false, JSON.stringify(back.layers));
  ok('project: job dims', close(back.job.w,24)&&close(back.job.h,18)&&close(back.job.thickness,0.5)&&back.job.origin==='bl');
  ok('project: op params preserved', back.opsQueue.length===1 && back.opsQueue[0].p.op==='profile' && close(back.opsQueue[0].p.toolDia,0.25) && back.opsQueue[0].ids.length===1, JSON.stringify(back.opsQueue));
  ok('project: toolpath name + visible round-trip', back.opsQueue[0].name==='Outer profile' && back.opsQueue[0].visible===false, JSON.stringify(back.opsQueue[0]));
  ok('project: meta preserved', back.meta.name==='test job' && back.meta.savedAt===12345);
  ok('project: meta.view (active tab) round-trips', back.meta.view==='preview', JSON.stringify(back.meta));
  ok('project: version stamped', C.PROJECT_VERSION===JSON.parse(json).version);
  const thrw=fn=>{ try{ fn(); return false; }catch(e){ return true; } };
  ok('project: bad JSON throws', thrw(()=>C.projectFromJSON('{not json')));
  ok('project: wrong format throws', thrw(()=>C.projectFromJSON('{"format":"other","version":1,"shapes":[]}')));
  ok('project: unknown version throws', thrw(()=>C.projectFromJSON(JSON.stringify({format:'aqcam',version:99,shapes:[]}))));
  ok('project: missing shapes throws', thrw(()=>C.projectFromJSON(JSON.stringify({format:'aqcam',version:1}))));
  ok('project: empty-layers input defaults to layer 0', C.projectFromJSON(JSON.stringify({format:'aqcam',version:1,shapes:[],layers:[]})).layers[0].name==='0');
}

// ---------- bezier curves ----------
{
  // straight "curve": handles at anchors -> flattened points lie on the line y=0
  const straight=C.flattenBezier([{x:0,y:0,hx0:0,hy0:0,hx1:0,hy1:0,type:'corner'},{x:4,y:0,hx0:4,hy0:0,hx1:4,hy1:0,type:'corner'}],false);
  ok('bezier: straight stays on line', straight.every(p=>Math.abs(p.y)<1e-6) && close(straight[0].x,0) && close(straight[straight.length-1].x,4), JSON.stringify([straight[0],straight[straight.length-1]]));
  // an arch: out(1,2) / in(1,2) -> peak above the anchors
  const arch=C.flattenBezier([{x:0,y:0,hx1:1,hy1:2,hx0:0,hy0:0,type:'smooth'},{x:2,y:0,hx0:1,hy0:2,hx1:2,hy1:0,type:'smooth'}],false);
  const maxY=Math.max(...arch.map(p=>p.y));
  ok('bezier: arch rises above anchors', maxY>1 && maxY<2, maxY);
  ok('bezier: endpoints preserved', close(arch[0].x,0)&&close(arch[0].y,0)&&close(arch[arch.length-1].x,2)&&close(arch[arch.length-1].y,0));
  ok('bezier: flatten yields many pts', arch.length>6, arch.length);
  // mkBezier stores prim + flattened pts
  const bz=C.mkBezier([{x:0,y:0,hx1:1,hy1:1},{x:3,y:0,hx0:2,hy0:1}],false);
  ok('bezier: mkBezier prim kind', bz.prim.kind==='bezier' && bz.prim.nodes.length===2, JSON.stringify(bz.prim.kind));
  ok('bezier: mkBezier defaults missing handles to anchor', close(bz.prim.nodes[0].hx0,0)&&close(bz.prim.nodes[0].hy0,0));
  ok('bezier: mkBezier has flattened pts', bz.pts.length>2, bz.pts.length);
  // mirrorSmoothHandle: moving the out handle mirrors the in handle about the anchor
  const nd={x:1,y:1,hx1:2,hy1:2,hx0:9,hy0:9,type:'smooth'}; C.mirrorSmoothHandle(nd,'out');
  ok('bezier: smooth handle mirrors', close(nd.hx0,0)&&close(nd.hy0,0), JSON.stringify(nd));
  // reflowBezier re-flattens after a node edit
  bz.prim.nodes[1].y=2; C.reflowBezier(bz);
  ok('bezier: reflow updates pts endpoint', close(bz.pts[bz.pts.length-1].y,2), bz.pts[bz.pts.length-1].y);
  // transforms keep the curve editable (translate moves nodes + handles)
  const tbz=C.translate(bz,5,1);
  ok('bezier: translate keeps bezier prim + moves node', tbz.prim.kind==='bezier' && close(tbz.prim.nodes[0].x,5) && close(tbz.prim.nodes[0].y,1), JSON.stringify(tbz.prim.nodes[0]));
}

// ---------- vector validator (check vectors) ----------
{
  const rectA=C.mkRect(0,0,4,3), rectB=C.mkRect(0,0,4,3);            // duplicate of A
  const openLine=C.mkPoly([{x:0,y:0},{x:5,y:0},{x:5,y:2}],false);   // open contour
  const bowtie=C.mkPoly([{x:0,y:0},{x:2,y:2},{x:2,y:0},{x:0,y:2}],true);  // self-intersecting (closed)
  const v=C.validateShapes([rectA,rectB,openLine,bowtie]);
  ok('validate: open contour flagged', v.open.indexOf(openLine.id)>=0 && v.open.indexOf(rectA.id)<0, JSON.stringify(v.open));
  ok('validate: duplicate flagged once', v.duplicate.length===1 && v.duplicate[0]===rectB.id, JSON.stringify(v.duplicate));
  ok('validate: self-intersection flagged', v.selfIntersect.indexOf(bowtie.id)>=0, JSON.stringify(v.selfIntersect));
  ok('validate: clean rect not self-intersecting', v.selfIntersect.indexOf(rectA.id)<0);
  const clean=C.validateShapes([C.mkRect(0,0,4,3), C.mkCircle({x:10,y:10},2)]);
  ok('validate: clean set reports nothing', clean.open.length===0 && clean.duplicate.length===0 && clean.selfIntersect.length===0, JSON.stringify(clean));
}

// shapesToContoursInput for CAM
let inp=C.shapesToContoursInput([r,ci]); ok('contours input closed',inp.every(c=>c.closed));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
