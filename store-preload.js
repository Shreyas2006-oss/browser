/**
 * Silence Extension Store — preload bridge for the store tab.
 *
 * Silence creates webviews with contextIsolation:false / sandbox:false, so the
 * preload can expose a plain global. The contextBridge path is kept as a
 * fallback in case you ever flip contextIsolation on.
 */

const { ipcRenderer, contextBridge } = require('electron');

/** every invoke is wrapped so a missing handler rejects fast instead of hanging */
function call(channel, arg) {
  return ipcRenderer.invoke(channel, arg).catch((err) => ({
    success: false,
    error: String((err && err.message) || err),
    code: 'IPC'
  }));
}

const api = {
  /** true when running inside Silence (false = plain browser / preview) */
  real: true,

  install: (id) => call('silence-store:install', { id }),
  installUrl: (url) => call('silence-store:install-url', { url }),
  uninstall: (id) => call('silence-store:uninstall', { id }),
  update: (id) => call('silence-store:update', { id }),
  updateAll: () => call('silence-store:update-all'),
  updateStatus: () => call('silence-store:update-status'),
  setEnabled: (id, enabled) => call('silence-store:set-enabled', { id, enabled }),
  browseUnpacked: () => call('silence-store:browse-unpacked'),
  selftest: () => call('silence-store:selftest'),
  catalog: () => ipcRenderer.invoke('silence-store:catalog').catch(() => null),

  listInstalled: async () => {
    const r = await call('silence-store:list');
    return (r && r.extensions) || [];
  },

  openFolder: (id) => ipcRenderer.send('silence-store:open-folder', { id }),
  openUrl: (url) => ipcRenderer.send('silence-store:open-url', { url }),

  onProgress: (cb) => ipcRenderer.on('silence-store:progress', (_e, data) => cb(data)),
  onChanged: (cb) => ipcRenderer.on('silence-store:changed', (_e, data) => cb(data || {}))
};

try {
  if (contextBridge && process.contextIsolated) {
    contextBridge.exposeInMainWorld('SilenceStore', api);
  } else {
    window.SilenceStore = api;
  }
} catch {
  window.SilenceStore = api;
}
