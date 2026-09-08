/**
 * Silence Pro — main-process services.
 *
 *  • hardens tab webviews (no Node in pages, real same-origin policy)
 *  • repairs Google / Microsoft / Facebook sign-in inside those hardened webviews
 *  • bookmarks + history stores
 *  • printing & Save-as-PDF for the active tab
 */

const { app, ipcMain, session, webContents, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ state */
let storeDir = '';
let bookmarksFile = '';
let historyFile = '';
let bookmarks = { items: [] };
let history = { items: [] };

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
};
const writeJson = (file, data) => {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
};

/* --------------------------------------------------- session / sign-in fix */
/**
 * Relax one Set-Cookie value so an embedded sign-in frame can keep its cookie.
 * Prefixed cookies (__Secure-, __Host-) and anything on plain http:// are left
 * exactly as the site sent them.
 */
/** Hosts that are allowed to keep SameSite=None.  Rewriting every third-party
 *  cookie would undo Chromium's CSRF protection everywhere, so only the
 *  identity providers people actually sign in through are relaxed — and only
 *  over https, and only when the setting is on. */
const LOGIN_FRAME_HOSTS = [
  'accounts.google.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'login.microsoftonline.com', 'microsoftonline.com', 'live.com', 'microsoft.com',
  'appleid.apple.com', 'apple.com', 'github.com', 'facebook.com',
  'linkedin.com', 'okta.com', 'auth0.com', 'amazon.com', 'paypal.com', 'dropbox.com'
];

function isLoginFrameHost(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  return LOGIN_FRAME_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/** Settings -> Privacy -> "Fix embedded sign-in cookies" (on by default) */
function thirdPartyCookieFixEnabled() {
  try {
    const { readSettingsSync } = require('./silence-core');   // lazy: no require cycle
    const s = readSettingsSync();
    return !!(s && s.privacy && s.privacy.thirdPartyCookieFix !== false);
  } catch (e) { return true; }
}

function relaxCookie(c, https) {
  if (/samesite=none/i.test(c)) return c;                     // already permissive
  if (/^__(secure|host)-/i.test(c)) return c;                 // site manages these
  if (!https) return c;                                       // Secure over http:// = dropped
  let out = c.replace(/;\s*samesite=(lax|strict)/i, '');
  if (!/;\s*secure/i.test(out)) out += '; Secure';
  return out + '; SameSite=None';
}

/**
 * Two things break "Sign in with Google" in an Electron webview:
 *   1. the session still advertises itself as Electron  → "This browser or app
 *      may not be secure".
 *   2. cross-site login cookies arrive with SameSite=Lax/Strict and get dropped
 *      inside the iframe, so the login loops forever.
 */
function applySessionFixes() {
  try {
    session.defaultSession.setUserAgent(CHROME_UA);
  } catch (e) { console.warn('[pro] setUserAgent failed:', e.message); }

  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      let cookies = details.responseHeaders['set-cookie'] || details.responseHeaders['Set-Cookie'];
      if (!cookies) return callback({ responseHeaders: details.responseHeaders });
      // Only frames served to a *different* site need this.  Rewriting the
      // page's own cookies (or adding Secure on http://) turns working logins
      // into "couldn't sign you in", so first-party responses pass untouched.
      if (details.resourceType === 'mainFrame') return callback({ responseHeaders: details.responseHeaders });
      // ...and only for the sign-in providers on the allow-list.  Everything
      // else keeps Chromium's own SameSite policy, CSRF protection included.
      if (!thirdPartyCookieFixEnabled() || !isLoginFrameHost(details.url)) {
        return callback({ responseHeaders: details.responseHeaders });
      }

      const https = /^https:/i.test(details.url || '');
      const key = details.responseHeaders['set-cookie'] ? 'set-cookie' : 'Set-Cookie';
      details.responseHeaders[key] = cookies.map((c) => relaxCookie(c, https));
      callback({ responseHeaders: details.responseHeaders });
    });
    console.log('[pro] third-party login cookies enabled (SameSite=None, embedded frames only)');
  } catch (e) { console.warn('[pro] cookie fix failed:', e.message); }
}

/** tab webviews must not have Node — pages are untrusted */
function hardenWebviews(getWindow) {
  const win = getWindow && getWindow();
  if (!win || !win.webContents) return;
  win.webContents.on('will-attach-webview', (event, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;       // sandboxed preloads still get ipcRenderer, and extension service workers need it
    webPreferences.webSecurity = true;   // real same-origin policy
    webPreferences.plugins = true;       // video/DRM
    webPreferences.allowRunningInsecureContent = false;
  });
  console.log('[pro] tab webviews hardened (no node, contextIsolation on, webSecurity on)');
}

/* ---------------------------------------------------------------- helpers */
const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
const guard = (channel, fn) => {
  ipcMain.handle(channel, async (event, arg) => {
    try { return await fn(arg || {}, event); }
    catch (e) { console.warn(`[pro] ${channel}:`, e.message); return { error: e.message }; }
  });
};

/* -------------------------------------------------------------- bookmarks */
function saveBookmarks() { writeJson(bookmarksFile, bookmarks); }
function saveHistory() { writeJson(historyFile, history); }
const byId = (arr, id) => arr.find((x) => x.id === id);

