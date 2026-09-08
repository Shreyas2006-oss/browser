/**
 * Silence Core — main-process upgrade pack
 * ------------------------------------------------------------------
 * Adds the pieces a modern browser is expected to have and wires them to
 * Settings → (the new panels in silence-plus.js):
 *
 *   • real ad/tracker blocking (@ghostery/adblocker-electron) + pause list
 *   • HTTPS-First mode, Secure DNS (DoH), Do-Not-Track header, popup blocking
 *   • per-site permissions (camera, mic, location, notifications …) + log
 *   • encrypted password vault (safeStorage)
 *   • Widevine DRM detection (Netflix / Prime / Spotify)
 *   • clear-data-on-quit, hardware acceleration, spellcheck languages
 *   • optional advanced chrome.* API support (electron-chrome-extensions)
 *
 * Usage in main.js (see INSTALL.md):
 *   const { applyStartupSwitches, initSilenceCore } = require('./silence-core');
 *   applyStartupSwitches();                       // before app ready
 *   …inside createWindow(): initSilenceCore({ getWindow: () => win });
 */

const fs = require('fs');
const path = require('path');
const { app, session, ipcMain, shell, dialog, safeStorage, BrowserWindow } = require('electron');

/* ------------------------------------------------------------------ *
 * settings store
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  privacy: {
    adBlock: true,
    adBlockPause: [],          // hosts where ad blocking is paused
    httpsFirst: true,
    doh: 'off',                // off | automatic | secure
    dohProvider: 'cloudflare',
    doNotTrack: true,
    blockPopups: false,          // pop-ups allowed unless you turn this on
    clearOnQuit: false,
    clearOnQuitItems: ['cache', 'storage'],
    thirdPartyCookieFix: true      // relax SameSite for embedded sign-in frames only
  },
  tabs: {
    askBeforeNewTab: false         // Chrome opens links in a new tab straight away
  },
  permissions: {},            // origin -> { permission: 'allow' | 'deny' }
  permissionDefaults: {},     // permission -> 'ask' | 'allow' | 'deny'
  permissionLog: [],          // [{ origin, permission, ts }]
  sites: { zoom: {} },        // host -> zoom factor
  downloads: { path: null, ask: false },
  search: { engine: null, startup: 'blank', homepage: 'https://www.google.com', newTab: 'home' },
  languages: { spellcheck: true, languages: ['en-US'] },
  system: { hardwareAcceleration: true, runInBackground: false, smoothScrolling: true, animations: true },
  drm: { enabled: true },
  extensions: { advancedApis: true },
  vault: []                   // [{ id, site, username, password (encrypted base64) }]
};

const DOH_PROVIDERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
  adguard: 'https://dns.adguard.com/dns-query'
};

function settingsFile() { return path.join(app.getPath('userData'), 'silence_settings.json'); }

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

let SETTINGS = null;

function readSettingsSync() {
  if (SETTINGS) return SETTINGS;
  try { SETTINGS = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); }
  catch { SETTINGS = deepMerge(DEFAULTS, {}); }
  return SETTINGS;
}
function writeSettings(s) {
  SETTINGS = s;
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8'); } catch (e) { console.error('[core] save failed', e.message); }
}
const get = () => readSettingsSync();

/* ------------------------------------------------------------------ *
 * startup switches (must run before app ready)
 * ------------------------------------------------------------------ */

