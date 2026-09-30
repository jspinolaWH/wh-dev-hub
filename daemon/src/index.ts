import { loadConfig, DATA_DIR } from './config'
import { StaticTokenAuth } from './auth'
import { SessionManager } from './sessions'
import { FolderStore } from './folders'
import { PrStatusService } from './prs'
import { startServer } from './server'
import { PortAllocator } from './presets'
import { SlackAuth } from './slackAuth'
import { startOtelReceiver } from './otel'

// Last-resort safety net: a stray error anywhere (e.g. a socket write to a
// dead peer) must never crash a daemon serving the whole team. Log and keep
// running; the runner loop / service still restarts on genuine fatal exits.
process.on('uncaughtException', (err) => {
  console.error('[wh-dev-hub] uncaughtException (kept alive):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[wh-dev-hub] unhandledRejection (kept alive):', reason)
})

const config = loadConfig()
const allocator = new PortAllocator()
const otelPort = config.otelPort ?? 7813
const sessions = new SessionManager(config.scrollbackLines, allocator, otelPort)
startOtelReceiver(otelPort, sessions)

// Graceful shutdown: when the service stops (Ctrl+C / Ctrl+Break / SIGTERM),
// kill our own pty children and exit fast, so the service manager never has to
// tear down a live process tree (that race crashed winsw and orphaned the
// daemon holding the ports).
let shuttingDown = false
const shutdown = (sig: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[wh-dev-hub] ${sig}: killing sessions and exiting...`)
  try {
    sessions.killAllProcs()
  } catch (err) {
    console.error('[wh-dev-hub] shutdown killAll error:', err)
  }
  setTimeout(() => process.exit(0), 400)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  try {
    process.on(sig, () => shutdown(sig))
  } catch {
    /* signal not supported on this platform */
  }
}
const auth = new StaticTokenAuth(config.tokens)
const slackAuth = config.slack?.clientId ? new SlackAuth(config) : undefined
if (!slackAuth) console.log('[wh-dev-hub] slack sign-in not configured (config.slack missing)')

startServer({
  host: config.host,
  port: config.port,
  auth,
  sessions,
  folders: new FolderStore(),
  prStatus: new PrStatusService(config),
  inheritHostClaudeLogin: config.inheritHostClaudeLogin,
  presets: config.presets,
  allocator,
  slackAuth,
  tailnetHost: config.slack?.publicHost,
})

console.log(`[wh-dev-hub] daemon listening on ws://${config.host}:${config.port}`)
console.log(`[wh-dev-hub] data dir: ${DATA_DIR}`)
console.log(`[wh-dev-hub] users: ${Object.values(config.tokens).join(', ')}`)
