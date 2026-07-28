const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile, execFileSync } = require('node:child_process')

// Native file picker: returns the selected files' name + base64 bytes so the
// renderer can ship them to the host session. Reading happens here (main) since
// the sandboxed renderer has no filesystem access.
ipcMain.handle('pick-files', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  if (res.canceled) return []
  const out = []
  for (const p of res.filePaths) {
    try {
      const buf = fs.readFileSync(p)
      out.push({ name: path.basename(p), base64: buf.toString('base64') })
    } catch (err) {
      console.error('pick-files read failed:', p, err)
    }
  }
  return out
})

// On Windows, "Apps for websites" can route domains (e.g. slack.com) to an
// installed app instead of the browser — Slack's embedded view then rejects
// OAuth. Resolve the real default browser from the registry and launch it
// directly; fall back to the OS handler everywhere else.
function openInDefaultBrowser(url) {
  if (process.platform === 'win32') {
    try {
      const choice = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
        { encoding: 'utf8' },
      )
      const progId = choice.match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1]
      if (progId) {
        const cmd = execFileSync('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], { encoding: 'utf8' })
        const line = cmd.match(/REG_SZ\s+(.+)/)?.[1]?.trim()
        const exe = line?.match(/^"([^"]+)"/)?.[1]
        if (exe) {
          execFile(exe, [url], { windowsHide: true })
          return
        }
      }
    } catch {
      // fall through to shell.openExternal
    }
  }
  shell.openExternal(url)
}

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) openInDefaultBrowser(url)
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'WasteHero Dev Hub',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
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
