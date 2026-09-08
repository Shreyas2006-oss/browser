/**
 * Silence Plus — renderer side of the upgrade pack.
 * Adds Chrome/Edge-grade settings sections (with sub-menus), fixes extension
 * removal, adds remove icons, repairs extension pop-ups, and keeps the old
 * settings panels in sync with the new ones.
 */

(function silencePlus() {
  const { ipcRenderer } = (typeof require === 'function') ? require('electron') : {};
  if (!ipcRenderer) { console.warn('[plus] no ipcRenderer — settings add-on disabled'); return; }

  const VERSION = '1.4';
  let S = null;
  let INFO = null;
  let VAULT = [];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

  function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(p, v) {
    const out = {};
    const parts = p.split('.');
    let cur = out;
    parts.forEach((k, i) => { cur = cur[k] = (i === parts.length - 1) ? v : {}; });
    return out;
  }
  async function save(patch) {
    const r = await ipcRenderer.invoke('silence:set-settings', patch);
    if (r && !r.error) S = r;
    return S;
  }

  /* ------------------------- visibility helpers ------------------------- */
  function ensureCss() {
    try {
      const loaded = [...document.styleSheets].some((ss) => (ss.href || '').includes('silence-plus.css'));
      if (loaded) return;
      const fs = require('fs');
      const p = require('path');
      const style = document.createElement('style');
      style.textContent = fs.readFileSync(p.join(__dirname, 'silence-plus.css'), 'utf8');
      document.head.appendChild(style);
      console.log('[plus] css injected from disk');
    } catch (e) { console.warn('[plus] css fallback failed:', e.message); }
  }

  function addToolbarButton() {
    try {
      if (document.getElementById('sp-plus-btn')) return;
      const anchor = document.getElementById('ext-menu-btn');
      if (!anchor || !anchor.parentNode) return;
      const btn = document.createElement('button');
      btn.id = 'sp-plus-btn';
      btn.className = anchor.className || 'icon-btn';
      btn.title = 'Silence Plus — privacy & settings (⚡)';
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>';
      btn.style.cssText = 'width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;color:#a5b4fc';
      btn.onclick = () => {
        try { toggleSettings(true); } catch (e) {}
        setTimeout(() => {
          const nav = document.querySelector('.settings-nav-item[data-sp-nav][data-target="panel-privacy-plus"]');
          if (nav) nav.click();
        }, 60);
      };
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } catch (e) { console.warn('[plus] toolbar button failed:', e.message); }
  }

  function pill(msg, kind, ms) {
    try {
      let el = document.getElementById('sp-pill');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sp-pill';
        el.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;' +
          'background:#1c1c22;border:1px solid rgba(255,255,255,.12);color:#e8e9ef;padding:11px 16px;' +
          'border-radius:11px;font-size:12.6px;box-shadow:0 14px 40px rgba(0,0,0,.5);display:none;gap:10px;align-items:center';
        document.body.appendChild(el);
      }
      el.innerHTML = '<span style="color:' + (kind === 'error' ? '#f87171' : '#a5b4fc') + '">⚡</span><span>' + esc(msg) + '</span>';
      el.style.display = 'flex';
      clearTimeout(el.__t);
      if (ms !== 0) el.__t = setTimeout(() => { el.style.display = 'none'; }, ms || 9000);
    } catch (e) {}
  }

  /* ---------------------------- sub-menu nav ---------------------------- */
  function subNav(id) {
    const self = ALL_PANELS.find((p) => p.id === id);
    if (!self) return '';
    const root = self.parent ? ALL_PANELS.find((p) => p.id === self.parent) : self;
    if (!root) return '';
    const list = [root].concat(ALL_PANELS.filter((p) => p.parent === root.id));
    if (list.length < 2) return '';
    return '<div class="sp-subnav">' + list.map((p) =>
      '<button class="sp-pill-btn' + (p.id === id ? ' active' : '') + '" data-sp-nav data-target="' + p.id + '" data-label="' + esc(p.label) + '">' + esc(p.label) + '</button>'
    ).join('') + '</div>';
  }

  /* --------------------------- control markup --------------------------- */
  const toggle = (path, label, desc) => {
    const on = !!getPath(S, path);
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<label class="sp-switch"><input type="checkbox" data-sp-toggle="' + path + '"' + (on ? ' checked' : '') + '><span class="sp-slider"></span></label></div>';
  };
  const select = (path, label, desc, options) => {
    const val = getPath(S, path);
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<select class="sp-input" style="min-width:190px" data-sp-select="' + path + '">' +
      options.map((o) => '<option value="' + esc(o.v) + '"' + (String(val) === String(o.v) ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('') +
      '</select></div>';
  };
  const input = (path, label, desc, placeholder) => {
    const val = getPath(S, path) || '';
    return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4>' +
      (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>' +
      '<input class="sp-input" data-sp-input="' + path + '" value="' + esc(val) + '" placeholder="' + esc(placeholder || '') + '" spellcheck="false" /></div>';
  };

  /* ------------------------- privacy & security ------------------------- */
  function panelBlocking() {
    const paused = (S.privacy && S.privacy.adBlockPause) || [];
    return subNav('panel-privacy-plus') + '<div class="setting-card">' +
      '<h4>Blocking</h4><p class="sp-desc">Applies instantly — no restart.</p>' +
      toggle('privacy.adBlock', 'Block ads & trackers', 'Ghostery engine when installed, otherwise the built-in filter list.') +
      '<div class="setting-card-row"><div><h4>Pause ad blocking on</h4><p>Sites you want to support — blocking pauses while you are on them.</p></div>' +
        '<div style="display:flex;gap:8px"><input class="sp-input" id="sp-pause-input" placeholder="example.com" style="min-width:170px" spellcheck="false" />' +
        '<button class="sp-btn" data-sp-action="pause-add">Add</button></div></div>' +
      '<div class="sp-chips">' + (paused.length
        ? paused.map((h) => '<span class="sp-chip">' + esc(h) + '<button data-sp-action="pause-del" data-host="' + esc(h) + '">×</button></span>').join('')
        : '<span class="sp-hint" style="margin:0">No paused sites.</span>') + '</div>' +
      toggle('privacy.blockPopups', 'Block pop-ups', 'Off by default. Turn on to stop ad popunders opening new tabs.') +
      '</div>';
  }

  function panelNet() {
    return subNav('panel-privacy-net') + '<div class="setting-card">' +
      '<h4>Network & DNS</h4>' +
      toggle('privacy.httpsFirst', 'HTTPS-First mode', 'Upgrades http:// navigations to https:// when a secure version exists.') +
      select('privacy.doh', 'Secure DNS (DoH)', 'Encrypts DNS lookups your ISP would otherwise see.', [
        { v: 'off', t: 'Off (system DNS)' }, { v: 'automatic', t: 'Automatic' }, { v: 'secure', t: 'Secure only' }
      ]) +
      select('privacy.dohProvider', 'DNS provider', '', [
        { v: 'cloudflare', t: 'Cloudflare' }, { v: 'google', t: 'Google' }, { v: 'quad9', t: 'Quad9' }, { v: 'adguard', t: 'AdGuard' }
      ]) +
      toggle('privacy.doNotTrack', 'Send Do-Not-Track & GPC', 'Adds DNT: 1 and Sec-GPC: 1 to every request.') +
      '</div>';
  }

  function panelData() {
    const items = (S.privacy && S.privacy.clearOnQuitItems) || [];
    return subNav('panel-privacy-data') + '<div class="setting-card">' +
      '<h4>Clear browsing data</h4>' +
      toggle('privacy.clearOnQuit', 'Clear when Silence closes', 'Runs automatically on quit.') +
      '<div class="setting-card-row"><div><h4>What to clear</h4></div><div class="sp-chips" style="margin-top:0">' +
        ['cache', 'storage', 'cookies'].map((k) =>
          '<label class="sp-chip" style="cursor:pointer"><input type="checkbox" data-sp-action="clear-item" value="' + k + '"' +
          (items.includes(k) ? ' checked' : '') + ' style="accent-color:#6366f1"> ' + k + '</label>').join('') +
      '</div></div>' +
      '<div style="margin-top:14px"><button class="sp-btn" data-sp-action="clear-now">Clear now…</button></div>' +
      '</div>';
  }

  /* ---------------------------- site settings --------------------------- */
  const PERMS = [
    ['camera', 'Camera'], ['microphone', 'Microphone'], ['geolocation', 'Location'],
    ['notifications', 'Notifications'], ['clipboard-sanitized-write', 'Clipboard'], ['display-capture', 'Screen capture']
  ];

  function panelPerms() {
    const log = (S.permissionLog || []).slice(0, 12);
    const defs = S.permissionDefaults || {};
    return subNav('panel-sites') + '<div class="setting-card"><h4>Default behaviour</h4>' +
      '<p class="sp-desc">What happens when a site asks. “Ask” blocks it and lists the request below so you can allow it.</p>' +
      PERMS.map(([k, label]) => {
        const cur = defs[k] || 'ask';
        return '<div class="setting-card-row"><div><h4>' + esc(label) + '</h4></div>' +
          '<select class="sp-input" style="min-width:130px" data-sp-action="perm-default" data-perm="' + k + '">' +
          ['ask', 'allow', 'deny'].map((v) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' +
            (v === 'ask' ? 'Ask (block + log)' : v === 'allow' ? 'Allow' : 'Block') + '</option>').join('') +
          '</select></div>';
      }).join('') + '</div>' +
      '<div class="setting-card"><h4>Recent permission requests</h4>' +
      (log.length
        ? '<table class="sp-table"><tr><th>Site</th><th>Permission</th><th style="text-align:right">Action</th></tr>' +
          log.map((r) => '<tr><td class="mono">' + esc(r.origin) + '</td><td>' + esc(r.permission) + '</td><td style="text-align:right">' +
            '<button class="sp-btn small" data-sp-action="perm-allow" data-origin="' + esc(r.origin) + '" data-perm="' + esc(r.permission) + '">Allow</button> ' +
            '<button class="sp-btn small danger" data-sp-action="perm-deny" data-origin="' + esc(r.origin) + '" data-perm="' + esc(r.permission) + '">Block</button></td></tr>').join('') + '</table>'
        : '<div class="sp-empty">Nothing blocked yet.</div>') + '</div>';
  }

  function panelZoom() {
    const zoom = (S.sites && S.sites.zoom) || {};
    const rows = Object.keys(zoom).map((h) =>
      '<tr><td class="mono">' + esc(h) + '</td><td>' + Math.round(zoom[h] * 100) + '%</td>' +
      '<td style="text-align:right"><button class="sp-btn small danger" data-sp-action="zoom-del" data-host="' + esc(h) + '">Remove</button></td></tr>').join('');
    return subNav('panel-sites-zoom') + '<div class="setting-card"><h4>Per-site zoom</h4>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<input class="sp-input" id="sp-zoom-host" placeholder="example.com" style="min-width:170px" spellcheck="false" />' +
        '<input class="sp-input" id="sp-zoom-val" type="number" min="25" max="500" step="5" value="125" style="min-width:90px" />' +
        '<button class="sp-btn" data-sp-action="zoom-add">Add</button></div>' +
      (rows ? '<table class="sp-table"><tr><th>Site</th><th>Zoom</th><th></th></tr>' + rows + '</table>'
            : '<div class="sp-hint">No per-site zoom levels.</div>') + '</div>';
  }

  /* ------------------------------- passwords ---------------------------- */
  function panelPasswords() {
    const items = VAULT || [];
    return '<div class="setting-card"><h4>Saved passwords</h4>' +
      '<p class="sp-desc">' + (INFO && INFO.encryption ? 'Encrypted with your OS keychain (safeStorage).'
        : '⚠️ OS encryption unavailable — passwords are stored as plain text.') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<input class="sp-input" id="sp-v-site" placeholder="Site (example.com)" style="min-width:170px" />' +
        '<input class="sp-input" id="sp-v-user" placeholder="Username" style="min-width:150px" />' +
        '<input class="sp-input" id="sp-v-pass" type="password" placeholder="Password" style="min-width:150px" />' +
        '<button class="sp-btn primary" data-sp-action="vault-add">Save</button></div>' +
      (items.length
        ? '<table class="sp-table"><tr><th>Site</th><th>Username</th><th style="text-align:right">Actions</th></tr>' +
          items.map((v) => '<tr><td class="mono">' + esc(v.site) + '</td><td>' + esc(v.username) + '</td><td style="text-align:right">' +
            '<button class="sp-btn small" data-sp-action="vault-fill" data-id="' + esc(v.id) + '">Fill</button> ' +
            '<button class="sp-btn small" data-sp-action="vault-copy" data-id="' + esc(v.id) + '">Copy</button> ' +
            '<button class="sp-btn small danger" data-sp-action="vault-del" data-id="' + esc(v.id) + '">Delete</button></td></tr>').join('') + '</table>'
        : '<div class="sp-empty">No saved passwords.</div>') +
      '<p class="sp-hint">“Fill” injects the credentials into the login form of the current tab.</p></div>';
  }

  const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['hi-IN', 'हिन्दी'], ['de-DE', 'Deutsch'],
    ['fr-FR', 'Français'], ['es-ES', 'Español'], ['pt-BR', 'Português (BR)'], ['it-IT', 'Italiano'],
    ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文 (简体)'], ['ru-RU', 'Русский']];

  function panelLanguages() {
    const sel = (S.languages && S.languages.languages) || ['en-US'];
    return '<div class="setting-card"><h4>Spell check</h4>' +
      toggle('languages.spellcheck', 'Check spelling while typing', 'Applied to text fields on web pages.') +
      '<div class="setting-card-row"><div><h4>Languages</h4><p>Dictionaries used for spell checking.</p></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:7px;max-width:420px;justify-content:flex-end">' +
      LANGS.map(([code, name]) =>
        '<label class="sp-chip" style="cursor:pointer"><input type="checkbox" data-sp-action="lang" value="' + code + '"' +
        (sel.includes(code) ? ' checked' : '') + ' style="accent-color:#6366f1"> ' + esc(name) + '</label>').join('') +
      '</div></div></div>';
  }

  function panelDownloads() {
    return '<div class="setting-card"><h4>Downloads</h4>' +
      input('downloads.path', 'Download location', 'Leave empty to use your system Downloads folder.', (INFO && INFO.downloads) || '') +
      '<div style="margin-top:-6px;margin-bottom:12px"><button class="sp-btn" data-sp-action="pick-folder">Choose folder…</button> ' +
      '<button class="sp-btn" data-sp-action="open-downloads">Open folder</button></div>' +
      toggle('downloads.ask', 'Ask where to save each file', 'Shows a save dialog instead of downloading automatically.') +
      '</div>';
  }

  const ENGINES = [
    ['https://www.google.com/search?q=', 'Google'], ['https://duckduckgo.com/?q=', 'DuckDuckGo'],
    ['https://www.bing.com/search?q=', 'Bing'], ['https://search.brave.com/search?q=', 'Brave'],
    ['https://lite.duckduckgo.com/lite/?q=', 'DuckDuckGo Lite'], ['https://www.startpage.com/sp/search?query=', 'Startpage'],
    ['https://www.ecosia.org/search?q=', 'Ecosia']
  ];
  const engineName = (u) => {
    const hit = ENGINES.find((e) => e[0] === u);
    return hit ? hit[1] : String(u || '').replace(/^https?:\/\//, '').split('/')[0] || '—';
  };
  function setEngineName(u) {
    const el = document.querySelector('.sp-engine-name');
    if (el) el.textContent = engineName(u != null ? u : (S.search && S.search.engine));
  }

  function panelSearch() {
    const engines = ENGINES;
    const legacy = document.getElementById('engine-select');
    const cur = (S.search && S.search.engine) || localStorage.getItem('silence_search_engine') || (legacy && legacy.value) || engines[0][0];
    return '<div class="setting-card"><h4>Search engine</h4>' +
      '<div class="setting-card-row"><div><p class="sp-desc">Used by the address bar and the new-tab search box.</p></div>' +
      '<select class="sp-input" style="min-width:200px" data-sp-action="engine">' +
      engines.map(([u, n]) => '<option value="' + esc(u) + '"' + (cur === u ? ' selected' : '') + '>' + n + '</option>').join('') +
      '</select></div></div>' +
      '<div class="setting-card"><h4>On startup</h4>' +
      select('search.startup', 'When Silence opens', '', [
        { v: 'blank', t: 'Open a new tab' }, { v: 'restore', t: 'Continue where you left off' }, { v: 'homepage', t: 'Open the homepage' }
      ]) +
      input('search.homepage', 'Homepage', 'Used by the home button and “Open the homepage”.', 'https://www.google.com') +
      '<div style="margin-top:10px"><button class="sp-btn" data-sp-action="restore-now">Restore saved session now</button></div></div>' +
      '<div class="setting-card"><h4>New tab</h4>' +
      select('search.newTab', 'New tabs show', '', [
        { v: 'home', t: 'Silence home screen' }, { v: 'blank', t: 'A blank page' }
      ]) + '</div>';
  }

  function panelPerf() {
    return subNav('panel-system') + '<div class="setting-card"><h4>Performance & system</h4>' +
      toggle('system.hardwareAcceleration', 'Use hardware acceleration', 'Turn off if you see flickering or black video. Needs a restart.') +
      '<div style="margin:10px 0 14px"><button class="sp-btn" data-sp-action="relaunch">Restart Silence</button></div>' +
      toggle('system.runInBackground', 'Keep running in the background', 'Silence stays alive after you close the window.') +
      toggle('system.animations', 'Interface animations', 'Off gives a snappier, more “silent” feel.') +
      '</div>' +
      '<div class="setting-card"><h4>Trackpad gestures</h4>' +
      select('gestures.swipe', 'Two-finger swipe to navigate', 'Swipe left/right with two fingers to go back and forward.', [
        { v: 'high', t: 'On — normal' }, { v: 'low', t: 'On — sensitive (shorter swipe)' }, { v: 'off', t: 'Off' }
      ]) +
      '<p class="sp-hint">The swipe is processed once per frame instead of once per wheel event, so it follows your fingers without stutter.</p></div>';
  }

  function panelDrm() {
    const wv = INFO && INFO.widevine;
    return subNav('panel-system-drm') + '<div class="setting-card"><h4>DRM & streaming</h4>' +
      '<div class="setting-card-row"><div>' +
      (wv ? '<span class="sp-badge ok">● Widevine ' + esc(wv.version) + ' — ' + esc(wv.source) + '</span>'
          : '<span class="sp-badge warn">● Widevine not found</span>') +
      '<div class="sp-hint">' + (wv ? esc(wv.path) : 'Install Google Chrome or Microsoft Edge, then restart Silence.') + '</div></div>' +
      toggle('drm.enabled', 'Enable DRM playback', '') + '</div>' +
      input('drm.path', 'Manual Widevine folder', 'Optional — the folder containing widevinecdm.dll.', 'C:\\…\\WidevineCdm\\4.10.2710.0\\_platform_specific\\win_x64') +
      '<div style="margin-top:10px"><button class="sp-btn" data-sp-action="pick-drm">Browse…</button></div>' +
      '<p class="sp-hint">Chrome only downloads Widevine the first time you play protected video, so play something on Netflix/Prime in Chrome once, then restart Silence.</p></div>' +
      '<div class="setting-card"><h4>Extensions</h4>' +
      toggle('extensions.advancedApis', 'Advanced extension APIs', 'Loads electron-chrome-extensions for chrome.tabs / contextMenus / windows support. Needs a restart.') +
      '<p class="sp-hint">Install with: <code>npm i electron-chrome-extensions</code></p></div>';
  }

  function panelReset() {
    const curVer = (INFO && INFO.version) || '2.1.0';
    const curArch = (INFO && INFO.platform && INFO.platform.includes('64')) ? '64-bit' : '32-bit';

    return '<div class="setting-card" id="sp-about-card">' +
      '<div style="display:flex; align-items:center; gap:16px;">' +
        '<img src="icon.jpg" onerror="this.src=\'icon.ico\'" style="width:44px; height:44px; border-radius:10px; object-fit:cover; box-shadow:0 0 14px var(--accent-glow);" />' +
        '<div style="flex:1;">' +
          '<h4 style="margin:0; font-size:15px; font-weight:600;">Silence</h4>' +
          '<p style="margin:2px 0 0; font-size:12.2px; color:var(--text-muted);">Version ' + esc(curVer) + ' (Official Build) (' + esc(curArch) + ')</p>' +
        '</div>' +
        '<button class="sp-btn primary" id="sp-check-update-btn" data-sp-action="check-update">Check for updates</button>' +
      '</div>' +
      '<div id="sp-update-status" style="margin-top:12px; font-size:12.4px; display:flex; align-items:center; gap:8px;">' +
        '<span class="sp-badge ok">✓ Silence is up to date</span>' +
      '</div>' +
      '</div>' +
      '<div class="setting-card"><h4>Reset</h4>' +
      '<div class="setting-card-row"><div><h4>Restore settings to defaults</h4><p>Keeps passwords, extensions and browsing data.</p></div>' +
      '<button class="sp-btn danger" data-sp-action="reset-settings">Reset settings</button></div>' +
      '<div class="setting-card-row"><div><h4>Clear all browsing data</h4><p>Cache, cookies, site storage and service workers.</p></div>' +
      '<button class="sp-btn danger" data-sp-action="clear-now">Clear data…</button></div></div>' +
      '<div class="setting-card"><h4>System Specifications</h4><div class="sp-grid2">' +
      [['Electron', INFO && INFO.electron], ['Chromium', INFO && INFO.chrome], ['Node', INFO && INFO.node],
       ['Platform', INFO && INFO.platform], ['Profile folder', INFO && INFO.userData], ['Downloads', INFO && INFO.downloads],
       ['Extensions', INFO && INFO.extensions], ['Encryption', INFO && (INFO.encryption ? 'available' : 'unavailable')]]
        .map(([k, v]) => '<div class="sp-fact"><label>' + esc(k) + '</label><div>' + esc(v || '—') + '</div></div>').join('') +
      '</div><div style="margin-top:14px;display:flex;gap:9px;flex-wrap:wrap">' +
      '<button class="sp-btn" data-sp-action="open-profile">Open profile folder</button>' +
      '<button class="sp-btn" data-sp-action="open-ext">Open extensions folder</button>' +
      '<button class="sp-btn" data-sp-action="open-store">Open Extension Store</button></div></div>';
  }

  /* ------------------------------ panel list ---------------------------- */
  const PANELS = [
    { id: 'panel-privacy-plus', icon: '🔒', label: 'Privacy & security', group: 'Browser', render: panelBlocking, children: [
      { id: 'panel-privacy-net', label: 'Network & DNS', render: panelNet },
      { id: 'panel-privacy-data', label: 'Clear data', render: panelData }
    ] },
    { id: 'panel-sites', icon: '🌐', label: 'Site settings', group: 'Browser', render: panelPerms, children: [
      { id: 'panel-sites-zoom', label: 'Zoom', render: panelZoom }
    ] },
    { id: 'panel-autofill', icon: '🔑', label: 'Passwords', group: 'You', render: panelPasswords },
    { id: 'panel-languages', icon: '🌍', label: 'Languages', group: 'Browser', render: panelLanguages },
    { id: 'panel-downloads', icon: '⬇️', label: 'Downloads', group: 'Browser', render: panelDownloads },
    { id: 'panel-search-plus', icon: '🔎', label: 'Search & startup', group: 'Browser', render: panelSearch },
    { id: 'panel-system', icon: '⚙️', label: 'System', group: 'Advanced', render: panelPerf, children: [
      { id: 'panel-system-drm', label: 'DRM & streaming', render: panelDrm }
    ] },
    { id: 'panel-reset', icon: '🔄', label: 'Reset & about', group: 'Advanced', render: panelReset }
  ];
  PANELS.forEach((p) => (p.children || []).forEach((c) => { c.parent = p.id; c.group = p.group; c.icon = p.icon; }));
  const ALL_PANELS = PANELS.concat(...PANELS.map((p) => p.children || []));

  /* -------------------------------- build ------------------------------- */
  function buildNav() {
    const sidebar = $('.settings-sidebar');
    if (!sidebar || sidebar.querySelector('[data-sp-nav]')) return;
    let html = '';
    let group = '';
    PANELS.forEach((p) => {
      if (p.group !== group) { group = p.group; html += '<div class="sp-nav-sep">' + esc(group) + '</div>'; }
      html += '<button class="settings-nav-item" data-sp-nav data-target="' + p.id + '" data-label="' + esc(p.label) + '"><span>' + p.icon + '</span>' + esc(p.label) + '</button>';
      (p.children || []).forEach((c) => {
        html += '<button class="settings-nav-item sp-sub" data-sp-nav data-parent="' + p.id + '" data-target="' + c.id + '" data-label="' + esc(c.label) + '">' + esc(c.label) + '</button>';
      });
    });
    const search = '<div id="sp-nav-search-wrap"><input class="sp-input" id="sp-nav-search" placeholder="Search settings" spellcheck="false" /></div>';
    sidebar.insertAdjacentHTML('afterbegin', search);
    sidebar.insertAdjacentHTML('beforeend', html);
  }

  function buildPanels() {
    const area = $('.settings-content-area');
    if (area) { area.classList.add('sp-area'); }
    if (!area) return;
    ALL_PANELS.forEach((p) => {
      let el = document.getElementById(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'settings-panel-section sp-panel';
        el.id = p.id;
        area.appendChild(el);
      }
      try { el.innerHTML = p.render(); }
      catch (e) { el.innerHTML = '<div class="setting-card"><h4>This section failed to render</h4><p class="sp-desc">' + esc(e.message) + '</p></div>'; }
    });
  }

  function refresh() {
    buildPanels();
    const active = document.querySelector('.settings-nav-item.active[data-sp-nav]');
    if (active) showPanel(active.dataset.target);
    else updateSubVisibility('');
  }

  function rootOf(id) {
    const p = ALL_PANELS.find((x) => x.id === id);
    return (p && p.parent) || id;
  }

  /** sub-pages are only shown for the section you are actually in (Chrome-style) */
  function updateSubVisibility(activeId) {
    const root = rootOf(activeId);
    document.querySelectorAll('.settings-nav-item.sp-sub').forEach((b) => {
      b.style.display = (b.dataset.parent === root || b.dataset.target === activeId) ? '' : 'none';
    });
  }

  function showPanel(id) {
    document.querySelectorAll('.settings-panel-section').forEach((x) => x.classList.remove('active'));
    updateSubVisibility(id);
    const panel = document.getElementById(id);
    if (panel) panel.classList.add('active');
    const btn = document.querySelector('.settings-nav-item[data-sp-nav][data-target="' + id + '"]');
    if (btn) {
      document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const title = document.getElementById('settings-panel-title');
      if (title) { title.textContent = btn.dataset.label; try { title.innerText = btn.dataset.label; } catch (e) {} }
    }
    document.querySelectorAll('.sp-pill-btn[data-sp-nav]').forEach((b) => b.classList.toggle('active', b.dataset.target === id));
    const area = $('.settings-content-area');
    if (area) area.scrollTop = 0;
  }

  /* ------------------------------ actions ------------------------------- */
  async function action(a, el) {
    switch (a) {
      case 'pause-add': {
        const inp = document.getElementById('sp-pause-input');
        const h = ((inp && inp.value) || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!h) return;
        const list = ((S.privacy && S.privacy.adBlockPause) || []).filter((x) => x !== h);
        list.push(h);
        await save({ privacy: { adBlockPause: list } });
        refresh();
        break;
      }
      case 'pause-del':
        await save({ privacy: { adBlockPause: ((S.privacy && S.privacy.adBlockPause) || []).filter((x) => x !== el.dataset.host) } });
        refresh();
        break;
      case 'clear-item':
        await save({ privacy: { clearOnQuitItems: [...document.querySelectorAll('[data-sp-action="clear-item"]:checked')].map((x) => x.value) } });
        break;
      case 'clear-now': openClearModal(); break;
      case 'perm-default':
        await ipcRenderer.invoke('silence:permission-default', { permission: el.dataset.perm, value: el.value });
        S = (await ipcRenderer.invoke('silence:get-settings')) || S;
        break;
      case 'perm-allow':
      case 'perm-deny':
        await ipcRenderer.invoke('silence:permission-set', { origin: el.dataset.origin, permission: el.dataset.perm, value: a === 'perm-allow' ? 'allow' : 'deny' });
        S = (await ipcRenderer.invoke('silence:get-settings')) || S;
        refresh();
        break;
      case 'zoom-add': {
        const host = ((document.getElementById('sp-zoom-host') || {}).value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const val = parseFloat((document.getElementById('sp-zoom-val') || {}).value || '125');
        if (!host) return;
        const zoom = Object.assign({}, ((S.sites && S.sites.zoom) || {}));
        zoom[host] = Math.max(0.25, Math.min(5, val / 100));
        await save({ sites: { zoom } });
        refresh();
        break;
      }
      case 'zoom-del': {
        const zoom = Object.assign({}, ((S.sites && S.sites.zoom) || {}));
        delete zoom[el.dataset.host];
        await save({ sites: { zoom } });
        refresh();
        break;
      }
      case 'vault-add': {
        const site = (document.getElementById('sp-v-site') || {}).value || '';
        const username = (document.getElementById('sp-v-user') || {}).value || '';
        const password = (document.getElementById('sp-v-pass') || {}).value || '';
        if (!site || !username) return;
        const r = await ipcRenderer.invoke('silence:vault-save', { site, username, password });
        VAULT = (r && r.items) || VAULT;
        refresh();
        break;
      }
      case 'vault-del': {
        const r = await ipcRenderer.invoke('silence:vault-delete', { id: el.dataset.id });
        VAULT = (r && r.items) || VAULT;
        refresh();
        break;
      }
      case 'vault-copy': {
        const r = await ipcRenderer.invoke('silence:vault-reveal', { id: el.dataset.id });
        try { await navigator.clipboard.writeText((r && r.password) || ''); } catch (e) {}
        pill('Password copied', 'ok', 2500);
        break;
      }
      case 'vault-fill': await fillCredentials(el.dataset.id); break;
      case 'lang': {
        const langs = [...document.querySelectorAll('[data-sp-action="lang"]:checked')].map((x) => x.value);
        await save({ languages: { languages: langs.length ? langs : ['en-US'] } });
        break;
      }
      case 'check-update': {
        const btn = document.getElementById('sp-check-update-btn');
        const statusBox = document.getElementById('sp-update-status');
        if (!statusBox) return;

        if (btn) btn.disabled = true;
        statusBox.innerHTML = '<span class="sp-badge" style="background:rgba(99,102,241,.15); border-color:rgba(99,102,241,.3); color:#a5b4fc;">' +
          '<span style="display:inline-block; animation:spSpin 1s linear infinite;">⏳</span> Checking for updates…</span>';

        const result = await ipcRenderer.invoke('silence:check-app-update');

        if (btn) btn.disabled = false;
        if (result && result.status === 'update-available') {
          statusBox.innerHTML = '<span class="sp-badge warn">▲ Update available: Version ' + esc(result.latestVersion) + '</span> ' +
            '<button class="sp-btn small primary" id="sp-trigger-dl">Download in Silence</button>';

          setTimeout(() => {
            const dlBtn = document.getElementById('sp-trigger-dl');
            if (dlBtn) {
              dlBtn.onclick = async () => {
                dlBtn.disabled = true;
                dlBtn.textContent = 'Starting download...';
                const dRes = await ipcRenderer.invoke('silence:download-update', { url: result.url });
                if (dRes && dRes.success) {
                  dlBtn.textContent = 'Downloading in shelf ⬇';
                  pill('Update download started! Check your downloads shelf.', 'ok', 3500);
                } else {
                  dlBtn.disabled = false;
                  dlBtn.textContent = 'Download in Silence';
                  pill('Could not start download automatically.', 'error', 3000);
                }
              };
            }
          }, 50);
        } else {
          statusBox.innerHTML = '<span class="sp-badge ok">✓ Silence is up to date (Version ' + esc(result.currentVersion || '2.1.0') + ')</span>';
        }
        break;
      }
      case 'pick-drm': {
        const r = await ipcRenderer.invoke('silence:browse-folder');
        if (r && r.path) { await save({ drm: { path: r.path } }); refresh(); }
        break;
      }
      case 'open-downloads': ipcRenderer.invoke('silence:open-path', { target: 'downloads' }); break;
      case 'open-profile': ipcRenderer.invoke('silence:open-path', { target: 'userData' }); break;
      case 'open-ext': ipcRenderer.invoke('silence:open-path', { target: 'extensions' }); break;
      case 'open-store': if (typeof createTab === 'function') createTab('silence://store', false, null, 'Extension Store', true); break;
      case 'engine': {
        await save({ search: { engine: el.value } });
        try { localStorage.setItem('silence_search_engine', el.value); } catch (e) {}
        try { if (typeof searchEngine !== 'undefined') searchEngine = el.value; } catch (e) {}
        const legacy = document.getElementById('engine-select');
        if (legacy) legacy.value = el.value;
        setEngineName(el.value);
        break;
      }
      case 'restore-now': try { restoreSession(); } catch (e) { console.warn('[plus] restore failed', e.message); } break;
      case 'reset-settings': S = (await ipcRenderer.invoke('silence:reset-settings')) || S; refresh(); break;
      case 'relaunch': ipcRenderer.invoke('silence:relaunch'); break;
    }
  }

  async function fillCredentials(id) {
    try {
      const rec = (VAULT || []).find((v) => v.id === id);
      const r = await ipcRenderer.invoke('silence:vault-reveal', { id });
      const tab = (typeof tabs !== 'undefined') ? tabs.find((t) => t.id === activeTabId) : null;
      if (!tab || !tab.webview) return;
      const js = '(function(){var u=document.querySelector("input[type=email],input[name*=user i],input[name*=email i],input#username,input#email");' +
        'var p=document.querySelector("input[type=password]");' +
        'if(u){u.value=' + JSON.stringify(rec ? rec.username : '') + ';u.dispatchEvent(new Event("input",{bubbles:true}));}' +
        'if(p){p.value=' + JSON.stringify((r && r.password) || '') + ';p.dispatchEvent(new Event("input",{bubbles:true}));}return !!(u||p);})()';
      const ok = await tab.webview.executeJavaScript(js);
      pill(ok ? 'Credentials filled' : 'No login form found on this page', ok ? 'ok' : 'error', 2600);
    } catch (e) { console.warn('[plus] fill failed', e.message); }
  }

  function openClearModal() {
    let m = document.getElementById('sp-clear-modal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'sp-scrim';
      m.id = 'sp-clear-modal';
      m.innerHTML = '<div class="sp-modal"><h3>Clear browsing data</h3><p class="sp-desc">Choose what Silence should delete.</p>' +
        ['cache', 'storage', 'cookies'].map((k) =>
          '<label class="sp-chip" style="cursor:pointer;margin-top:10px"><input type="checkbox" data-clear="' + k + '" checked style="accent-color:#6366f1"> ' + k + '</label>').join('') +
        '<div class="row-end"><button class="sp-btn" data-close="1">Cancel</button><button class="sp-btn primary" id="sp-clear-go">Clear</button></div></div>';
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m || e.target.dataset.close) m.classList.remove('open'); });
      m.querySelector('#sp-clear-go').onclick = async () => {
        const opts = {};
        m.querySelectorAll('[data-clear]').forEach((x) => { opts[x.dataset.clear] = x.checked; });
        await ipcRenderer.invoke('silence:clear-data', opts);
        m.classList.remove('open');
        pill('Browsing data cleared', 'ok', 2600);
      };
    }
    m.classList.add('open');
  }

  /* --------------------------- extension fixes -------------------------- */
  function hookExtensions() {
    if (window.__spExtHooked) return;
    if (typeof loadExtensionsUI !== 'function') return;
    window.__spExtHooked = true;

    const origLoad = loadExtensionsUI;
    loadExtensionsUI = async function () {
      try { await origLoad.apply(this, arguments); } catch (e) {}
      try { enhanceExtCards(); } catch (e) {}
    };

    // removing must delete the files too, otherwise it returns on restart
    removeExtension = async function (id) {
      try { await ipcRenderer.invoke('silence-store:uninstall', { id }); } catch (e) {}
      try { await ipcRenderer.invoke('remove-extension', id); } catch (e) {}
      try {
        pinnedExtensions = pinnedExtensions.filter((x) => x !== id);
        localStorage.setItem('silence_pinned_exts', JSON.stringify(pinnedExtensions));
      } catch (e) {}
      try { await loadExtensionsUI(); } catch (e) {}
      pill('Extension removed', 'ok', 2600);
    };

    // pop-ups: the inline webview often cannot load chrome-extension:// URLs,
    // so fall back to a frameless window when it fails
    triggerExtensionAction = function (ext, triggerEl) {
      if (!ext || !ext.popupUrl) return;
      const rect = triggerEl.getBoundingClientRect();
      let failed = false;
      const onFail = () => {
        if (failed) return;
        failed = true;
        try { extPopupBubble.classList.remove('open'); } catch (e) {}
        ipcRenderer.send('silence:ext-popup', { url: ext.popupUrl, x: rect.left, y: rect.bottom, width: 400, height: 560 });
      };
      try {
        extPopupWebview.addEventListener('did-fail-load', onFail);
        setTimeout(() => extPopupWebview.removeEventListener('did-fail-load', onFail), 10000);
        extPopupBubble.style.top = (rect.bottom + 6) + 'px';
        extPopupBubble.style.left = Math.max(10, rect.left - 140) + 'px';
        extPopupWebview.src = ext.popupUrl;
        extPopupBubble.classList.add('open');
        extMenuDropdown.classList.remove('open');
        // if nothing rendered in 1.2s, use the window instead
        setTimeout(() => {
          try {
            if (extPopupBubble.classList.contains('open') && !extPopupWebview.getURL()) onFail();
          } catch (e) {}
        }, 1200);
      } catch (e) { onFail(); }
    };
  }

  /** add a trash icon to every extension row so removal is obvious */
  function enhanceExtCards() {
    const list = document.getElementById('extensions-manager-list');
    if (list) {
      list.querySelectorAll('.ext-card').forEach((card) => {
        if (card.querySelector('.sp-ext-del')) return;
        const rm = card.querySelector('.action-btn.danger');
        const match = rm && rm.getAttribute('onclick') && rm.getAttribute('onclick').match(/removeExtension\(['"]([^'"]+)['"]\)/);
        const btn = document.createElement('button');
        btn.className = 'sp-ext-del';
        btn.title = 'Remove this extension';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
        btn.onclick = async (e) => {
          e.stopPropagation();
          if (btn.dataset.busy) return;
          btn.dataset.busy = '1';
          btn.style.opacity = '.45';
          if (match) await removeExtension(match[1]);
          else await loadExtensionsUI();
        };
        const actions = card.lastElementChild;
        if (actions) actions.insertBefore(btn, actions.firstChild);
        else card.appendChild(btn);
      });
    }
    const menu = document.getElementById('ext-menu-dropdown');
    if (menu) {
      menu.querySelectorAll(':scope > div').forEach((item) => {
        if (item.querySelector('.sp-ext-del')) return;
        const pinBtn = item.querySelector('button');
        const del = document.createElement('button');
        del.className = 'sp-ext-del';
        del.title = 'Remove';
        del.style.cssText = 'width:20px;height:20px;margin-left:4px';
        del.innerHTML = '✕';
        del.onclick = async (e) => {
          e.stopPropagation();
          item.style.opacity = '.4';
          const list = await ipcRenderer.invoke('silence-store:list');
          const rows = (list && list.extensions) || [];
          const name = item.querySelector('span') && item.querySelector('span').textContent.trim();
          const row = rows.find((r) => r.name === name);
          if (row) await removeExtension(row.id);
        };
        if (pinBtn && pinBtn.parentNode) pinBtn.parentNode.insertBefore(del, pinBtn.nextSibling);
      });
    }
  }

  /* --------------------- keep old & new settings in sync ---------------- */
  function syncLegacy() {
    try {
      const sel = document.getElementById('engine-select');
      if (sel && !sel.__spSynced) {
        sel.__spSynced = true;
        if (S.search && S.search.engine) sel.value = S.search.engine;
        else save({ search: { engine: sel.value } });
        sel.addEventListener('change', () => {
          S.search = S.search || {};
          S.search.engine = sel.value;
          save({ search: { engine: sel.value } });
          try { localStorage.setItem('silence_search_engine', sel.value); } catch (e) {}
          const mine = document.querySelector('[data-sp-action="engine"]');
          if (mine) mine.value = sel.value;
          setEngineName(sel.value);
        });

        // the same drop-down was also in Appearance — keep exactly one copy
        const dupe = sel.closest('.setting-card');
        if (dupe && dupe.querySelectorAll('select, input, button').length === 1) {
          const card = document.createElement('div');
          card.className = 'setting-card';
          card.innerHTML = '<div class="setting-card-row"><div><h4>Search engine</h4>' +
            '<p>Moved to <b>Search &amp; startup</b> so there is only one copy. Current: <b class="sp-engine-name">' +
            esc(engineName((S.search && S.search.engine) || sel.value)) + '</b></p></div></div>';
          const btn = document.createElement('button');
          btn.className = 'action-btn';
          btn.textContent = 'Change';
          btn.onclick = () => showPanel('panel-search-plus');
          card.querySelector('.setting-card-row').appendChild(btn);
          dupe.parentNode.replaceChild(card, dupe);
        }
      }
    } catch (e) {}

    // the old "Privacy & Ads" panel: make its badge honest and link to the new panel
    try {
      const rows = [...document.querySelectorAll('#panel-privacy .setting-card-row')];
      rows.forEach((row) => {
        const h = row.querySelector('h4');
        if (!h || !/ad\s*&\s*tracker/i.test(h.textContent)) return;
        if (row.__spSynced) return;
        row.__spSynced = true;
        const badge = row.querySelector('span');
        const on = !!(S.privacy && S.privacy.adBlock);
        const paused = ((S.privacy && S.privacy.adBlockPause) || []).length;
        if (badge) {
          badge.textContent = on ? ('Active' + (paused ? ' · ' + paused + ' paused' : '')) : 'Off';
          badge.style.color = on ? 'var(--accent)' : '#8b8f9e';
        }
        const p = row.querySelector('p');
        if (p) p.textContent = 'Managed in Privacy & security → Blocking.';
        if (!row.querySelector('[data-sp-goto]')) {
          const btn = document.createElement('button');
          btn.className = 'action-btn';
          btn.textContent = 'Manage';
          btn.setAttribute('data-sp-goto', 'panel-privacy-plus');
          btn.onclick = () => showPanel('panel-privacy-plus');
          row.appendChild(btn);
        }
      });
    } catch (e) {}
  }

  /* ------------------------------ wiring -------------------------------- */
  function wire() {
    const sidebar = $('.settings-sidebar');
    const area = $('.settings-content-area');

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sp-nav]');
      if (btn) { showPanel(btn.dataset.target); return; }
    });

    const search = document.getElementById('sp-nav-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        if (!q) {
          const active = document.querySelector('.settings-nav-item.active[data-sp-nav]');
          updateSubVisibility(active ? active.dataset.target : '');
          document.querySelectorAll('.settings-nav-item:not(.sp-sub)').forEach((b) => { b.style.display = ''; });
          return;
        }
        document.querySelectorAll('.settings-nav-item').forEach((b) => {
          b.style.display = b.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    }

    area.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.spToggle) { await save(setPath(t.dataset.spToggle, t.checked)); if (t.dataset.spToggle === 'system.animations') document.body.classList.toggle('no-anim', !t.checked); }
      else if (t.dataset.spSelect) {
        await save(setPath(t.dataset.spSelect, t.value));
        if (t.dataset.spSelect === 'gestures.swipe') applySwipeMode();
      }
      else if (t.dataset.spAction) await action(t.dataset.spAction, t);
    });
    area.addEventListener('blur', async (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.spInput) await save(setPath(t.dataset.spInput, t.value));
    }, true);
    area.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-sp-action]');
      if (el && el.tagName === 'BUTTON') await action(el.dataset.spAction, el);
    });
  }

  /* --------------------- runtime behaviour in the shell ----------------- */
  /** tell every tab (and any tab opened later) how sensitive the swipe should be */
  function applySwipeMode(tab) {
    try {
      const mode = ((S.gestures && S.gestures.swipe) || 'high');
      const wire = mode === 'off' ? 'disabled' : mode;
      const send = (t) => { try { if (t && t.webview && t.webview.send) t.webview.send('set-trackpad-nav-config', wire); } catch (e) {} };
      if (tab) { send(tab); return; }
      if (typeof tabs !== 'undefined') tabs.forEach(send);
    } catch (e) {}
  }

  function applyRuntime() {
    document.body.classList.toggle('no-anim', !(S.system && S.system.animations));
    hookTabs();
    hookExtensions();
    syncLegacy();
    applySwipeMode();
    try { tabs.forEach((t) => { if (t.url) applySiteRules(t, t.url); }); } catch (e) {}
    try { loadExtensionsUI(); } catch (e) {}
  }

  function applySiteRules(tab, url) {
    try {
      const host = hostOf(url);
      if (!host) return;
      const z = (S.sites && S.sites.zoom && S.sites.zoom[host]);
      if (z && tab.webview && tab.webview.setZoomFactor) tab.webview.setZoomFactor(z);
      ipcRenderer.send('silence:adblock-sync', { url });
    } catch (e) {}
  }

  function hookTabs() {
    if (typeof createTab !== 'function' || window.__spHooked) return;
    window.__spHooked = true;
    const original = createTab;
    createTab = function () {
      const tab = original.apply(this, arguments);
      try {
        if (tab && tab.webview) {
          setTimeout(() => applySwipeMode(tab), 900);
          tab.webview.addEventListener('did-navigate', (e) => applySiteRules(tab, e.url));
          tab.webview.addEventListener('did-frame-navigate', (e) => { if (e.isMainFrame) applySiteRules(tab, e.url); });
        }
        if ((!arguments[0]) && S.search && S.search.newTab === 'blank') {
          setTimeout(() => { try { hideHomeOverlay(); } catch (e) {} }, 60);
        }
      } catch (e) {}
      return tab;
    };
  }

  async function startupBehaviour() {
    const mode = (S.search && S.search.startup) || 'blank';
    if (mode === 'restore') setTimeout(() => { try { restoreSession(); } catch (e) {} }, 400);
    else if (mode === 'homepage') {
      const url = (S.search && S.search.homepage) || 'https://www.google.com';
      setTimeout(() => { try { createTab(url, false, null, null, true); } catch (e) {} }, 400);
    }
  }

  /* -------------------------------- boot ------------------------------- */
  async function boot() {
    try {
      S = await ipcRenderer.invoke('silence:get-settings');
      INFO = await ipcRenderer.invoke('silence:app-info');
      const v = await ipcRenderer.invoke('silence:vault-list');
      VAULT = (v && v.items) || [];
      ensureCss();
      buildNav();
      buildPanels();
      wire();
      addToolbarButton();
      applyRuntime();
      startupBehaviour();
      window.__silencePlus = { version: VERSION, panels: ALL_PANELS.map((p) => p.id) };
      console.log('[plus] settings add-on ready (v' + VERSION + ')');
      if (S && S.error) pill('Silence core did not load (' + S.error + ') — restart Silence', 'error', 0);
      else if (localStorage.getItem('sp_seen_version') !== VERSION) {
        try { localStorage.setItem('sp_seen_version', VERSION); } catch (e) {}
        pill('<b>Silence Plus v' + VERSION + '</b> — removal & pop-ups fixed, sub-menus added, pop-up blocking now off by default.', 'ok');
      }
    } catch (e) {
      console.error('[plus] failed to start:', e);
      pill('Silence Plus failed to start: ' + ((e && e.message) || e), 'error', 0);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
