// Vendored-file drift check. Every file pinned in cam-engine/VENDORED (the shared PDF importer and
// clipper.js, canonical in aquamentor-vector-studio) must still hash to its pin, and cadcam-studio.html
// must carry each bundled one verbatim. To fix a failure, make the change in aquamentor-vector-studio
// and run tools/sync-pdfparse.sh. Editing the copy here is exactly the fork this check exists to stop.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : extra); } }

const root = path.join(__dirname, '..');
const pins = fs.readFileSync(path.join(__dirname, 'VENDORED'), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'))
  .map(l => { const [sha, file, from] = l.trim().split(/\s+/); return { sha, file, from }; });
const buildOrder = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'cadcam-studio.html'), 'utf8');

ok('VENDORED pins the shared files', ['cam-engine/pdfparse.js', 'cam-engine/package/clipper.js'].every(f => pins.some(p => p.file === f)), pins.map(p => p.file));
for (const p of pins) {
  const abs = path.join(root, p.file);
  if (!fs.existsSync(abs)) { ok(p.file + ' exists', false); continue; }
  const src = fs.readFileSync(abs);
  const got = crypto.createHash('sha256').update(src).digest('hex');
  ok(p.file + ' matches its pin (canonical: aquamentor-vector-studio/' + p.from + ')', got === p.sha,
    '\n    pinned ' + p.sha + '\n    actual ' + got + '\n    edited here? move the change to vector-studio and run tools/sync-pdfparse.sh');
  const rel = path.relative(__dirname, abs).split(path.sep).join('/');
  if (buildOrder.includes("'" + rel + "'"))
    ok(p.file + ' is in cadcam-studio.html verbatim (npm run build)', bundle.includes(src.toString('utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