function findWidevine() {
  const home = process.env.LOCALAPPDATA || (process.env.HOME || '');
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      { src: 'Google Chrome', root: path.join(home, 'Google', 'Chrome', 'User Data', 'WidevineCdm') },
      { src: 'Microsoft Edge', root: path.join(home, 'Microsoft', 'Edge', 'User Data', 'WidevineCdm') },
      { src: 'Chrome Beta', root: path.join(home, 'Google', 'Chrome Beta', 'User Data', 'WidevineCdm') },
      { src: 'Brave', root: path.join(home, 'BraveSoftware', 'Brave-Browser', 'User Data', 'WidevineCdm') },
      { src: 'Opera', root: path.join(home, 'Opera Software', 'Opera Stable', 'WidevineCdm') },
      { src: 'Vivaldi', root: path.join(home, 'Vivaldi', 'User Data', 'WidevineCdm') }
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      { src: 'Google Chrome', root: path.join(process.env.HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'WidevineCdm') },
      { src: 'Microsoft Edge', root: path.join(process.env.HOME, 'Library', 'Application Support', 'Microsoft Edge', 'WidevineCdm') }
    );
  } else {
    candidates.push(
      { src: 'Google Chrome', root: path.join(process.env.HOME || '', '.config', 'google-chrome', 'WidevineCdm') },
      { src: 'Chromium', root: path.join(process.env.HOME || '', '.config', 'chromium', 'WidevineCdm') }
    );
  }
  const s = readSettingsSync();
  const manual = s.drm && s.drm.path;
  if (manual && fs.existsSync(manual)) {
    try {
      const files = fs.readdirSync(manual);
      if (files.some((f) => /widevinecdm\.(dll|so|dylib)$/.test(f))) {
        return { path: manual, version: (s.drm.version || '0.0.0.0'), source: 'manual', adapter: files.some((f) => /widevinecdmadapter/.test(f)) };
      }
    } catch {}
  }
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c.root)) continue;
      const versions = fs.readdirSync(c.root)
        .filter((v) => /^[\d.]+$/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        const archDir = path.join(c.root, v, '_platform_specific');
        if (!fs.existsSync(archDir)) continue;
        for (const arch of fs.readdirSync(archDir)) {
          const dir = path.join(archDir, arch);
          const files = fs.readdirSync(dir);
          if (files.some((f) => /widevinecdm\.(dll|so|dylib)$/.test(f))) {
            return { path: dir, version: v, source: c.src, adapter: files.some((f) => /widevinecdmadapter/.test(f)) };
          }
        }
      }
    } catch {}
  }
  return null;
}

function applyStartupSwitches() {
  const s = readSettingsSync();
  if (s.system && s.system.hardwareAcceleration === false) {
    try { app.disableHardwareAcceleration(); } catch {}
  }
  if (s.drm && s.drm.enabled) {
    const wv = findWidevine();
    if (wv) {
      app.commandLine.appendSwitch('widevine-cdm-path', wv.path);
      app.commandLine.appendSwitch('widevine-cdm-version', wv.version);
      console.log('[core] Widevine CDM:', wv.version, 'from', wv.source);
    } else {
      console.log('[core] Widevine CDM not found (install Chrome or Edge to enable DRM playback)');
    }
  }
  return readSettingsSync();
}

/* ------------------------------------------------------------------ *
 * ad blocking
 * ------------------------------------------------------------------ */

let blocker = null;
let blockerActive = false;

