/**
 * Silence Extension Store — main-process backend
 * ------------------------------------------------------------------
 * A Chrome-Web-Store-like extension installer that works *inside* Silence
 * (Electron). It downloads the real .crx from Google's update service
 * (the same endpoint Chrome itself uses), unpacks it with a dependency-free
 * ZIP reader, and hands the folder to Electron's session.loadExtension().
 *
 * No Chrome Web Store account / web page / "Add to Chrome" button needed.
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { ipcMain, session, dialog, shell, app, BrowserWindow, webContents, net } = require('electron');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PROD_VERSION = '131.0.6778.204';
const CWS_CRX = (id) =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${PROD_VERSION}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;

const ID_RE = /^[a-p]{32}$/;
const DOWNLOAD_TIMEOUT = 90000;   // 90s to fetch the package
const LOAD_TIMEOUT = 25000;       // 25s for Electron to register it
const TEST_ID = 'bcjindcccaagfpapjjmafapmmgkkhgoa'; // JSON Formatter, ~20 KB probe

let hooks = null;              // filled by init()
let storeDir = '';             // <userData>/installed_extensions
let metaFile = '';             // <userData>/silence_store_extensions.json
let catalogFile = '';
let meta = { items: [] };      // [{ extId, storeId, name, version, dir, source, installedAt, disabled }]

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function log(...a) { console.log('[store]', ...a); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { log('write failed', e.message); }
}

/**
 * Send an event to every renderer, *including webview guests* — the store runs
 * inside a webview, so broadcasting to BrowserWindows alone never reaches it.
 */
function broadcast(channel, payload) {
  const targets = [];
  try { for (const w of BrowserWindow.getAllWindows()) targets.push(w.webContents); } catch {}
  try { for (const wc of webContents.getAllWebContents()) targets.push(wc); } catch {}
  const seen = new Set();
  for (const wc of targets) {
    if (!wc || seen.has(wc)) continue;
    seen.add(wc);
    try { if (!wc.isDestroyed()) wc.send(channel, payload); } catch {}
  }
}

function parseId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (ID_RE.test(s)) return s;
  const m = s.match(/[?&]id=([a-p]{32})/) || s.match(/\/([a-p]{32})(?:[/?#]|$)/);
  if (m && ID_RE.test(m[1])) return m[1];
  return null;
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms); })
  ]);
}

/* --------------------------- CRX + ZIP ---------------------------- */

function stripCrxHeader(buf) {
  if (buf.slice(0, 2).toString('latin1') === 'PK') return buf; // plain zip
  if (buf.slice(0, 4).toString('latin1') !== 'Cr24') throw new Error('Not a CRX file (bad magic)');
  const version = buf.readUInt32LE(4);
  if (version === 3) {
    const headerLength = buf.readUInt32LE(8);
    return buf.slice(12 + headerLength);
  }
  if (version === 2) {
    const pubLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return buf.slice(16 + pubLen + sigLen);
  }
  throw new Error('Unsupported CRX version ' + version);
}

