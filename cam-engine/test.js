const CAM = require('./camcore.js');
let pass=0, fail=0;
function ok(name,cond,extra){ if(cond){pass++; /*console.log('  ok',name)*/} else {fail++; console.log('  FAIL',name, extra||'');} }

// ---- 1. contour assembly from loose LINE segments (a 4x3 rect, 4 separate lines, scrambled) ----
const lines = [
  {pts:[{x:4,y:0},{x:4,y:3}]},
  {pts:[{x:0,y:0},{x:4,y:0}]},
  {pts:[{x:0,y:3},{x:0,y:0}]},
  {pts:[{x:4,y:3},{x:0,y:3}]},
];
let cs = CAM.assembleContours(lines);
ok('assemble: 1 closed loop', cs.length===1 && cs[0].closed, JSON.stringify(cs.map(c=>({n:c.pts.length,closed:c.closed}))));
ok('assemble: area=12', Math.abs(cs[0].area-12)<1e-6, cs[0] && cs[0].area);

// ---- 2. already-closed polyline passes through ----
const closedPoly = [{closed:true, pts:[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]}];
let cs2 = CAM.assembleContours(closedPoly);
ok('closed poly passthrough', cs2.length===1 && cs2[0].closed && Math.abs(cs2[0].area-4)<1e-6);

// ---- 3. profile OUTSIDE: bounds grow by tool radius ----
const rectC = CAM.assembleContours(lines); // 4x3
const out = CAM.profileOp(rectC, {side:'outside', toolDia:0.25, cutDepth:0.25, passDepth:0.5, safeZ:0.25, topZ:0});
const b = CAM.boundsOf(out.ops[0].passes.map(p=>p.path));
ok('outside bounds -0.125..4.125', Math.abs(b.minX+0.125)<1e-3 && Math.abs(b.maxX-4.125)<1e-3, JSON.stringify(b));
ok('single pass (passDepth>=cutDepth)', out.ops[0].passes.length===1, out.ops[0].passes.length);

// ---- 4. profile INSIDE: bounds shrink by tool radius ----
const inn = CAM.profileOp(rectC, {side:'inside', toolDia:0.25, cutDepth:0.25, passDepth:0.5});
const bi = CAM.boundsOf(inn.ops[0].passes.map(p=>p.path));
ok('inside bounds 0.125..3.875', Math.abs(bi.minX-0.125)<1e-3 && Math.abs(bi.maxX-3.875)<1e-3, JSON.stringify(bi));

// ---- 5. inside profile with oversized tool collapses -> warning ----
const big = CAM.profileOp(rectC, {side:'inside', toolDia:5, cutDepth:0.1, passDepth:0.5});
ok('oversize inside warns', big.warnings.length>0, JSON.stringify(big.warnings));

// ---- 6. multi-pass depth count ----
const mp = CAM.profileOp(rectC, {side:'outside', toolDia:0.25, cutDepth:0.5, passDepth:0.125});
// depths: .125,.25,.375,.5 = 4 passes per loop (1 loop) -> 4
ok('multipass = 4', mp.ops[0].passes.length===4, mp.ops[0].passes.length);
ok('last pass z=-0.5', Math.abs(mp.ops[0].passes[3].z+0.5)<1e-9, mp.ops[0].passes[3].z);

// ---- 7. climb vs conventional flips orientation (outside) ----
function loopCCW(path){ const pts=path.map(p=>({x:p.x,y:p.y})); return CAM.signedArea(pts)>0; }
const climb = CAM.profileOp(rectC,{side:'outside',climb:true,toolDia:0.25,cutDepth:0.1,passDepth:0.5});
const conv  = CAM.profileOp(rectC,{side:'outside',climb:false,toolDia:0.25,cutDepth:0.1,passDepth:0.5});
ok('outside climb => CW path', loopCCW(climb.ops[0].passes[0].path)===false);
ok('outside conventional => CCW path', loopCCW(conv.ops[0].passes[0].path)===true);

// ---- 8. tabs produce raised-Z breakpoints in g-code ----
const tabbed = CAM.profileOp(rectC,{side:'outside',toolDia:0.25,cutDepth:0.25,passDepth:0.5,tabs:{count:4,length:0.4,height:0.06}});
ok('some path pts flagged tab', tabbed.ops[0].passes[0].path.some(p=>p.tab));

// ---- 9. post round-trip: generated g-code parses back to same XY bounds ----
const job = {name:'TEST RECT', units:'inch', ops: out.ops};
const gcode = CAM.postProcess(job, CAM.POSTS.shopsabre);
ok('wincnc has G90 header', /G90/.test(gcode));
ok('wincnc tool select T1 (no M6)', /\nT1\r?\n/.test(gcode) && !/T1 M6/.test(gcode));
ok('wincnc warmup g4 x 4', /g4 x 4/.test(gcode));
ok('wincnc vacuum M50/M51', /M50/.test(gcode) && /M51/.test(gcode));
ok('wincnc park X0 Y115', /G0 X0\.0000 Y115\.0000/.test(gcode));
ok('wincnc ends M5 then m51', /M5\r?\nm51\s*$/.test(gcode));
ok('wincnc NO M30', !/M30/.test(gcode));
const gGen = CAM.postProcess(job, CAM.POSTS.generic);
ok('generic has T1 M6 + M30', /T1 M6/.test(gGen) && /M30/.test(gGen));
// crude parse of X/Y from G1/G0 lines
let mnX=Infinity,mxX=-Infinity,mnY=Infinity,mxY=-Infinity;
for(const ln of gcode.split(/\r?\n/)){
  if(!/^G0?1 /.test(ln)) continue; // cut moves only (exclude rapids/park)
  const mx=ln.match(/X(-?[\d.]+)/), my=ln.match(/Y(-?[\d.]+)/);
  if(mx){const v=+mx[1]; mnX=Math.min(mnX,v); mxX=Math.max(mxX,v);}
  if(my){const v=+my[1]; mnY=Math.min(mnY,v); mxY=Math.max(mxY,v);}
}
ok('roundtrip X bounds', Math.abs(mnX+0.125)<1e-3 && Math.abs(mxX-4.125)<1e-3, `${mnX}..${mxX}`);
ok('roundtrip Y bounds', Math.abs(mnY+0.125)<1e-3 && Math.abs(mxY-3.125)<1e-3, `${mnY}..${mxY}`);