async function setupAdBlocker() {
  const ses = session.defaultSession;
  try {
    // eslint-disable-next-line
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const fetchImpl = (() => { try { return require('cross-fetch'); } catch { return fetch; } })();
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchImpl);
    blocker.enableBlockingInSession(ses);
    blockerActive = true;
    console.log('[core] ad blocker engine loaded');
    return 'engine';
  } catch (e) {
    console.warn('[core] adblocker engine unavailable (' + e.message + ') — falling back to built-in list');
    // Chromium only allows a wildcard as the leading "*." of a host,
    // so every pattern below is validated before it is registered.
    const adFilterList = [
      '*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.googleadservices.com/*',
      '*://*.google-analytics.com/*', '*://*.adnxs.com/*', '*://*.popads.net/*',
      '*://*.outbrain.com/*', '*://*.taboola.com/*', '*://*.adsterra.com/*', '*://*.propellerads.com/*',
      '*://*.exoclick.com/*', '*://*.trafficjunky.com/*', '*://*.clickadu.com/*',
      '*://*.ad-maven.com/*', '*://*.monetag.com/*', '*://*.hilltopads.com/*',
      '*://*.onclickads.net/*', '*://*.popunder.net/*', '*://*.popunder.com/*',
      '*://*.ad-maven.net/*', '*://*.juicyads.com/*', '*://*.ero-advertising.com/*'
    ].filter((u) => {
      const m = u.match(/^\*?:\/\/([^/]+)\//);
      if (!m) return false;
      const host = m[1];
      if (host === '*') return true;
      return /^\*\.[a-z0-9.-]+$/.test(host);          // *.example.com only
    });
    try {
      ses.webRequest.onBeforeRequest({ urls: adFilterList }, (details, callback) => {
        callback({ cancel: blockerActive && !paused(details.url) });
      });
      blockerActive = true;
      console.log('[core] built-in filter list active (' + adFilterList.length + ' patterns)');
    } catch (err) {
      console.warn('[core] could not install filter list:', err.message);
    }
    return 'fallback';
  }
}

const SIGNIN_HOSTS = ['accounts.google.com', 'gstatic.com', 'googleusercontent.com', 'recaptcha.net', 'www.recaptcha.net'];
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function paused(url) {
  // sign-in must never be filtered: a blocked accounts.google.com script is
  // one of the classic causes of "couldn't sign you in"
  const h = hostOf(url);
  if (SIGNIN_HOSTS.some((x) => h === x || h.endsWith('.' + x))) return true;
  if (h === 'www.google.com' && /\/(gsi|signin|ServiceLogin|o\/oauth2)/i.test(url)) return true;

  const list = (get().privacy && get().privacy.adBlockPause) || [];
  if (!list.length) return false;
  return list.some((x) => h === x || h.endsWith('.' + x));
}
function setAdBlockEnabled(on) {
  const s = get();
  s.privacy.adBlock = !!on;
  writeSettings(s);
  const ses = session.defaultSession;
  try {
    if (blocker) {
      if (on) blocker.enableBlockingInSession(ses); else blocker.disableBlockingInSession(ses);
    }
    blockerActive = !!on;
  } catch {}
}
/** ghostery is session-wide, so a paused host pauses blocking while you're on it */
function syncPause(url) {
  if (!blocker) return;
  const s = get();
  if (!s.privacy.adBlock) return;
  try {
    if (paused(url)) blocker.disableBlockingInSession(session.defaultSession);
    else blocker.enableBlockingInSession(session.defaultSession);
  } catch {}
}

/* ------------------------------------------------------------------ *
 * privacy: HTTPS-First, DoH, DNT
 * ------------------------------------------------------------------ */

function httpsExceptions() { return (get().privacy && get().privacy.httpsFirstExceptions) || []; }

function installPrivacyHandlers() {
  const ses = session.defaultSession;

  // HTTPS-First: upgrade top-level http navigations
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, callback) => {
    const s = get();
    if (!s.privacy.httpsFirst) return callback({ cancel: false });
    if (details.resourceType !== 'mainFrame') return callback({ cancel: false });
    const h = hostOf(details.url);
    if (!h || h === 'localhost' || h.startsWith('127.') || httpsExceptions().some((x) => h === x || h.endsWith('.' + x))) {
      return callback({ cancel: false });
    }
    callback({ redirectURL: details.url.replace(/^http:/, 'https:') });
  });

  // Do Not Track
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const s = get();
    if (s.privacy.doNotTrack && details.requestHeaders) {
      details.requestHeaders['DNT'] = '1';
      details.requestHeaders['Sec-GPC'] = '1';
    }
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  applyDoh();
  applySpellcheck();
}

