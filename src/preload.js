const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  newTab: () => ipcRenderer.send('tab:new'),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  activateTab: (id) => ipcRenderer.send('tab:activate', id),
  navigate: (input) => ipcRenderer.send('nav:go', input),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  stop: () => ipcRenderer.send('nav:stop'),
  toggleKeepAlive: (id) => ipcRenderer.send('keepalive:toggle', id),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),
});