// ---- 10. circle (closed) offset both ways ----
const circ=[]; for(let i=0;i<64;i++){const a=i/64*2*Math.PI; circ.push({x:1+Math.cos(a),y:1+Math.sin(a)});}
const cc=CAM.assembleContours([{closed:true,pts:circ}]);
const co=CAM.profileOp(cc,{side:'outside',toolDia:0.5,cutDepth:0.1,passDepth:0.5});
const cb=CAM.boundsOf(co.ops[0].passes.map(p=>p.path));
ok('circle outside R grows to 1.25', Math.abs((cb.maxX-cb.minX)/2-1.25)<2e-2, (cb.maxX-cb.minX)/2);

// ---- 11. exact match to official .pp header/footer/toolchange ----
(function(){
  const rectC2 = CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]}]);
  const r = CAM.profileOp(rectC2,{side:'outside',toolNum:2,toolDia:0.25,cutDepth:0.25,passDepth:0.5,feed:120,plunge:40,rpm:18000});
  const g = CAM.postProcess({name:'X',units:'inch',ops:r.ops}, CAM.POSTS.shopsabre);
  const lines = g.split('\r\n');
  const head = lines.slice(0,12).join('|');
  const expHead = 'G90||M5|M51|T2|Z2|S18000|M3|g4 x 4|M50||F120.0';
  ok('header byte-exact to .pp', head===expHead, JSON.stringify({got:head}));
  const tail = lines.slice(-6).join('|');
  const expTail = '|G0 Z2.0000|G0 X0.0000 Y115.0000||M5|m51';
  ok('footer byte-exact to .pp', tail===expTail, JSON.stringify({got:tail}));
  // multi-op: second tool uses TOOLCHANGE (no Z2, no F line)
  const r2 = CAM.profileOp(rectC2,{side:'inside',toolNum:5,toolDia:0.25,cutDepth:0.1,passDepth:0.5,feed:90,plunge:30,rpm:12000});
  const job2 = {name:'multi',units:'inch',ops:[r.ops[0], r2.ops[0]]};
  const g2 = CAM.postProcess(job2, CAM.POSTS.shopsabre).split('\r\n');
  // find the T5 block
  const t5i = g2.findIndex(l=>l==='T5');
  const tcBlock = g2.slice(t5i-2, t5i+5).join('|'); // M5|M51|T5|S12000|M3|g4 x 4|M50
  ok('toolchange has no Z2 after T5', g2[t5i+1]==='S12000', 'got '+g2[t5i+1]);
  ok('toolchange block shape', /M5\|M51\|T5\|S12000\|M3\|g4 x 4\|M50/.test(tcBlock), tcBlock);
})();
console.log('\n(post-pp assertions added)');

// ---- 12. pocket: clears a closed rect with concentric rings ----
(function(){
  const sq = CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const pk = CAM.pocketOp(sq, {toolDia:0.5, stepover:0.5, cutDepth:0.1, passDepth:0.5, topZ:0});
  const passes = pk.ops[0].passes;
  ok('pocket produces rings', passes.length>=2, passes.length);
  // every ring stays inside the wall (tool radius 0.25 clearance)
  const pb = CAM.boundsOf(passes.map(p=>p.path));
  ok('pocket rings inside wall', pb.minX>=0.25-1e-3 && pb.maxX<=3.75+1e-3, JSON.stringify(pb));
  ok('pocket rings closed', passes.every(p=>p.closed));
  // climb -> CW rings
  ok('pocket climb CW', CAM.signedArea(passes[0].path.map(p=>({x:p.x,y:p.y})))<0);
  // multi-depth multiplies pass count
  const pk2 = CAM.pocketOp(sq, {toolDia:0.5, stepover:0.5, cutDepth:0.5, passDepth:0.25, topZ:0});
  ok('pocket multi-depth', pk2.ops[0].passes.length===passes.length*2, pk2.ops[0].passes.length);
  // oversized tool warns / no rings
  const pkBig = CAM.pocketOp(sq, {toolDia:10, cutDepth:0.1, passDepth:0.5});
  ok('pocket oversize warns', pkBig.warnings.length>0 && pkBig.ops[0].passes.length===0, JSON.stringify(pkBig.warnings));
  // pocket with an island/hole (nested loop) leaves the island uncut: ring bounds avoid the hole center
  const withHole = CAM.assembleContours([
    {closed:true,pts:[{x:0,y:0},{x:6,y:0},{x:6,y:6},{x:0,y:6}]},
    {closed:true,pts:[{x:2,y:2},{x:4,y:2},{x:4,y:4},{x:2,y:4}]}
  ]);
  const pkh = CAM.pocketOp(withHole, {toolDia:0.25, stepover:0.5, cutDepth:0.1, passDepth:0.5});
  ok('pocket with island produces rings', pkh.ops[0].passes.length>0, pkh.ops[0].passes.length);
  // no ring point should fall strictly inside the island (allowing tool radius near its wall)
  const insideIsland = pkh.ops[0].passes.some(p=>p.path.some(q=>q.x>2.3&&q.x<3.7&&q.y>2.3&&q.y<3.7));
  ok('pocket leaves island uncut', !insideIsland);
})();