/** Minimal, dependency-free ZIP extractor (stored + deflate, zip-slip safe). */
function extractZip(buffer, destDir) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  const scanEnd = Math.max(0, buffer.length - 22);
  const scanStart = Math.max(0, buffer.length - 22 - 65535);
  for (let i = scanEnd; i >= scanStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Downloaded file is not a valid ZIP archive');

  let count = buffer.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new Error('ZIP64 archives are not supported');
  let ptr = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error('ZIP archive is empty');

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  // many packages ship everything inside a single top-level folder
  const files = entries.filter((e) => !e.name.endsWith('/'));
  let rootPrefix = '';
  for (let depth = 0; depth < 4; depth++) {
    if (files.some((f) => f.name.slice(rootPrefix.length) === 'manifest.json')) break;
    const first = files.length ? files[0].name.slice(rootPrefix.length).split('/')[0] : '';
    if (!first) break;
    if (files.every((f) => f.name.slice(rootPrefix.length).startsWith(first + '/'))) rootPrefix += first + '/';
    else break;
  }

  for (const e of entries) {
    let rel = e.name;
    if (rootPrefix && rel.startsWith(rootPrefix)) rel = rel.slice(rootPrefix.length);
    if (!rel || rel.endsWith('/')) {
      if (rel) fs.mkdirSync(path.join(destDir, rel), { recursive: true });
      continue;
    }
    const target = path.join(destDir, rel);                       // zip-slip guard
    if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) continue;

    let p = e.localOffset;
    if (buffer.readUInt32LE(p) !== 0x04034b50) {
      p = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      while (p >= 0) {
        const nl = buffer.readUInt16LE(p + 26);
        if (buffer.toString('utf8', p + 30, p + 30 + nl) === e.name) break;
        p = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), p + 1);
      }
      if (p < 0) continue;
    }
    const dataStart = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const raw = buffer.slice(dataStart, dataStart + e.compSize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = zlib.inflateRawSync(raw);
    else { log('skipping unsupported compression method', e.method, e.name); continue; }
    fs.writeFileSync(target, out);
  }

  if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
    throw new Error('manifest.json not found inside the archive');
  }
  return destDir;
}

/* ---------------------------- download ---------------------------- */

/** Electron's net.fetch honours system proxy settings; fall back to Node's fetch. */
function doFetch(url, opts) {
  if (net && typeof net.fetch === 'function') return net.fetch(url, opts);
  return fetch(url, opts);
}

async function downloadBuffer(url, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
  let res;
  try {
    res = await withTimeout(
      doFetch(url, { headers: { 'User-Agent': CHROME_UA, Accept: '*/*' }, redirect: 'follow', signal: controller.signal }),
      DOWNLOAD_TIMEOUT,
      'Download'
    );
  } catch (err) {
    clearTimeout(timer);
    const e = new Error('Could not reach the download server — ' + err.message);
    e.code = 'NETWORK';
    throw e;
  }

  if (res.status === 204) {
    clearTimeout(timer);
    const e = new Error('Google refused the direct download (HTTP 204 — this extension cannot be fetched from the CRX service)');
    e.code = 'CWS_204';
    throw e;
  }
  if (res.status === 404) {
    clearTimeout(timer);
    const e = new Error('Extension not found on the Chrome Web Store (HTTP 404 — check the ID)');
    e.code = 'CWS_404';
    throw e;
  }
  if (!res.ok) {
    clearTimeout(timer);
    const e = new Error('Download failed: HTTP ' + res.status);
    e.code = 'HTTP_' + res.status;
    throw e;
  }

  try {
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let received = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await withTimeout(reader.read(), DOWNLOAD_TIMEOUT, 'Download');
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
        if (onProgress) onProgress(received, total);
      }
    } else {
      const b = Buffer.from(await withTimeout(res.arrayBuffer(), DOWNLOAD_TIMEOUT, 'Download'));
      chunks.push(b);
      if (onProgress) onProgress(b.length, b.length);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 512) throw new Error('Downloaded package is suspiciously small (' + buf.length + ' bytes)');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function githubAssetUrl(repo, assetPattern) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await withTimeout(
    doFetch(api, { headers: { 'User-Agent': 'Silence-Browser', Accept: 'application/vnd.github+json' } }),
    30000, 'GitHub lookup'
  );
  if (!res.ok) throw new Error('Could not query GitHub releases (HTTP ' + res.status + ')');
  const data = await res.json();
  const asset = (data.assets || []).find((a) => a.name.includes(assetPattern));
  if (!asset) throw new Error('No release asset matching "' + assetPattern + '" in ' + repo);
  return { url: asset.browser_download_url, version: data.tag_name, name: asset.name };
}

/* --------------------------- manifest ----------------------------- */

