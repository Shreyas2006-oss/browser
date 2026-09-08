const { ipcRenderer } = require('electron');

try {
  // configurable:true — otherwise this locks the property and the main-world
  // shim below can no longer redefine it
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });

  if (!window.chrome) window.chrome = {};
  window.chrome.app = {
    isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
  };
} catch (e) {}

/* -------------------------------------------------------------------------
 * Everything above runs in this *isolated* preload world, so the page never
 * sees any of it — Google still reads the real navigator and answers
 * "Couldn't sign you in / this browser or app may not be secure".
 *
 * A <script> pushed through the shared DOM runs in the page's own main world,
 * which is where those checks actually live.
 * ---------------------------------------------------------------------- */
function mainWorldChromeShim() {
  try {
    var BRANDS = [
      { brand: 'Not;A=Brand', version: '24' },
      { brand: 'Chromium', version: '128' },
      { brand: 'Google Chrome', version: '128' }
    ];
    var HIGH = {
      architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0',
      uaFullVersion: '128.0.0.0', fullVersionList: BRANDS, wow64: false
    };
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
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          id: undefined,
          connect: function () { return { onDisconnect: { addListener: function () {} }, onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; },
          sendMessage: function () {},
          onMessage: { addListener: function () {} },
          onConnect: { addListener: function () {} }
        };
      }
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        };
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = function () {
          var t = Date.now() / 1000;
          return { requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t, finishLoadTime: t,
                   firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other',
                   wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2',
                   wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
        };
      }
      if (!window.chrome.csi) {
        window.chrome.csi = function () {
          return { startE: Date.now(), onloadT: Date.now(), pageT: (performance && performance.now ? performance.now() : 0), tran: 15 };
        };
      }
    } catch (e) {}
  } catch (e) {}
}

try {
  var __injectShim = function () {
    var el = document.head || document.documentElement;
    if (!el) { setTimeout(__injectShim, 0); return; }
    var script = document.createElement('script');
    script.textContent = '(' + mainWorldChromeShim.toString() + ')();';
    el.appendChild(script);
    if (script.parentNode) script.parentNode.removeChild(script);
  };
  if (document.readyState === 'loading' || !document.documentElement) setTimeout(__injectShim, 0);
  else __injectShim();
} catch (e) {}

/* -------------------------------------------------------------------------
 * Chrome keyboard shortcuts.
 *
 * A key pressed inside a page never reaches the browser window, so the combo
 * is recognised here and handed to the host — the host owns every bit of
 * browser UI (tabs, find, history, downloads...).  Anything not on the list is
 * left alone so pages keep their own key handling.
 * ---------------------------------------------------------------------- */
