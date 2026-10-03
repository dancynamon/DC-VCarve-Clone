const fs=require('fs'),path=require('path');const {parseTap}=require(process.argv[2]+'/tapcompare.js');const {passesOf}=require(process.argv[2]+'/tap2spec.js');
const rep=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const root=process.argv[4];
const near=(P,x,y)=>{let b=[1e9];for(const s of P){const dx=s.x1-s.x0,dy=s.y1-s.y0,L=dx*dx+dy*dy;let t=L?((x-s.x0)*dx+(y-s.y0)*dy)/L:0;t=Math.max(0,Math.min(1,t));const px=s.x0+dx*t,py=s.y0+dy*t,d=Math.hypot(px-x,py-y);if(d<b[0])b=[d,px,py]}return b};
const score={};let n=0;const add=(k,ok)=>{score[k]=score[k]||[0,0];score[k][0]+=ok?1:0;score[k][1]++};
for(const j of rep.jobs.filter(j=>j.status==='PASS').slice(0,+process.argv[5]||200)){let T;try{T=parseTap(fs.readFileSync(path.join(root,j.tap),'utf8'))}catch(e){continue}
 let prevEnd={x:0,y:0},prevStart={x:0,y:0};
 for(const t of T){for(const p of passesOf(t)){const cut=p.filter(s=>s.z1<-1e-6&&Math.abs(s.z0-s.z1)<1e-6&&Math.hypot(s.x1-s.x0,s.y1-s.y0)>1e-9);if(cut.length<4){continue}
  const e={x:cut[0].x0,y:cut[0].y0},last=cut[cut.length-1];const closed=Math.hypot(last.x1-e.x,last.y1-e.y)<0.01;
  if(closed){n++;const chk=(k,q)=>{const r=near(cut,q.x,q.y);add(k,Math.hypot(r[1]-e.x,r[2]-e.y)<0.01)};
   chk('nearest origin',{x:0,y:0});chk('nearest prevEnd',prevEnd);chk('nearest prevStart',prevStart);
   let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;for(const s of cut){minx=Math.min(minx,s.x0);miny=Math.min(miny,s.y0);maxx=Math.max(maxx,s.x0);maxy=Math.max(maxy,s.y0)}
   chk('nearest own bbox LL',{x:minx,y:miny});chk('nearest own bbox UL',{x:minx,y:maxy});chk('nearest own bbox LR',{x:maxx,y:miny});
   add('entry is a vertex w/ arc next',!!cut[0].arc);}
  prevEnd={x:p[p.length-1].x1,y:p[p.length-1].y1};prevStart={x:(p.find(s=>s.z1<0)||p[0]).x1,y:(p.find(s=>s.z1<0)||p[0]).y1};}}}
console.log('closed passes',n);for(const [k,v] of Object.entries(score))console.log(k,v[0]+'/'+v[1],(100*v[0]/v[1]).toFixed(1)+'%');