/** resolve Chrome's __MSG_key__ placeholders using the extension's own locale files */
function localize(dir, str, m) {
  if (!str || !String(str).includes('__MSG_')) return str;
  try {
    const order = ['en', m.default_locale, 'en_US', 'en_GB'].filter(Boolean);
    let msgs = null;
    for (const l of order) {
      const p = path.join(dir, '_locales', l, 'messages.json');
      if (fs.existsSync(p)) { msgs = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    }
    if (!msgs) return str;
    return String(str).replace(/__MSG_([A-Za-z0-9_@]+)__/g, (mm, key) => (msgs[key] && msgs[key].message) || mm);
  } catch {
    return str;
  }
}

function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    name: localize(dir, m.name, m) || path.basename(dir),
    version: m.version || '0.0.0',
    description: localize(dir, m.description, m) || '',
    manifestVersion: m.manifest_version || 2,
    homepage: m.homepage_url || null
  };
}

function iconDataUrl(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const sets = [m.icons, (m.action || {}).default_icon, (m.browser_action || {}).default_icon];
    const cands = [];
    for (const s of sets) {
      if (typeof s === 'string') cands.push([16, s]);
      else if (s && typeof s === 'object') for (const k of Object.keys(s)) cands.push([parseInt(k, 10) || 0, s[k]]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [, rel] of cands) {
      const full = path.join(dir, rel);
      if (!fs.existsSync(full)) continue;
      const buf = fs.readFileSync(full);
      if (buf.length > 400000) continue;
      const ext = path.extname(full).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch {}
  return null;
}

/* ------------------------- install pipeline ----------------------- */

async function finalizeInstall(dir, { storeId, source, label, stage }) {
  stage && stage('loading');
  let ext;
  try {
    ext = await withTimeout(
      hooks.registerExtension ? hooks.registerExtension(dir)
                              : session.defaultSession.loadExtension(dir, { allowFileAccess: true }),
      LOAD_TIMEOUT,
      'Registering the extension with Electron'
    );
  } catch (err) {
    const e = new Error('Electron could not load this extension — ' + err.message);
    e.code = 'LOAD_FAILED';
    throw e;
  }

  const info = readManifest(dir);
  const record = {
    extId: ext.id,
    storeId: storeId || null,
    name: ext.name || info.name,
    version: info.version,
    description: info.description,
    icon: iconDataUrl(dir),
    dir,
    source: source || 'cws',
    installedAt: Date.now(),
    disabled: false
  };
  meta.items = meta.items.filter((i) => i.extId !== ext.id && i.dir !== dir);
  meta.items.push(record);
  writeJson(metaFile, meta);
  if (hooks.persistPath) hooks.persistPath(dir);

  broadcast('silence-store:changed', { extId: ext.id, name: record.name, action: 'installed' });
  log('installed', record.name, record.version, '<-', label || source || 'cws');
  return record;
}

async function installFromBuffer(buf, { storeId, source, label, stage }) {
  stage && stage('extracting');
  const zipBuf = stripCrxHeader(buf);
  const dir = path.join(storeDir, storeId || 'local_' + Date.now());
  extractZip(zipBuf, dir);                 // sync — small archives, few ms
  return finalizeInstall(dir, { storeId, source, label, stage });
}

async function installById(id, onProgress, stage) {
  const catalog = readJson(catalogFile, { items: [] });
  const entry = (catalog.items || []).find((i) => i.id === id);
  const source = (entry && entry.source) || { type: 'cws' };
  const report = (p) => onProgress && onProgress(p);

  stage && stage('resolving');
  let buf;
  let usedSource = 'cws';
  try {
    buf = await downloadBuffer(CWS_CRX(id), (received, total) =>
      report({ id, stage: 'download', received, total, percent: total ? Math.round((received / total) * 100) : null }));
  } catch (err) {
    if (source.type === 'github') {
      log('CWS source failed (' + err.code + '), trying GitHub', source.repo);
      const gh = await githubAssetUrl(source.repo, source.asset);
      report({ id, stage: 'download', received: 0, total: 0, percent: null });
      buf = await downloadBuffer(gh.url, (received, total) =>
        report({ id, stage: 'download', received, total, percent: total ? Math.round((received / total) * 100) : null }));
      usedSource = 'github:' + source.repo;
    } else {
      throw err;
    }
  }
  return installFromBuffer(buf, { storeId: id, source: usedSource, label: (entry && entry.name) || id, stage });
}

/* ------------------------- self diagnostics ----------------------- */

async function selfTest() {
  const out = {
    ok: true,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    storeDir,
    metaFile,
    catalogFile,
    catalogItems: (readJson(catalogFile, { items: [] }).items || []).length,
    loadedExtensions: 0,
    writable: false,
    steps: []
  };
  try { out.loadedExtensions = session.defaultSession.getAllExtensions().length; } catch {}

  // 1) can we write where extensions get unpacked?
  const t0 = Date.now();
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const probe = path.join(storeDir, '.write_probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    out.writable = true;
    out.steps.push({ name: 'Write to extensions folder', ok: true, detail: storeDir, ms: Date.now() - t0 });
  } catch (e) {
    out.ok = false;
    out.steps.push({ name: 'Write to extensions folder', ok: false, detail: e.message, ms: Date.now() - t0 });
  }

  // 2) can we reach Google's CRX service and pull a tiny extension?
  const t1 = Date.now();
  try {
    const buf = await downloadBuffer(CWS_CRX(TEST_ID), () => {});
    const bytes = buf.length;
    const magic = buf.slice(0, 4).toString('latin1');
    const ok = bytes > 1000 && (magic === 'Cr24' || magic.slice(0, 2) === 'PK');
    out.ok = out.ok && ok;
    out.steps.push({
      name: 'Download from Google CRX service',
      ok,
      detail: (bytes / 1024).toFixed(1) + ' KB received, magic "' + magic + '"',
      ms: Date.now() - t1
    });
    // 3) unpack it
    const t2 = Date.now();
    try {
      const tmp = path.join(storeDir, '.selftest_' + Date.now());
      extractZip(stripCrxHeader(buf), tmp);
      const files = fs.readdirSync(tmp).length;
      fs.rmSync(tmp, { recursive: true, force: true });
      out.steps.push({ name: 'Unpack the archive', ok: true, detail: files + ' entries', ms: Date.now() - t2 });
    } catch (e) {
      out.ok = false;
      out.steps.push({ name: 'Unpack the archive', ok: false, detail: e.message, ms: Date.now() - t2 });
    }
  } catch (e) {
    out.ok = false;
    out.steps.push({
      name: 'Download from Google CRX service',
      ok: false,
      detail: e.message + (e.code ? ' [' + e.code + ']' : ''),
      ms: Date.now() - t1
    });
  }

  // 4) GitHub fallback reachable (used by uBlock Origin / Violentmonkey)
  const t3 = Date.now();
  try {
    const gh = await githubAssetUrl('gorhill/uBlock', 'chromium.crx');
    out.steps.push({ name: 'GitHub fallback', ok: true, detail: gh.name, ms: Date.now() - t3 });
  } catch (e) {
    out.steps.push({ name: 'GitHub fallback', ok: false, detail: e.message, ms: Date.now() - t3 });
  }

  // 5) can Electron register an extension at all?
  const t4 = Date.now();
  try {
    const probe = path.join(storeDir, '.selftest_probe_' + Date.now());
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Silence Store Probe', version: '1.0.0', description: 'connectivity probe'
    }));
    const ext = await withTimeout(session.defaultSession.loadExtension(probe, { allowFileAccess: true }), LOAD_TIMEOUT, 'loadExtension');
    session.defaultSession.removeExtension(ext.id);
    fs.rmSync(probe, { recursive: true, force: true });
    out.steps.push({ name: 'Electron loadExtension()', ok: true, detail: 'registered ' + ext.id, ms: Date.now() - t4 });
  } catch (e) {
    out.ok = false;
    out.steps.push({ name: 'Electron loadExtension()', ok: false, detail: e.message, ms: Date.now() - t4 });
  }

  return out;
}

