import { loadConfig, DATA_DIR } from './config'
import { StaticTokenAuth } from './auth'
import { SessionManager } from './sessions'
import { startServer } from './server'
import { PortAllocator } from './presets'
import { SlackAuth } from './slackAuth'

const config = loadConfig()
const allocator = new PortAllocator()
const sessions = new SessionManager(config.scrollbackChars, allocator)
const auth = new StaticTokenAuth(config.tokens)
const slackAuth = config.slack?.clientId ? new SlackAuth(config) : undefined
if (!slackAuth) console.log('[wh-dev-hub] slack sign-in not configured (config.slack missing)')

startServer({
  host: config.host,
  port: config.port,
  auth,
  sessions,
  inheritHostClaudeLogin: config.inheritHostClaudeLogin,
  presets: config.presets,
  allocator,
  slackAuth,
})

console.log(`[wh-dev-hub] daemon listening on ws://${config.host}:${config.port}`)
console.log(`[wh-dev-hub] data dir: ${DATA_DIR}`)
console.log(`[wh-dev-hub] users: ${Object.values(config.tokens).join(', ')}`)
