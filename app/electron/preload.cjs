const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('wh', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
})