function applyDoh() {
  const s = get();
  try {
    const mode = s.privacy.doh || 'off';
    if (mode === 'off') {
      if (session.defaultSession.configureHostResolver) session.defaultSession.configureHostResolver({ secureDnsMode: 'off' });
    } else {
      const server = DOH_PROVIDERS[s.privacy.dohProvider] || DOH_PROVIDERS.cloudflare;
      session.defaultSession.configureHostResolver({
        secureDnsMode: mode === 'secure' ? 'secure' : 'automatic',
        secureDnsServers: [server]
      });
    }
  } catch (e) { console.warn('[core] DoH not applied:', e.message); }
}

function applySpellcheck() {
  const s = get();
  try {
    session.defaultSession.setSpellCheckerLanguages((s.languages && s.languages.languages) || ['en-US']);
  } catch {}
}

/* ------------------------------------------------------------------ *
 * permissions
 * ------------------------------------------------------------------ */

const INVASIVE = ['media', 'camera', 'microphone', 'geolocation', 'notifications', 'midiSysex',
  'serial', 'bluetooth', 'hid', 'usb', 'idle-detection', 'display-capture'];

function originOf(url) {
  try { return new URL(url).origin; } catch { return String(url || ''); }
}

function logPermission(origin, permission) {
  const s = get();
  s.permissionLog = (s.permissionLog || []).filter((r) => !(r.origin === origin && r.permission === permission));
  s.permissionLog.unshift({ origin, permission, ts: Date.now() });
  s.permissionLog = s.permissionLog.slice(0, 60);
  writeSettings(s);
}

function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    try {
      const origin = originOf((details && (details.requestingUrl || details.securityOrigin)) || webContents.getURL());
      const s = get();
      const rule = (s.permissions && s.permissions[origin] && s.permissions[origin][permission]) ||
                   (s.permissionDefaults || {})[permission];
      if (rule === 'allow') return callback(true);
      if (rule === 'deny') { logPermission(origin, permission); return callback(false); }
      if (permission === 'clipboard-sanitized-write') {
        return callback(origin.startsWith('file://') || origin.startsWith('silence://'));
      }
      if (INVASIVE.includes(permission)) { logPermission(origin, permission); return callback(false); }
      callback(true);
    } catch { callback(false); }
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    try {
      const origin = originOf(requestingOrigin);
      const s = get();
      const rule = (s.permissions && s.permissions[origin] && s.permissions[origin][permission]) ||
                   (s.permissionDefaults || {})[permission];
      if (rule === 'allow') return true;
      if (rule === 'deny') return false;
      return permission === 'clipboard-sanitized-write'
        ? String(requestingOrigin).startsWith('file://') || String(requestingOrigin).startsWith('silence://')
        : !INVASIVE.includes(permission);
    } catch { return false; }
  });
}

/* ------------------------------------------------------------------ *
 * password vault
 * ------------------------------------------------------------------ */

function encAvailable() { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }
function encrypt(str) {
  const buf = safeStorage.encryptString(String(str));
  return { enc: true, data: buf.toString('base64') };
}
function decrypt(rec) {
  if (rec && rec.enc) {
    try { return safeStorage.decryptString(Buffer.from(rec.data, 'base64')); } catch { return ''; }
  }
  return rec || '';
}
function vaultPublic() {
  return (get().vault || []).map((v) => ({ id: v.id, site: v.site, username: v.username }));
}

/* ------------------------------------------------------------------ *
 * data clearing
 * ------------------------------------------------------------------ */

async function clearData(opts = {}) {
  const ses = session.defaultSession;
  if (opts.cache) await ses.clearCache();
  if (opts.storage) await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'websql', 'serviceworkers', 'filesystem'] });
  if (opts.cookies) await ses.clearStorageData({ storages: ['cookies'] });
  return true;
}

