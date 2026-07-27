const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('wh', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
  // Returns base64 PNG of a clipboard image, or '' if the clipboard holds no
  // image. Used to ferry a pasted screenshot to the session on the host.
  readClipboardImage: () => {
    const img = clipboard.readImage()
    if (!img || img.isEmpty()) return ''
    return img.toPNG().toString('base64')
  },
})