(function chromeShortcuts() {
  if (typeof ipcRenderer === 'undefined' || !ipcRenderer.sendToHost) return;

  var NAMED = {
    ' ': 'space', escape: 'esc', arrowleft: 'left', arrowright: 'right',
    arrowup: 'up', arrowdown: 'down', delete: 'del', add: '=', subtract: '-'
  };

  var COMBOS = [
    /* tabs & windows */
    'ctrl+t', 'ctrl+n', 'ctrl+w', 'ctrl+shift+w', 'ctrl+shift+t',
    'ctrl+tab', 'ctrl+shift+tab',
    'ctrl+1', 'ctrl+2', 'ctrl+3', 'ctrl+4', 'ctrl+5',
    'ctrl+6', 'ctrl+7', 'ctrl+8', 'ctrl+9',
    /* the page */
    'ctrl+r', 'ctrl+shift+r', 'f5', 'shift+f5', 'ctrl+f5',
    'ctrl+u', 'ctrl+s', 'ctrl+o', 'ctrl+p',
    'ctrl+f', 'f3', 'ctrl+g', 'ctrl+shift+g',
    /* navigation */
    'alt+left', 'alt+right', 'backspace', 'alt+home',
    'ctrl+l', 'alt+d', 'f6', 'ctrl+e', 'ctrl+k',
    /* browser features */
    'ctrl+h', 'ctrl+j', 'ctrl+shift+delete', 'ctrl+shift+o',
    'ctrl+d', 'ctrl+shift+b',
    'ctrl+shift+i', 'ctrl+shift+j', 'ctrl+shift+c', 'f12', 'f11',
    'ctrl+=', 'ctrl+-', 'ctrl+0',
    /* Silence extras, so they also work while a page has focus */
    'ctrl+shift+s', 'ctrl+shift+n', 'ctrl+shift+u', 'ctrl+shift+d'
  ];
  var OWNED = {};
  for (var i = 0; i < COMBOS.length; i++) OWNED[COMBOS[i]] = true;

  /* backspace / alt+arrows only behave as navigation when you are not typing */
  var NEEDS_NOT_TYPING = { 'backspace': true, 'alt+left': true, 'alt+right': true };

  function isTyping(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'input' || t === 'textarea' || t === 'select') return true;
    try { if (el.isContentEditable) return true; } catch (e) {}
    return false;
  }

  window.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    var k = String(e.key || '').toLowerCase();
    if (NAMED[k]) k = NAMED[k];
    var combo = '';
    if (e.ctrlKey || e.metaKey) combo += 'ctrl+';
    if (e.altKey) combo += 'alt+';
    if (e.shiftKey) combo += 'shift+';
    combo += k;
    if (!OWNED[combo]) return;
    if (NEEDS_NOT_TYPING[combo] && isTyping(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('chrome-shortcut', combo);
  }, true);
})();

const DIRECTION_ARROWS = {
  'L': '←',
  'R': '→',
  'U': '↑',
  'D': '↓'
};