async function runClearOnQuit() {
  const s = get();
  if (!s.privacy.clearOnQuit) return;
  const items = s.privacy.clearOnQuitItems || [];
  try { await clearData({ cache: items.includes('cache'), storage: items.includes('storage'), cookies: items.includes('cookies') }); }
  catch (e) { console.warn('[core] clear-on-quit failed', e.message); }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function initSilenceCore(opts = {}) {
  const getWindow = opts.getWindow || (() => BrowserWindow.getAllWindows()[0]);

  setupAdBlocker().catch((e) => console.warn('[core] ad blocker setup failed:', e && e.message));
  installPrivacyHandlers();
  installPermissionHandlers();
  maybeLoadAdvancedApis(opts);

  const guard = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
    try { return await fn(arg || {}); }
    catch (err) { return { error: err && err.message ? err.message : String(err) }; }
  });

  guard('silence:get-settings', async () => get());
  guard('silence:set-settings', async (patch) => {
    const merged = deepMerge(get(), patch);
    writeSettings(merged);
    applyDoh();
    applySpellcheck();
    setAdBlockEnabled(merged.privacy.adBlock);
    return merged;
  });
  guard('silence:reset-settings', async () => { writeSettings(deepMerge(DEFAULTS, {})); return get(); });

  guard('silence:app-info', async () => {
    const s = get();
    return {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform + ' ' + process.arch,
      userData: app.getPath('userData'),
      downloads: s.downloads.path || app.getPath('downloads'),
      extensions: path.join(app.getPath('userData'), 'installed_extensions'),
      widevine: findWidevine(),
      encryption: encAvailable()
    };
  });

  guard('silence:clear-data', async (o) => { await clearData(o); return { ok: true }; });
  guard('silence:open-path', async ({ target }) => {
    const s = get();
    const map = {
      userData: app.getPath('userData'),
      downloads: s.downloads.path || app.getPath('downloads'),
      extensions: path.join(app.getPath('userData'), 'installed_extensions'),
      temp: app.getPath('temp')
    };
    const p = target && target.startsWith('/') ? target : (map[target] || app.getPath('userData'));
    shell.openPath(p);
    return { ok: true };
  });
  guard('silence:relaunch', async () => { app.relaunch(); app.exit(0); return { ok: true }; });

  guard('silence:permission-set', async ({ origin, permission, value }) => {
    const s = get();
    s.permissions = s.permissions || {};
    s.permissions[origin] = s.permissions[origin] || {};
    if (value === 'ask') delete s.permissions[origin][permission];
    else s.permissions[origin][permission] = value;
    s.permissionLog = (s.permissionLog || []).filter((r) => !(r.origin === origin && r.permission === permission));
    writeSettings(s);
    return s.permissions;
  });
  guard('silence:permission-default', async ({ permission, value }) => {
    const s = get();
    s.permissionDefaults = s.permissionDefaults || {};
    s.permissionDefaults[permission] = value;
    writeSettings(s);
    return s.permissionDefaults;
  });
  guard('silence:permission-clear', async ({ origin }) => {
    const s = get();
    if (origin) delete s.permissions[origin]; else s.permissions = {};
    writeSettings(s);
    return s.permissions;
  });

  guard('silence:vault-list', async () => ({ ok: true, items: vaultPublic(), encryption: encAvailable() }));
  guard('silence:vault-save', async ({ id, site, username, password }) => {
    const s = get();
    s.vault = s.vault || [];
    const rec = { id: id || 'v_' + Date.now(), site, username, password: encAvailable() ? encrypt(password) : password };
    const i = s.vault.findIndex((v) => v.id === rec.id);
    if (i >= 0) s.vault[i] = rec; else s.vault.push(rec);
    writeSettings(s);
    return { ok: true, items: vaultPublic() };
  });
  guard('silence:vault-reveal', async ({ id }) => {
    const rec = (get().vault || []).find((v) => v.id === id);
    return { ok: true, password: decrypt(rec && rec.password) };
  });
  guard('silence:vault-delete', async ({ id }) => {
    const s = get();
    s.vault = (s.vault || []).filter((v) => v.id !== id);
    writeSettings(s);
    return { ok: true, items: vaultPublic() };
  });

  // the renderer tells us which page is active so a paused host can disable blocking
  ipcMain.on('silence:adblock-sync', (_e, { url } = {}) => { try { syncPause(url); } catch {} });

  guard('silence:browse-folder', async () => {
    const r = await dialog.showOpenDialog(getWindow() || undefined, { properties: ['openDirectory'] });
    return { path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] };
  });

  /* ---------- extension pop-up window ----------
     A <webview> often fails to load chrome-extension://…/popup.html (ERR_FAILED).
     A frameless BrowserWindow in the same session always works, so the renderer
     falls back to this whenever the inline bubble cannot load. */
  let popupWin = null;
  ipcMain.on('silence:ext-popup', (_e, { url, x, y, width, height } = {}) => {
    try {
      if (popupWin && !popupWin.isDestroyed()) { popupWin.close(); popupWin = null; }
      if (!url || !String(url).startsWith('chrome-extension://')) return;
      const w = Math.max(240, Math.min(720, width || 360));
      const h = Math.max(120, Math.min(700, height || 520));
      popupWin = new BrowserWindow({
        width: w, height: h, x: Math.max(0, (x || 0) - w + 60), y: Math.max(0, (y || 0) + 8),
        frame: false, resizable: false, movable: true, skipTaskbar: true,
        alwaysOnTop: true, backgroundColor: '#ffffff', show: false,
        webPreferences: { session: session.defaultSession, nodeIntegration: false, contextIsolation: true, sandbox: false }
      });
      popupWin.once('ready-to-show', () => popupWin.show());
      popupWin.on('blur', () => { if (popupWin && !popupWin.isDestroyed()) { popupWin.close(); popupWin = null; } });
      popupWin.on('closed', () => { popupWin = null; });
      popupWin.loadURL(url).catch((e) => console.warn('[core] popup load failed:', e.message));
    } catch (e) { console.warn('[core] popup window failed:', e.message); }
  });
  ipcMain.on('silence:ext-popup-close', () => {
    try { if (popupWin && !popupWin.isDestroyed()) popupWin.close(); } catch (e) {}
  });

  console.log('[core] ready');
}

