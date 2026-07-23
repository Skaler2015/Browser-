// Runs in every tab (session preload), but the main process only answers
// these calls for frames actually loaded from src/ui/pages/ (validated there).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tez', {
  list: (kind) => ipcRenderer.invoke('tez:list', kind),
  action: (kind, action, payload) => ipcRenderer.invoke('tez:action', { kind, action, payload }),
});
