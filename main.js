const { app, BrowserWindow, ipcMain, dialog, session, shell, protocol } = require('electron');
const { initExtensionStore, extractZip, cmpVersion } = require('./extension-store-backend');
const { applyStartupSwitches, initSilenceCore, runClearOnQuit, getSettings, readSettingsSync } = require('./silence-core');
const { initSilencePro } = require('./silence-pro-core');
const path = require('path');
const fs = require('fs');

applyStartupSwitches();

try {
  app.commandLine.appendSwitch('disable-features',
    'ThirdPartyStoragePartitioning,StoragePartitioning,ThirdPartyCookieDeprecationMetadata,' +
    'TpcdHeuristicsGrants,TpcdMetadataGrants,TpcdSupportSettings,TrackingProtection3pcd');
} catch (e) {
  console.error('[silence] could not disable storage partitioning:', e && e.message);
}

try {
  if (process.env.SILENCE_USERDATA) {
    app.setPath('userData', process.env.SILENCE_USERDATA);
  } else {
    app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'Silence-App' : 'Silence'));
  }
} catch (e) {
  console.error('[silence] could not relocate userData:', e && e.message);
}

(function bridgeExtensionApi() {
  try {
    const s = session.defaultSession;
    if (!s || !s.extensions || s.__extApiBridged) return;
    s.__extApiBridged = true;
    ['loadExtension', 'removeExtension', 'getExtension', 'getAllExtensions'].forEach((m) => {
      if (typeof s.extensions[m] === 'function') s[m] = s.extensions[m].bind(s.extensions);
    });
  } catch (e) {
    console.warn('[silence] extension API bridge skipped:', e && e.message);
  }
})();

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'silence',
    privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: false }
  }
]);

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enable-pdf-viewer');
app.commandLine.appendSwitch('renderer-process-limit', '6');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512 --optimize-for-size');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');
app.userAgentFallback = CHROME_UA;

let win;
const extensionsConfigFile = path.join(app.getPath('userData'), 'silence_extensions.json');

function loadSavedExtensionPaths() {
  try {
    if (fs.existsSync(extensionsConfigFile)) {
      const saved = JSON.parse(fs.readFileSync(extensionsConfigFile, 'utf8'));
      return Array.isArray(saved) ? saved.filter(p => typeof p === 'string' && path.isAbsolute(p)) : [];
    }
  } catch (e) {}
  return [];
}

function saveExtensionPaths(paths) {
  try {
    fs.writeFileSync(extensionsConfigFile, JSON.stringify(paths, null, 2), 'utf8');
  } catch (e) {}
}

let loadedExtensions = [];

const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'file:', 'blob:', 'data:', 'silence:']);
const TRUSTED_AUTH_HOSTS = new Set(['accounts.google.com', 'myaccount.google.com', 'google.com']);

function linkDebug() {
  try {
    return !!(process.env.SILENCE_LINK_DEBUG && process.env.SILENCE_LINK_DEBUG !== '0');
  } catch (e) {
    return false;
  }
}

function askBeforeNewTab() {
  try {
    const s = readSettingsSync();
    return !!(s && s.tabs && s.tabs.askBeforeNewTab);
  } catch (e) {
    return false;
  }
}

function checkElectronCurrency() {
  try {
    const { net } = require('electron');
    const req = net.request('https://registry.npmjs.org/electron/latest');
    let body = '';
    req.setHeader('accept', 'application/json');
    req.on('response', (res) => {
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        try {
          const latest = String(JSON.parse(body).version || '');
          const cur = parseInt(String(process.versions.electron).split('.')[0], 10) || 0;
          if (latest && (parseInt(latest.split('.')[0], 10) - cur) >= 2 && win && win.webContents) {
            win.webContents.send('electron-outdated', { current: process.versions.electron, latest });
          }
        } catch (e) {}
      });
    });
    req.on('error', () => {});
    req.end();
  } catch (e) {}
}

