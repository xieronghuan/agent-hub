'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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
