/**
 * Silence Pro — renderer add-on (v2.0)
 *
 * Adds the everyday browser tools the shell was missing:
 *   bookmarks (bar + menu + manager, Ctrl+D)
 *   history   (Ctrl+H, search, delete, clear by range)
 *   printing  (Ctrl+P → Print / Save as PDF)
 *   DevTools  (F12 / Ctrl+Shift+I)
 *   password save prompts + one-click fill
 *   vertical tabs + tab groups
 *   reopen closed tab (Ctrl+Shift+T), Ctrl+1..9, duplicate tab
 */

(function silencePro() {
  const { ipcRenderer } = (typeof require === 'function') ? require('electron') : {};
  if (!ipcRenderer) { console.warn('[pro] no ipcRenderer'); return; }

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
  const faviconFor = (url, fav) => fav || (url ? ('https://www.google.com/s2/favicons?domain=' + hostOf(url) + '&sz=32') : '');

  const LS = {
    groups: 'silence_tab_groups',
    vertical: 'silence_vertical_tabs',
    bar: 'silence_bookmarks_bar',
    never: 'silence_never_save'
  };
  const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let bookmarks = [];
  let groups = lsGet(LS.groups, {});           // { tabId: { name, color } }
  let vertical = !!lsGet(LS.vertical, false);
  let barVisible = lsGet(LS.bar, true);
  let neverSave = lsGet(LS.never, []);

  /* ================================================================ chrome */
  function ensureCss() {
    try {
      if ([...document.styleSheets].some((s) => (s.href || '').includes('silence-pro.css'))) return;
      const fs = require('fs'), p = require('path');
      const st = document.createElement('style');
      st.textContent = fs.readFileSync(p.join(__dirname, 'silence-pro.css'), 'utf8');
      document.head.appendChild(st);
    } catch (e) { console.warn('[pro] css fallback:', e.message); }
  }

  function toast(msg, kind, detail) {
    let t = document.getElementById('spro-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'spro-toast';
      document.body.appendChild(t);
    }
    t.innerHTML = msg + (detail ? '<div class="spro-toast-detail">' + detail + '</div>' : '');
    t.className = 'spro-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(t.__t);
    t.__t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /** close a floating panel shortly after the pointer leaves it */
  function hoverClose(el, ms) {
    if (!el || el.__hoverBound) return;
    el.__hoverBound = true;
    el.addEventListener('mouseenter', () => clearTimeout(el.__hoverT));
    el.addEventListener('mouseleave', () => {
      clearTimeout(el.__hoverT);
      el.__hoverT = setTimeout(() => {
        el.classList.remove('open');
        el.style.display = '';
      }, ms || 200);
    });
  }

  function makeButton(id, glyph, title, cls) {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'icon-btn ' + (cls || '');
    b.title = title;
    b.innerHTML = glyph;
    return b;
  }
  /** append a compact button to the end of a container */
  function navButtonEnd(id, glyph, title, containerSel) {
    if (document.getElementById(id)) return document.getElementById(id);
    const box = document.querySelector(containerSel);
    if (!box) return null;
    const b = makeButton(id, glyph, title);
    box.appendChild(b);
    return b;
  }

  /* ============================================================== overlays */
  function overlay(id, title) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'spro-overlay';
      el.id = id;
      el.innerHTML =
        '<div class="spro-sheet">' +
          '<div class="spro-head"><h3>' + esc(title) + '</h3>' +
            '<div class="spro-head-tools"></div>' +
            '<button class="spro-x" data-close="1">✕</button>' +
          '</div>' +
          '<div class="spro-body"></div>' +
        '</div>';
      document.body.appendChild(el);
      el.addEventListener('click', (e) => { if (e.target === el || e.target.dataset.close) el.classList.remove('open'); });
    }
    return el;
  }
  const openOverlay = (el) => { closeOverlays(); el.classList.add('open'); };
  function closeOverlays() { document.querySelectorAll('.spro-overlay.open').forEach((o) => o.classList.remove('open')); }

  /* ============================================================= bookmarks */
  async function loadBookmarks() {
    try { const r = await ipcRenderer.invoke('silence:bookmarks-list'); bookmarks = (r && r.items) || []; }
    catch (e) { bookmarks = []; }
    renderBar();
  }
  async function toggleBookmark() {
    const tab = currentTab();
    if (!tab || !tab.url) return toast('Nothing to bookmark');
    const url = tab.url.startsWith('silence://') ? tab.url : (tab.webview && tab.webview.getURL()) || tab.url;
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) {
      await ipcRenderer.invoke('silence:bookmark-remove', { id: existing.id });
      toast('Removed from bookmarks');
    } else {
      await ipcRenderer.invoke('silence:bookmark-add', { url, title: tab.title, favicon: tab.favicon });
      toast('Bookmarked ⭐ <b>' + esc((tab.title || '').slice(0, 48)) + '</b>');
    }
    loadBookmarks();
    refreshStar();
    if (window.__sproDrawBookmarks) setTimeout(() => window.__sproDrawBookmarks(false), 30);
  }

  function renderBar() {
    // a floating panel anchored to the star button — no layout surgery needed
    let menu = document.getElementById('spro-bm-drop');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'spro-bm-drop';
      document.body.appendChild(menu);
    }
    const star = document.getElementById('spro-star');
    const draw = (forceOpen) => {
      if (!barVisible) { menu.classList.remove('open'); return; }
      const favs = bookmarks.slice(0, 40);
      menu.innerHTML =
        '<div class="spro-drop-head">Bookmarks</div>' +
        (favs.length
          ? favs.map((b) =>
              '<a class="spro-bm" href="#" data-url="' + esc(b.url) + '" title="' + esc(b.title + ' — ' + b.url) + '">' +
                '<img src="' + esc(faviconFor(b.url, b.favicon)) + '" />' +
                '<span>' + esc((b.title || hostOf(b.url) || '').slice(0, 34)) + '</span>' +
                '<button class="spro-mini" data-del="' + esc(b.id) + '">🗑</button></a>').join('')
          : '<div class="spro-empty">No bookmarks yet — press <b>Ctrl+D</b>.</div>') +
        '<div class="spro-drop-foot"><button class="spro-btn" id="spro-bm-all">Manage all…</button>' +
        '<button class="spro-btn" id="spro-bm-page">' + (isBookmarked(currentUrl()) ? 'Remove this page' : 'Bookmark this page') + '</button></div>';
      menu.querySelectorAll('.spro-bm').forEach((a) => {
        a.onclick = (e) => { e.preventDefault(); if (!e.target.dataset.del) { menu.classList.remove('open'); openUrl(a.dataset.url); } };
      });
      menu.querySelectorAll('[data-del]').forEach((d) => {
        d.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          await ipcRenderer.invoke('silence:bookmark-remove', { id: d.dataset.del });
          loadBookmarks(); menu.classList.add('open');
        };
      });
      const all = menu.querySelector('#spro-bm-all');
      if (all) all.onclick = () => { menu.classList.remove('open'); openBookmarksManager(); };
      const page = menu.querySelector('#spro-bm-page');
      if (page) page.onclick = () => { menu.classList.remove('open'); toggleBookmark(); };
      if (star) {
        const r = star.getBoundingClientRect();
        menu.style.top = (r.bottom + 6) + 'px';
        menu.style.left = Math.max(8, r.left - 180) + 'px';
      }
      if (forceOpen !== false) menu.classList.add('open');
      hoverClose(menu, 220);
    };
    window.__sproDrawBookmarks = draw;
    if (star) star.onclick = (e) => { e.stopPropagation(); (menu.classList.contains('open') ? menu.classList.remove('open') : draw(true)); };
    document.addEventListener('click', (e) => {
      if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== star) menu.classList.remove('open');
    });
    if (star) {
      const url = currentUrl();
      star.classList.toggle('on', isBookmarked(url));
    }
  }

  const isBookmarked = (url) => !!url && !!bookmarks.find((b) => b.url === url);
  function refreshStar() {
    const star = document.getElementById('spro-star');
    if (star) star.classList.toggle('on', isBookmarked(currentUrl()));
  }
  function currentUrl() {
    const tab = currentTab();
    if (!tab) return '';
    try { return (tab.webview && tab.webview.getURL()) || tab.url || ''; } catch (e) { return tab.url || ''; }
  }

  function openBookmarksManager() {
    const el = overlay('spro-bm-manager', 'Bookmarks');
    const body = el.querySelector('.spro-body');
    const tools = el.querySelector('.spro-head-tools');
    tools.innerHTML =
      '<input class="spro-input" id="spro-bm-search" placeholder="Search bookmarks" />' +
      '<button class="spro-btn" id="spro-bm-toggle-bar">' + (barVisible ? 'Hide bar' : 'Show bar') + '</button>';
    tools.querySelector('#spro-bm-search').addEventListener('input', (e) => draw(e.target.value));
    tools.querySelector('#spro-bm-toggle-bar').onclick = async () => {
      barVisible = !barVisible; lsSet(LS.bar, barVisible); renderBar(); openBookmarksManager();
    };
    const draw = (q) => {
      const list = q ? bookmarks.filter((b) => ((b.title || '') + ' ' + (b.url || '')).toLowerCase().includes(q.toLowerCase())) : bookmarks;
      body.innerHTML = list.length
        ? '<div class="spro-grid">' + list.map((b) =>
            '<div class="spro-card" data-url="' + esc(b.url) + '">' +
              '<img src="' + esc(faviconFor(b.url, b.favicon)) + '" />' +
              '<div class="spro-card-main"><div class="spro-card-title">' + esc(b.title || hostOf(b.url)) + '</div>' +
              '<div class="spro-card-url">' + esc(b.url) + '</div></div>' +
              '<button class="spro-del" data-id="' + esc(b.id) + '" title="Remove">🗑</button>' +
            '</div>').join('') + '</div>'
        : '<div class="spro-empty">No bookmarks yet — press <b>Ctrl+D</b> on any page.</div>';
      body.querySelectorAll('.spro-card').forEach((c) => { c.onclick = (e) => { if (!e.target.classList.contains('spro-del')) openUrl(c.dataset.url); }; });
      body.querySelectorAll('.spro-del').forEach((d) => {
        d.onclick = async (e) => {
          e.stopPropagation();
          await ipcRenderer.invoke('silence:bookmark-remove', { id: d.dataset.id });
          loadBookmarks(); draw(document.getElementById('spro-bm-search').value);
        };
      });
    };
    draw('');
    openOverlay(el);
  }

  /* =============================================================== history */
  function openHistory() {
    const el = overlay('spro-history', 'History');
    const body = el.querySelector('.spro-body');
    const tools = el.querySelector('.spro-head-tools');
    tools.innerHTML =
      '<input class="spro-input" id="spro-h-search" placeholder="Search history" />' +
      '<button class="spro-btn" data-range="hour">Clear last hour</button>' +
      '<button class="spro-btn" data-range="day">Clear today</button>' +
      '<button class="spro-btn danger" data-range="all">Clear all</button>';
    tools.querySelector('#spro-h-search').addEventListener('input', (e) => draw(e.target.value));
    tools.querySelectorAll('[data-range]').forEach((b) => {
      b.onclick = async () => {
        const range = b.dataset.range;
        if (range === 'all' && !confirm('Delete all browsing history?')) return;
        const since = range === 'hour' ? Date.now() - 3600e3 : range === 'day' ? Date.now() - 86400e3 : null;
        await ipcRenderer.invoke('silence:history-clear', since ? { since } : {});
        draw('');
      };
    });

    const draw = async (q) => {
      const r = await ipcRenderer.invoke('silence:history-list', { query: q || '', limit: 400 });
      const items = (r && r.items) || [];
      if (!items.length) { body.innerHTML = '<div class="spro-empty">No history yet.</div>'; return; }
      let html = '', day = '';
      items.forEach((h) => {
        const d = new Date(h.visitedAt).toDateString();
        if (d !== day) { day = d; html += '<div class="spro-day">' + esc(d === new Date().toDateString() ? 'Today' : d) + '</div>'; }
        const time = new Date(h.visitedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html +=
          '<div class="spro-row" data-url="' + esc(h.url) + '">' +
            '<img src="' + esc(faviconFor(h.url, h.favicon)) + '" />' +
            '<div class="spro-card-main"><div class="spro-card-title">' + esc(h.title || h.url) + '</div>' +
            '<div class="spro-card-url">' + esc(h.url) + '</div></div>' +
            '<span class="spro-time">' + esc(time) + '</span>' +
            '<button class="spro-del" data-id="' + esc(h.id) + '" title="Remove">🗑</button>' +
          '</div>';
      });
      body.innerHTML = html;
      body.querySelectorAll('.spro-row').forEach((row) => {
        row.onclick = (e) => { if (!e.target.classList.contains('spro-del')) openUrl(row.dataset.url); };
      });
      body.querySelectorAll('.spro-del').forEach((d) => {
        d.onclick = async (e) => {
          e.stopPropagation();
          await ipcRenderer.invoke('silence:history-delete', { id: d.dataset.id });
          draw(document.getElementById('spro-h-search').value);
        };
      });
    };
    draw('');
    openOverlay(el);
  }

  /* ================================================================ print */
  function openPrint() {
    const tab = currentTab();
    if (!tab || !tab.webview) return toast('No page open');
    const el = overlay('spro-print', 'Print');
    const body = el.querySelector('.spro-body');
    const id = (() => { try { return tab.webview.getWebContentsId(); } catch (e) { return null; } })();
    body.innerHTML =
      '<div class="spro-print-box">' +
        '<h4>' + esc(tab.title || 'Current page') + '</h4>' +
        '<p>Send this page to your printer, or save it as a PDF file.</p>' +
        '<div class="spro-print-actions">' +
          '<button class="spro-btn primary" id="spro-do-print">Print…</button>' +
          '<button class="spro-btn" id="spro-do-pdf">Save as PDF</button>' +
        '</div>' +
      '</div>';
    body.querySelector('#spro-do-print').onclick = async () => {
      const r = await ipcRenderer.invoke('silence:print', { webContentsId: id });
      if (r && r.error) toast(r.error, 'error');
      closeOverlays();
    };
    body.querySelector('#spro-do-pdf').onclick = async () => {
      const r = await ipcRenderer.invoke('silence:print-pdf', { webContentsId: id });
      closeOverlays();
      if (r && r.error) toast(r.error, 'error');
      else if (r && r.filePath) toast('Saved: ' + esc(r.filePath));
    };
    openOverlay(el);
  }

  function toggleDevTools() {
    const tab = currentTab();
    if (!tab || !tab.webview) return;
    try {
      if (tab.webview.isDevToolsOpened()) tab.webview.closeDevTools();
      else tab.webview.openDevTools();
    } catch (e) { toast('DevTools unavailable', 'error'); }
  }

  /* ============================================================ passwords */
  function offerSave(tab, cred) {
    if (!cred || !cred.password) return;
    const host = hostOf((tab && tab.url) || '');
    if (!host || neverSave.includes(host)) return;
    let chip = document.getElementById('spro-save-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'spro-save-chip';
      document.body.appendChild(chip);
    }
    chip.innerHTML =
      '<span>🔑 Save password for <b>' + esc(host) + '</b>?</span>' +
      '<button class="spro-btn primary" id="spro-save-yes">Save</button>' +
      '<button class="spro-btn" id="spro-save-never">Never</button>' +
      '<button class="spro-x" id="spro-save-no">✕</button>';
    chip.classList.add('show');
    const hide = () => chip.classList.remove('show');
    chip.querySelector('#spro-save-yes').onclick = async () => {
      await ipcRenderer.invoke('silence:vault-save', { site: host, username: cred.username || '', password: cred.password });
      hide(); toast('Password saved for <b>' + esc(host) + '</b>');
    };
    chip.querySelector('#spro-save-never').onclick = () => { neverSave.push(host); lsSet(LS.never, neverSave); hide(); };
    chip.querySelector('#spro-save-no').onclick = hide;
  }

  /* ====================================================== tabs & groups */
  function currentTab() {
    try { return tabs.find((t) => t.id === activeTabId) || null; } catch (e) { return null; }
  }
  function openUrl(url) {
    try { closeOverlays(); createTab(url, false, null, null, true); } catch (e) {}
  }

  /* ---------------------------------------------------------------------
     Vertical tabs were removed at your request. The hooks below stay as
     no-ops so tab events keep working without touching the shell's code.
     --------------------------------------------------------------------- */
  function renderRail() { /* vertical tabs removed */ }
  function setVertical(on) { vertical = !!on; lsSet(LS.vertical, vertical); }
  function positionRail() {}

  /* ============================================================== wiring */
  /** history + password-capture listeners for one tab (idempotent) */
  function wireTab(tab) {
    if (!tab || !tab.webview || tab.__sproWired) return;
    try { tab.__sproWired = true; } catch (e) { return; }
    const record = (url) => {
      try {
        if (url && !/^(about:|silence:|chrome-extension:)/i.test(url)) {
          ipcRenderer.invoke('silence:history-add', { url, title: tab.title, favicon: tab.favicon });
        }
      } catch (e) {}
    };
    try {
      tab.webview.addEventListener('did-finish-load', () => { record(tab.webview.getURL()); focusActiveTab(); });
      tab.webview.addEventListener('dom-ready', focusActiveTab);
      tab.webview.addEventListener('did-navigate', (e) => { record(e.url); renderRail(); });
      tab.webview.addEventListener('page-title-updated', () => { renderRail(); refreshStar(); });
      tab.webview.addEventListener('ipc-message', (e) => {
        if (e.channel === 'silence-login') offerSave(tab, e.args && e.args[0]);
      });
    } catch (e) {}
  }

  function hookTabs() {
    if (typeof createTab !== 'function' || window.__sproHooked) return;
    window.__sproHooked = true;
    const original = createTab;
    createTab = function () {
      const tab = original.apply(this, arguments);
      try { wireTab(tab); } catch (e) {}
      setTimeout(renderRail, 30);
      return tab;
    };
    // tabs that already exist (session restore, first tab) need wiring too
    try { (typeof tabs !== 'undefined' ? tabs : []).forEach(wireTab); } catch (e) {}
    setInterval(() => { try { (typeof tabs !== 'undefined' ? tabs : []).forEach(wireTab); } catch (e) {} }, 2000);
    // keep the rail in sync with the shell's own tab actions
    const origRender = typeof renderTabs === 'function' ? renderTabs : null;
    if (origRender) {
      renderTabs = function () { const r = origRender.apply(this, arguments); try { renderRail(); } catch (e) {} return r; };
    }
    ['switchTab', 'closeTab'].forEach((fn) => {
      if (typeof window[fn] === 'function') {
        const orig = window[fn];
        window[fn] = function () { const r = orig.apply(this, arguments); try { renderRail(); refreshStar(); if (fn === 'switchTab') focusActiveTab(); } catch (e) {} return r; };
      }
    });
  }

  function shortcuts() {
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && k === 'o') { e.preventDefault(); openBookmarksManager(); }
      else if (mod && !e.shiftKey && k === 'd') { e.preventDefault(); toggleBookmark(); }
      else if (mod && e.shiftKey && k === 'h') { e.preventDefault(); openHistory(); }
      else if (mod && !e.shiftKey && k === 'p') { e.preventDefault(); openPrint(); }
      else if (e.key === 'F12' || (mod && e.shiftKey && k === 'i')) { e.preventDefault(); toggleDevTools(); }
      else if (mod && e.shiftKey && k === 't') {
        e.preventDefault();
        try {
          if (typeof recentlyClosedTabs !== 'undefined' && recentlyClosedTabs.length) {
            const t = recentlyClosedTabs.pop();
            createTab(t.url, t.isSaved, null, t.title, true);
          }
        } catch (err) {}
      } else if (mod && e.shiftKey && k === 'u') {
        e.preventDefault();
        const tab = currentTab();
        if (tab) createTab(tab.webview ? tab.webview.getURL() : tab.url, false, null, tab.title, true);
      } else if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        try { const t = tabs[parseInt(e.key, 10) - 1]; if (t) switchTab(t.id); } catch (err) {}
      } else if (e.key === 'Escape') { closeOverlays(); }
    }, true);
  }

  /**
   * The address bar sits inside a narrow 280px dock, so the Pro controls get
   * their own row directly under it — no more squeezing the bar itself.
   */
  function buildCluster() {
    let box = document.getElementById('spro-cluster');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'spro-cluster';
    const mk = (id, glyph, title, fn) => {
      const b = makeButton(id, glyph, title, 'spro-tb');
      b.onclick = fn;
      box.appendChild(b);
      return b;
    };
    mk('spro-star', '⭐', 'Bookmark this tab (Ctrl+D)', (e) => { e.stopPropagation(); toggleBookmark(); });
    mk('spro-hist', '🕘', 'History (Ctrl+Shift+H)', (e) => { e.stopPropagation(); openHistory(); });
    mk('spro-menu-btn', '⚙', 'Silence Pro — print, DevTools, bookmarks', (e) => { e.stopPropagation(); openProMenu(e.currentTarget); });
    return box;
  }

  /** place the row directly beneath the address bar */
  function placeCluster() {
    const box = buildCluster();
    const navBar = document.querySelector('.nav-bar-container');
    if (navBar && navBar.parentNode) {
      if (box.parentNode !== navBar.parentNode || box.previousElementSibling !== navBar) {
        navBar.parentNode.insertBefore(box, navBar.nextSibling);
      }
      return;
    }
    const fallback = document.querySelector('.header-right-actions') || document.getElementById('titlebar');
    if (fallback && box.parentNode !== fallback) fallback.insertBefore(box, fallback.firstChild);
  }

  /* --------------------------------------------- keyboard shortcut help */
  const SHORTCUT_HELP = [
    ['Tabs & windows', [
      ['Ctrl + T', 'New tab'],
      ['Ctrl + N', 'New tab (Silence runs in one window)'],
      ['Ctrl + W', 'Close tab'],
      ['Ctrl + Shift + T', 'Reopen the last closed tab'],
      ['Ctrl + Tab', 'Next tab'],
      ['Ctrl + Shift + Tab', 'Previous tab'],
      ['Ctrl + 1…8', 'Jump to that tab'],
      ['Ctrl + 9', 'Jump to the last tab'],
      ['Ctrl + Shift + W', 'Close the window'],
      ['Ctrl + Shift + U', 'Duplicate tab'],
      ['F11', 'Full screen']
    ]],
    ['Navigation', [
      ['Alt + ←  /  Backspace', 'Back'],
      ['Alt + →', 'Forward'],
      ['Alt + Home', 'Home page'],
      ['Ctrl + R  /  F5', 'Reload'],
      ['Ctrl + Shift + R', 'Reload, ignoring cache'],
      ['Ctrl + L  /  Alt + D  /  F6', 'Jump to the address bar'],
      ['Ctrl + E', 'Jump to the quick-search box'],
      ['Ctrl + K', 'Command palette'],
      ['Ctrl + O', 'Open a file from your PC']
    ]],
    ['The page', [
      ['Ctrl + F  /  F3', 'Find in page'],
      ['Ctrl + G  /  Ctrl + Shift + G', 'Next / previous match'],
      ['Ctrl + P', 'Print'],
      ['Ctrl + S', 'Save the page'],
      ['Ctrl + U', 'View source'],
      ['Ctrl + +  /  Ctrl + −', 'Zoom in / out'],
      ['Ctrl + 0', 'Reset zoom'],
      ['Ctrl + D', 'Bookmark this page']
    ]],
    ['Browser', [
      ['Ctrl + H', 'History'],
      ['Ctrl + J', 'Downloads'],
      ['Ctrl + Shift + O', 'Bookmark manager'],
      ['Ctrl + Shift + B', 'Show / hide the bookmarks bar'],
      ['Ctrl + Shift + Delete', 'Clear browsing data'],
      ['Ctrl + Shift + I  /  F12', 'Developer tools']
    ]],
    ['Silence extras', [
      ['Ctrl + Shift + S', 'Split view'],
      ['Ctrl + Shift + D', 'Force dark mode'],
      ['Ctrl + Shift + N', 'Scratchpad']
    ]]
  ];

  function openShortcutHelp() {
    const el = overlay('spro-keys', 'Keyboard shortcuts');
    const body = el.querySelector('.spro-body');
    body.innerHTML = SHORTCUT_HELP.map((sec) =>
      '<h4 class="spro-h4">' + sec[0] + '</h4>' +
      '<table class="spro-keys">' + sec[1].map((r) =>
        '<tr><td><kbd>' + r[0] + '</kbd></td><td>' + r[1] + '</td></tr>').join('') +
      '</table>').join('');
  }

  function openProMenu(anchor) {
    let m = document.getElementById('spro-main-menu');
    if (!m) {
      m = document.createElement('div');
      m.id = 'spro-main-menu';
      document.body.appendChild(m);
    }
    const tab = currentTab();
    const bm = tab && isBookmarked(currentUrl());
    m.innerHTML =
      '<button data-a="bookmark">' + (bm ? '★ Remove bookmark' : '☆ Bookmark this page') + ' <span>Ctrl+D</span></button>' +
      '<button data-a="bookmarks">⭐ All bookmarks <span>Ctrl+Shift+O</span></button>' +
      '<button data-a="history">🕘 History <span>Ctrl+Shift+H</span></button>' +
      '<button data-a="print">🖨 Print… <span>Ctrl+P</span></button>' +
      '<button data-a="pdf">📄 Save as PDF</button>' +
      '<button data-a="devtools">🛠 DevTools <span>F12</span></button>' +
      '<button data-a="keys">⌨ Keyboard shortcuts</button>';
    m.style.display = 'block';
    positionMenu(anchor, m);
    m.classList.add('open');
    hoverClose(m, 200);
    m.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        m.classList.remove('open');
        const a = b.dataset.a;
        if (a === 'bookmark') toggleBookmark();
        else if (a === 'bookmarks') openBookmarksManager();
        else if (a === 'history') openHistory();
        else if (a === 'print') openPrint();
        else if (a === 'pdf') openPrint();
        else if (a === 'devtools') toggleDevTools();
        else if (a === 'keys') openShortcutHelp();
        else if (a === 'vtabs') setVertical(!vertical);
      };
    });
    setTimeout(() => {
      document.addEventListener('click', function close(ev) {
        if (!m.contains(ev.target) && ev.target !== anchor) { m.classList.remove('open'); document.removeEventListener('click', close); }
      });
    }, 10);
  }

  function addNavButtons() {
    placeCluster();
    buildTitleSearch();
    // follow the window into and out of fullscreen (the title bar is hidden there)
    const replace = () => { placeCluster(); buildTitleSearch(); };
    new MutationObserver(replace).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', replace);
  }

  /* Every combo the browser owns.  Keep this identical to COMBOS in
   * gesture-preload.js — make_release.sh fails the build if they drift apart. */
  const SHORTCUT_COMBOS = [
    'ctrl+t', 'ctrl+n', 'ctrl+w', 'ctrl+shift+w', 'ctrl+shift+t',
    'ctrl+tab', 'ctrl+shift+tab',
    'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5',
    'ctrl+6', 'ctrl+7', 'ctrl+8', 'ctrl+9',
    'ctrl+r', 'ctrl+shift+r', 'f5', 'shift+f5', 'ctrl+f5',
    'ctrl+u', 'ctrl+s', 'ctrl+o', 'ctrl+p',
    'ctrl+f', 'f3', 'ctrl+g', 'ctrl+shift+g',
    'alt+left', 'alt+right', 'backspace', 'alt+home',
    'ctrl+l', 'alt+d', 'f6', 'ctrl+e', 'ctrl+k',
    'ctrl+h', 'ctrl+j', 'ctrl+shift+delete', 'ctrl+shift+o',
    'ctrl+d', 'ctrl+shift+b',
    'ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+c', 'f12', 'f11',
    'ctrl+=', 'ctrl+-', 'ctrl+0',
    'ctrl+shift+s', 'ctrl+shift+n', 'ctrl+shift+u', 'ctrl+shift+d'
  ];

  /**
   * Shortcuts must fire no matter what holds the keyboard: a page (handled by
   * the preload) or the browser chrome itself (handled here).  Without this
   * you had to click the page before Ctrl+T would do anything.
   */
  function windowShortcuts() {
    const OWNED = {};
    SHORTCUT_COMBOS.forEach((c) => { OWNED[c] = true; });
    const NAMED = {
      ' ': 'space', escape: 'esc', arrowleft: 'left', arrowright: 'right',
      arrowup: 'up', arrowdown: 'down', delete: 'del', add: '=', subtract: '-'
    };
    const TYPING_SAFE = { backspace: 1, 'alt+left': 1, 'alt+right': 1 };

    const isTyping = (el) => {
      if (!el || !el.tagName) return false;
      const t = String(el.tagName).toLowerCase();
      if (t === 'input' || t === 'textarea' || t === 'select') return true;
      try { if (el.isContentEditable) return true; } catch (e) {}
      return false;
    };

    window.addEventListener('keydown', (e) => {
      if (e.isComposing || !e.key) return;
      let k = String(e.key).toLowerCase();
      if (NAMED[k]) k = NAMED[k];
      let combo = '';
      if (e.ctrlKey || e.metaKey) combo += 'ctrl+';
      if (e.altKey) combo += 'alt+';
      if (e.shiftKey) combo += 'shift+';
      combo += k;
      if (!OWNED[combo]) return;
      if (TYPING_SAFE[combo] && isTyping(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof window.__silenceShortcut === 'function') window.__silenceShortcut(combo);
    }, true);
  }

  /** hand the keyboard to the page, the way Chrome does once a page settles */
  function focusActiveTab() {
    try {
      const busy = document.querySelector('.spro-overlay.open') ||
                   document.getElementById('settings-screen.active') ||
                   document.querySelector('#settings-screen.active');
      if (busy) return;
      const el = document.activeElement;
      if (el && el !== document.body && el !== document.documentElement) return;   // typing somewhere
      const t = currentTab();
      if (!t || !t.webview || !t.webview.focus) return;
      setTimeout(() => {
        try { if (currentTab() === t) t.webview.focus(); } catch (e) {}
      }, 60);
    } catch (e) {}
  }

  /* ================================================== security notices
   * Two things the main process tells the user about: a download that started
   * from a file link (so the click never looks dead), and Silence's Chromium
   * falling behind current Electron releases.
   */
  function wireSecurityNotices() {
    try {
      ipcRenderer.on('download-started', (e, data) => {
        const u = (data && data.url) || '';
        let name = 'file';
        try { name = decodeURIComponent(u.split('/').pop().split('?')[0]) || 'file'; } catch (err) {}
        toast('⬇ Downloading <b>' + extEsc(name) + '</b>', 'ok',
              'Saved to your downloads folder — press Ctrl+J to see it.');
      });
    } catch (e) {}

    try {
      ipcRenderer.on('electron-outdated', (e, data) => {
        const cur = (data && data.current) || '';
        const latest = (data && data.latest) || '';
        toast('🛡 Silence is running an older Chromium (' + extEsc(cur) + ')', 'err',
              'Electron ' + extEsc(latest) + ' is out with security fixes. Run:  npm run update-electron');
      });
    } catch (e) {}
  }

  /* ================================================== extension toolbar
   * Chrome shows a crisp icon, a tooltip and a popup that sizes itself to the
   * extension's own markup.  Silence drew 14px icons with a 🧩 fallback and
   * clicks often went nowhere, so the buttons and the popup are rebuilt here.
   */
  const EXT_TILE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

  const extEsc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** a coloured letter tile — always better than a broken image or a 🧩 */
  function extTile(ext, size) {
    const name = (ext && ext.name) || '';
    const letter = (name.replace(/[^a-z0-9]/gi, '').charAt(0) || '?').toUpperCase();
    let h = 0;
    const seed = String((ext && ext.id) || name);
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const bg = EXT_TILE_COLORS[h % EXT_TILE_COLORS.length];
    const px = size || 18;
    return '<span class="spro-ext-tile" style="background:' + bg + ';width:' + px + 'px;height:' + px +
           'px;font-size:' + Math.max(8, Math.round(px * 0.55)) + 'px">' + extEsc(letter) + '</span>';
  }

  function extIconHtml(ext, size) {
    return ext && ext.icon ? '<img src="' + extEsc(ext.icon) + '" style="width:' + (size || 18) + 'px;height:' + (size || 18) + 'px;border-radius:4px;" />'
                           : extTile(ext, size);
  }

  /** make every rendered extension button look and behave like Chrome's */
  function beautifyExtensionUI() {
    try {
      const list = window.extensionsCache || [];
      const byId = {};
      list.forEach((e) => { byId[e.id] = e; });

      // 1. toolbar buttons
      document.querySelectorAll('.ext-toolbar-btn').forEach((btn) => {
        btn.classList.add('spro-ext-btn');
        const id = btn.dataset.extId;
        const ext = byId[id];
        if (!ext) return;
        btn.title = ext.name + (ext.popupUrl ? '' : '  (no popup)');
        if (!btn.querySelector('img')) {
          btn.innerHTML = extIconHtml(ext, 18);
        } else {
          const img = btn.querySelector('img');
          img.style.width = '18px';
          img.style.height = '18px';
          img.style.borderRadius = '4px';
          img.style.objectFit = 'contain';
        }
        btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openExtMenu(ext, btn); });
      });

      // 2. the puzzle-piece dropdown rows
      const drop = document.getElementById('ext-menu-dropdown');
      if (drop) {
        drop.querySelectorAll('div').forEach((row) => {
          const ext = byId[row.dataset.extId];
          if (!ext) return;
          if (!row.querySelector('img')) {
            const holder = row.firstElementChild;
            if (holder) holder.innerHTML = extIconHtml(ext, 16) + holder.innerHTML.replace(/^\u{1F9E9}/u, '');
          }
        });
      }

      // 3. the cards in the extension manager — their id is in the Pin button
      document.querySelectorAll('#extensions-manager-list .ext-card').forEach((card) => {
        const m = /togglePinExtension\('([^']+)'\)/.exec(card.innerHTML);
        const ext = m && byId[m[1]];
        if (!ext || card.querySelector('img')) return;
        const left = card.querySelector('.ext-left');
        if (left) left.innerHTML = extIconHtml(ext, 32) + left.innerHTML.replace(/\u{1F9E9}/u, '');
      });
    } catch (e) {}
  }

  /* ---------------------------------------------------- extension popup */
  function closeExtensionPopup() {
    const bubble = document.getElementById('ext-popup-bubble');
    window.__sproPopupOpen = false;
    if (!bubble) return;
    bubble.classList.remove('open');
    bubble.style.width = '';
    bubble.style.height = '';
    document.querySelectorAll('.ext-toolbar-btn.popup-open').forEach((b) => b.classList.remove('popup-open'));
  }

  function openExtensionPopup(ext, anchor) {
    const bubble = document.getElementById('ext-popup-bubble');
    const wv = document.getElementById('ext-popup-webview');
    if (!bubble || !wv) return;

    if (bubble.classList.contains('open') && bubble.dataset.extId === ext.id) { closeExtensionPopup(); return; }
    closeExtensionPopup();

    if (!ext.popupUrl) {
      if (ext.optionsUrl) {
        try { createTab(ext.optionsUrl, false, null, (ext.name || 'Extension') + ' options', true); } catch (e) {}
      } else {
        toast('🧩 <b>' + extEsc(ext.name) + '</b> has no popup — it does its work in the background.', 'ok');
      }
      return;
    }

    // Chrome closes the extension list when a popup takes over
    try {
      const drop = document.getElementById('ext-menu-dropdown');
      if (drop) drop.classList.remove('open');
    } catch (e2) {}

    bubble.dataset.extId = ext.id;
    wv.src = ext.popupUrl;
    bubble.classList.add('open');
    window.__sproPopupOpen = true;          // the shell's hover-out must not close it
    if (anchor) anchor.classList.add('popup-open');

    const place = () => {
      const r = (anchor || document.body).getBoundingClientRect();
      const w = parseInt(bubble.style.width, 10) || 360;
      let left = Math.round(r.right - w);
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      bubble.style.left = left + 'px';
      bubble.style.top = Math.round(r.bottom + 6) + 'px';
    };
    bubble.style.width = '360px';
    bubble.style.height = '420px';
    place();

    // Chrome sizes the popup to the extension's own content
    const fit = () => {
      try {
        wv.executeJavaScript('(function(){var b=document.body;return {w:Math.ceil(b.scrollWidth),h:Math.ceil(b.scrollHeight)};})()', false)
          .then((size) => {
            if (!size) return;
            const w = Math.max(220, Math.min(800, size.w + 2));
            const h = Math.max(80, Math.min(600, size.h + 2));
            bubble.style.width = w + 'px';
            bubble.style.height = h + 'px';
            place();
          }).catch(() => {});
      } catch (e) {}
    };
    wv.addEventListener('did-finish-load', fit);
    wv.addEventListener('did-fail-load', () => {
      toast('🧩 <b>' + extEsc(ext.name) + '</b> could not open its popup in Silence.', 'err',
            'Its background code may need a newer Electron than the one this build ships with.');
      closeExtensionPopup();
    });
    setTimeout(fit, 700);
  }

  /** right-click an extension → the menu Chrome shows */
  function openExtMenu(ext, anchor) {
    let m = document.getElementById('spro-ext-menu');
    if (!m) { m = document.createElement('div'); m.id = 'spro-ext-menu'; document.body.appendChild(m); }
    m.innerHTML =
      (ext.popupUrl ? '<button data-a="open">Open popup</button>' : '') +
      (ext.optionsUrl ? '<button data-a="options">Options</button>' : '') +
      '<button data-a="pin">' + (pinnedExts().includes(ext.id) ? 'Unpin from toolbar' : 'Pin to toolbar') + '</button>' +
      '<button data-a="remove" class="danger">Remove from Silence</button>';
    m.style.display = 'block';
    positionMenu(anchor, m);
    m.classList.add('open');
    hoverClose(m, 220);
    m.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        m.classList.remove('open');
        const a = b.dataset.a;
        if (a === 'open') openExtensionPopup(ext, anchor);
        else if (a === 'options') { try { createTab(ext.optionsUrl, false, null, (ext.name || 'Extension') + ' options', true); } catch (e) {} }
        else if (a === 'pin') { try { togglePinExtension(ext.id); } catch (e) {} }
        else if (a === 'remove') { try { removeExtension(ext.id); } catch (e) {} }
      };
    });
    setTimeout(() => {
      document.addEventListener('click', function close(ev) {
        if (!m.contains(ev.target) && ev.target !== anchor) { m.classList.remove('open'); document.removeEventListener('click', close); }
      });
    }, 10);
  }

  function pinnedExts() {
    try { return JSON.parse(localStorage.getItem('silence_pinned_exts')) || []; } catch (e) { return []; }
  }

  /** take over the shell's extension rendering and click handling */
  function hookExtensionUI() {
    if (window.__sproExtHooked) return;
    window.__sproExtHooked = true;

    if (typeof window.loadExtensionsUI === 'function') {
      const origLoad = window.loadExtensionsUI;
      window.loadExtensionsUI = async function () {
        let r;
        try { r = await origLoad.apply(this, arguments); } catch (e) {}
        try {
          window.extensionsCache = await ipcRenderer.invoke('get-extensions') || [];
          // tag the buttons with their extension id so they can be matched up
          const list = window.extensionsCache || [];
          const pinned = pinnedExts();
          const btns = document.querySelectorAll('.ext-toolbar-btn');
          const pinnedOrder = list.filter((e) => pinned.includes(e.id));
          if (pinnedOrder.length === btns.length) {
            btns.forEach((b, i) => { if (pinnedOrder[i]) b.dataset.extId = pinnedOrder[i].id; });
          } else if (list.length === btns.length) {
            btns.forEach((b, i) => { if (list[i]) b.dataset.extId = list[i].id; });   // all pinned
          }
          const rows = document.querySelectorAll('#ext-menu-dropdown > div');
          rows.forEach((row, i) => { if (list[i]) row.dataset.extId = list[i].id; });
          beautifyExtensionUI();
        } catch (e) {}
        return r;
      };
    }

    if (typeof window.triggerExtensionAction === 'function') {
      window.triggerExtensionAction = function (ext, triggerEl) {
        try { openExtensionPopup(ext, triggerEl); } catch (e) {}
      };
    }

    // close the popup the way Chrome does
    document.addEventListener('click', (e) => {
      const bubble = document.getElementById('ext-popup-bubble');
      if (!bubble || !bubble.classList.contains('open')) return;
      // wait for the click that opened the popup to finish travelling, otherwise
      // a menu item's own click would close the popup it just opened
      setTimeout(() => {
        if (!bubble.classList.contains('open')) return;
        if (bubble.contains(e.target)) return;
        if (e.target && e.target.closest) {
          if (e.target.closest('#ext-menu-dropdown')) return;   // the puzzle menu handles itself
          if (e.target.closest('.ext-toolbar-btn')) return;     // so does the toolbar button
          if (e.target.closest('#spro-ext-menu')) return;
        }
        closeExtensionPopup();
      }, 0);
    });
    window.addEventListener('resize', closeExtensionPopup);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') closeExtensionPopup();
    });
  }

  /* ==================================================== Chrome shortcuts
   * Keys typed inside a page never reach the browser window, so the preload
   * recognises the combo and sends it here.  This is the single place that
   * maps Chrome's keyboard shortcuts onto Silence's own UI.
   */
  function chromeShortcuts() {
    const activeWv = () => { const t = currentTab(); return t && t.webview ? t.webview : null; };

    function newTab() {
      try { if (typeof toggleSettings === 'function') toggleSettings(false); } catch (e) {}
      try { createTab(); } catch (e) { toast('Could not open a tab', 'err'); }
    }

    function cycleTab(dir) {
      try {
        if (!tabs.length) return;
        const i = tabs.findIndex((t) => t.id === activeTabId);
        const next = ((i < 0 ? 0 : i + dir) + tabs.length) % tabs.length;
        switchTab(tabs[next].id);
      } catch (e) {}
    }

    function reload(hard) {
      const wv = activeWv();
      if (!wv) return;
      try { if (hard) wv.reloadIgnoringCache(); else wv.reload(); } catch (e) {}
    }

    function goBack() {
      const wv = activeWv();
      if (!wv) return;
      try {
        if (wv.canGoBack && wv.canGoBack()) wv.goBack();
        else if (typeof showHomeOverlay === 'function') showHomeOverlay();
      } catch (e) {}
    }

    function goForward() {
      const wv = activeWv();
      if (!wv) return;
      try { if (wv.canGoForward && wv.canGoForward()) wv.goForward(); } catch (e) {}
    }

    function focusUrlBar() {
      try {
        const u = document.getElementById('url-bar');
        if (u) { u.focus(); if (u.select) u.select(); }
      } catch (e) {}
    }

    function focusQuickSearch() {
      try {
        const i = document.getElementById('spro-tsearch-input');
        if (i) { i.focus(); if (i.select) i.select(); }
      } catch (e) {}
    }

    /* ------------------------------------------------------- find in page */
    function findInPage(text, forward) {
      const wv = activeWv();
      if (!wv || typeof wv.findInPage !== 'function') return;
      if (!text) { try { wv.stopFindInPage('clearSelection'); } catch (e) {} return; }
      try { wv.findInPage(text, { forward: forward !== false, findNext: true, matchCase: false }); } catch (e) {}
    }

    function openFind() {
      try {
        const widget = document.getElementById('find-widget');
        const input = document.getElementById('find-input');
        if (!widget || !input) return;
        widget.classList.add('open');
        input.focus();
        if (input.select) input.select();
        if (input.__sproWired) return;
        input.__sproWired = true;
        input.addEventListener('input', () => findInPage(input.value, true));
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); findInPage(input.value, !ev.shiftKey); }
          else if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
        });
        const prev = document.getElementById('find-prev-btn');
        const next = document.getElementById('find-next-btn');
        const close = document.getElementById('find-close-btn');
        if (prev) prev.onclick = () => findInPage(input.value, false);
        if (next) next.onclick = () => findInPage(input.value, true);
        if (close) close.onclick = closeFind;
      } catch (e) {}
    }

    function closeFind() {
      try {
        const widget = document.getElementById('find-widget');
        const input = document.getElementById('find-input');
        if (widget) widget.classList.remove('open');
        if (input) input.value = '';
        const wv = activeWv();
        if (wv && wv.stopFindInPage) wv.stopFindInPage('clearSelection');
      } catch (e) {}
    }

    /* ------------------------------------------------------------- panels */
    function openDownloads() {
      try { const b = document.getElementById('downloads-toggle-btn'); if (b) b.click(); } catch (e) {}
    }

    function toggleBookmarksBar() {
      barVisible = !barVisible;
      lsSet(LS.bar, barVisible);
      renderBar();
      toast(barVisible ? '📚 Bookmarks bar shown' : '📚 Bookmarks bar hidden', 'ok');
    }

    function openClearData() {
      try {
        if (typeof toggleSettings === 'function') toggleSettings(true);
        setTimeout(() => {
          const nav = document.querySelector('.settings-nav-item[data-target="panel-privacy"]');
          if (nav) { try { nav.click(); nav.scrollIntoView({ block: 'center' }); } catch (e) {} }
        }, 80);
      } catch (e) {}
    }

    async function savePage() {
      const wv = activeWv();
      if (!wv) return;
      try {
        const id = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : 0;
        const t = currentTab();
        const suggested = String((t && t.title) || 'page').replace(/[^\w\-. ]+/g, '_').slice(0, 60) + '.html';
        const res = await ipcRenderer.invoke('save-page', { id, suggested });
        if (res && res.ok) toast('💾 Page saved — ' + res.path, 'ok');
        else if (res && !res.canceled) toast('Could not save this page', 'err');
      } catch (e) { toast('Could not save this page', 'err'); }
    }

    async function openFile() {
      try {
        const p = await ipcRenderer.invoke('open-file-dialog');
        if (!p) return;
        const url = 'file:///' + String(p).replace(/\\/g, '/');
        createTab(url, false, null, String(p).split(/[\\/]/).pop(), true);
      } catch (e) {}
    }

    function viewSource() {
      const t = currentTab();
      if (!t) return;
      const url = (t.webview && t.webview.getURL) ? t.webview.getURL() : t.url;
      if (!url || /^view-source:/i.test(url) || url === 'about:blank') return;
      try { createTab('view-source:' + url, false, null, 'Source: ' + url, true); } catch (e) {}
    }

    async function goHome() {
      let home = 'https://www.google.com';
      try {
        const s = await ipcRenderer.invoke('silence:get-settings');
        if (s && s.search && s.search.homepage) home = s.search.homepage;
      } catch (e) {}
      try { navigateActiveTab(home); } catch (e) { try { createTab(home, false, null, 'Home', true); } catch (e2) {} }
    }

    function zoom(delta) {
      try { if (typeof adjustZoom === 'function') { adjustZoom(delta); return; } } catch (e) {}
      const wv = activeWv();
      if (wv && wv.getZoomFactor) {
        try { wv.setZoomFactor(Math.max(0.25, Math.min(5, wv.getZoomFactor() + delta))); } catch (e) {}
      }
    }

    function resetZoom() {
      try { const b = document.getElementById('zoom-reset-btn'); if (b) { b.click(); return; } } catch (e) {}
      const wv = activeWv();
      if (wv && wv.setZoomFactor) { try { wv.setZoomFactor(1); } catch (e) {} }
    }

    /* ---------------------------------------------------------- dispatch */
    window.__silenceShortcut = function (combo) {
      try {
        switch (combo) {
          /* tabs & windows */
          case 'ctrl+t': newTab(); break;
          case 'ctrl+n': newTab(); toast('Silence runs in a single window — opened a new tab', 'ok'); break;
          case 'ctrl+w': if (typeof handleSafeCloseTab === 'function') handleSafeCloseTab(); break;
          case 'ctrl+shift+w': ipcRenderer.send('window-close'); break;
          case 'ctrl+shift+t':
            try {
              if (typeof recentlyClosedTabs !== 'undefined' && recentlyClosedTabs.length) {
                const t = recentlyClosedTabs.pop();
                createTab(t.url, t.isSaved, null, t.title, true);
              }
            } catch (e) {}
            break;
          case 'ctrl+tab': cycleTab(1); break;
          case 'ctrl+shift+tab': cycleTab(-1); break;
          case 'ctrl+9':
            try { const last = tabs[tabs.length - 1]; if (last) switchTab(last.id); } catch (e) {}
            break;

          /* the page */
          case 'ctrl+r': case 'f5': reload(false); break;
          case 'ctrl+shift+r': case 'shift+f5': case 'ctrl+f5': reload(true); break;
          case 'ctrl+u': viewSource(); break;
          case 'ctrl+s': savePage(); break;
          case 'ctrl+o': openFile(); break;
          case 'ctrl+p': openPrint(); break;
          case 'ctrl+f': openFind(); break;
          case 'f3': case 'ctrl+g': openFind(); findInPage((document.getElementById('find-input') || {}).value, true); break;
          case 'ctrl+shift+g': openFind(); findInPage((document.getElementById('find-input') || {}).value, false); break;

          /* navigation */
          case 'alt+left': case 'backspace': goBack(); break;
          case 'alt+right': goForward(); break;
          case 'alt+home': goHome(); break;
          case 'ctrl+l': case 'alt+d': case 'f6': focusUrlBar(); break;
          case 'ctrl+e': focusQuickSearch(); break;
          case 'ctrl+k':
            try { if (typeof openCommandPalette === 'function') openCommandPalette(); } catch (e) {}
            break;

          /* browser features */
          case 'ctrl+h': openHistory(); break;
          case 'ctrl+j': openDownloads(); break;
          case 'ctrl+shift+delete': openClearData(); break;
          case 'ctrl+shift+o': openBookmarksManager(); break;
          case 'ctrl+d': toggleBookmark(); break;
          case 'ctrl+shift+b': toggleBookmarksBar(); break;
          case 'ctrl+shift+i': case 'ctrl+shift+j': case 'ctrl+shift+c': case 'f12': toggleDevTools(); break;
          case 'f11': ipcRenderer.send('window-fullscreen-toggle'); break;

          /* zoom */
          case 'ctrl+=': zoom(0.1); break;
          case 'ctrl+-': zoom(-0.1); break;
          case 'ctrl+0': resetZoom(); break;

          /* Silence extras */
          case 'ctrl+shift+s':
            try { if (typeof toggleSplitView === 'function') toggleSplitView(); } catch (e) {}
            break;
          case 'ctrl+shift+n':
            try { if (typeof toggleScratchpad === 'function') toggleScratchpad(); } catch (e) {}
            break;
          case 'ctrl+shift+u': {
            const t = currentTab();
            if (t) { try { createTab(t.webview ? t.webview.getURL() : t.url, false, null, t.title, true); } catch (e) {} }
            break;
          }
          case 'ctrl+shift+d':
            try { if (typeof toggleForceDarkMode === 'function') toggleForceDarkMode(); } catch (e) {}
            break;
          default: break;
        }
        /* Ctrl+1..8 — switch to the tab in that position */
        if (/^ctrl\+[1-8]$/.test(combo)) {
          try {
            const t = tabs[parseInt(combo.slice(5), 10) - 1];
            if (t) switchTab(t.id);
          } catch (e) {}
        }
      } catch (e) { console.warn('[pro] shortcut failed:', e && e.message); }
    };
  }

  /* =============================================== title bar quick search
   * A slim search field that floats in the empty middle of the title bar —
   * the row that carries the - [] X buttons.  Nothing is resized: the bar keeps
   * its 32px height, the buttons keep their 28x24 size, and the field only
   * occupies space that was already blank.
   */
  function buildTitleSearch() {
    const bar = document.getElementById('titlebar');
    if (!bar || document.getElementById('spro-tsearch')) return;

    const box = document.createElement('div');
    box.id = 'spro-tsearch';
    box.title = 'Search the web - Enter opens a new tab, Shift+Enter uses this tab';
    box.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2">' +
        '<circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>' +
      '<input id="spro-tsearch-input" type="text" spellcheck="false" autocomplete="off" placeholder="Search the web" />';
    bar.insertBefore(box, bar.firstChild);

    const drop = document.createElement('div');
    drop.id = 'spro-tsug';
    bar.appendChild(drop);

    const input = box.querySelector('input');
    let timer = null, ctrl = null, items = [], sel = -1;

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const close = () => { drop.classList.remove('open'); sel = -1; };

    function highlight() {
      drop.querySelectorAll('.spro-tsug-item').forEach((b, i) => b.classList.toggle('sel', i === sel));
      const el = drop.querySelector('.spro-tsug-item.sel');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function paint(list) {
      items = list; sel = -1;
      if (!list.length) { close(); return; }
      drop.innerHTML = list.map((it, i) =>
        '<button class="spro-tsug-item" data-i="' + i + '">' +
          '<span class="ico">' + (it.kind === 'tab' ? '\uD83D\uDDC2' : '\uD83D\uDD0D') + '</span>' +
          '<span class="txt">' + esc(it.text) + '</span>' +
          (it.tag ? '<span class="tag">' + esc(it.tag) + '</span>' : '') +
        '</button>').join('');
      drop.classList.add('open');
      drop.querySelectorAll('.spro-tsug-item').forEach((b) => {
        // mousedown, not click - the input must not blur first
        b.addEventListener('mousedown', (e) => { e.preventDefault(); choose(+b.dataset.i); });
      });
    }

    function choose(i) {
      const it = items[i];
      if (!it) return;
      close();
      input.blur();
      if (it.kind === 'tab') { input.value = ''; try { switchTab(it.id); } catch (e) {} return; }
      input.value = '';
      run(it.text);
    }

    /** turn what the user typed into a real URL (same rules as the address bar) */
    function toUrl(q) {
      q = (q || '').trim();
      if (/^!g\s+/i.test(q)) return 'https://www.google.com/search?q=' + encodeURIComponent(q.replace(/^!g\s+/i, ''));
      if (/^!yt\s+/i.test(q)) return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q.replace(/^!yt\s+/i, ''));
      if (/^!w\s+/i.test(q)) return 'https://en.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent(q.replace(/^!w\s+/i, ''));
      if (/^(https?:\/\/|file:\/\/\/|silence:\/\/)/i.test(q)) return q;
      if (!/\s/.test(q) && /\.[a-z]{2,}(?:[/?#]|$)/i.test(q)) return 'https://' + q;
      let engine = 'https://www.google.com/search?q=';
      try { if (typeof searchEngine !== 'undefined' && searchEngine) engine = searchEngine; } catch (e) {}
      return engine + encodeURIComponent(q);
    }

    /** Enter = fresh tab (keeps the page you are reading), Shift+Enter = this tab */
    function run(q, inThisTab) {
      q = (q || '').trim();
      if (!q) return;
      try {
        if (inThisTab) {
          if (typeof navigateActiveTab === 'function') navigateActiveTab(q);
          return;
        }
        const url = toUrl(q);
        if (typeof createTab === 'function') {
          createTab(url, false, null, null, true);
          try { if (typeof hideHomeOverlay === 'function') hideHomeOverlay(); } catch (e) {}
        } else if (typeof navigateActiveTab === 'function') {
          navigateActiveTab(url);
        }
      } catch (e) { console.warn('[pro] search failed:', e && e.message); }
    }

    async function suggest(q) {
      const list = [];
      try {
        const needle = q.toLowerCase();
        (typeof tabs !== 'undefined' ? tabs : []).forEach((t) => {
          if (list.length >= 4) return;
          const hay = ((t.title || '') + ' ' + (t.url || '')).toLowerCase();
          if (hay.indexOf(needle) !== -1) list.push({ kind: 'tab', id: t.id, text: (t.title || t.url || '').slice(0, 70), tag: 'tab' });
        });
      } catch (e) {}
      try {
        if (ctrl) ctrl.abort();
        ctrl = new AbortController();
        const res = await fetch('https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list', { signal: ctrl.signal });
        if (res && res.ok) {
          const data = await res.json();
          (data[1] || []).slice(0, 8 - list.length).forEach((sug) => list.push({ kind: 'web', text: sug }));
        }
      } catch (e) {}
      if (!input.value.trim()) return;   // user cleared the box while we waited
      paint(list);
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { close(); return; }
      timer = setTimeout(() => suggest(q), 130);
    });

    input.addEventListener('focus', () => { if (input.value.trim()) suggest(input.value.trim()); });
    input.addEventListener('blur', () => { setTimeout(close, 180); });

    input.addEventListener('keydown', (e) => {
      const openNow = drop.classList.contains('open') && items.length;
      if (e.key === 'ArrowDown' && openNow) { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); highlight(); return; }
      if (e.key === 'ArrowUp' && openNow) { e.preventDefault(); sel = Math.max(0, sel - 1); highlight(); return; }
      if (e.key === 'Escape') { input.value = ''; close(); input.blur(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        if (sel >= 0 && items[sel]) { choose(sel); return; }
        close();
        input.blur();
        run(q, e.shiftKey);
        input.value = '';
      }
    });
  }

  function positionMenu(anchor, menu) {
    const r = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 240;
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 10)) + 'px';
  }

  /* ================================================================ boot */
  async function boot() {
    try {
      ensureCss();
      addNavButtons();
      chromeShortcuts();
      windowShortcuts();
      hookExtensionUI();
      wireSecurityNotices();
      try { if (typeof window.loadExtensionsUI === 'function') window.loadExtensionsUI(); } catch (e) {}
      setTimeout(focusActiveTab, 600);
      hookTabs();
      shortcuts();
      await loadBookmarks();
      renderRail();
      window.addEventListener('resize', () => { if (vertical) positionRail(); });
      window.__silencePro = { version: '2.0', bookmarks: () => bookmarks };
      console.log('[pro] Silence Pro ready (v2.0)');
      refreshStar();
      if (localStorage.getItem('spro_seen') !== '2.0') {
        localStorage.setItem('spro_seen', '2.0');
        toast('⚙ <b>Silence Pro</b> — bookmarks, history, printing, DevTools, password saving, vertical tabs &amp; groups. Press <b>Ctrl+D</b>, <b>Ctrl+Shift+H</b>, <b>Ctrl+P</b>, <b>F12</b>.', 'ok');
      }
    } catch (e) {
      console.error('[pro] failed to start:', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
