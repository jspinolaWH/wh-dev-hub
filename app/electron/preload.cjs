const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wh', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
})