const DEFAULT_GESTURES = {
  'L': { name: 'Back', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>', action: 'back' },
  'R': { name: 'Forward', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>', action: 'forward' },
  'U': { name: 'Scroll to Top', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>', action: 'scroll-top' },
  'D': { name: 'Scroll to Bottom', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>', action: 'scroll-bottom' },
  'DR': { name: 'Close Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>', action: 'close-tab' },
  'UD': { name: 'Reload Page', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>', action: 'reload' },
  'LR': { name: 'New Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>', action: 'new-tab' },
  'RL': { name: 'Reopen Closed Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 4v6h6M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>', action: 'restore-tab' },
  'UR': { name: 'Next Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>', action: 'next-tab' },
  'LU': { name: 'Previous Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>', action: 'prev-tab' },
  'DL': { name: 'Duplicate Tab', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>', action: 'duplicate-tab' },
  'RD': { name: 'Toggle Split Screen', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>', action: 'toggle-split' },
  'UL': { name: 'Dashboard Home', icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>', action: 'go-home' }
};

let activeGestures = { ...DEFAULT_GESTURES };

ipcRenderer.on('sync-custom-gestures', (e, customMap) => {
  if (customMap && typeof customMap === 'object') {
    Object.keys(customMap).forEach(key => {
      if (activeGestures[key]) {
        activeGestures[key].action = customMap[key];
      }
    });
  }
});

document.addEventListener('mouseover', (e) => {
  const anchor = e.target.closest('a[href]');
  if (anchor && anchor.href && !anchor.href.startsWith('javascript:')) {
    ipcRenderer.sendToHost('link-hover-status', anchor.href);
  }
}, true);

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('a[href]')) {
    ipcRenderer.sendToHost('link-hover-status', null);
  }
}, true);

ipcRenderer.on('toggle-pip', () => {
  const video = document.querySelector('video');
  if (!video) return;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if (typeof video.requestPictureInPicture === 'function') {
    video.requestPictureInPicture().catch(() => {});
  }
});

ipcRenderer.on('set-media-speed', (e, speed) => {
  const media = document.querySelectorAll('video, audio');
  media.forEach(m => { m.playbackRate = speed; });
});

ipcRenderer.on('extract-reader-article', () => {
  try {
    const title = (document.querySelector('article h1') || document.querySelector('h1') || document.title || 'Untitled Article').innerText || document.title;
    let candidate = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]');
    
    if (!candidate) {
      let maxScore = 0;
      const divs = Array.from(document.querySelectorAll('div, section'));
      divs.forEach(d => {
        const textLength = d.innerText ? d.innerText.length : 0;
        const paragraphs = d.querySelectorAll('p').length;
        const score = textLength + (paragraphs * 120);
        if (score > maxScore) {
          maxScore = score;
          candidate = d;
        }
      });
    }

    if (!candidate) candidate = document.body;

    const clone = candidate.cloneNode(true);
    const unwanted = clone.querySelectorAll('script, style, nav, aside, footer, header, form, iframe, button, .ad, .advertisement, [role="complementary"]');
    unwanted.forEach(u => u.remove());

    const wordCount = clone.innerText ? clone.innerText.split(/\s+/).length : 0;
    const readingTimeMin = Math.max(1, Math.round(wordCount / 200));

    ipcRenderer.sendToHost('reader-article-data', {
      title,
      contentHtml: clone.innerHTML,
      wordCount,
      readingTimeMin,
      url: window.location.href
    });
  } catch (err) {
    ipcRenderer.sendToHost('reader-article-data', null);
  }
});

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    ipcRenderer.sendToHost('page-zoom-change', delta);
  }
}, { passive: false });

const GESTURE_ACTIVATION_DIST = 10;
const VECTOR_SAMPLE_STEP = 22;
const MAX_DIRECTIONS = 4;

let isRmbDown = false;
let isLmbDown = false;
let gestureActive = false;
let suppressContext = false;
let gestureCancelled = false;

let startPoint = null;
let anchorPoint = null;
let strokePoints = [];
let directions = [];
let lastDirection = null;

let gestureCanvas = null;
let gestureCtx = null;
let gestureHud = null;
let rafId = null;

function setupGestureUI() {
  if (!gestureCanvas) {
    gestureCanvas = document.createElement('canvas');
    gestureCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;display:none;';
    document.documentElement.appendChild(gestureCanvas);
    gestureCtx = gestureCanvas.getContext('2d');
  }

  if (!gestureHud) {
    gestureHud = document.createElement('div');
    gestureHud.style.cssText = `
      position: fixed;
      display: none;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: rgba(22, 22, 22, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 20px;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.75), 0 0 24px rgba(99, 102, 241, 0.25);
      backdrop-filter: blur(24px);
      pointer-events: none;
      z-index: 2147483647;
      transition: border-color 0.15s, box-shadow 0.15s;
      will-change: left, top;
    `;
    document.documentElement.appendChild(gestureHud);
  }
}

function syncCanvasSize() {
  if (!gestureCanvas || !gestureCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  gestureCanvas.width = Math.floor(w * dpr);
  gestureCanvas.height = Math.floor(h * dpr);
  gestureCanvas.style.width = `${w}px`;
  gestureCanvas.style.height = `${h}px`;
  gestureCtx.setTransform(1, 0, 0, 1, 0, 0);
  gestureCtx.scale(dpr, dpr);
}

function resetGestureState() {
  isRmbDown = false;
  gestureActive = false;
  gestureCancelled = false;
  strokePoints = [];
  directions = [];
  lastDirection = null;
  startPoint = null;
  anchorPoint = null;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (gestureCanvas && gestureCtx) {
    gestureCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    gestureCanvas.style.display = 'none';
  }
  if (gestureHud) {
    gestureHud.style.display = 'none';
  }
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    isLmbDown = true;
    if (isRmbDown) {
      suppressContext = true;
      resetGestureState();
      cancelOverscroll();
      dispatchGesture('back');
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  } else if (e.button === 2) {
    if (isLmbDown) {
      suppressContext = true;
      cancelOverscroll();
      dispatchGesture('forward');
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    isRmbDown = true;
    gestureActive = false;
    gestureCancelled = false;
    startPoint = { x: e.clientX, y: e.clientY };
    anchorPoint = { x: e.clientX, y: e.clientY };
    strokePoints = [{ x: e.clientX, y: e.clientY }];
    directions = [];
    lastDirection = null;
  }
}, true);

window.addEventListener('wheel', (e) => {
  if (isRmbDown) {
    suppressContext = true;
    resetGestureState();
    cancelOverscroll();
    if (e.deltaY > 0) {
      dispatchGesture('next-tab');
    } else if (e.deltaY < 0) {
      dispatchGesture('prev-tab');
    }
    e.preventDefault();
    e.stopPropagation();
  }
}, { passive: false });

window.addEventListener('mousemove', (e) => {
  if (!isRmbDown || gestureCancelled) return;

  const curX = e.clientX;
  const curY = e.clientY;

  if (!gestureActive) {
    const initialDist = Math.hypot(curX - startPoint.x, curY - startPoint.y);
    if (initialDist >= GESTURE_ACTIVATION_DIST) {
      gestureActive = true;
      suppressContext = true;
      setupGestureUI();
      syncCanvasSize();
      gestureCanvas.style.display = 'block';
      gestureHud.style.display = 'flex';
      strokePoints.push({ x: curX, y: curY });
      anchorPoint = { x: curX, y: curY };
    }
    return;
  }

  strokePoints.push({ x: curX, y: curY });
  // keep the trail bounded — an ever-growing path made long gestures crawl
  if (strokePoints.length > 160) strokePoints.shift();
  const distFromAnchor = Math.hypot(curX - anchorPoint.x, curY - anchorPoint.y);

  if (distFromAnchor >= VECTOR_SAMPLE_STEP) {
    const dx = curX - anchorPoint.x;
    const dy = curY - anchorPoint.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    let dir = '';

    if (angle >= -45 && angle <= 45) dir = 'R';
    else if (angle > 45 && angle < 135) dir = 'D';
    else if (angle < -45 && angle > -135) dir = 'U';
    else dir = 'L';

    if (dir && dir !== lastDirection) {
      lastDirection = dir;
      directions.push(dir);
      if (directions.length > MAX_DIRECTIONS) directions.shift();
    }
    anchorPoint = { x: curX, y: curY };
  }

  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!gestureCtx || strokePoints.length < 2 || !gestureActive) return;

      const w = window.innerWidth;
      const h = window.innerHeight;
      gestureCtx.clearRect(0, 0, w, h);

      gestureCtx.save();
      gestureCtx.beginPath();
      gestureCtx.lineWidth = 4.5;
      gestureCtx.lineCap = 'round';
      gestureCtx.lineJoin = 'round';

      const grad = gestureCtx.createLinearGradient(
        strokePoints[0].x, strokePoints[0].y,
        curX, curY
      );
      grad.addColorStop(0, 'rgba(129, 140, 248, 0.3)');
      grad.addColorStop(1, '#6366f1');

      gestureCtx.strokeStyle = grad;
      gestureCtx.shadowColor = 'rgba(99, 102, 241, 0.75)';
      gestureCtx.shadowBlur = 12;

      gestureCtx.moveTo(strokePoints[0].x, strokePoints[0].y);
      for (let i = 1; i < strokePoints.length - 1; i++) {
        const xc = (strokePoints[i].x + strokePoints[i + 1].x) / 2;
        const yc = (strokePoints[i].y + strokePoints[i + 1].y) / 2;
        gestureCtx.quadraticCurveTo(strokePoints[i].x, strokePoints[i].y, xc, yc);
      }
      gestureCtx.lineTo(curX, curY);
      gestureCtx.stroke();

      gestureCtx.beginPath();
      gestureCtx.arc(curX, curY, 5, 0, Math.PI * 2);
      gestureCtx.fillStyle = '#ffffff';
      gestureCtx.shadowColor = '#6366f1';
      gestureCtx.shadowBlur = 14;
      gestureCtx.fill();
      gestureCtx.restore();

      if (gestureHud) {
        const posX = Math.min(w - 240, curX + 18);
        const posY = Math.min(h - 60, curY + 18);
        gestureHud.style.left = `${posX}px`;
        gestureHud.style.top = `${posY}px`;

        const key = directions.join('');
        const match = activeGestures[key] || (directions.length === 1 ? activeGestures[lastDirection] : null);
        const directionBreadcrumbs = directions.map(d => DIRECTION_ARROWS[d] || d).join(' ');

        if (match && match.action !== 'disabled') {
          gestureHud.innerHTML = `
            <span style="color:#a5b4fc; display:flex; align-items:center;">${match.icon || '⚡'}</span>
            <span style="color:#ffffff; font-weight:600;">${match.name}</span>
            <span style="color:#818cf8; font-size:11px; background:rgba(99,102,241,0.22); padding:2px 6px; border-radius:4px; margin-left:4px;">${directionBreadcrumbs}</span>
          `;
          gestureHud.style.borderColor = 'rgba(99, 102, 241, 0.75)';
          gestureHud.style.boxShadow = '0 16px 40px rgba(0,0,0,0.85), 0 0 20px rgba(99, 102, 241, 0.4)';
        } else if (directions.length > 0) {
          gestureHud.innerHTML = `
            <span style="color:#e2e8f0;">Gesture</span>
            <span style="color:#a5b4fc; font-weight:600; margin-left:2px;">${directionBreadcrumbs}</span>
            <span style="color:#64748b; font-size:11px; margin-left:4px;">(No Action)</span>
          `;
          gestureHud.style.borderColor = 'rgba(255, 255, 255, 0.16)';
          gestureHud.style.boxShadow = '0 16px 36px rgba(0,0,0,0.75)';
        } else {
          gestureHud.innerHTML = `<span style="color:#94a3b8;">Draw gesture...</span>`;
          gestureHud.style.borderColor = 'rgba(255, 255, 255, 0.16)';
          gestureHud.style.boxShadow = '0 14px 36px rgba(0,0,0,0.75)';
        }
      }
    });
  }
}, true);

