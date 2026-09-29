import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from '@wh/shared'
import type { Authenticator } from './auth'
import type { SessionManager } from './sessions'
import { DATA_DIR } from './config'
import { resolvePreset, type Preset, type PortAllocator } from './presets'
import type { SlackAuth } from './slackAuth'
import type { FolderStore } from './folders'
import { createWebHandler, defaultDistDir } from './web'

interface ClientState {
  user: string | null
  attached: Set<string>
  pendingLoginState: string | null
}

export function startServer(opts: {
  host: string
  port: number
  auth: Authenticator
  sessions: SessionManager
  folders: FolderStore
  inheritHostClaudeLogin: string[]
  presets: Preset[]
  allocator: PortAllocator
  slackAuth?: SlackAuth
  tailnetHost?: string
}) {
  const { host, port, auth, sessions, folders, inheritHostClaudeLogin, presets, allocator, slackAuth, tailnetHost } = opts
  const presetInfos = presets.map((p) => ({ id: p.id, name: p.name, description: p.description }))

  // Injected into every session so anything started here can be reached from
  // teammates' machines over Tailscale: bind servers to WH_BIND_HOST, and
  // point frontends' API/WS base URLs at WH_TAILNET_HOST (never localhost —
  // the browser runs on the user's machine, not the host). RemoteServer's
  // CLAUDE.md documents these as standing rules.
  const tunnelEnv: Record<string, string> = { WH_BIND_HOST: '0.0.0.0' }
  if (tailnetHost) tunnelEnv.WH_TAILNET_HOST = tailnetHost

  /** Isolated Claude profile per user so each teammate has their own login. */
  const envForUser = (user: string): Record<string, string> => {
    const base = { ...tunnelEnv }
    if (inheritHostClaudeLogin.includes(user)) return base
    const profileDir = path.join(DATA_DIR, 'profiles', user, 'claude')
    fs.mkdirSync(profileDir, { recursive: true })
    return { ...base, CLAUDE_CONFIG_DIR: profileDir }
  }
  // One HTTP server on `port` serves BOTH the web client (so phones/browsers
  // can open the UI over Tailscale) and the WebSocket (via upgrade). No extra
  // port, no extra firewall rule.
  const webHandler = createWebHandler(defaultDistDir())
  const httpServer = http.createServer(webHandler)
  // Compress only big frames: a long chat's attach snapshot is ~1MB of very
  // repetitive text (tens of times smaller deflated — matters over Tailscale
  // relays), while keystroke echoes and spinner frames stay uncompressed.
  // (ws only honours `threshold` without server context takeover.)
  const wss = new WebSocketServer({
    server: httpServer,
    perMessageDeflate: { serverNoContextTakeover: true, threshold: 16 * 1024 },
  })
  wss.on('error', (err) => console.error('[wh-dev-hub] wss error:', err))
  // If the port is still held (e.g. a stale/orphaned daemon), fail loudly and
  // exit instead of running as a non-listening zombie — makes the problem
  // visible in the log rather than silently "up but useless".
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[wh-dev-hub] FATAL: port ${port} already in use — another daemon is still holding it. ` +
          `Free it (kill the node process running daemon\\dist\\index.cjs) then restart.`,
      )
      process.exit(1)
    }
    console.error('[wh-dev-hub] http server error:', err)
  })
  httpServer.listen(port, host)
  const clients = new Map<WebSocket, ClientState>()

  // A write to a socket the peer already closed can throw synchronously
  // (EOF/EPIPE) — that must never take the daemon down. Guard every send.
  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      console.error('[wh-dev-hub] send failed (dropping client):', err instanceof Error ? err.message : err)
      try {
        ws.terminate()
      } catch {
        /* already gone */
      }
    }
  }
  // Per-user isolation: each user only sees and receives events for their OWN
  // sessions. (Owner is set at create time from the signed-in user.)
  const listFor = (user: string) => sessions.list().filter((s) => s.owner === user)
  const ownerOf = (sessionId: string) => sessions.get(sessionId)?.meta.owner

  const broadcastSessions = () => {
    for (const [ws, state] of clients) {
      if (state.user) send(ws, { t: 'sessions', sessions: listFor(state.user) })
    }
  }
  // Folders are per user: only that user's clients (all their devices) hear it.
  const broadcastFolders = (user: string) => {
    for (const [ws, state] of clients) {
      if (state.user === user) send(ws, { t: 'folders', folders: folders.list(user) })
    }
  }

  sessions.on('changed', broadcastSessions)
  sessions.on('output', (sessionId: string, data: string) => {
    const owner = ownerOf(sessionId)
    for (const [ws, state] of clients) {
      if (state.user === owner && state.attached.has(sessionId)) {
        send(ws, { t: 'output', sessionId, data })
      }
    }
  })
  sessions.on('exit', (sessionId: string, exitCode: number) => {
    const owner = ownerOf(sessionId)
    for (const [ws, state] of clients) {
      if (state.user && state.user === owner) send(ws, { t: 'exit', sessionId, exitCode })
    }
  })
  sessions.on('notification', (sessionId: string, kind: string, message: string) => {
    const owner = ownerOf(sessionId)
    for (const [ws, state] of clients) {
      if (state.user && state.user === owner) send(ws, { t: 'notification', sessionId, kind, message })
    }
  })

  slackAuth?.on('login', (loginState: string, token: string, user: string) => {
    for (const [ws, state] of clients) {
      if (state.pendingLoginState === loginState) {
        state.pendingLoginState = null
        send(ws, { t: 'login-ok', token, user })
      }
    }
  })

  wss.on('connection', (ws) => {
    const state: ClientState = { user: null, attached: new Set(), pendingLoginState: null }
    clients.set(ws, state)

    // Without an 'error' listener, a socket error (reset/EOF) is emitted as
    // an unhandled 'error' event and crashes the process.
    ws.on('error', (err) => console.error('[wh-dev-hub] client socket error:', err instanceof Error ? err.message : err))

    ws.on('message', async (raw) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return send(ws, { t: 'error', message: 'invalid JSON' })
      }

      try {
        if (msg.t === 'login-start') {
          if (!slackAuth) return send(ws, { t: 'error', message: 'Slack sign-in is not configured on this hub' })
          const { state: loginState, url } = slackAuth.startLogin()
          state.pendingLoginState = loginState
          return send(ws, { t: 'login-url', url })
        }

        if (msg.t === 'hello') {
          const result = await auth.verify(msg.token)
          if (!result) return send(ws, { t: 'error', message: 'authentication failed' })
          state.user = result.user
          return send(ws, {
            t: 'hello-ok',
            user: result.user,
            sessions: listFor(result.user),
            presets: presetInfos,
            folders: folders.list(result.user),
          })
        }

        if (!state.user) return send(ws, { t: 'error', message: 'not authenticated' })
        const user = state.user

        // Per-user isolation: a session belongs to its creator. Everything
        // (view, attach, type, kill) requires ownership — you never see or
        // touch another user's sessions.
        const mustOwn = (sessionId: string) => {
          const s = sessions.get(sessionId)
          if (!s) throw new Error(`no such session: ${sessionId}`)
          if (s.meta.owner !== user) throw new Error(`this session belongs to ${s.meta.owner}`)
        }

        switch (msg.t) {
          case 'list':
            return send(ws, { t: 'sessions', sessions: listFor(user) })
          case 'create': {
            const userEnv = envForUser(user)
            let info
            if (msg.presetId) {
              const preset = presets.find((p) => p.id === msg.presetId)
              if (!preset) throw new Error(`no such preset: ${msg.presetId}`)
              const resolved = await resolvePreset(preset, allocator)
              try {
                info = sessions.create({
                  name: msg.name || preset.name,
                  cwd: resolved.cwd,
                  command: resolved.command,
                  cols: msg.cols,
                  rows: msg.rows,
                  owner: user,
                  env: { ...userEnv, ...resolved.env },
                  links: resolved.links,
                  ports: resolved.ports,
                })
              } catch (err) {
                allocator.release(resolved.ports)
                throw err
              }
            } else {
              if (!msg.cwd) throw new Error('working directory is required')
              info = sessions.create({
                name: msg.name,
                cwd: msg.cwd,
                command: msg.command ?? 'claude',
                cols: msg.cols,
                rows: msg.rows,
                owner: user,
                env: userEnv,
                links: [],
                ports: [],
              })
            }
            return send(ws, { t: 'created', session: info })
          }
          case 'attach': {
            mustOwn(msg.sessionId)
            const scrollback = sessions.attach(msg.sessionId, msg.cols, msg.rows)
            state.attached.add(msg.sessionId)
            return send(ws, { t: 'attached', sessionId: msg.sessionId, scrollback })
          }
          case 'relaunch': {
            mustOwn(msg.sessionId)
            sessions.relaunch(msg.sessionId, msg.cols, msg.rows)
            return
          }
          case 'detach':
            if (state.attached.delete(msg.sessionId)) sessions.detach(msg.sessionId)
            return
          case 'input':
            mustOwn(msg.sessionId)
            return sessions.input(msg.sessionId, msg.data)
          case 'paste-image': {
            mustOwn(msg.sessionId)
            const png = Buffer.from(msg.pngBase64, 'base64')
            const file = sessions.saveFile(msg.sessionId, 'screenshot.png', png)
            // Claude Code (headless/PTY) attaches a file by a bare filesystem
            // path in the prompt — its Read tool auto-detects images/docs. No
            // quotes/@ (quotes can defeat the detector; the saved name has no
            // spaces). User then types their message + submits.
            sessions.input(msg.sessionId, `${file} `)
            return
          }
          case 'attach-file': {
            mustOwn(msg.sessionId)
            const buf = Buffer.from(msg.base64, 'base64')
            const file = sessions.saveFile(msg.sessionId, msg.name, buf)
            sessions.input(msg.sessionId, `${file} `)
            return
          }
          case 'set-auto-continue': {
            mustOwn(msg.sessionId)
            sessions.setAutoContinue(msg.sessionId, {
              enabled: msg.enabled,
              prompt: msg.prompt,
              maxNudges: msg.maxNudges,
            })
            return
          }
          case 'resize':
            mustOwn(msg.sessionId)
            return sessions.resize(msg.sessionId, msg.cols, msg.rows)
          case 'kill':
            mustOwn(msg.sessionId)
            return sessions.kill(msg.sessionId)
          case 'remove':
            mustOwn(msg.sessionId)
            return sessions.remove(msg.sessionId)
          case 'update-session': {
            mustOwn(msg.sessionId)
            if (msg.folderId && !folders.has(user, msg.folderId)) throw new Error(`no such folder: ${msg.folderId}`)
            return sessions.update(msg.sessionId, { name: msg.name, color: msg.color, folderId: msg.folderId })
          }
          case 'create-folder':
            folders.create(user, msg.name)
            return broadcastFolders(user)
          case 'rename-folder':
            folders.rename(user, msg.folderId, msg.name)
            return broadcastFolders(user)
          case 'delete-folder':
            folders.remove(user, msg.folderId)
            broadcastFolders(user)
            return sessions.unfile(user, msg.folderId)
        }
      } catch (err) {
        send(ws, { t: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })

    ws.on('close', () => {
      for (const sessionId of state.attached) sessions.detach(sessionId)
      clients.delete(ws)
    })
  })

  return wss
}
