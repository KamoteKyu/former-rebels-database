const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:      ()  => ipcRenderer.send('win-minimize'),
  maximize:      ()  => ipcRenderer.send('win-maximize'),
  close:         ()  => ipcRenderer.send('win-close'),
  isMaximized:   ()  => ipcRenderer.invoke('win-is-maximized'),
  onMaximized:   (cb) => ipcRenderer.on('window-maximized', (_e, val) => cb(val))
});