window.addEventListener('mouseup', (e) => {
  if (e.button === 0) isLmbDown = false;

  if (e.button === 2 && isRmbDown) {
    if (gestureActive && !gestureCancelled) {
      const key = directions.join('');
      const match = activeGestures[key] || (directions.length === 1 ? activeGestures[lastDirection] : null);

      if (match && match.action !== 'disabled') {
        dispatchGesture(match.action);
      }
    }
    resetGestureState();
  }
}, true);

window.addEventListener('contextmenu', (e) => {
  if (suppressContext) {
    e.preventDefault();
    e.stopPropagation();
    suppressContext = false;
  }
}, true);

window.addEventListener('mouseleave', () => {
  if (isRmbDown) resetGestureState();
  cancelOverscroll();
});

window.addEventListener('blur', () => {
  resetGestureState();
  cancelOverscroll();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (gestureActive) {
      gestureCancelled = true;
      resetGestureState();
      suppressContext = true;
    }
    cancelOverscroll();
  }
});

function dispatchGesture(action) {
  switch (action) {
    case 'back':
      ipcRenderer.sendToHost('execute-gesture', 'back');
      break;
    case 'forward':
      ipcRenderer.sendToHost('execute-gesture', 'forward');
      break;
    case 'close-tab':
      ipcRenderer.sendToHost('shortcut-close-tab');
      break;
    case 'reload':
      window.location.reload();
      break;
    case 'new-tab':
      ipcRenderer.sendToHost('execute-gesture', 'new-tab');
      break;
    case 'restore-tab':
      ipcRenderer.sendToHost('execute-gesture', 'restore-tab');
      break;
    case 'next-tab':
      ipcRenderer.sendToHost('execute-gesture', 'next-tab');
      break;
    case 'prev-tab':
      ipcRenderer.sendToHost('execute-gesture', 'prev-tab');
      break;
    case 'duplicate-tab':
      ipcRenderer.sendToHost('execute-gesture', 'duplicate-tab');
      break;
    case 'toggle-split':
      ipcRenderer.sendToHost('execute-gesture', 'toggle-split');
      break;
    case 'go-home':
      ipcRenderer.sendToHost('execute-gesture', 'go-home');
      break;
    case 'reader-mode':
      ipcRenderer.sendToHost('execute-gesture', 'reader-mode');
      break;
    case 'dark-mode':
      ipcRenderer.sendToHost('execute-gesture', 'dark-mode');
      break;
    case 'toggle-pip':
      ipcRenderer.sendToHost('execute-gesture', 'toggle-pip');
      break;
    case 'scroll-top':
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'scroll-bottom':
      window.scrollTo({ top: document.body ? document.body.scrollHeight : 999999, behavior: 'smooth' });
      break;
  }
}