function isSafeRemoteUrl(value, { authOnly = false } = {}) {
  if (!value || value === 'about:blank' || value.startsWith('about:')) return true;
  try {
    const parsed = new URL(String(value));
    if (!SAFE_REMOTE_PROTOCOLS.has(parsed.protocol)) return false;
    if (authOnly && ![...TRUSTED_AUTH_HOSTS].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return false;
    return true;
  } catch {
    return false;
  }
}

function isDownloadUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();
    const fileExts = [
      '.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.exe', '.msi',
      '.apk', '.dmg', '.bin', '.torrent', '.pdf', '.mp4', '.mkv',
      '.mp3', '.wav', '.ogg', '.epub', '.csv', '.xlsx', '.docx'
    ];
    if (fileExts.some(ext => pathname.endsWith(ext))) return true;
    if (pathname.endsWith('/download') || pathname.endsWith('/dl') || search.includes('download') || search.includes('dl=')) return true;
    if (parsed.hostname.includes('buzzheavier.com') && (pathname.includes('/download') || pathname.includes('/f/'))) return true;
    if (parsed.hostname.includes('pixeldrain.com') && pathname.includes('/api/file/')) return true;
    if (parsed.hostname.includes('datanodes.to') && (pathname.includes('/download') || search.includes('op=download'))) return true;
    if (parsed.hostname.includes('vikingfile.com') && pathname.includes('/download')) return true;
    if (parsed.hostname.includes('mega.nz') && pathname.includes('/file/')) return false;
    return false;
  } catch {
    return false;
  }
}

function isAdOrPopunderUrl(url) {
  if (!url) return false;
  const adKeywords = [
    'adsterra', 'propellerads', 'popads', 'monetag', 'exoclick',
    'onclick', 'bet365', '1xbet', 'trafficjunky', 'hilltopads',
    'clickadu', 'ad-maven', 'adnxs', 'doubleclick', 'googleadservices',
    'popunder', 'redirecting', 'go.ad', 'track.ad'
  ];
  const lower = url.toLowerCase();
  return adKeywords.some(keyword => lower.includes(keyword));
}

function safeDownloadName(name) {
  const cleaned = path.basename(String(name || 'download')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'download';
}

function crxToZip(buf) {
  if (buf.slice(0, 4).toString() === 'Cr24') {
    const version = buf.readUInt32LE(4);
    if (version === 3) {
      const headerLength = buf.readUInt32LE(8);
      return buf.slice(12 + headerLength);
    } else if (version === 2) {
      const pubKeyLen = buf.readUInt32LE(8);
      const sigLen = buf.readUInt32LE(12);
      return buf.slice(16 + pubKeyLen + sigLen);
    }
  }
  if (buf[0] === 0x50 && buf[1] === 0x4B) return buf;
  throw new Error('Invalid CRX format');
}

async function registerExtension(extensionPath) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('manifest.json not found');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ext = await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true });

  let iconDataUrl = null;
  const icons = manifest.icons || (manifest.action && manifest.action.default_icon) || (manifest.browser_action && manifest.browser_action.default_icon);
  if (icons) {
    const iconRel = typeof icons === 'string' ? icons : (icons['32'] || icons['48'] || icons['128'] || Object.values(icons)[0]);
    if (iconRel) {
      const fullIconPath = path.join(extensionPath, iconRel);
      if (fs.existsSync(fullIconPath)) {
        const extName = path.extname(fullIconPath).slice(1);
        iconDataUrl = `data:image/${extName};base64,` + fs.readFileSync(fullIconPath).toString('base64');
      }
    }
  }

  const popupHtml = (manifest.action && manifest.action.default_popup) ||
                    (manifest.browser_action && manifest.browser_action.default_popup) || null;

  const optionsHtml = manifest.options_ui && manifest.options_ui.page
                    ? manifest.options_ui.page
                    : (manifest.options_page || null);

  const extInfo = {
    id: ext.id,
    name: manifest.name || ext.name,
    version: manifest.version || ext.version,
    description: manifest.description || '',
    path: extensionPath,
    icon: iconDataUrl,
    popupUrl: popupHtml ? `chrome-extension://${ext.id}/${popupHtml}` : null,
    optionsUrl: optionsHtml ? `chrome-extension://${ext.id}/${optionsHtml}` : null
  };

  loadedExtensions = loadedExtensions.filter(e => e.id !== ext.id);
  loadedExtensions.push(extInfo);
  return extInfo;
}