// ---- 12b. raster pocket: zig-zag scan-line clearing of a 4x3 rect ----
(function(){
  const rect = CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]}]);
  const pk = CAM.pocketOp(rect, {toolDia:0.25, stepover:0.25, cutDepth:0.1, passDepth:0.5, topZ:0, pocketStyle:'raster'});
  const passes = pk.ops[0].passes;
  ok('raster pocket >10 passes', passes.length>10, passes.length);
  // every pass is an open scan-line segment (2 points), not a closed ring
  ok('raster passes are open lines', passes.every(p=>!p.closed && p.path.length===2), JSON.stringify(passes.slice(0,2)));
  // every pass midpoint lands inside a 4.1 x 3.1 bbox (the part, plus a hair of margin)
  const allInside = passes.every(p=>{ const mx=(p.path[0].x+p.path[1].x)/2, my=(p.path[0].y+p.path[1].y)/2;
    return mx>=-0.05 && mx<=4.05 && my>=-0.05 && my<=3.05; });
  ok('raster midpoints inside 4.1x3.1 bbox', allInside, JSON.stringify(CAM.boundsOf(passes.map(p=>p.path))));
  // adjacent rows lace in opposite directions (row0 left->right, row1 right->left)
  ok('raster zig-zag alternates', passes[0].path[0].x < passes[0].path[1].x && passes[1].path[0].x > passes[1].path[1].x,
     JSON.stringify([passes[0].path.map(p=>p.x), passes[1].path.map(p=>p.x)]));
  // posted g-code has both rapids (G0, retract+reposition between rows) and cuts (G1)
  const g = CAM.postProcess({name:'R',units:'inch',ops:pk.ops}, CAM.POSTS.shopsabre);
  ok('raster g-code has G0 and G1', /\bG0\b/.test(g) && /\bG1\b/.test(g), g.length);
  // default style is still concentric offset (backward compatible)
  const pkOff = CAM.pocketOp(rect, {toolDia:0.25, stepover:0.25, cutDepth:0.1, passDepth:0.5, topZ:0});
  ok('pocket defaults to offset style (closed rings)', pkOff.ops[0].passes.every(p=>p.closed));
})();

// 12c. helical (ramp) pocket entry
(function(){
  const rect = CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]}]);
  const pk = CAM.pocketOp(rect, {toolDia:0.25, stepover:0.4, cutDepth:0.2, passDepth:0.5, topZ:0, rampEntry:true});
  const p0 = pk.ops[0].passes[0];
  ok('ramp entry: first pass is open (lead-in)', p0.closed===false);
  const ramps = p0.path.filter(p=>p.ramp!=null).map(p=>p.ramp);
  ok('ramp entry: first pass has ramp-tagged points', ramps.length>=3, ramps.length);
  ok('ramp entry: ramp starts at 0', Math.abs(ramps[0])<1e-9, ramps[0]);
  ok('ramp entry: ramp climbs toward 1 (descends to depth)', Math.max(...ramps)>0.8 && Math.max(...ramps)<1, Math.max(...ramps));
  ok('ramp entry: no intermediate ramp reaches full depth (single helix)', ramps.every(r=>r<1-1e-9));
  // posted g-code: a helical G2/G3 carrying a Z word (descends while arcing)
  const g = CAM.postProcess({name:'H',units:'inch',ops:pk.ops}, Object.assign({},CAM.POSTS.shopsabre,{arcs:true,helical:true}));
  ok('ramp entry: g-code has a helical G2/G3 + Z', /\bG[23]\b[^\r\n]*\bZ-?\d/.test(g), (g.match(/G[23][^\r\n]*Z[^\r\n]*/g)||[]).slice(0,1));
  // backward compatible: without rampEntry the first pass is still a closed ring
  const pkNo = CAM.pocketOp(rect, {toolDia:0.25, stepover:0.4, cutDepth:0.2, passDepth:0.5, topZ:0});
  ok('ramp entry off by default (first pass closed)', pkNo.ops[0].passes[0].closed===true);
})();


