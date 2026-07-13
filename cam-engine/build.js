const fs=require('fs'), p=require('path'), d=__dirname;
const shell=fs.readFileSync(p.join(d,'studio_shell.html'),'utf8');
const order=['package/clipper.js','package/opentype.js','camcore.js','cadcore.js','dxfparse.js','pdfparse.js','studio_app.js'];
const libs=order.map(f=>'<script>\n'+fs.readFileSync(p.join(d,f),'utf8')+'\n</script>').join('\n');
const out=shell.replace('<!--LIBS-->',libs);
const dest=p.join(d,'..','cadcam-studio.html');
fs.writeFileSync(dest,out);
// index.html → redirect to the app so a static server's root opens the studio (not a dir listing)
const idx=p.join(d,'..','index.html');
fs.writeFileSync(idx,'<!DOCTYPE html><meta charset="utf-8"><title>Aquamentor CAD/CAM</title>\n<meta http-equiv="refresh" content="0; url=cadcam-studio.html">\n<a href="cadcam-studio.html">Open Aquamentor CAD/CAM Studio</a>\n');
console.log('built',dest,Math.round(out.length/1024)+'KB','(+ index.html redirect)');
