const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getMetadata: () => ipcRenderer.invoke('get-metadata'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  addImage: (path) => ipcRenderer.invoke('add-image', path),
  removeMedia: (id) => ipcRenderer.invoke('remove-media', id),
  setWallpaper: () => ipcRenderer.invoke('set-wallpaper'),
  getImages: () => ipcRenderer.invoke('get-images'),
  getTimerStatus: () => ipcRenderer.invoke('get-timer-status'),
  toggleTimer: (enable) => ipcRenderer.invoke('toggle-timer', enable),
  updateTimer: (hours, minutes, mode, baseMs) => ipcRenderer.invoke('update-timer', hours, minutes, mode, baseMs),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  close: () => ipcRenderer.send('win-close'),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
});