/** optional: much better chrome.* API coverage for extensions */
function maybeLoadAdvancedApis(opts) {
  const s = get();
  if (!s.extensions || !s.extensions.advancedApis) return;
  // the library leans on service-worker preload scripts that only exist in
  // Electron 35 and newer; on older builds it is skipped, never half-loaded
  const major = parseInt((process.versions.electron || '0').split('.')[0], 10);
  if (major && major < 35) {
    console.log('[core] extension APIs need Electron 35+ (this build runs ' + process.versions.electron + ')');
    return;
  }
  try {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    const ext = new ElectronChromeExtensions({
      session: session.defaultSession,
      createTab: async (details) => {
        const win = opts.getWindow && opts.getWindow();
        if (!win) return [];
        win.webContents.send('open-url-in-tab', { url: details.url || 'about:blank' });
        return [];
      }
    });
    const { webContents } = require('electron');
    webContents.getAllWebContents().forEach((wc) => { try { ext.addTab(wc, BrowserWindow.fromWebContents(wc) || undefined); } catch {} });
    app.on('web-contents-created', (_e, wc) => {
      try { ext.addTab(wc, BrowserWindow.fromWebContents(wc) || undefined); } catch {}
    });
    console.log('[core] advanced extension APIs enabled');
  } catch (e) {
    console.warn('[core] electron-chrome-extensions unavailable:', e.message);
  }
}

module.exports = {
  applyStartupSwitches, initSilenceCore, readSettingsSync, writeSettings, getSettings: get,
  clearData, runClearOnQuit, syncPause, paused, findWidevine, setAdBlockEnabled, DOH_PROVIDERS, DEFAULTS
};