/* ---------------------------- IPC API ----------------------------- */

function init(opts = {}) {
  hooks = {
    registerExtension: opts.registerExtension || null,
    persistPath: opts.persistPath || null,
    forgetPath: opts.forgetPath || null,
    appDir: opts.appDir || __dirname
  };

  storeDir = path.join(app.getPath('userData'), 'installed_extensions');
  metaFile = path.join(app.getPath('userData'), 'silence_store_extensions.json');
  catalogFile = opts.catalogFile || path.join(hooks.appDir, 'catalog.json');
  meta = readJson(metaFile, { items: [] });
  if (!meta || !Array.isArray(meta.items)) meta = { items: [] };
  try { fs.mkdirSync(storeDir, { recursive: true }); } catch {}

  const progress = (payload) => broadcast('silence-store:progress', payload);
  const stageOf = (id) => (stage, extra) => progress(Object.assign({ id, stage }, extra || {}));

  /** every handler is guarded: it always answers, never hangs the UI */
  const guard = (name, fn) => ipcMain.handle(name, async (event, arg) => {
    try {
      return await fn(arg || {}, event);
    } catch (err) {
      log(name + ' threw:', err && err.message);
      return { success: false, error: err && err.message ? err.message : String(err), code: (err && err.code) || null };
    }
  });

  guard('silence-store:install', async ({ id, url }) => {
    const storeId = parseId(url || id || '');
    if (!storeId) throw new Error('That does not look like a Chrome Web Store ID or link');
    const rec = await installById(storeId,
      (p) => progress(p),
      (s) => progress({ id: storeId, stage: s }));
    progress({ id: storeId, stage: 'done', percent: 100 });
    return { success: true, extension: rec };
  });

  guard('silence-store:install-url', async ({ url }) => {
    if (!url) throw new Error('No URL provided');
    const asId = parseId(url);
    if (asId) {
      const rec = await installById(asId, (p) => progress(p), (s) => progress({ id: asId, stage: s }));
      progress({ id: asId, stage: 'done', percent: 100 });
      return { success: true, extension: rec };
    }
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links are supported');
    progress({ id: url, stage: 'resolving' });
    const buf = await downloadBuffer(url, (received, total) =>
      progress({ id: url, stage: 'download', received, total, percent: total ? Math.round((received / total) * 100) : null }));
    const rec = await installFromBuffer(buf, { storeId: null, source: 'url', label: url, stage: stageOf(url) });
    progress({ id: url, stage: 'done', percent: 100 });
    return { success: true, extension: rec };
  });

  guard('silence-store:list', async () => {
    const live = session.defaultSession.getAllExtensions().map((e) => ({
      id: e.id, name: e.name, version: e.version, path: e.path, url: e.url
    }));
    const rows = live.map((e) => {
      const m = meta.items.find((x) => x.extId === e.id || x.dir === e.path) || {};
      return {
        id: e.id,
        name: m.name || e.name,
        version: e.version,
        description: m.description || '',
        icon: m.icon || null,
        dir: e.path,
        storeId: m.storeId || null,
        source: m.source || 'unpacked',
        installedAt: m.installedAt || null,
        disabled: !!m.disabled
      };
    });
    // an entry whose folder no longer exists is a leftover, not an installed
    // extension — forget it instead of showing a zombie card that can never be removed
    let dirty = false;
    for (const m of meta.items) {
      if (live.some((e) => e.id === m.extId)) continue;
      if (!m.dir || fs.existsSync(m.dir)) { rows.push(Object.assign({}, m, { id: m.extId, offline: true })); continue; }
      dirty = true;
    }
    if (dirty) {
      meta.items = meta.items.filter((m) =>
        live.some((e) => e.id === m.extId) || !m.dir || fs.existsSync(m.dir));
      writeJson(metaFile, meta);
    }
    return { success: true, extensions: rows };
  });

  guard('silence-store:uninstall', async ({ id }) => {
    const rec = meta.items.find((m) => m.extId === id || m.storeId === id);
    if (rec) {
      try { session.defaultSession.removeExtension(rec.extId); } catch {}
      try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch {}
      meta.items = meta.items.filter((m) => m.extId !== rec.extId);
      writeJson(metaFile, meta);
      if (hooks.forgetPath) hooks.forgetPath(rec.dir);
    } else {
      session.defaultSession.removeExtension(id);
    }
    broadcast('silence-store:changed', { extId: id, action: 'removed' });
    return { success: true };
  });

  guard('silence-store:update', async ({ id }) => {
    const rec = meta.items.find((m) => m.extId === id || m.storeId === id);
    if (!rec) throw new Error('That extension was not installed by the store');
    if (!rec.storeId) throw new Error('Unpacked folders have to be updated manually');
    try { session.defaultSession.removeExtension(rec.extId); } catch {}
    const fresh = await installById(rec.storeId, (p) => progress(p), (s) => progress({ id: rec.storeId, stage: s }));
    progress({ id: rec.storeId, stage: 'done', percent: 100 });
    return { success: true, extension: fresh, updated: fresh.version !== rec.version };
  });

  guard('silence-store:set-enabled', async ({ id, enabled }) => {
    const rec = meta.items.find((m) => m.extId === id);
    if (!rec) throw new Error('Unknown extension');
    if (enabled) {
      await withTimeout(hooks.registerExtension ? hooks.registerExtension(rec.dir)
                                                : session.defaultSession.loadExtension(rec.dir, { allowFileAccess: true }),
        LOAD_TIMEOUT, 'Re-enabling');
    } else {
      session.defaultSession.removeExtension(rec.extId);
    }
    rec.disabled = !enabled;
    writeJson(metaFile, meta);
    broadcast('silence-store:changed', { extId: id, action: enabled ? 'enabled' : 'disabled' });
    return { success: true };
  });

  guard('silence-store:browse-unpacked', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win || undefined, {
      title: 'Select unpacked extension folder', properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const rec = await finalizeInstall(result.filePaths[0], { storeId: null, source: 'unpacked', label: result.filePaths[0] });
    return { success: true, extension: rec };
  });

  guard('silence-store:selftest', async () => selfTest());

  ipcMain.on('silence-store:open-folder', (event, { id } = {}) => {
    const rec = meta.items.find((m) => m.extId === id);
    if (rec && fs.existsSync(rec.dir)) shell.showItemInFolder(rec.dir);
    else shell.openPath(storeDir);
  });

  ipcMain.on('silence-store:open-url', (event, { url } = {}) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && url) win.webContents.send('open-url-in-tab', { url });
  });

  ipcMain.handle('silence-store:catalog', () => readJson(catalogFile, { items: [] }));
  ipcMain.handle('silence-store:version', () => (readJson(catalogFile, {}) || {}).generated || null);

  guard('silence-store:update-all', async () => {
    const r = await checkAllUpdates();
    return { success: true, ...r };
  });
  guard('silence-store:update-status', async () => ({
    success: true,
    checkedAt: lastUpdateCheck,
    results: lastUpdateResults,
    installed: meta.items.length
  }));

  log('ready —', (readJson(catalogFile, { items: [] }).items || []).length, 'catalog items,', meta.items.length, 'installed');
  try { scheduleUpdates(); } catch (e) { log('update scheduler failed:', e.message); }
}