const DEADZONE_PX = 12;            // smaller deadzone = the bubble reacts sooner
const COMMIT_DELTA = 150;          // travel needed to actually navigate
const DIRECTION_LOCK_RATIO = 1.6;  // axis dominance before a swipe is cancelled
const VERTICAL_LOCKOUT_MS = 170;   // was 280 — that made real swipes feel ignored
const SWIPE_END_MS = 110;          // quiet period that ends the gesture
const COMMIT_COOLDOWN_MS = 420;    // stops momentum from firing a second navigation
const PROGRESS_EPS = 0.004;        // don't send IPC for invisible changes

let lastVerticalScrollTime = 0;
let swipeDirection = null;
let accumulatedDeltaX = 0;
let wheelEndTimer = null;
let isSwipeActive = false;
let trackpadNavConfig = 'high';

/* per-frame coalescing state */
let pendingDeltaX = 0;
let pendingDeltaY = 0;
let wheelRafId = null;
let lastWheelTarget = null;
let lastCommitAt = 0;
let lastSentProgress = -1;
let lastSentReady = false;
let navCache = { el: null, dir: 0, value: false, ts: 0 };

ipcRenderer.on('set-trackpad-nav-config', (e, mode) => {
  trackpadNavConfig = mode || 'high';
});

const targetThreshold = () => (trackpadNavConfig === 'low' ? 110 : COMMIT_DELTA);

