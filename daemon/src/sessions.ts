import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as pty from '@lydell/node-pty'
import type { SessionInfo, SessionLink, CreateSessionRequest } from '@wh/shared'
import { DATA_DIR } from './config'

interface SessionMeta {
  id: string
  name: string
  cwd: string
  command: string
  owner: string
  createdAt: string
  links: SessionLink[]
}

interface Session {
  meta: SessionMeta
  proc: pty.IPty | null
  status: 'running' | 'exited' | 'lost'
  exitCode?: number
  scrollback: string[]
  scrollbackLen: number
  attachedClients: number
}

const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json')

export interface SessionEvents {
  output: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  changed: () => void
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(private scrollbackChars: number) {
    super()
    this.restoreMeta()
  }

  /** Sessions from a previous daemon run come back as 'lost' (pty is gone). */
  private restoreMeta() {
    if (!fs.existsSync(SESSIONS_PATH)) return
    try {
      const metas: SessionMeta[] = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
      for (const meta of metas) {
        this.sessions.set(meta.id, {
          meta,
          proc: null,
          status: 'lost',
          scrollback: [],
          scrollbackLen: 0,
          attachedClients: 0,
        })
      }
    } catch (err) {
      console.error('[sessions] failed to restore metadata:', err)
    }
  }

  private persistMeta() {
    const metas = [...this.sessions.values()].map((s) => s.meta)
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(metas, null, 2))
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toInfo(s))
  }

  private toInfo(s: Session): SessionInfo {
    return {
      id: s.meta.id,
      name: s.meta.name,
      cwd: s.meta.cwd,
      owner: s.meta.owner,
      status: s.status,
      exitCode: s.exitCode,
      createdAt: s.meta.createdAt,
      attachedClients: s.attachedClients,
      links: s.meta.links,
    }
  }

  create(req: CreateSessionRequest, owner: string, env: Record<string, string> = {}): SessionInfo {
    const id = crypto.randomBytes(6).toString('hex')
    const command = req.command?.trim() || 'claude'
    if (!fs.existsSync(req.cwd)) throw new Error(`cwd does not exist: ${req.cwd}`)

    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec ?? 'cmd.exe' : '/bin/bash'
    // On Windows the full command line must be one string ("/s" strips the
    // outer quotes); an args array gets re-quoted by node-pty and mangles
    // commands that contain their own quotes.
    const shellArgs: string | string[] = isWin ? `/d /s /c "${command}"` : ['-lc', command]

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: req.cwd,
      env: { ...(process.env as Record<string, string>), ...env },
    })

    const session: Session = {
      meta: {
        id,
        name: req.name || command,
        cwd: req.cwd,
        command,
        owner,
        createdAt: new Date().toISOString(),
        links: [],
      },
      proc,
      status: 'running',
      scrollback: [],
      scrollbackLen: 0,
      attachedClients: 0,
    }
    this.sessions.set(id, session)
    this.persistMeta()

    proc.onData((data) => {
      this.appendScrollback(session, data)
      this.emit('output', id, data)
    })
    proc.onExit(({ exitCode }) => {
      session.status = 'exited'
      session.exitCode = exitCode
      session.proc = null
      this.emit('exit', id, exitCode)
      this.emit('changed')
    })

    this.emit('changed')
    return this.toInfo(session)
  }

  private appendScrollback(s: Session, data: string) {
    s.scrollback.push(data)
    s.scrollbackLen += data.length
    while (s.scrollbackLen > this.scrollbackChars && s.scrollback.length > 1) {
      const dropped = s.scrollback.shift()!
      s.scrollbackLen -= dropped.length
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  attach(id: string, cols: number, rows: number): string {
    const s = this.mustGet(id)
    s.attachedClients += 1
    if (s.proc) s.proc.resize(cols, rows)
    this.emit('changed')
    return s.scrollback.join('')
  }

  detach(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    s.attachedClients = Math.max(0, s.attachedClients - 1)
    this.emit('changed')
  }

  input(id: string, data: string) {
    const s = this.mustGet(id)
    if (!s.proc) throw new Error('session is not running')
    s.proc.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id)
    if (s?.proc) s.proc.resize(cols, rows)
  }

  kill(id: string) {
    const s = this.mustGet(id)
    if (s.proc) s.proc.kill()
    else {
      s.status = 'exited'
      this.emit('changed')
    }
  }

  remove(id: string) {
    const s = this.mustGet(id)
    if (s.status === 'running') throw new Error('kill the session before removing it')
    this.sessions.delete(id)
    this.persistMeta()
    this.emit('changed')
  }

  private mustGet(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`no such session: ${id}`)
    return s
  }
}