/* =========================================================================
   Automatic updates — the same Omaha protocol Chrome itself uses.
   Chrome polls https://clients2.google.com/service/update2/crx with each
   installed extension's id + version; the reply names a newer CRX when one
   exists. We do exactly that, then swap the extension folder in place.
   ========================================================================= */
const UPDATE_SERVICE = 'https://clients2.google.com/service/update2/crx';
const PRODVERSION = '128.0.0.0';
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastUpdateCheck = 0;
let lastUpdateResults = [];
let updateTimer = null;

function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.\-+_]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split(/[.\-+_]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function omahaUpdateCheck(apps) {
  const params = new URLSearchParams();
  params.set('prodversion', PRODVERSION);
  params.set('acceptformat', 'crx2,crx3');
  apps.forEach((a) => params.append('x', 'id=' + a.id + '&v=' + (a.version || '0.0.0.0') + '&installsource=ondemand&uc'));
  const res = await net.fetch(UPDATE_SERVICE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) throw new Error('update service returned ' + res.status);
  return res.text();
}

function parseUpdateXml(xml) {
  const out = {};
  const appRe = /<app\s+appid="([^"]+)"([^>]*)>([\s\S]*?)<\/app>/g;
  let m;
  while ((m = appRe.exec(xml))) {
    const id = m[1], body = m[3], attrs = m[2];
    const uc = /<updatecheck[^>]*>/i.exec(body);
    const pick = (re) => (uc ? ((re.exec(uc[0]) || [])[1] || null) : null);
    out[id] = {
      status: pick(/status="([^"]+)"/i) || (/status="([^"]+)"/i.exec(attrs) || [])[1] || 'unknown',
      codebase: pick(/codebase="([^"]+)"/i),
      version: pick(/version="([^"]+)"/i)
    };
  }
  return out;
}