// ---- 13. drill: one hole per closed contour at its centroid, with peck ----
(function(){
  const c1=[]; for(let i=0;i<32;i++){const a=i/32*2*Math.PI; c1.push({x:3+0.5*Math.cos(a),y:3+0.5*Math.sin(a)});}
  const c2=[]; for(let i=0;i<32;i++){const a=i/32*2*Math.PI; c2.push({x:8+0.5*Math.cos(a),y:5+0.5*Math.sin(a)});}
  const holes=CAM.assembleContours([{closed:true,pts:c1},{closed:true,pts:c2}]);
  const dr=CAM.drillOp(holes,{toolDia:0.25,cutDepth:0.3,peck:0,topZ:0});
  ok('drill 2 points',dr.points.length===2,dr.points.length);
  ok('drill centroid #1 ~ (3,3)',Math.abs(dr.points[0].x-3)<1e-2&&Math.abs(dr.points[0].y-3)<1e-2,JSON.stringify(dr.points[0]));
  ok('drill no-peck = 1 pass/hole',dr.ops[0].passes.length===2,dr.ops[0].passes.length);
  const drp=CAM.drillOp(holes,{toolDia:0.25,cutDepth:0.3,peck:0.1,topZ:0});
  // peck depths .1,.2,.3 = 3 per hole * 2 holes = 6
  ok('drill peck = 3 pecks/hole',drp.ops[0].passes.length===6,drp.ops[0].passes.length);
  ok('drill last z=-0.3',Math.abs(drp.ops[0].passes[2].z+0.3)<1e-9,drp.ops[0].passes[2].z);
  // post emits a plunge at the hole XY
  const g=CAM.postProcess({name:'D',units:'inch',ops:dr.ops},CAM.POSTS.shopsabre);
  ok('drill g-code has hole XY',/X8\.0000 Y5\.0000/.test(g),g.split(/\r?\n/).filter(l=>/X8/.test(l)).join(';'));
  ok('drill empty warns',CAM.drillOp([],{}).warnings.length>0);
})();

// ---- 14. v-carve: nested offsets deepen inward, capped at maxDepth, depth scales with bit angle ----
(function(){
  const sq=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const v=CAM.vcarveOp(sq,{bitAngle:90,step:0.05,maxDepth:0.25,topZ:0});
  ok('vcarve has passes',v.ops[0].passes.length>2,v.ops[0].passes.length);
  const zs=v.ops[0].passes.map(p=>p.z);
  ok('vcarve first pass shallow',Math.abs(zs[0]- (-0.05))<1e-6, zs[0]);       // 90deg: depth=offset=0.05
  ok('vcarve never exceeds maxDepth',zs.every(z=>z>=-0.25-1e-9), Math.min(...zs));
  ok('vcarve reaches near maxDepth',Math.min(...zs)<=-0.25+1e-9, Math.min(...zs));
  // 60deg bit cuts deeper for same offset (depth=offset/tan30 ~ 1.73x)
  const v60=CAM.vcarveOp(sq,{bitAngle:60,step:0.05,maxDepth:1,topZ:0});
  ok('vcarve 60deg deeper than 90deg at first ring',Math.abs(v60.ops[0].passes[0].z) > Math.abs(zs[0])+1e-6, v60.ops[0].passes[0].z);
  ok('vcarve 60deg first ~0.0866',Math.abs(v60.ops[0].passes[0].z+0.05/Math.tan(30*Math.PI/180))<1e-3, v60.ops[0].passes[0].z);
  // sharp V (maxDepth 0) deepest point near medial axis = half-width/tan(45)=2 for 4x4 square @90deg
  const vs=CAM.vcarveOp(sq,{bitAngle:90,step:0.05,maxDepth:0,topZ:0});
  ok('vcarve sharp deep center ~2"',Math.min(...vs.ops[0].passes.map(p=>p.z))< -1.8, Math.min(...vs.ops[0].passes.map(p=>p.z)));
  ok('vcarve empty warns',CAM.vcarveOp([],{}).warnings.length>0);
  // medial-axis depth: 2x2 square, inscribed radius 1 -> deepest = 1/tan(half) regardless of step coarseness.
  // The skeleton finishing pass reaches the true value (a pure step approach would fall step/tan(half) short).
  const sq2=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]}]);
  const m90=CAM.vcarveOp(sq2,{bitAngle:90,step:0.05,maxDepth:0,topZ:0});
  const d90=-Math.min(...m90.ops[0].passes.map(p=>p.z));
  ok('medial-axis 2x2 @90deg deepest ~1.0', Math.abs(d90-1.0)<0.01, d90);
  const m60=CAM.vcarveOp(sq2,{bitAngle:60,step:0.05,maxDepth:0,topZ:0});
  const d60=-Math.min(...m60.ops[0].passes.map(p=>p.z));
  ok('medial-axis 2x2 @60deg deepest ~1.732', Math.abs(d60-1/Math.tan(30*Math.PI/180))<0.01, d60);
  // notched (L) shape: the true max inscribed circle sits on the diagonal touching the two outer walls
  // AND the reflex corner at (1,1) -> radius c where c=sqrt2*(1-c) => c=2-sqrt2 ~ 0.5858 (a naive
  // "arm width / 2 = 0.5" guess is wrong; the medial axis reaches the concave corner). @90deg depth=radius.
  const Lshape=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:3,y:0},{x:3,y:1},{x:1,y:1},{x:1,y:3},{x:0,y:3}]}]);
  const mL=CAM.vcarveOp(Lshape,{bitAngle:90,step:0.05,maxDepth:0,topZ:0});
  const dL=-Math.min(...mL.ops[0].passes.map(p=>p.z));
  ok('medial-axis L-shape @90deg deepest ~0.586 (touches reflex corner)', Math.abs(dL-(2-Math.sqrt(2)))<0.01, dL);
  // ---- flat-depth area clearance ----
  // 4x4 @90deg would sink to ~2"; cap at flatDepth 0.5 and rough the core with a 0.25" endmill.
  const fc=CAM.vcarveOp(sq,{bitAngle:90,step:0.05,maxDepth:0,topZ:0,flatDepth:0.5,clearDia:0.25,clearNum:5,passDepth:0.25});
  ok('flat: returns two ops (endmill rough + V finish)', fc.ops.length===2, fc.ops.length);
  const endmill=fc.ops.find(op=>op.kind==='pocket'), vbit=fc.ops.find(op=>op.kind==='vcarve');
  ok('flat: endmill op is first (roughs before finishing)', fc.ops[0]===endmill && fc.ops[0].toolNum===5, fc.ops[0].kind+'#'+fc.ops[0].toolNum);
  ok('flat: endmill clears down to flat depth', endmill.passes.length>0 && Math.abs(Math.min(...endmill.passes.map(p=>p.z))+0.5)<1e-6, JSON.stringify(endmill.passes.map(p=>p.z).slice(-1)));
  ok('flat: V-bit never exceeds flat depth', vbit.passes.every(p=>p.z>=-0.5-1e-9), Math.min(...vbit.passes.map(p=>p.z)));
  ok('flat: V-bit reaches the flat depth at the core', Math.min(...vbit.passes.map(p=>p.z))<=-0.5+1e-6, Math.min(...vbit.passes.map(p=>p.z)));
  ok('flat: ops carry toolProfile for the sim', endmill.toolProfile.type==='flat' && vbit.toolProfile.type==='v', JSON.stringify([endmill.toolProfile.type,vbit.toolProfile.type]));
  // shallow shape or no clearDia -> single V op, no endmill
  const noClr=CAM.vcarveOp(sq,{bitAngle:90,step:0.05,topZ:0,flatDepth:0.5,clearDia:0});
  ok('flat: no clearDia -> single V op capped at flat', noClr.ops.length===1 && Math.min(...noClr.ops[0].passes.map(p=>p.z))>=-0.5-1e-9, noClr.ops.length);
  const deepFlat=CAM.vcarveOp(sq2,{bitAngle:90,step:0.05,topZ:0,flatDepth:5,clearDia:0.25,clearNum:5});
  ok('flat: flatDepth beyond shape depth -> no endmill core', deepFlat.ops.length===1, deepFlat.ops.length);
})();

