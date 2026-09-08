/**
 * Silence — install checker
 * Run:   node check-silence.js        (from C:\Users\rshre\Desktop\silence)
 * Paste the whole output back.
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
let fails = 0;
const line = (s) => process.stdout.write(s + '\n');

line('==================================================');
line(' SILENCE INSTALL CHECK  —  ' + new Date().toString());
line(' folder: ' + DIR);
line(' node  : ' + process.version);
line('==================================================\n');

const FILES = [
  { f: 'main.js', must: ['silence-core', 'initSilenceCore', 'initExtensionStore', 'registerSilencePages'], mustNot: [] },
  { f: 'index.html', must: ['silence-plus.js', 'silence-plus.css', 'open-ext-store-btn', 'storePreloadPath'], mustNot: [] },
  { f: 'silence-core.js', must: ['built-in filter list active', 'silence:adblock-sync'], mustNot: ['popunder*/'] },
  { f: 'silence-plus.js', must: ['sp-plus-btn', 'Silence Plus v', 'panel-privacy-plus'], mustNot: [] },
  { f: 'silence-plus.css', must: ['.sp-switch', '.sp-scrim'], mustNot: [] },
  { f: 'store.html', must: ['SilenceStore', 'Add to Silence'], mustNot: [] },
  { f: 'store-preload.js', must: ['silence-store:install'], mustNot: [] },
  { f: 'extension-store-backend.js', must: ['initExtensionStore: init', 'silence-store:selftest'], mustNot: [] },
  { f: 'catalog.json', must: ['"items"'], mustNot: [] },
  { f: 'package.json', must: ['@ghostery/adblocker-electron', 'cross-fetch'], mustNot: [] },
  { f: 'gesture-preload.js', must: [], mustNot: [] }
];

line('--- files ----------------------------------------');
for (const it of FILES) {
  const p = path.join(DIR, it.f);
  if (!fs.existsSync(p)) {
    line('  MISSING  ' + it.f);
    fails++;
    continue;
  }
  const st = fs.statSync(p);
  let src = '';
  try { src = fs.readFileSync(p, 'utf8'); } catch (e) { src = ''; }
  const missing = it.must.filter((m) => !src.includes(m));
  const present = it.mustNot.filter((m) => src.includes(m));
  const ok = !missing.length && !present.length;
  if (!ok) fails++;
  line(
    '  ' + (ok ? 'OK     ' : 'FAIL   ') + it.f.padEnd(30) +
    String(Math.round(st.size / 1024)).padStart(6) + ' KB   ' +
    st.mtime.toISOString().replace('T', ' ').slice(0, 19)
  );
  if (missing.length) line('           missing markers : ' + missing.join(', '));
  if (present.length) line('           OLD CODE FOUND  : ' + present.join(', ') + '   <-- file was not updated');
}

line('\n--- npm packages ---------------------------------');
const PKGS = ['@ghostery/adblocker-electron', 'cross-fetch', 'electron-chrome-extensions', 'electron'];
for (const pkg of PKGS) {
  const p = path.join(DIR, 'node_modules', pkg);
  const ok = fs.existsSync(p);
  if (!ok && pkg !== 'electron-chrome-extensions') fails++;
  line('  ' + (ok ? 'installed' : (pkg === 'electron-chrome-extensions' ? 'optional, not installed' : 'MISSING  ')) + '   ' + pkg);
}

line('\n--- summary --------------------------------------');
if (fails === 0) {
  line('  ALL CHECKS PASSED');
  line('  Next: close Silence completely, then run:  npm start');
} else {
  line('  ' + fails + ' PROBLEM(S) FOUND — see the FAIL / MISSING / OLD CODE lines above.');
  line('  Fix: re-copy the files from the workspace into this folder, overwrite all,');
  line('       then run  npm install  and start the app again.');
}
line('==================================================\n');
