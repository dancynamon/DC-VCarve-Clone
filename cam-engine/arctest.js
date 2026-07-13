const CAM=require('./camcore.js');
let pass=0,fail=0; const ok=(n,c,x)=>{c?pass++:(fail++,console.log('  FAIL',n,x||''));};

// parse helper using the SAME arc expansion the viewer uses (mirror of parseGcode G2/G3)
function parseXY(g){
  let x=0,y=0,mode=null,mn=[1e9,1e9],mx=[-1e9,-1e9];
  const upd=(X,Y)=>{mn[0]=Math.min(mn[0],X);mn[1]=Math.min(mn[1],Y);mx[0]=Math.max(mx[0],X);mx[1]=Math.max(mx[1],Y);};
  for(const raw of g.split(/\r?\n/)){
    const line=raw.trim().toUpperCase(); if(!line||line[0]==='('||line[0]==='%')continue;
    const m=line.match(/^(G[0-3])/); if(m)mode=m[1];
    const pv=c=>{const r=line.match(new RegExp(c+'(-?[\\d.]+)'));return r?+r[1]:null;};
    const nx=pv('X'),ny=pv('Y'),ni=pv('I'),nj=pv('J'); const x0=x,y0=y;
    if(nx!==null)x=nx; if(ny!==null)y=ny;
    if((mode==='G2'||mode==='G3')&&ni!==null&&nj!==null){
      const cx=x0+ni,cy=y0+nj,r=Math.hypot(ni,nj);let sa=Math.atan2(y0-cy,x0-cx),ea=Math.atan2(y-cy,x-cx);
      if(mode==='G2'){if(ea>=sa)ea-=2*Math.PI;}else{if(ea<=sa)ea+=2*Math.PI;}
      const steps=64;for(let s=0;s<=steps;s++){const a=sa+(ea-sa)*s/steps;upd(cx+r*Math.cos(a),cy+r*Math.sin(a));}
    } else if(mode==='G1'){ if(nx!==null||ny!==null) upd(x,y); }
  }
  return {mn,mx};
}

// 1) CIRCLE r=2 at (3,3): outside profile 0.25 tool -> path radius 2.125 -> bounds 0.875..5.125
const circ=[];for(let i=0;i<80;i++){const a=i/80*2*Math.PI;circ.push({x:3+2*Math.cos(a),y:3+2*Math.sin(a)});}
const cc=CAM.assembleContours([{closed:true,pts:circ}]);
const res=CAM.profileOp(cc,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,toolNum:2,feed:120,plunge:40});
const g=CAM.postProcess({name:'circ',ops:res.ops},CAM.POSTS.shopsabre);
const nArc=(g.match(/^G[23] /gm)||[]).length, nLine=(g.match(/^G1 X/gm)||[]).length;
ok('circle emits arcs',nArc>0,'arcs='+nArc);
ok('circle mostly arcs not lines',nArc>0 && nLine<=2,'arcs='+nArc+' lines='+nLine);
const b=parseXY(g);
ok('circle arc round-trip bounds 0.875..5.125',Math.abs(b.mn[0]-0.875)<5e-3&&Math.abs(b.mx[0]-5.125)<5e-3,JSON.stringify(b));
ok('circle arcs each <=270deg (>=2 arc moves)',nArc>=2,'arcs='+nArc);

// 2) RECTANGLE: straight edges must stay G1 lines (no spurious arcs on flat sides). Outside corners become arcs.
const rect=CAM.assembleContours([{closed:true,pts:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]}]);
const rr=CAM.profileOp(rect,{side:'outside',toolDia:0.25,cutDepth:0.1,passDepth:0.5,feed:120,plunge:40});
const gr=CAM.postProcess({name:'rect',ops:rr.ops},CAM.POSTS.shopsabre);
const rArc=(gr.match(/^G[23] /gm)||[]).length, rLine=(gr.match(/^G1 X/gm)||[]).length;
ok('rect has 4 line edges',rLine>=4,'lines='+rLine);
ok('rect outside has 4 corner arcs',rArc===4,'arcs='+rArc);
const br=parseXY(gr);
ok('rect outside bounds -0.125..4.125',Math.abs(br.mn[0]+0.125)<5e-3&&Math.abs(br.mx[0]-4.125)<5e-3,JSON.stringify(br));

// 3) ON-LINE rectangle (no offset): pure square, all lines, no arcs
const on=CAM.profileOp(rect,{side:'on',toolDia:0.25,cutDepth:0.1,passDepth:0.5});
const gon=CAM.postProcess({name:'on',ops:on.ops},CAM.POSTS.shopsabre);
ok('on-line square has no arcs',(gon.match(/^G[23] /gm)||[]).length===0);

// 4) tabs still work with arcs (circle + 4 tabs) -> tab Z rises present
const t=CAM.profileOp(cc,{side:'outside',toolDia:0.25,cutDepth:0.25,passDepth:0.5,tabs:{count:4,length:0.4,height:0.1}});
const gt=CAM.postProcess({name:'tabs',ops:t.ops},CAM.POSTS.shopsabre);
ok('tabbed circle raises Z for tabs',/G1 Z-0\.15/.test(gt)||/G1 Z-0\.1500/.test(gt),'(tab z = cut -0.25 + 0.1 = -0.15)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