function registerBookmarks() {
  guard('silence:bookmarks-list', async () => ({ items: bookmarks.items }));

  guard('silence:bookmark-add', async ({ url, title, favicon, folder }) => {
    if (!url || !/^(https?:|file:|silence:)/i.test(url)) return { error: 'Unsupported URL' };
    const existing = bookmarks.items.find((b) => b.url === url);
    if (existing) { Object.assign(existing, { title: title || existing.title, favicon: favicon || existing.favicon }); saveBookmarks(); return { item: existing, updated: true }; }
    const item = {
      id: 'bm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      url, title: title || hostOf(url) || url, favicon: favicon || null,
      folder: folder || 'Bookmarks bar', addedAt: Date.now()
    };
    bookmarks.items.push(item);
    saveBookmarks();
    return { item };
  });

  guard('silence:bookmark-remove', async ({ id, url }) => {
    const before = bookmarks.items.length;
    bookmarks.items = bookmarks.items.filter((b) => (id ? b.id !== id : b.url !== url));
    saveBookmarks();
    return { removed: before - bookmarks.items.length, items: bookmarks.items };
  });

  guard('silence:bookmark-update', async ({ id, patch }) => {
    const item = byId(bookmarks.items, id);
    if (!item) return { error: 'Not found' };
    Object.assign(item, patch || {});
    saveBookmarks();
    return { item };
  });

  guard('silence:bookmarks-clear', async () => { bookmarks.items = []; saveBookmarks(); return { items: [] }; });
}

/* ---------------------------------------------------------------- history */
function addHistoryEntry(entry) {
  if (!entry || !entry.url) return;
  if (!/^(https?:|file:)/i.test(entry.url)) return;
  if (/^(silence:|about:|chrome-extension:)/i.test(entry.url)) return;
  const host = hostOf(entry.url);
  history.items = history.items.filter((h) => h.url !== entry.url);
  history.items.unshift({
    id: 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    url: entry.url,
    title: entry.title || host || entry.url,
    host,
    favicon: entry.favicon || null,
    visitedAt: Date.now(),
    visitCount: 1
  });
  if (history.items.length > 20000) history.items.length = 20000;
  saveHistory();
}

function registerHistory() {
  guard('silence:history-add', async (a) => { addHistoryEntry(a); return { ok: true }; });

  guard('silence:history-list', async ({ query, limit } = {}) => {
    let items = history.items;
    if (query) {
      const q = String(query).toLowerCase();
      items = items.filter((h) => (h.title || '').toLowerCase().includes(q) || (h.url || '').toLowerCase().includes(q));
    }
    return { items: items.slice(0, limit || 500) };
  });

  guard('silence:history-delete', async ({ id, url }) => {
    history.items = history.items.filter((h) => (id ? h.id !== id : h.url !== url));
    saveHistory();
    return { items: history.items };
  });

  guard('silence:history-clear', async ({ since } = {}) => {
    if (since) history.items = history.items.filter((h) => h.visitedAt >= since);
    else history.items = [];
    saveHistory();
    return { items: history.items };
  });
}

/* ----------------------------------------------------------------- print */
function registerPrint() {
  const fromId = (id) => { try { return webContents.fromId(id); } catch (e) { return null; } };

  guard('silence:print', async ({ webContentsId } = {}) => {
    const wc = fromId(webContentsId);
    if (!wc) return { error: 'Tab not found' };
    wc.print({ silent: false, printBackground: true }, (success, reason) => {
      if (!success) console.warn('[pro] print failed:', reason);
    });
    return { ok: true };
  });

  guard('silence:print-pdf', async ({ webContentsId } = {}) => {
    const wc = fromId(webContentsId);
    if (!wc) return { error: 'Tab not found' };
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win || null, {
      title: 'Save page as PDF',
      defaultPath: path.join(app.getPath('downloads'), (wc.getTitle() || 'page').replace(/[^\w\- ]+/g, '').trim() + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    try {
      const data = await wc.printToPDF({
        pageSize: 'A4', printBackground: true, margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
      });
      fs.writeFileSync(res.filePath, data);
      return { ok: true, filePath: res.filePath };
    } catch (e) { return { error: e.message }; }
  });
}

/* ------------------------------------------------------------------- init */
function initSilencePro(options) {
  const opts = options || {};
  try {
    storeDir = app.getPath('userData');
    bookmarksFile = path.join(storeDir, 'silence_bookmarks.json');
    historyFile = path.join(storeDir, 'silence_history.json');
    bookmarks = readJson(bookmarksFile, { items: [] });
    history = readJson(historyFile, { items: [] });
    if (!Array.isArray(bookmarks.items)) bookmarks.items = [];
    if (!Array.isArray(history.items)) history.items = [];

    applySessionFixes();
    hardenWebviews(opts.getWindow);
    registerBookmarks();
    registerHistory();
    registerPrint();
    console.log('[pro] ready —', bookmarks.items.length, 'bookmarks,', history.items.length, 'history entries');
  } catch (e) {
    console.error('[pro] failed to start:', e);
  }
}

module.exports = { initSilencePro, addHistoryEntry, CHROME_UA };