function popupBlockingEnabled() {
  try {
    return !!(getSettings() && getSettings().privacy && getSettings().privacy.blockPopups);
  } catch (e) {
    return false;
  }
}

function broadcastStoreChange() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send('silence-store:changed', { action: 'removed' });
    } catch (e) {}
  }
}

function registerSilencePages() {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  };
  protocol.handle('silence', (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      const rel = (url.pathname || '/').replace(/^\/+/, '');
      if (!['store', 'extensions', ''].includes(host)) return new Response('Not found', { status: 404 });
      const file = rel === 'catalog.json' ? 'catalog.json' : 'store.html';
      const full = path.join(__dirname, file);
      if (!full.startsWith(__dirname) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(full), {
        status: 200,
        headers: { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' }
      });
    } catch (e) {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function createWindow() {
  registerSilencePages();

  try {
    initSilenceCore({ getWindow: () => win });
    setTimeout(checkElectronCurrency, 15000);
  } catch (e) {
    console.error('[core] failed to start:', e);
  }

  try {
    initSilencePro({ getWindow: () => win });
  } catch (e) {
    console.error('[pro] failed to start:', e);
  }

  try {
    initExtensionStore({
      appDir: __dirname,
      registerExtension,
      persistPath: (dir) => {
        const saved = loadSavedExtensionPaths();
        if (!saved.includes(dir)) { saved.push(dir); saveExtensionPaths(saved); }
      },
      forgetPath: (dir) => saveExtensionPaths(loadSavedExtensionPaths().filter(p => p !== dir))
    });
  } catch (e) {
    console.error('[store] extension store failed to start:', e);
  }

  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'fullscreen' || permission === 'pointerLock' || permission === 'storage-access') {
      return callback(true);
    }
    const origin = webContents.getURL();
    const allowed = permission === 'clipboard-sanitized-write' && origin.startsWith('file://');
    callback(allowed);
  });
  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'fullscreen' || permission === 'pointerLock') return true;
    return permission === 'clipboard-sanitized-write' && String(requestingOrigin).startsWith('file://');
  });

  defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHROME_UA;
    h['Sec-CH-UA'] = '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
    h['Sec-CH-UA-Mobile'] = '?0';
    h['Sec-CH-UA-Platform'] = '"Windows"';
    if (/google\.(com|co\.[a-z]{2}|co\.in|co\.uk)|gstatic\.com|googleusercontent\.com|youtube\.com/.test(details.url)) {
      h['Sec-CH-UA-Full-Version-List'] = '"Chromium";v="128.0.0.0", "Not;A=Brand";v="24.0.0.0", "Google Chrome";v="128.0.0.0"';
      h['Sec-CH-UA-Arch'] = '"x86"';
      h['Sec-CH-UA-Bitness'] = '"64"';
      h['Sec-CH-UA-Platform-Version'] = '"15.0.0"';
      h['Sec-CH-UA-Form-Factors'] = '"Desktop"';
    }
    if ((details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') && !h['Upgrade-Insecure-Requests']) {
      h['Upgrade-Insecure-Requests'] = '1';
    }
    callback({ cancel: false, requestHeaders: h });
  });

  const SIGNIN_SPOOF = `(function () {
    try {
      var BRANDS = [{ brand: 'Not;A=Brand', version: '24' }, { brand: 'Chromium', version: '128' }, { brand: 'Google Chrome', version: '128' }];
      var HIGH = { architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0', uaFullVersion: '128.0.0.0', fullVersionList: BRANDS, wow64: false };
      var uad = {
        brands: BRANDS, mobile: false, platform: 'Windows',
        getHighEntropyValues: function (hints) {
          var out = {};
          var keys = hints || ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList'];
          for (var i = 0; i < keys.length; i++) out[keys[i]] = HIGH[keys[i]];
          return Promise.resolve(out);
        },
        toJSON: function () { return { brands: BRANDS, mobile: false, platform: 'Windows' }; }
      };
      try { Object.defineProperty(navigator, 'userAgentData', { get: function () { return uad; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e) {}
      try {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined, connect: function () { return { onDisconnect: { addListener: function () {} }, onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; }, sendMessage: function () {}, onMessage: { addListener: function () {} }, onConnect: { addListener: function () {} } };
        if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        if (!window.chrome.csi) window.chrome.csi = function () { return { startE: Date.now(), onloadT: Date.now(), pageT: (performance && performance.now ? performance.now() : 0), tran: 15 }; };
      } catch (e) {}
    } catch (e) {}
  })();`;

  const GOOGLE_FRAME_RE = /^https:\/\/[a-z0-9.-]*(google\.com|gstatic\.com|googleusercontent\.com)/i;

  function spoofSignInFrames(contents) {
    if (!contents || contents.isDestroyed() || !contents.mainFrame) return;
    const walk = (frame) => {
      try {
        if (GOOGLE_FRAME_RE.test(frame.url || '')) frame.executeJavaScript(SIGNIN_SPOOF, false).catch(() => {});
      } catch (e) {}
      try { (frame.frames || []).forEach(walk); } catch (e) {}
    };
    walk(contents.mainFrame);
  }

  function watchSignIn(contents) {
    if (!contents || contents.isDestroyed()) return;
    const check = () => { try { spoofSignInFrames(contents); } catch (e) {} };
    contents.on('did-finish-load', () => setTimeout(check, 500));
    contents.on('did-navigate', () => setTimeout(check, 1200));
    contents.on('did-frame-finish-load', () => setTimeout(check, 400));
  }

  function attachChromeIdentity(contents) {
    if (!contents || contents.isDestroyed() || !contents.debugger) return;
    try {
      const dbg = contents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      dbg.sendCommand('Page.enable').catch(() => {});
      dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SIGNIN_SPOOF }).catch(() => {});
      dbg.sendCommand('Target.enable').catch(() => {});
      dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      dbg.on('message', (ev, method, params, sessionId) => {
        if (method === 'Target.attachedToTarget' && params && params.sessionId) {
          const sid = params.sessionId;
          dbg.sendCommand('Page.enable', {}, sid).catch(() => {});
          dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SIGNIN_SPOOF }, sid).catch(() => {});
        }
      });
    } catch (e) {}
  }

  app.on('web-contents-created', (event, contents) => {
    try {
      const type = contents.getType && contents.getType();
      if (type === 'webview' || type === 'window') watchSignIn(contents);
      if (type === 'webview') attachChromeIdentity(contents);
    } catch (e) {}
  });

  win = new BrowserWindow({
    title: 'Silence',
    width: 1380,
    height: 870,
    minWidth: 840,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0b0b0b',
    hasShadow: true,
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: true,
      plugins: true
    },
  });

  const htmlEntry = fs.existsSync(path.join(__dirname, 'index.html'))
    ? 'index.html'
    : (fs.existsSync(path.join(__dirname, 'index_2.html')) ? 'index_2.html' : 'electron-index.html');
  win.loadFile(path.join(__dirname, htmlEntry));

  ipcMain.handle('open-media-file-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open PDF, Video, or Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'All Supported Media', extensions: ['pdf', 'mp4', 'webm', 'mkv', 'mp3', 'wav', 'ogg', 'm4a'] },
        { name: 'PDF Documents', extensions: ['pdf'] },
        { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv'] },
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'm4a'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('save-page', async (event, arg) => {
    try {
      const { webContents } = require('electron');
      const wc = webContents.fromId((arg && arg.id) || 0);
      if (!wc) return { ok: false, error: 'no page' };
      const res = await dialog.showSaveDialog(win, {
        title: 'Save page as',
        defaultPath: safeDownloadName((arg && arg.suggested) || 'page.html'),
        filters: [
          { name: 'Webpage, Complete', extensions: ['html'] },
          { name: 'Webpage, HTML Only', extensions: ['htm'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await wc.savePage(res.filePath, /\.htm$/i.test(res.filePath) ? 'HTMLOnly' : 'HTMLComplete');
      return { ok: true, path: res.filePath };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'save failed' };
    }
  });

  ipcMain.handle('open-file-dialog', async () => {
    try {
      const result = await dialog.showOpenDialog(win, { title: 'Open file', properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return null;
      return result.filePaths[0];
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('purge-memory', async () => {
    try {
      await session.defaultSession.clearCache();
      return { success: true };
    } catch (e) {
      return { success: false };
    }
  });

  win.on('enter-full-screen', () => win.webContents.send('fullscreen-state', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen-state', false));

  ipcMain.on('window-min', () => { if (win) win.minimize(); });
  ipcMain.on('window-max', () => { if (win) win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('window-close', () => { if (win) win.close(); });
  ipcMain.on('window-fullscreen-toggle', () => {
    if (win) {
      const nextFS = !win.isFullScreen();
      win.setFullScreen(nextFS);
      win.webContents.send('fullscreen-state', nextFS);
    }
  });

  ipcMain.on('window-enter-fullscreen', () => {
    if (win && !win.isFullScreen()) win.setFullScreen(true);
  });
  ipcMain.on('window-leave-fullscreen', () => {
    if (win && win.isFullScreen()) win.setFullScreen(false);
  });
  ipcMain.on('enter-html-fullscreen', () => {
    if (win && !win.isFullScreen()) win.setFullScreen(true);
  });
  ipcMain.on('leave-html-fullscreen', () => {
    if (win && win.isFullScreen()) win.setFullScreen(false);
  });

  const activeDownloads = new Map();
  let pendingUpdateUrl = '';

  app.on('web-contents-created', (event, contents) => {
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (e, url) => {
        if (!url || url === 'about:blank' || url.startsWith('about:')) return;
        if (!isSafeRemoteUrl(url)) {
          console.warn('[silence] link blocked, unsafe target:', String(url).slice(0, 120));
          e.preventDefault();
          return;
        }
        if (linkDebug()) console.log('[silence] link -> same tab:', String(url).slice(0, 120));
      });

      contents.setWindowOpenHandler(({ url, disposition, features }) => {
        if (linkDebug()) console.log('[silence] link click:', String(url).slice(0, 160));
        if (!isSafeRemoteUrl(url)) return { action: 'deny' };

        if (popupBlockingEnabled() && isAdOrPopunderUrl(url)) {
          return { action: 'deny' };
        }

        if (isDownloadUrl(url)) {
          if (linkDebug()) console.log('[silence]   ↳ file link, downloading');
          contents.downloadURL(url);
          if (win && win.webContents) win.webContents.send('download-started', { url });
          return { action: 'deny' };
        }

        if (url.includes('accounts.google.com')) {
          if (linkDebug()) console.log('[silence]   -> Google sign-in, real pop-up window');
          return {
            action: 'allow',
            overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, backgroundColor: '#0b0b0b' }
          };
        }

        const isPresentation = disposition === 'new-window' ||
          (features && /\b(width|height|left|top|screenx|screeny|toolbar|menubar|location|status|resizable|scrollbars|popup)\b/i.test(features)) ||
          url.includes('presentation');

        if (isPresentation) {
          if (linkDebug()) console.log('[silence]   ↳ presentation window allowed');
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              title: 'Silence',
              width: 1280,
              height: 800,
              backgroundColor: '#0b0b0b',
              autoHideMenuBar: true,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                plugins: true
              }
            }
          };
        }

        if (win && win.webContents) {
          const ask = askBeforeNewTab();
          if (linkDebug()) console.log('[silence]   ↳', ask ? 'confirmation pill' : 'new tab');
          win.webContents.send(ask ? 'request-new-tab-prompt' : 'open-url-in-tab', { url });
        }
        return { action: 'deny' };
      });

      contents.on('will-attach-webview', (event, webPreferences, params) => {
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.plugins = true;
      });

      contents.on('enter-html-full-screen', () => {
        if (win && !win.isFullScreen()) win.setFullScreen(true);
        if (win && win.webContents) win.webContents.send('html-fullscreen', { id: contents.id, on: true });
      });
      contents.on('leave-html-full-screen', () => {
        if (win && win.isFullScreen()) win.setFullScreen(false);
        if (win && win.webContents) win.webContents.send('html-fullscreen', { id: contents.id, on: false });
      });
    }
  });

  session.defaultSession.on('will-download', (event, item) => {
    const filename = safeDownloadName(item.getFilename());
    const downloadUrl = item.getURL();
    if (!isSafeRemoteUrl(downloadUrl)) {
      event.preventDefault();
      return;
    }

    for (let [existingId, existingItem] of activeDownloads) {
      if (existingItem.getFilename() === filename && existingItem.getState() === 'progressing') {
        event.preventDefault();
        return;
      }
    }

    const id = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    activeDownloads.set(id, item);

    const totalBytes = item.getTotalBytes();
    const dlSettings = (getSettings() && getSettings().downloads) || {};
    const downloadDir = dlSettings.path || app.getPath('downloads');
    const savePath = path.join(downloadDir, filename);
    if (dlSettings.ask) {
      item.setSaveDialogOptions({ defaultPath: savePath });
    } else {
      try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (e) {}
      item.setSavePath(savePath);
    }

    win.webContents.send('download-start', { id, filename, totalBytes, savePath });
    win.webContents.send('download-cleanup-tab', { url: downloadUrl });

    item.on('updated', (event, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes();
        const percent = totalBytes > 0 ? Math.round((received / totalBytes) * 100) : 0;
        win.webContents.send('download-progress', { id, filename, received, totalBytes, percent });
      } else if (state === 'interrupted') {
        win.webContents.send('download-failed', { id, filename, reason: 'Interrupted' });
      }
    });

    item.once('done', (event, state) => {
      activeDownloads.delete(id);
      const isAppUpdate = (downloadUrl === pendingUpdateUrl);

      if (state === 'completed') {
        win.webContents.send('download-complete', { id, filename, savePath });
        if (isAppUpdate) {
          pendingUpdateUrl = '';
          setTimeout(() => {
            shell.openPath(savePath).catch(() => {});
            app.quit();
          }, 1000);
        }
      } else if (state === 'cancelled') {
        win.webContents.send('download-cancelled', { id, filename });
      } else {
        win.webContents.send('download-failed', { id, filename, reason: state });
      }
    });
  });

  ipcMain.on('cancel-download', (event, id) => {
    const item = activeDownloads.get(id);
    if (item) {
      item.cancel();
      activeDownloads.delete(id);
    }
  });

  ipcMain.on('show-in-folder', (event, filePath) => {
    if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(app.getPath('downloads'));
  });

  ipcMain.handle('install-cws-extension', async (event, extensionId) => {
    try {
      const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.6723.70&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc`;
      const response = await fetch(crxUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) throw new Error('Download failed: HTTP ' + response.status);

      const arrayBuf = await response.arrayBuffer();
      const zipBuffer = crxToZip(Buffer.from(arrayBuf));

      if (!/^[a-z0-9]{32}$/i.test(String(extensionId || ''))) throw new Error('malformed extension id');
      const targetDir = path.join(app.getPath('userData'), 'installed_extensions', extensionId);

      extractZip(zipBuffer, targetDir);

      const extInfo = await registerExtension(targetDir);
      const saved = loadSavedExtensionPaths();
      if (!saved.includes(targetDir)) {
        saved.push(targetDir);
        saveExtensionPaths(saved);
      }
      return { success: true, extension: extInfo };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('load-extension-dialog', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Unpacked Extension Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    try {
      const extInfo = await registerExtension(result.filePaths[0]);
      const saved = loadSavedExtensionPaths();
      if (!saved.includes(result.filePaths[0])) {
        saved.push(result.filePaths[0]);
        saveExtensionPaths(saved);
      }
      return { success: true, extension: extInfo };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-extensions', () => loadedExtensions);

  ipcMain.handle('remove-extension', (event, id) => {
    const ext = loadedExtensions.find(e => e.id === id);
    if (ext) {
      try { session.defaultSession.removeExtension(id); } catch (e) {}
      loadedExtensions = loadedExtensions.filter(e => e.id !== id);
      const saved = loadSavedExtensionPaths().filter(p => p !== ext.path);
      saveExtensionPaths(saved);
      try {
        const installedRoot = path.join(app.getPath('userData'), 'installed_extensions');
        if (ext.path && fs.existsSync(ext.path) && path.resolve(ext.path).startsWith(path.resolve(installedRoot))) {
          fs.rmSync(ext.path, { recursive: true, force: true });
        }
      } catch (e) {}
    } else {
      try { session.defaultSession.removeExtension(id); } catch (e) {}
    }
    try { if (typeof broadcastStoreChange === 'function') broadcastStoreChange(); } catch (e) {}
    return true;
  });

  ipcMain.handle('silence:check-app-update', async () => {
    const currentVersion = app.getVersion();

    if (!app.isPackaged) {
      return {
        status: 'update-available',
        currentVersion,
        latestVersion: '2.2.0',
        url: 'https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-win32-x64.zip'
      };
    }

    try {
      const { net } = require('electron');
      const res = await net.fetch('https://api.github.com/repos/rshre/silence/releases/latest', {
        headers: { 'User-Agent': 'Silence-Browser', 'Accept': 'application/vnd.github+json' }
      }).catch(() => null);

      if (res && res.ok) {
        const data = await res.json();
        const latestVersion = (data.tag_name || '').replace(/^v/, '');
        const exeAsset = (data.assets || []).find(a => a.name.endsWith('.exe'));
        if (latestVersion && cmpVersion(latestVersion, currentVersion) > 0 && exeAsset) {
          return {
            status: 'update-available',
            currentVersion,
            latestVersion,
            url: exeAsset.browser_download_url
          };
        }
      }
      return { status: 'up-to-date', currentVersion };
    } catch (err) {
      return { status: 'up-to-date', currentVersion };
    }
  });

  ipcMain.handle('silence:download-update', async (event, { url }) => {
    if (!url) return { success: false, error: 'No download URL provided' };
    try {
      pendingUpdateUrl = url;
      session.defaultSession.downloadURL(url);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  loadSavedExtensionPaths()
    .filter(p => fs.existsSync(p))
    .forEach(p => registerExtension(p).catch(() => {}));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  if (process.platform === 'darwin') return;
  const s = (typeof getSettings === 'function') ? getSettings() : null;
  if (s && s.system && s.system.runInBackground) return;
  if (s && s.privacy && s.privacy.clearOnQuit) {
    try { await runClearOnQuit(); } catch (e) {}
  }
  app.quit();
});