// ---- 15. tool database CRUD ----
(function(){
  const def=CAM.defaultTools();
  ok('default tools present',def.length>=4 && def.every(t=>t.id&&t.name&&t.op),def.length);
  const added=CAM.upsertTool(def,{id:'custom-375',name:'3/8" Flat',op:'profile',toolNum:6,dia:0.375,angle:90,feed:100,plunge:35,rpm:16000});
  ok('upsert adds new',added.length===def.length+1 && added.some(t=>t.id==='custom-375'));
  const edited=CAM.upsertTool(added,{id:'custom-375',name:'3/8" Flat v2',op:'pocket',toolNum:6,dia:0.375,angle:90,feed:110,plunge:35,rpm:16000});
  ok('upsert replaces same id',edited.length===added.length && edited.find(t=>t.id==='custom-375').name==='3/8" Flat v2');
  const removed=CAM.removeTool(edited,'custom-375');
  ok('remove drops it',removed.length===def.length && !removed.some(t=>t.id==='custom-375'));
  ok('slugId',CAM.slugId('1/4" Down-cut!')==='1-4-down-cut' && CAM.slugId('')==='tool');
})();

// ---- 16. lead-in/out on profile (arc + line), 'none' unchanged ----
(function(){
  const sq=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const base=CAM.profileOp(sq,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5});           // default leadType none
  const none=CAM.profileOp(sq,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,leadType:'none'});
  const bp=base.ops[0].passes[0], np=none.ops[0].passes[0];
  ok('lead none == default (path len)', bp.path.length===np.path.length && bp.closed===true && np.closed===true, bp.path.length+'/'+np.path.length);
  const p0=np.path[0];   // contour start point
  const arc=CAM.profileOp(sq,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,leadType:'arc',leadLen:0.25});
  const ap=arc.ops[0].passes[0];
  ok('arc lead: pass is open', ap.closed===false);
  ok('arc lead: adds moves', ap.path.length > np.path.length, ap.path.length+' vs '+np.path.length);
  const idx=ap.path.findIndex(q=>Math.hypot(q.x-p0.x,q.y-p0.y)<1e-6);
  ok('arc lead: lead-in precedes contour start', idx>0, 'idx='+idx);
  ok('arc lead: lead-in start != contour start', Math.hypot(ap.path[0].x-p0.x,ap.path[0].y-p0.y)>1e-3);
  ok('arc lead: start ~ leadLen*sqrt2 from start pt', Math.abs(Math.hypot(ap.path[0].x-p0.x,ap.path[0].y-p0.y)-0.25*Math.SQRT2)<1e-6, Math.hypot(ap.path[0].x-p0.x,ap.path[0].y-p0.y));
  const line=CAM.profileOp(sq,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,leadType:'line',leadLen:0.25});
  const lp=line.ops[0].passes[0];
  ok('line lead: open + tangential', lp.closed===false);
  ok('line lead: start exactly leadLen from contour', Math.abs(Math.hypot(lp.path[0].x-p0.x,lp.path[0].y-p0.y)-0.25)<1e-9, Math.hypot(lp.path[0].x-p0.x,lp.path[0].y-p0.y));
  // too-small contour: lead skipped with warning, pass stays closed
  const tiny=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:0.3,y:0},{x:0.3,y:0.3},{x:0,y:0.3}]}]);
  const sk=CAM.profileOp(tiny,{side:'inside',toolDia:0.0625,cutDepth:0.1,passDepth:0.5,leadType:'arc',leadLen:0.5});
  ok('tiny contour: lead skipped warns', sk.warnings.some(w=>/Lead/.test(w)), JSON.stringify(sk.warnings));
  // pocket still generates with a lead
  const pk=CAM.pocketOp(sq,{toolDia:0.25,stepover:0.5,cutDepth:0.1,passDepth:0.5,leadType:'arc',leadLen:0.2});
  ok('pocket with lead generates passes', pk.ops[0].passes.length>0, pk.ops[0].passes.length);
  // arc-lead g-code still posts and re-parses to the contour bounds (lead extends beyond)
  const g=CAM.postProcess({name:'L',units:'inch',ops:arc.ops},CAM.POSTS.shopsabre);
  ok('arc lead posts with arcs', /G[23] /.test(g));
})();