function isInsideHorizontallyScrollableArea(target, deltaX) {
  if (!target || !(target instanceof Element)) return false;

  if (
    window.location.pathname.toLowerCase().endsWith('.pdf') ||
    document.contentType === 'application/pdf' ||
    document.querySelector('embed[type="application/pdf"], pdf-viewer, #viewerContainer') ||
    target.closest('embed, object, iframe, #viewerContainer, .pdf-viewer, [data-pdf-viewer]')
  ) {
    return true;
  }

  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  if (
    target.isContentEditable ||
    tag === 'textarea' ||
    target.closest('.monaco-editor, .cm-editor, .handsontable')
  ) {
    return true;
  }

  // cheap geometry test first — only pay for getComputedStyle when it can matter
  let el = target;
  while (el && el !== document.documentElement && el !== document.body) {
    if (el.scrollWidth - el.clientWidth > 4) {
      const ox = window.getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        const scrollLeft = el.scrollLeft;
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (deltaX < 0 && scrollLeft > 2) return true;
        if (deltaX > 0 && scrollLeft < maxScroll - 2) return true;
      }
    }
    el = el.parentElement;
  }

  const maxPageScroll = Math.max(
    0,
    (document.documentElement ? document.documentElement.scrollWidth : 0) - window.innerWidth,
    (document.body ? document.body.scrollWidth : 0) - window.innerWidth
  );
  if (deltaX < 0 && window.scrollX > 2) return true;
  if (deltaX > 0 && window.scrollX < maxPageScroll - 2) return true;

  return false;
}

/* the ancestor walk above used to run on every wheel event — cache it for the
   length of a gesture instead (the target element does not change mid-swipe) */
