const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'WasteHero Dev Hub',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