// ---- 17. ramped arc lead -> single helical G2/G3+Z; line lead -> G1 ramp; helical off -> G1; rampLen=0 unchanged ----
(function(){
  const sq=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const optA={side:'outside',toolDia:0.25,cutDepth:0.5,passDepth:0.5,leadType:'arc',leadLen:0.25};
  const gA=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,Object.assign({},optA,{rampLen:0.15})).ops},CAM.POSTS.shopsabre);
  // ramped arc lead-in = a single G2/G3 line carrying both an arc (I/J) AND a Z word (helical descent)
  const helix=gA.split(/\r?\n/).filter(l=>/^G[23] /.test(l) && /I-?[\d.]/.test(l) && /J-?[\d.]/.test(l) && /Z-?[\d.]/.test(l));
  ok('arc ramp -> single helical G2/G3 with Z', helix.length===1, JSON.stringify(helix));
  ok('helical descends to cutZ -0.5', /Z-0\.5000/.test(helix[0]||''), helix[0]);
  // helical disabled on the post -> G1 ramp fallback (multiple descending Z on G1 lines)
  const gG1=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,Object.assign({},optA,{rampLen:0.15})).ops}, Object.assign({},CAM.POSTS.shopsabre,{helical:false}));
  const z1=[]; for(const l of gG1.split(/\r?\n/)){ if(!/^G1 /.test(l))continue; const m=l.match(/Z(-?[\d.]+)/); if(m)z1.push(+m[1]); }
  ok('helical off -> G1 ramp descends', z1.length>=2 && z1[0]>z1[z1.length-1]+1e-9, JSON.stringify(z1.slice(0,4)));
  ok('helical off -> no helical line', !/^G[23] [^\n]*Z/m.test(gG1));
  // line lead always G1 ramp (only 2 pts -> cannot arc-fit), even with helical post
  const gLine=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,{side:'outside',toolDia:0.25,cutDepth:0.5,passDepth:0.5,leadType:'line',leadLen:0.25,rampLen:0.2}).ops},CAM.POSTS.shopsabre);
  ok('line ramp -> G1 X Y Z (no helical with Z)', /G1 X-?[\d.]+ Y-?[\d.]+ Z-0\.5000/.test(gLine) && !/^G[23] [^\n]*Z/m.test(gLine));
  // rampLen=0 byte-identical to default lead (straight plunge, no helical)
  const gNo0=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,Object.assign({},optA,{rampLen:0})).ops},CAM.POSTS.shopsabre);
  const gDef=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,optA).ops},CAM.POSTS.shopsabre);
  ok('rampLen=0 == default + straight plunge', gNo0===gDef && /\r?\nG1 Z-0\.5000 F/.test(gNo0));
  // pocket with ramped lead still generates
  const pk=CAM.pocketOp(sq,{toolDia:0.25,stepover:0.5,cutDepth:0.3,passDepth:0.5,leadType:'arc',leadLen:0.2,rampLen:0.1});
  ok('pocket ramped lead generates', pk.ops[0].passes.length>0, pk.ops[0].passes.length);
})();

// ---- 18. helical ramp honors Ramp" length: rampLen<arc -> two arcs (descend+flat); rampLen>=arc -> single helix ----
(function(){
  const sq=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const base={side:'outside',toolDia:0.25,cutDepth:0.5,passDepth:0.5};
  const p0=CAM.profileOp(sq,Object.assign({},base,{leadType:'none'})).ops[0].passes[0].path[0];   // contour start
  const ex=l=>({x:+l.match(/X(-?[\d.]+)/)[1], y:+l.match(/Y(-?[\d.]+)/)[1]});
  // rampLen (0.15) < lead-in arc (leadLen 0.4 -> arc ~0.628) => split into two arcs
  const gS=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,Object.assign({},base,{leadType:'arc',leadLen:0.4,rampLen:0.15})).ops},CAM.POSTS.shopsabre);
  const ls=gS.split(/\r?\n/);
  const di=ls.findIndex(l=>/^G[23] /.test(l)&&/Z-?[\d.]/.test(l));   // descending helix (has Z)
  ok('split: descending helix exists', di>=0, di);
  ok('split: descending helix to cutZ', /Z-0\.5000/.test(ls[di]), ls[di]);
  ok('split: descend ends BEFORE contour start', Math.hypot(ex(ls[di]).x-p0.x, ex(ls[di]).y-p0.y)>1e-3, JSON.stringify(ex(ls[di])));
  const flat=ls[di+1];
  ok('split: flat sub-arc follows (G2/G3, no Z)', /^G[23] /.test(flat)&&!/Z-?[\d.]/.test(flat), flat);
  ok('split: flat sub-arc ends AT contour start', Math.hypot(ex(flat).x-p0.x, ex(flat).y-p0.y)<1e-3, JSON.stringify(ex(flat)));
  ok('split: exactly one Z-bearing lead arc', ls.filter(l=>/^G[23] /.test(l)&&/Z-?[\d.]/.test(l)).length===1);
  // rampLen (0.5) >= lead-in arc (leadLen 0.25 -> arc ~0.393) => single descending helix to the contour start
  const gH=CAM.postProcess({name:'x',units:'inch',ops:CAM.profileOp(sq,Object.assign({},base,{leadType:'arc',leadLen:0.25,rampLen:0.5})).ops},CAM.POSTS.shopsabre);
  const lh=gH.split(/\r?\n/); const hi=lh.findIndex(l=>/^G[23] /.test(l)&&/Z-?[\d.]/.test(l));
  ok('single: one Z-bearing helix', lh.filter(l=>/^G[23] /.test(l)&&/Z-?[\d.]/.test(l)).length===1);
  ok('single: helix ends AT contour start', Math.hypot(ex(lh[hi]).x-p0.x, ex(lh[hi]).y-p0.y)<1e-3, JSON.stringify(ex(lh[hi])));
})();