function navBlocked(target, deltaX) {
  const now = performance.now();
  const dir = deltaX < 0 ? -1 : 1;
  if (navCache.el === target && navCache.dir === dir && (now - navCache.ts) < 140) {
    return navCache.value;
  }
  const value = isInsideHorizontallyScrollableArea(target, deltaX);
  navCache = { el: target, dir, value, ts: now };
  return value;
}

function sendSwipeProgress(force) {
  const effective = Math.max(0, accumulatedDeltaX - DEADZONE_PX);
  const progress = Math.min(effective / targetThreshold(), 1);
  const isReady = effective >= targetThreshold();
  if (!force && Math.abs(progress - lastSentProgress) < PROGRESS_EPS && isReady === lastSentReady) return;
  lastSentProgress = progress;
  lastSentReady = isReady;
  ipcRenderer.sendToHost('edge-swipe-progress', {
    direction: swipeDirection,
    progress: progress,
    isReady: isReady
  });
}

function endSwipe() {
  if (isSwipeActive) {
    const effective = accumulatedDeltaX - DEADZONE_PX;
    const now = performance.now();
    if (effective >= targetThreshold() && swipeDirection && (now - lastCommitAt) > COMMIT_COOLDOWN_MS) {
      lastCommitAt = now;
      ipcRenderer.sendToHost('edge-swipe-commit', swipeDirection);
    } else {
      ipcRenderer.sendToHost('edge-swipe-cancel');
    }
  }
  isSwipeActive = false;
  accumulatedDeltaX = 0;
  swipeDirection = null;
  lastSentProgress = -1;
  lastSentReady = false;
  pendingDeltaX = 0;
  pendingDeltaY = 0;
}

function cancelOverscroll() {
  if (isSwipeActive || accumulatedDeltaX > 0) {
    ipcRenderer.sendToHost('edge-swipe-cancel');
  }
  isSwipeActive = false;
  accumulatedDeltaX = 0;
  swipeDirection = null;
  lastSentProgress = -1;
  lastSentReady = false;
  pendingDeltaX = 0;
  pendingDeltaY = 0;
  clearTimeout(wheelEndTimer);
}

/* one pass per animation frame instead of one per wheel event */
function processWheelFrame() {
  wheelRafId = null;
  const dx = pendingDeltaX;
  const dy = pendingDeltaY;
  pendingDeltaX = 0;
  pendingDeltaY = 0;

  if (trackpadNavConfig === 'disabled') return;

  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const now = performance.now();

  if (!isSwipeActive) {
    if (absX < 1.5) {
      if (absY > 6) lastVerticalScrollTime = now;
      return;
    }
    // a genuinely vertical scroll resets the lockout; a diagonal swipe should not
    if (absY > absX * 1.1) { lastVerticalScrollTime = now; return; }
    if (now - lastVerticalScrollTime < VERTICAL_LOCKOUT_MS) return;
  } else if (absY > Math.max(10, absX * DIRECTION_LOCK_RATIO)) {
    cancelOverscroll();
    lastVerticalScrollTime = now;
    return;
  }

  const currentDir = dx < 0 ? 'back' : 'forward';

  if (!swipeDirection) {
    swipeDirection = currentDir;
    accumulatedDeltaX = 0;
    lastSentProgress = -1;
  } else if (swipeDirection !== currentDir) {
    // reversing bleeds the travel back down instead of snapping to a cancel
    accumulatedDeltaX -= absX * 1.7;
    if (accumulatedDeltaX <= DEADZONE_PX) {
      accumulatedDeltaX = 0;
      swipeDirection = currentDir;
      lastSentProgress = -1;
    } else {
      sendSwipeProgress(false);
      clearTimeout(wheelEndTimer);
      wheelEndTimer = setTimeout(endSwipe, SWIPE_END_MS);
      return;
    }
  }

  if (!isSwipeActive) {
    if (navBlocked(lastWheelTarget, dx)) { swipeDirection = null; return; }
    isSwipeActive = true;
  }

  const resistance = Math.max(0.42, 1 - (accumulatedDeltaX / (targetThreshold() * 1.35)));
  accumulatedDeltaX += absX * resistance;

  if (accumulatedDeltaX < DEADZONE_PX) return;

  sendSwipeProgress(false);

  clearTimeout(wheelEndTimer);
  wheelEndTimer = setTimeout(endSwipe, SWIPE_END_MS);
}

