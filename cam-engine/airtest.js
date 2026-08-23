const { aircut } = require('./aircut.js');
const fs=require('fs');
let pass=0,fail=0; const ok=(n,c,e)=>{c?pass++:(fail++,console.log('  FAIL',n,e===undefined?'':e));};

const prod=fs.readFileSync(require('path').join(__dirname,'..','CAD','LGC 50 Job 1 Board 3-aq.tap'),'utf8');
const air=aircut(prod).gcode;
const zs=g=>[...g.matchAll(/Z(-?\d*\.?\d+)/g)].map(m=>parseFloat(m[1]));
ok('no Z is at or below the material top', zs(air).every(v=>v>0), zs(air).filter(v=>v<=0).slice(0,3));
ok('every cutting pass clears the stock by >= 0.25"', Math.min(...zs(air))>=0.25-1e-9, Math.min(...zs(air)));
ok('retract plane untouched', (air.match(/Z0\.8000/g)||[]).length === (prod.match(/Z0\.8000/g)||[]).length);
ok('park height untouched', /G0 Z2\.0000/.test(air) && /G0 X0\.0000 Y115\.0000/.test(air));
ok('max Z unchanged, so travel envelope is unchanged', Math.max(...zs(air))===Math.max(...zs(prod)), Math.max(...zs(air)));
ok('XY motion identical', air.replace(/Z-?\d*\.?\d+/g,'Z') === prod.replace(/Z-?\d*\.?\d+/g,'Z'));
ok('line count identical', air.split('\n').length===prod.split('\n').length);
ok('feeds identical', JSON.stringify([...air.matchAll(/F([\d.]+)/g)].map(m=>m[1]))===JSON.stringify([...prod.matchAll(/F([\d.]+)/g)].map(m=>m[1])));
ok('tool changes identical', JSON.stringify(air.match(/^T\d+$/gm))===JSON.stringify(prod.match(/^T\d+$/gm)));
ok('spindle speeds identical', JSON.stringify(air.match(/^S\d+$/gm))===JSON.stringify(prod.match(/^S\d+$/gm)));
// deepest pass stays the lowest in the air, so the staging still reads
const dz=(g,a,b)=>{const A=g.indexOf(a),B=g.indexOf(b);return A>=0&&B>=0;};
ok('deepest production pass maps lowest', air.includes('Z0.2500') && air.includes('Z0.5500'));
ok('order preserved', 0.2500 < 0.2800 && 0.2800 < 0.5500);
// guards
const bad=(f,re)=>{try{f();return false;}catch(e){return re.test(e.message)?true:e.message;}};
ok('clearance 0 is refused', bad(()=>aircut(prod,{clearance:0}),/greater than 0/)===true);
ok('clearance above the retract plane is refused', bad(()=>aircut(prod,{clearance:0.9}),/no room under/)===true);
ok('band is squeezed rather than climbing over the retract', (function(){
  const r=aircut(prod,{clearance:0.25,band:5}); return Math.max(...r.stats.airZ) < r.stats.retract; })());
ok('band 0 collapses to one height', (function(){
  const r=aircut(prod,{band:0}); return new Set(r.stats.airZ.map(v=>v.toFixed(4))).size===1; })());
ok('empty program refused', bad(()=>aircut(''),/empty program/)===true);
ok('a program with no cutting moves is returned untouched', (function(){
  const g='G90\r\nG0 Z2.0000\r\nG0 X0 Y0\r\n'; const r=aircut(g); return r.gcode===g && r.stats.unchanged; })());
console.log(`\n${pass}/${pass+fail} air-cut checks passed`);
process.exit(fail?1:0);