// ---- 19. multi-op job: pocket (T2) + profile-with-tabs (T1) -> one program, one HEADER, one TOOLCHANGE ----
(function(){
  const sq=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}]}]);
  const pocket=CAM.pocketOp(sq,{toolNum:2,toolDia:0.125,stepover:0.4,cutDepth:0.3,passDepth:0.25,feed:90,plunge:30,rpm:18000});
  const profile=CAM.profileOp(sq,{toolNum:1,side:'outside',toolDia:0.25,cutDepth:0.5,passDepth:0.25,feed:120,plunge:40,rpm:18000,tabs:{count:4,length:0.4,height:0.06}});
  const g=CAM.postProcess({name:'multi',units:'inch',ops:[pocket.ops[0], profile.ops[0]]}, CAM.POSTS.shopsabre);
  const lines=g.split('\r\n');
  ok('job: contains T2 and T1', lines.includes('T2') && lines.includes('T1'));
  ok('job: exactly one HEADER Z2', (g.match(/^Z2$/gm)||[]).length===1, (g.match(/^Z2$/gm)||[]).length);
  const t2i=lines.indexOf('T2'), t1i=lines.indexOf('T1');
  ok('job: T2 first (header, Z2 follows)', t2i<t1i && lines[t2i+1]==='Z2', lines[t2i+1]);
  ok('job: T1 toolchange (no Z2, S follows)', lines[t1i+1]!=='Z2' && /^S\d/.test(lines[t1i+1]||''), lines[t1i+1]);
  ok('job: single program (one G90, ends m51, no M30)', (g.match(/^G90$/gm)||[]).length===1 && /m51\s*$/.test(g) && !/M30/.test(g));
  ok('job: profile tabs present (T1 op cut)', profile.ops[0].passes[0].path.some(p=>p.tab));
})();

// 14. toolpath ordering (nearest-neighbor minimizes rapids)
(function(){
  const rectA=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]}]);
  const rectB=CAM.assembleContours([{closed:true,pts:[{x:20,y:0},{x:22,y:0},{x:22,y:2},{x:20,y:2}]}]);
  const opt={side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,leadType:'none'};
  const pA=CAM.profileOp(rectA,opt), pB=CAM.profileOp(rectB,opt);
  // naive: B (far) queued before A (origin) in one op
  const naiveJob={name:'ord',units:'inch',ops:[Object.assign({},pA.ops[0],{passes:pB.ops[0].passes.concat(pA.ops[0].passes)})]};
  const sortedJob=CAM.orderPasses(naiveJob);   // NN from (0,0) should flip to A-then-B
  // total XY travel of G0 rapids in the posted code
  const rapidLen=g=>{ let t=0,cur={x:0,y:0}; for(const ln of g.split(/\r?\n/)){ const m=ln.match(/^G0 X(-?[\d.]+) Y(-?[\d.]+)/); if(m){ const x=+m[1],y=+m[2]; t+=Math.hypot(x-cur.x,y-cur.y); cur={x,y}; } } return t; };
  const rNaive=rapidLen(CAM.postProcess(naiveJob,CAM.POSTS.shopsabre));
  const rSorted=rapidLen(CAM.postProcess(sortedJob,CAM.POSTS.shopsabre));
  ok('order: NN reorder reduces rapid travel', rSorted<rNaive, [rSorted.toFixed(2),'<',rNaive.toFixed(2)]);
  ok('order: sorted job cuts A (near origin) first', sortedJob.ops[0].passes[0].path[0].x<10, sortedJob.ops[0].passes[0].path[0].x);
  ok('order: pass count preserved', sortedJob.ops[0].passes.length===naiveJob.ops[0].passes.length);
  ok('order: input job not mutated', naiveJob.ops[0].passes[0].path[0].x>10, naiveJob.ops[0].passes[0].path[0].x);
})();