window.addEventListener('wheel', (e) => {
  if (trackpadNavConfig === 'disabled' || isRmbDown) return;
  lastWheelTarget = e.target;
  pendingDeltaX += e.deltaX;
  pendingDeltaY += e.deltaY;
  if (!wheelRafId) wheelRafId = requestAnimationFrame(processWheelFrame);
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('shortcut-close-tab');
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'l')) {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('shortcut-open-palette');
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('shortcut-find-in-page');
  }
}, true);

window.addEventListener('mousedown', () => ipcRenderer.sendToHost('pane-focused'), true);
window.addEventListener('focus', () => ipcRenderer.sendToHost('pane-focused'), true);

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
    const isFormInput = e.target.closest('input[type="file"], textarea, [contenteditable="true"], [data-dropzone]');
    if (!isFormInput) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }
}, true);

window.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const isFormInput = e.target.closest('input[type="file"], textarea, [contenteditable="true"], [data-dropzone]');
    if (!isFormInput) {
      e.preventDefault();
      e.stopPropagation();
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if (file && file.path) {
          ipcRenderer.sendToHost('open-dropped-file', { path: file.path, name: file.name });
        }
      }
    }
  }
}, true);

/* ---------- password capture ----------
   Watches for a submitted login form and forwards the credentials to the
   browser UI, which offers to save them. This runs in the isolated preload
   world, but DOM events such as "submit" are shared with the page. */
document.addEventListener('submit', (e) => {
  try {
    const form = e.target;
    if (!form || !form.querySelector) return;
    const pwd = form.querySelector('input[type="password"]');
    if (!pwd || !pwd.value) return;
    const user = form.querySelector(
      'input[type="email"], input[type="tel"], input[type="text"], ' +
      'input[name*="user" i], input[name*="email" i], input[name*="login" i]'
    );
    ipcRenderer.sendToHost('silence-login', {
      username: user ? user.value : '',
      password: pwd.value
    });
  } catch (err) {}
}, true);

if (window.location.hostname.includes('chromewebstore.google.com')) {
  const style = document.createElement('style');
  style.textContent = `
    div[role="alert"] { display: none !important; }
    button[aria-disabled="true"] { opacity: 1 !important; pointer-events: auto !important; }
  `;
  document.documentElement.appendChild(style);

  const patchStoreBtn = () => {
    document.querySelectorAll('div[role="alert"]').forEach(el => el.remove());
    const match = window.location.pathname.match(/\/detail\/[^\/]+\/([a-z]{32})/);
    if (!match) return;

    const buttons = Array.from(document.querySelectorAll('button'));
    const storeBtn = buttons.find(b => {
      const txt = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
      return (txt.includes('add to') || txt.includes('unavailable') || b.classList.contains('silence-cws-btn')) && !b.classList.contains('silence-patched');
    });

    if (storeBtn) {
      storeBtn.classList.add('silence-patched', 'silence-cws-btn');
      storeBtn.removeAttribute('disabled');
      storeBtn.setAttribute('aria-disabled', 'false');
      const label = storeBtn.querySelector('span') || storeBtn;
      label.textContent = 'Add to Silence';
      storeBtn.style.backgroundColor = '#6366f1';
      storeBtn.style.color = '#ffffff';

      storeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        label.textContent = 'Installing...';
        storeBtn.style.pointerEvents = 'none';
        ipcRenderer.sendToHost('cws-install-request', match[1]);
      };
    }
  };

  const observer = new MutationObserver(patchStoreBtn);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}