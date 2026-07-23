import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from '@wh/shared'
import type { Authenticator } from './auth'
import type { SessionManager } from './sessions'
import { DATA_DIR } from './config'

interface ClientState {
  user: string | null
  attached: Set<string>
}

export function startServer(opts: {
  host: string
  port: number
  auth: Authenticator
  sessions: SessionManager
  inheritHostClaudeLogin: string[]
}) {
  const { host, port, auth, sessions, inheritHostClaudeLogin } = opts

  /** Isolated Claude profile per user so each teammate has their own login. */
  const envForUser = (user: string): Record<string, string> => {
    if (inheritHostClaudeLogin.includes(user)) return {}
    const profileDir = path.join(DATA_DIR, 'profiles', user, 'claude')
    fs.mkdirSync(profileDir, { recursive: true })
    return { CLAUDE_CONFIG_DIR: profileDir }
  }
  const wss = new WebSocketServer({ host, port })
  const clients = new Map<WebSocket, ClientState>()

  const send = (ws: WebSocket, msg: ServerMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }
  const broadcastSessions = () => {
    const msg: ServerMsg = { t: 'sessions', sessions: sessions.list() }
    for (const [ws, state] of clients) if (state.user) send(ws, msg)
  }

  sessions.on('changed', broadcastSessions)
  sessions.on('output', (sessionId: string, data: string) => {
    for (const [ws, state] of clients) {
      if (state.user && state.attached.has(sessionId)) {
        send(ws, { t: 'output', sessionId, data })
      }
    }
  })
  sessions.on('exit', (sessionId: string, exitCode: number) => {
    for (const [ws, state] of clients) {
      if (state.user) send(ws, { t: 'exit', sessionId, exitCode })
    }
  })

  wss.on('connection', (ws) => {
    const state: ClientState = { user: null, attached: new Set() }
    clients.set(ws, state)

    ws.on('message', async (raw) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return send(ws, { t: 'error', message: 'invalid JSON' })
      }

      try {
        if (msg.t === 'hello') {
          const result = await auth.verify(msg.token)
          if (!result) return send(ws, { t: 'error', message: 'authentication failed' })
          state.user = result.user
          return send(ws, { t: 'hello-ok', user: result.user, sessions: sessions.list() })
        }

        if (!state.user) return send(ws, { t: 'error', message: 'not authenticated' })
        const user = state.user

        // Anyone signed in may attach (read-only peek); only the owner may
        // type into, resize, kill, or remove a session.
        const mustOwn = (sessionId: string) => {
          const s = sessions.get(sessionId)
          if (!s) throw new Error(`no such session: ${sessionId}`)
          if (s.meta.owner !== user) throw new Error(`read-only: this session belongs to ${s.meta.owner}`)
        }

        switch (msg.t) {
          case 'list':
            return send(ws, { t: 'sessions', sessions: sessions.list() })
          case 'create': {
            const info = sessions.create(msg, state.user, envForUser(state.user))
            return send(ws, { t: 'created', session: info })
          }
          case 'attach': {
            const scrollback = sessions.attach(msg.sessionId, msg.cols, msg.rows)
            state.attached.add(msg.sessionId)
            return send(ws, { t: 'attached', sessionId: msg.sessionId, scrollback })
          }
          case 'detach':
            if (state.attached.delete(msg.sessionId)) sessions.detach(msg.sessionId)
            return
          case 'input':
            mustOwn(msg.sessionId)
            return sessions.input(msg.sessionId, msg.data)
          case 'resize':
            mustOwn(msg.sessionId)
            return sessions.resize(msg.sessionId, msg.cols, msg.rows)
          case 'kill':
            mustOwn(msg.sessionId)
            return sessions.kill(msg.sessionId)
          case 'remove':
            mustOwn(msg.sessionId)
            return sessions.remove(msg.sessionId)
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