/** replace an installed extension's files with a newer CRX, keeping its id */
async function applyUpdate(rec, crxUrl, newVersion) {
  const tmp = path.join(storeDir, '.update_' + Date.now());
  const buf = await downloadBuffer(crxUrl, () => {});
  if (!buf || buf.length < 200) throw new Error('download blocked (' + (buf ? buf.length : 0) + ' bytes)');
  extractZip(stripCrxHeader(buf), tmp);
  try { session.defaultSession.removeExtension(rec.extId); } catch (e) {}
  try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch (e) {}
  fs.renameSync(tmp, rec.dir);
  if (hooks.registerExtension) await hooks.registerExtension(rec.dir);
  rec.version = newVersion || rec.version;
  rec.updatedAt = Date.now();
  writeJson(metaFile, meta);
  broadcast('silence-store:changed', { extId: rec.extId, name: rec.name, action: 'updated' });
  log('updated', rec.name, '->', rec.version);
  return rec;
}

async function checkAllUpdates() {
  const items = meta.items.slice();
  if (!items.length) { lastUpdateCheck = Date.now(); lastUpdateResults = []; return { results: [], checkedAt: lastUpdateCheck }; }
  const results = [];
  try {
    const xml = await omahaUpdateCheck(items.map((i) => ({ id: i.extId, version: i.version })));
    const info = parseUpdateXml(xml);
    for (const rec of items) {
      const u = info[rec.extId];
      try {
        if (!u || u.status !== 'ok' || !u.codebase || !u.version) { results.push({ id: rec.extId, name: rec.name, status: 'up-to-date' }); continue; }
        if (cmpVersion(u.version, rec.version) <= 0) { results.push({ id: rec.extId, name: rec.name, status: 'up-to-date', version: rec.version }); continue; }
        const updated = await applyUpdate(rec, u.codebase, u.version);
        results.push({ id: rec.extId, name: updated.name, status: 'updated', from: rec.version, to: u.version });
      } catch (e) {
        results.push({ id: rec.extId, name: rec.name, status: 'failed', error: e.message });
      }
    }
  } catch (e) {
    items.forEach((rec) => results.push({ id: rec.extId, name: rec.name, status: 'failed', error: e.message }));
  }
  lastUpdateCheck = Date.now();
  lastUpdateResults = results;
  broadcast('silence-store:updates', { results, checkedAt: lastUpdateCheck });
  return { results, checkedAt: lastUpdateCheck };
}

function scheduleUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(() => { checkAllUpdates().catch((e) => log('auto-update failed:', e.message)); }, UPDATE_INTERVAL_MS);
  setTimeout(() => { checkAllUpdates().catch((e) => log('auto-update failed:', e.message)); }, 90000);
}


module.exports = {
  init,
  initExtensionStore: init,   // name used by main.js
  parseId,
  stripCrxHeader,
  extractZip,
  readManifest,
  selfTest,
  checkAllUpdates,
  cmpVersion,
  parseUpdateXml
};
