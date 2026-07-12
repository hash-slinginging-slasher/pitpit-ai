// Minimal, safe bridge exposed to the renderer (contextIsolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codigo', {
  isElectron: true,
  relaunch: () => ipcRenderer.send('codigo:relaunch'),
});
