import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_DAEMON_PORT } from '@wh/shared'
import type { Preset } from './presets'

export interface SlackConfig {
  clientId: string
  clientSecret: string
  /** Slack team allowed to sign in. Empty = pinned on first successful login. */
  allowedTeamId: string
  /** HTTPS port for the OAuth callback listener. */
  httpsPort: number
  /** Hostname browsers use to reach this daemon (Tailscale name on the office PC). */
  publicHost: string
}

export interface HubConfig {
  host: string
  port: number
  /** Localhost port for the OTLP usage receiver (Claude cost/token metrics). */
  otelPort?: number
  slack?: SlackConfig
  /** token -> username. Filled with a generated dev token on first run. */
  tokens: Record<string, string>
  /**
   * Users who reuse the daemon host's own Claude login instead of an
   * isolated per-user profile (handy on a dev laptop).
   */
  inheritHostClaudeLogin: string[]
  /** One-click environment recipes offered in the New-session dialog. */
  presets: Preset[]
  /** Scrollback lines kept per session and restored when a client attaches. */
  scrollbackLines: number
}

export const DATA_DIR = process.env.WH_HUB_DATA
  ? path.resolve(process.env.WH_HUB_DATA)
  : path.join(process.cwd(), 'data')

const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

const DEFAULTS: HubConfig = {
  host: '127.0.0.1',
  port: DEFAULT_DAEMON_PORT,
  tokens: {},
  inheritHostClaudeLogin: ['dev'],
  presets: [],
  scrollbackLines: 10_000,
}

export function loadConfig(): HubConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  let onDisk: Partial<HubConfig> = {}
  if (fs.existsSync(CONFIG_PATH)) {
    onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  }
  const config: HubConfig = { ...DEFAULTS, ...onDisk }
  // Superseded by scrollbackLines; drop it so nobody tunes a dead setting.
  delete (config as { scrollbackChars?: number }).scrollbackChars
  if (Object.keys(config.tokens).length === 0) {
    const token = crypto.randomBytes(16).toString('hex')
    config.tokens = { [token]: 'dev' }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  return config
}

export function saveConfig(config: HubConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