// ---- material-removal heightfield sim ----
(function(){
  const near=(a,b,t)=>Math.abs(a-b)<=(t||0.03);
  // 1. straight flat cut lowers swept cells to depth, leaves the rest untouched
  const flat=CAM.simulateStock({ x0:0,y0:0,w:2,h:2,thickness:0.5,res:0.05,
    cuts:[{ tool:{type:'flat',radius:0.1}, segs:[{x0:0.5,y0:1,z0:-0.2,x1:1.5,y1:1,z1:-0.2}] }] });
  ok('sim: dims nx/ny', flat.nx===40 && flat.ny===40, flat.nx+'x'+flat.ny);
  ok('sim: flat cut reaches depth on the line', near(CAM.stockHeightAt(flat,1.0,1.0),-0.2), CAM.stockHeightAt(flat,1.0,1.0));
  ok('sim: uncut area stays at top (0)', near(CAM.stockHeightAt(flat,1.0,0.3),0), CAM.stockHeightAt(flat,1.0,0.3));
  ok('sim: within tool radius cut', near(CAM.stockHeightAt(flat,1.0,1.08),-0.2), CAM.stockHeightAt(flat,1.0,1.08));
  // 2. V-bit leaves a V cross-section (90deg: surface rises 1:1 with distance from center)
  const vf=CAM.simulateStock({ x0:0,y0:0,w:2,h:2,thickness:0.6,res:0.03,
    cuts:[{ tool:{type:'v',radius:0.5,angle:90}, segs:[{x0:0.3,y0:1,z0:-0.3,x1:1.7,y1:1,z1:-0.3}] }] });
  ok('sim: V center at full depth', near(CAM.stockHeightAt(vf,1.0,1.0),-0.3,0.04), CAM.stockHeightAt(vf,1.0,1.0));
  ok('sim: V wall rises ~1:1 at d=0.15', near(CAM.stockHeightAt(vf,1.0,1.15),-0.15,0.05), CAM.stockHeightAt(vf,1.0,1.15));
  ok('sim: V reaches surface by d=0.3', CAM.stockHeightAt(vf,1.0,1.3)>-0.06, CAM.stockHeightAt(vf,1.0,1.3));
  // 3. deeper of overlapping passes wins, regardless of order
  const ov=CAM.simulateStock({ x0:0,y0:0,w:1,h:1,thickness:0.5,res:0.05,
    cuts:[ { tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:-0.1,x1:1,y1:0.5,z1:-0.1}] },
           { tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:-0.3,x1:1,y1:0.5,z1:-0.3}] } ] });
  ok('sim: overlap keeps deeper pass', near(CAM.stockHeightAt(ov,0.5,0.5),-0.3), CAM.stockHeightAt(ov,0.5,0.5));
  const ov2=CAM.simulateStock({ x0:0,y0:0,w:1,h:1,thickness:0.5,res:0.05,
    cuts:[ { tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:-0.3,x1:1,y1:0.5,z1:-0.3}] },
           { tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:-0.1,x1:1,y1:0.5,z1:-0.1}] } ] });
  ok('sim: overlap deeper wins (reversed order)', near(CAM.stockHeightAt(ov2,0.5,0.5),-0.3), CAM.stockHeightAt(ov2,0.5,0.5));
  // 4. cut beyond thickness clamps to the floor
  const cl=CAM.simulateStock({ x0:0,y0:0,w:1,h:1,thickness:0.5,res:0.05,
    cuts:[{ tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:-1,x1:1,y1:0.5,z1:-1}] }] });
  ok('sim: overcut clamps to -thickness', near(CAM.stockHeightAt(cl,0.5,0.5),-0.5), CAM.stockHeightAt(cl,0.5,0.5));
  // 5. a pure rapid above the surface removes nothing
  const rp=CAM.simulateStock({ x0:0,y0:0,w:1,h:1,thickness:0.5,res:0.05,
    cuts:[{ tool:{type:'flat',radius:0.2}, segs:[{x0:0,y0:0.5,z0:0.25,x1:1,y1:0.5,z1:0.25}] }] });
  ok('sim: rapid above stock leaves it flat', near(CAM.stockHeightAt(rp,0.5,0.5),0), CAM.stockHeightAt(rp,0.5,0.5));
})();

// ---- machining time estimate ----
(function(){
  const near=(a,b,t)=>Math.abs(a-b)<=(t||0.01);
  const feedT=CAM.estimateTime([{x0:0,y0:0,z0:-0.2,x1:10,y1:0,z1:-0.2}], {feed:120,plunge:40,rapid:300});
  ok('time: 10in feed @120ipm = 5s', near(feedT.seconds,5), feedT.seconds);
  const plungeT=CAM.estimateTime([{x0:0,y0:0,z0:0,x1:0,y1:0,z1:-2}], {feed:120,plunge:40,rapid:300});
  ok('time: 2in plunge @40ipm = 3s', near(plungeT.seconds,3), plungeT.seconds);
  const rapidT=CAM.estimateTime([{x0:0,y0:0,z0:0.2,x1:10,y1:0,z1:0.2,rapid:true}], {feed:120,plunge:40,rapid:300});
  ok('time: 10in rapid @300ipm = 2s', near(rapidT.seconds,2), rapidT.seconds);
  const allT=CAM.estimateTime([
    {x0:0,y0:0,z0:0,x1:0,y1:0,z1:-2},        // plunge 2 -> 3s
    {x0:0,y0:0,z0:-2,x1:10,y1:0,z1:-2},      // feed 10 -> 5s
    {x0:10,y0:0,z0:0.2,x1:0,y1:0,z1:0.2,rapid:true} // rapid 10 -> 2s
  ], {feed:120,plunge:40,rapid:300});
  ok('time: combined = 10s', near(allT.seconds,10), allT.seconds);
  ok('time: distances split by kind', near(allT.plungeDist,2)&&near(allT.feedDist,10)&&near(allT.rapidDist,10), JSON.stringify(allT));
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);