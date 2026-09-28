'use strict';
/**
 * app/preload.js — the bridge between the main process and both windows.
 *
 * `window.i18n` carries the dictionary the main process resolved at startup, so
 * the renderer never has to know which language is active. `apply()` walks the
 * document and fills anything tagged with data-i18n / data-i18n-title /
 * data-i18n-ph / data-i18n-html.
 */
const { contextBridge, ipcRenderer } = require('electron');

const { lang, dict } = ipcRenderer.sendSync('i18n-sync');

function t(key, vars) {
  let s = dict[key];
  if (s === undefined) s = key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
  }
  return s;
}

function apply(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  r.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
  r.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  r.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
}

contextBridge.exposeInMainWorld('i18n', { lang, t, apply });

contextBridge.exposeInMainWorld('term', {
  onLine: (cb) => ipcRenderer.on('term-line', (_e, evt) => cb(evt)),
  onStatus: (cb) => ipcRenderer.on('term-status', (_e, s) => cb(s)),
  onWsList: (cb) => ipcRenderer.on('term-wslist', (_e, d) => cb(d)),
  selectWs: (side, p) => ipcRenderer.send('term-selectws', { side, path: p }),
  send: (payload) => ipcRenderer.send('term-send', payload),
  clearLog: () => ipcRenderer.invoke('log-clear'),
  openSettings: () => ipcRenderer.invoke('cfg-open'),
});

contextBridge.exposeInMainWorld('cfg', {
  get: () => ipcRenderer.invoke('cfg-get'),
  save: (patch) => ipcRenderer.invoke('cfg-save', patch),
  pick: (kind) => ipcRenderer.invoke('cfg-pick', kind),
  detect: () => ipcRenderer.invoke('cfg-detect'),
  restart: () => ipcRenderer.invoke('cfg-restart'),
  close: () => ipcRenderer.send('cfg-close'),
});
