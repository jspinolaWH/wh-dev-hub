// Installs the WasteHero Dev Hub daemon as a Windows service (node-windows /
// winsw). A service runs with no interactive console, so it cannot be
// Ctrl-C'd by whoever is using the shared PC, survives logoff/reboot, and
// auto-restarts on crash: the fix for the daemon dying over the weekend.
//
// This installs the service as LocalSystem. install-service.ps1 then switches
// it to run as the actual user account via sc.exe, because child `claude`
// processes must find the CLI and the user's login profile (both per-user).
// We do the credential step in sc.exe, not here, so the password is never
// echoed or written to disk.
//
// Invoked by install-service.ps1, which sets WH_HUB_DATA.
const path = require('node:path')
const { Service } = require('node-windows')

const repoRoot = path.resolve(__dirname, '..', '..')
const script = path.join(repoRoot, 'daemon', 'dist', 'index.cjs')
const dataDir = process.env.WH_HUB_DATA
if (!dataDir) {
  console.error('WH_HUB_DATA must be set (the daemon data dir, e.g. C:\\Users\\jacks\\.wh-dev-hub)')
  process.exit(1)
}

const svc = new Service({
  name: 'WasteHero Dev Hub',
  description: 'Persistent Claude Code session host for the WasteHero team.',
  script,
  env: [{ name: 'WH_HUB_DATA', value: dataDir }],
  // Auto-restart on crash: wait 2s, back off gently, keep trying.
  wait: 2,
  grow: 0.5,
  maxRestarts: 40,
  // Stop ordering must be explicit: stop the PARENT (daemon) first so it runs
  // its graceful shutdown (kills its own pty children, exits) — rather than
  // winsw walking the live tree and Process.Kill()-racing a child, which
  // crashed winsw and orphaned the daemon. A finite timeout lets the daemon
  // exit cleanly before any force-kill. (Also avoids node-windows emitting a
  // bogus `--stopparentfirst undefined` arg by setting the value explicitly.)
  stopparentfirst: true,
  stoptimeout: 15,
})

// NOTE: we deliberately do NOT set svc.logOnAs here. node-windows' logon path
// is buggy (double-domains "DOMAIN\user", writes the password in plaintext
// into the winsw XML, and echoes it to the console) and does not grant the
// service-logon right. Instead install-service.ps1 installs the service as
// LocalSystem via this script, then sets the run-as account + password with
// sc.exe (which never prints the password and stores it only in the SCM).

svc.on('install', () => {
  console.log('service installed; starting...')
  svc.start()
})
svc.on('alreadyinstalled', () => {
  console.log('service already installed; (re)starting...')
  svc.start()
})
svc.on('start', () => console.log('WasteHero Dev Hub service is running.'))
svc.on('error', (err) => console.error('service error:', err))

svc.install()
