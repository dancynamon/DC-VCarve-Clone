// Regression runner over a directory of .crv / .crv3d files (not committed: see tools/crv/README.md for the public
// corpus). Every file must decode to the terminal vcCadSheet marker; with --export DIR it also writes each file's
// embedded preview GIF and the flattened vectors as JSON so tools/crv/oracle.py can compare them.
//   node cam-engine/crvcorpus.js <dir> [<dir>...] [--export OUT]
const C = require('./crvparse.js'), fs = require('fs'), path = require('path');
const args = process.argv.slice(2); const ex = args.indexOf('--export'); const out = ex >= 0 ? args[ex + 1] : null;
const dirs = args.filter((a, i) => a !== '--export' && i !== ex + 1);
if (!dirs.length) { console.log('usage: node crvcorpus.js <dir>... [--export OUT]'); process.exit(2); }
const files = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.crv(3d)?$/i.test(e.name)) files.push(p); } };
dirs.forEach(walk); files.sort();
if (out) fs.mkdirSync(out, { recursive: true });
let ok = 0, empty = 0, skipped = 0, failed = 0;
for (const f of files) {
  const b = new Uint8Array(fs.readFileSync(f)); let ver = '?';
  try {
    const st = C.readCFB(b); const v = st.get('VersionData/Version'); if (v) { const r = new C._Ar(v); r.u32(); ver = [r.cstr(), r.cstr()].join(' ').trim(); }
    const doc = C.parse(b); let n = 0, t = 0; const w = o => { if (o.contours) n += o.contours.length; if (o.type === 'text') t++; if (o.children) o.children.forEach(w); }; doc.layers.forEach(L => L.objects.forEach(w));
    if (doc.empty) empty++; else ok++;
    console.log((doc.empty ? 'EMPTY' : 'OK   ') + ' ' + path.basename(f).padEnd(40) + ' | ' + ver.padEnd(14) + ' | layers ' + doc.layers.length + ' contours ' + n + ' text ' + t + (doc.job ? ' job ' + [doc.job.w, doc.job.h, doc.job.thickness].map(x => +x.toFixed(3)).join('x') : ''));
    if (out) { const nm = path.basename(f).replace(/\.crv3?d?$/i, '').replace(/[^A-Za-z0-9_-]/g, '_'); const gif = st.get('PreviewData/Preview2D_GIF'); if (gif) fs.writeFileSync(path.join(out, nm + '.gif'), gif); fs.writeFileSync(path.join(out, nm + '.json'), JSON.stringify(C.toShapes(b))); }
  } catch (e) {
    if (/not a CRV/.test(e.message)) { skipped++; console.log('SKIP  ' + path.basename(f).padEnd(40) + ' | ' + e.message); }
    else { failed++; console.log('FAIL  ' + path.basename(f).padEnd(40) + ' | ' + ver.padEnd(14) + ' | ' + e.message); }
  }
}
console.log('\n' + files.length + ' files: ' + ok + ' ok, ' + empty + ' empty, ' + skipped + ' skipped (not CRV), ' + failed + ' failed');
process.exit(failed ? 1 : 0);
