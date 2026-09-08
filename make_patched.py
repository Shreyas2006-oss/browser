import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def read_file(filename):
    filepath = os.path.join(BASE_DIR, filename)
    with open(filepath, 'r', encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')

def write_file(filename, content):
    filepath = os.path.join(BASE_DIR, filename)
    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

def apply_patch(content, search_text, replace_text, label):
    search_clean = search_text.replace('\r\n', '\n')
    count = content.count(search_clean)
    if count != 1:
        print(f"  [!] FAILED: {label} (found {count} matches, expected 1)")
        sys.exit(1)
    print(f"  [+] Patched: {label}")
    return content.replace(search_clean, replace_text, 1)

print("Patching main.js...")
m = read_file('main.js')

m = apply_patch(
    m,
    "const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');",
    "const { app, BrowserWindow, ipcMain, dialog, session, shell, protocol } = require('electron');\nconst { initExtensionStore } = require('./extension-store-backend');",
    "require protocol + store backend"
)

m = apply_patch(
    m,
    "const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'file:', 'blob:', 'data:']);",
    "const SAFE_REMOTE_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'file:', 'blob:', 'data:', 'silence:']);",
    "allow silence:// protocol"
)

m = apply_patch(
    m,
    "app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');",
    """protocol.registerSchemesAsPrivileged([
  {
    scheme: 'silence',
    privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: false }
  }
]);

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');""",
    "register silence scheme as privileged"
)

m = apply_patch(
    m,
    "function createWindow() {\n  setupAdBlocker();",
    """function registerSilencePages() {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  };
  protocol.handle('silence', (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      const rel = (url.pathname || '/').replace(/^\\/+/, '');
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
  setupAdBlocker();""",
    "register silence:// routing handler"
)

m = apply_patch(
    m,
    "  loadSavedExtensionPaths().forEach(p => registerExtension(p).catch(() => {}));",
    """  initExtensionStore({
    appDir: __dirname,
    registerExtension,
    persistPath: (dir) => {
      const saved = loadSavedExtensionPaths();
      if (!saved.includes(dir)) { saved.push(dir); saveExtensionPaths(saved); }
    },
    forgetPath: (dir) => saveExtensionPaths(loadSavedExtensionPaths().filter(p => p !== dir))
  });

  loadSavedExtensionPaths().forEach(p => registerExtension(p).catch(() => {}));""",
    "initialize store backend"
)

write_file('main.js', m)
print("-> main.js updated successfully.\n")

print("Patching index.html...")
h = read_file('index.html')

h = apply_patch(
    h,
    "const preloadScriptPath = 'file:///' + path.resolve(__dirname, 'gesture-preload.js').replace(/\\\\/g, '/');",
    "const preloadScriptPath = 'file:///' + path.resolve(__dirname, 'gesture-preload.js').replace(/\\\\/g, '/');\n    const storePreloadPath = 'file:///' + path.resolve(__dirname, 'store-preload.js').replace(/\\\\/g, '/');",
    "define storePreloadPath"
)

h = apply_patch(
    h,
    "webview.setAttribute('preload', preloadScriptPath);",
    "const isStorePage = /^silence:\\/\\//i.test(url || '') || /store\\.html(\\?|#|$)/i.test(url || '');\n      webview.setAttribute('preload', isStorePage ? storePreloadPath : preloadScriptPath);",
    "bind store preload script dynamically"
)

h = apply_patch(
    h,
    "if (query.startsWith('http://') || query.startsWith('https://') || query.startsWith('file:///')) targetUrl = query;",
    "if (query.startsWith('http://') || query.startsWith('https://') || query.startsWith('file:///') || query.startsWith('silence://')) targetUrl = query;",
    "allow omnibox silence:// navigation"
)

h = apply_patch(
    h,
    '<button class="action-btn" id="load-ext-btn">+ Load Unpacked Folder</button>',
    """<div style="display:flex; gap:8px;">
                <button class="action-btn" id="open-ext-store-btn">Open Extension Store</button>
                <button class="action-btn" id="load-ext-btn">+ Load Unpacked Folder</button>
              </div>""",
    "add store launcher button to settings"
)

h = apply_patch(
    h,
    "const extToolbar = document.getElementById('extension-toolbar-icons');",
    """const openStoreBtn = document.getElementById('open-ext-store-btn');
    if (openStoreBtn) openStoreBtn.onclick = () => createTab('silence://store', false, null, 'Extension Store', true);

    const loadUnpackedBtn = document.getElementById('load-ext-btn');
    if (loadUnpackedBtn) loadUnpackedBtn.onclick = async () => {
      const res = await ipcRenderer.invoke('load-extension-dialog');
      if (res && res.success) await loadExtensionsUI();
      else if (res && res.error) console.warn('Unpacked load failed:', res.error);
    };

    ipcRenderer.on('silence-store:changed', () => { loadExtensionsUI(); });

    const extToolbar = document.getElementById('extension-toolbar-icons');""",
    "wire store click listener and sync events"
)

write_file('index.html', h)
print("-> index.html updated successfully.\n")
print("Done! Both main.js and index.html are patched and ready.")