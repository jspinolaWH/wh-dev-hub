import { EventEmitter } from 'node:events'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { generate as generateCert } from 'selfsigned'
import { DATA_DIR, saveConfig, type HubConfig, type SlackConfig } from './config'

/**
 * Sign in with Slack (OpenID Connect).
 *
 * Flow: client sends `login-start` over WS -> we mint a `state`, return the
 * Slack authorize URL -> user approves in the browser -> Slack redirects to
 * our HTTPS callback -> we exchange the code at slack.com (trusted TLS
 * channel, so the returned id_token needs no extra signature check), verify
 * the workspace, issue a hub token, and emit it back to the waiting WS.
 *
 * The callback listener uses a self-signed cert (browsers warn once); Slack
 * requires HTTPS redirect URLs even on loopback.
 */
export class SlackAuth extends EventEmitter {
  private pending = new Map<string, { createdAt: number }>()
  private slack: SlackConfig

  constructor(private config: HubConfig) {
    super()
    if (!config.slack) throw new Error('slack config missing')
    this.slack = config.slack
    this.startCallbackServer().catch((err) => {
      console.error('[wh-dev-hub] slack callback server failed to start:', err)
    })
  }

  private redirectUri() {
    return `https://${this.slack.publicHost}:${this.slack.httpsPort}/auth/slack/callback`
  }

  startLogin(): { state: string; url: string } {
    // Drop stale pending logins (10 min TTL)
    const now = Date.now()
    for (const [state, p] of this.pending) if (now - p.createdAt > 600_000) this.pending.delete(state)

    const state = crypto.randomBytes(16).toString('hex')
    this.pending.set(state, { createdAt: now })
    const params = new URLSearchParams({
      response_type: 'code',
      scope: 'openid profile email',
      client_id: this.slack.clientId,
      state,
      redirect_uri: this.redirectUri(),
      nonce: crypto.randomBytes(8).toString('hex'),
    })
    return { state, url: `https://slack.com/openid/connect/authorize?${params}` }
  }

  private async loadTls(): Promise<{ key: string; cert: string }> {
    const dir = path.join(DATA_DIR, 'tls')
    const keyPath = path.join(dir, 'key.pem')
    const certPath = path.join(dir, 'cert.pem')
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      fs.mkdirSync(dir, { recursive: true })
      const pems = await generateCert([{ name: 'commonName', value: this.slack.publicHost }], {
        days: 3650,
        keySize: 2048,
      })
      fs.writeFileSync(keyPath, pems.private)
      fs.writeFileSync(certPath, pems.cert)
    }
    return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') }
  }

  private async startCallbackServer() {
    const { key, cert } = await this.loadTls()
    const server = https.createServer({ key, cert }, (req, res) => {
      const url = new URL(req.url ?? '/', `https://${req.headers.host}`)
      if (url.pathname !== '/auth/slack/callback') {
        res.writeHead(404).end('not found')
        return
      }
      this.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'))
        .then((user) => {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(page(`Signed in as <b>${escapeHtml(user)}</b>`, 'You can close this tab and return to the WasteHero Dev Hub app.'))
        })
        .catch((err) => {
          res.writeHead(403, { 'content-type': 'text/html' })
          res.end(page('Sign-in failed', escapeHtml(err instanceof Error ? err.message : String(err))))
        })
    })
    server.listen(this.slack.httpsPort, () => {
      console.log(`[wh-dev-hub] slack sign-in callback on ${this.redirectUri()}`)
    })
  }

  private async handleCallback(code: string | null, state: string | null): Promise<string> {
    if (!code || !state || !this.pending.has(state)) throw new Error('invalid or expired sign-in attempt')
    this.pending.delete(state)

    const body = new URLSearchParams({
      client_id: this.slack.clientId,
      client_secret: this.slack.clientSecret,
      code,
      redirect_uri: this.redirectUri(),
    })
    const resp = await fetch('https://slack.com/api/openid.connect.token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const data = (await resp.json()) as { ok: boolean; error?: string; id_token?: string }
    if (!data.ok || !data.id_token) throw new Error(`slack token exchange failed: ${data.error ?? 'no id_token'}`)

    const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString()) as Record<string, unknown>
    if (claims.aud !== this.slack.clientId) throw new Error('token audience mismatch')

    const teamId = String(claims['https://slack.com/team_id'] ?? '')
    if (!teamId) throw new Error('no team in Slack response')
    if (!this.slack.allowedTeamId) {
      // First successful login pins the workspace.
      this.slack.allowedTeamId = teamId
      saveConfig(this.config)
      console.log(`[wh-dev-hub] pinned Slack workspace: ${teamId}`)
    } else if (this.slack.allowedTeamId !== teamId) {
      throw new Error('your Slack workspace is not allowed on this hub')
    }

    const email = String(claims.email ?? '')
    const rawName = String(claims.name ?? email.split('@')[0] ?? 'user')
    const user = rawName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'user'

    const token = crypto.randomBytes(24).toString('hex')
    this.config.tokens[token] = user
    saveConfig(this.config)

    this.emit('login', state, token, user)
    return user
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(title: string, body: string) {
  return `<!doctype html><html><head><title>WasteHero Dev Hub</title></head>
<body style="font-family:system-ui;background:#0b1220;color:#d7e0ea;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center"><div style="width:52px;height:52px;border-radius:12px;background:#3fd08c;color:#06251a;font-weight:800;display:inline-flex;align-items:center;justify-content:center;font-size:20px">WH</div>
<h2>${title}</h2><p style="color:#8296ad">${body}</p></div></body></html>`
}
