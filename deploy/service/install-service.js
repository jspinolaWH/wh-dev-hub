// Installs the WasteHero Dev Hub daemon as a Windows service (node-windows /
// winsw). A service runs with no interactive console, so it cannot be
// Ctrl-C'd by whoever is using the shared PC, survives logoff/reboot, and
// auto-restarts on crash — the fix for the daemon dying over the weekend.
//
// Runs as the account whose credentials are passed in (must be the user that
// owns the Claude CLI install + login profile), NOT LocalSystem — otherwise
// child `claude` processes cannot find the CLI or the user's config.
//
// Invoked by install-service.ps1, which supplies env vars.
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
})

// Run as a real user account so PATH / claude / %USERPROFILE% match the
// working interactive setup. Without these it installs as LocalSystem.
//
// account MUST be the bare username and domain the machine/AD domain — passing
// "DOMAIN\user" as account makes node-windows emit <domain>D</domain><user>D\user</user>,
// an invalid double-domain that fails CreateService (and node-windows then
// wrongly reports success). For a local account, domain is the computer name.
if (process.env.WH_SVC_ACCOUNT) {
  svc.logOnAs.account = process.env.WH_SVC_ACCOUNT
  svc.logOnAs.password = process.env.WH_SVC_PASSWORD || ''
  if (process.env.WH_SVC_DOMAIN) svc.logOnAs.domain = process.env.WH_SVC_DOMAIN
}

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
