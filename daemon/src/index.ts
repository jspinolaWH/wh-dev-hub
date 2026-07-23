import { loadConfig, DATA_DIR } from './config'
import { StaticTokenAuth } from './auth'
import { SessionManager } from './sessions'
import { startServer } from './server'
import { PortAllocator } from './presets'

const config = loadConfig()
const allocator = new PortAllocator()
const sessions = new SessionManager(config.scrollbackChars, allocator)
const auth = new StaticTokenAuth(config.tokens)

startServer({
  host: config.host,
  port: config.port,
  auth,
  sessions,
  inheritHostClaudeLogin: config.inheritHostClaudeLogin,
  presets: config.presets,
  allocator,
})

console.log(`[wh-dev-hub] daemon listening on ws://${config.host}:${config.port}`)
console.log(`[wh-dev-hub] data dir: ${DATA_DIR}`)
console.log(`[wh-dev-hub] users: ${Object.values(config.tokens).join(', ')}`)
