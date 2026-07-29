import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as pty from '@lydell/node-pty'
import type { SessionInfo, SessionLink } from '@wh/shared'
import { DATA_DIR } from './config'
import type { PortAllocator } from './presets'

interface SessionMeta {
  id: string
  name: string
  cwd: string
  command: string
  owner: string
  createdAt: string
  links: SessionLink[]
  ports: number[]
  /** Extra env (user profile + preset vars) needed to respawn on relaunch. */
  env: Record<string, string>
  /** Bumped on each (re)launch so clients know to remount the terminal. */
  generation: number
  /** Accumulated Claude usage (summed OpenTelemetry delta exports). */
  usage: { costUsd: number; tokens: number }
}

export interface SpawnSpec {
  name: string
  cwd: string
  command: string
  cols: number
  rows: number
  owner: string
  env: Record<string, string>
  links: SessionLink[]
  ports: number[]
}

interface Session {
  meta: SessionMeta
  proc: pty.IPty | null
  status: 'running' | 'exited' | 'lost'
  exitCode?: number
  scrollback: string[]
  scrollbackLen: number
  attachedClients: number
  activity: {
    lastOutputAt: number
    activeSince: number
    lastBellAt: number
    idleTimer?: ReturnType<typeof setTimeout>
  }
}

const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json')

// How much recent output to replay when a client attaches. Full scrollback is
// kept server-side (scrollbackChars) but replaying all of it on every chat
// switch is slow; ~256KB is the last several screens and renders instantly.
const ATTACH_REPLAY_CHARS = 256_000

export interface SessionEvents {
  output: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  changed: () => void
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(
    private scrollbackChars: number,
    private allocator: PortAllocator,
    private otelPort: number,
  ) {
    super()
    this.restoreMeta()
  }

  /** Sessions from a previous daemon run come back as 'lost' (pty is gone). */
  private restoreMeta() {
    if (!fs.existsSync(SESSIONS_PATH)) return
    try {
      const metas: SessionMeta[] = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
      for (const meta of metas) {
        if (!meta.usage) meta.usage = { costUsd: 0, tokens: 0 } // older sessions.json
        this.sessions.set(meta.id, {
          meta,
          proc: null,
          status: 'lost',
          scrollback: [],
          scrollbackLen: 0,
          attachedClients: 0,
          activity: { lastOutputAt: 0, activeSince: 0, lastBellAt: 0 },
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
      generation: s.meta.generation,
      costUsd: s.meta.usage.costUsd,
      tokens: s.meta.usage.tokens,
    }
  }

  /** Add a (delta) usage sample for a session, from the OTLP receiver. */
  addUsage(id: string, costUsd: number, tokens: number) {
    const s = this.sessions.get(id)
    if (!s) return
    s.meta.usage.costUsd += costUsd
    s.meta.usage.tokens += tokens
    this.emit('changed')
  }

  create(spec: SpawnSpec): SessionInfo {
    const id = crypto.randomBytes(6).toString('hex')
    const command = spec.command.trim()
    if (!fs.existsSync(spec.cwd)) throw new Error(`cwd does not exist: ${spec.cwd}`)

    const session: Session = {
      meta: {
        id,
        name: spec.name || command || 'shell',
        cwd: spec.cwd,
        command,
        owner: spec.owner,
        createdAt: new Date().toISOString(),
        links: spec.links,
        ports: spec.ports,
        env: spec.env,
        generation: 0,
        usage: { costUsd: 0, tokens: 0 },
      },
      proc: null,
      status: 'exited',
      scrollback: [],
      scrollbackLen: 0,
      attachedClients: 0,
      activity: { lastOutputAt: 0, activeSince: 0, lastBellAt: 0 },
    }
    this.sessions.set(id, session)
    this.spawn(session, spec.cols, spec.rows)
    return this.toInfo(session)
  }

  /**
   * Re-run an exited or lost session in place, preserving its id, cwd,
   * command and env. Fixes both accidental exits (double Ctrl-C) and
   * sessions lost to a daemon restart.
   */
  relaunch(id: string, cols: number, rows: number): SessionInfo {
    const session = this.mustGet(id)
    if (session.status === 'running') throw new Error('session is already running')
    if (!fs.existsSync(session.meta.cwd)) throw new Error(`cwd no longer exists: ${session.meta.cwd}`)
    // Re-lease the same ports if still free (best effort; presets only).
    for (const port of session.meta.ports) {
      try {
        this.allocator.reserve(port)
      } catch {
        /* port taken now; the app inside may fail — acceptable edge */
      }
    }
    const marker = `\r\n\x1b[38;2;117;189;234m--- relaunched ${new Date().toISOString()} ---\x1b[0m\r\n`
    this.appendScrollback(session, marker)
    this.spawn(session, cols, rows)
    return this.toInfo(session)
  }

  /** (Re)spawn the pty for a session using its stored meta. */
  private spawn(session: Session, cols: number, rows: number) {
    const { command, cwd, env } = session.meta
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.ComSpec ?? 'cmd.exe' : '/bin/bash'
    // Empty command => interactive shell, so the user can run anything
    // (claude, claude --resume, git, docker...) before/instead of Claude.
    // With a command, run it in the shell: on Windows the full command line
    // must be one string ("/s" strips the outer quotes); an args array gets
    // re-quoted by node-pty and mangles commands that contain their own quotes.
    const shellArgs: string | string[] = command
      ? isWin
        ? `/d /s /c "${command}"`
        : ['-lc', command]
      : isWin
        ? []
        : ['-i']

    // Scrub Claude-session markers the daemon may have inherited (e.g. when
    // started from inside a Claude session in dev) — otherwise child claudes
    // think they are subagents and disable transcript saving / --resume.
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue
      baseEnv[k] = v
    }
    // xterm.js compatibility: Claude Code's fullscreen renderer + kitty
    // keyboard / mouse capture negotiation freezes input under our xterm.js
    // client (per code.claude.com/docs/en/fullscreen.md troubleshooting).
    // Force the classic renderer and plain key encoding for hub sessions.
    baseEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
    baseEnv.CLAUDE_CODE_DISABLE_MOUSE = '1'

    // OpenTelemetry: Claude Code exports cost/token metrics as OTLP JSON to
    // our local receiver, tagged with this session's id so we can attribute
    // usage. (Metrics only; logs exporter left off to keep it light.)
    baseEnv.CLAUDE_CODE_ENABLE_TELEMETRY = '1'
    baseEnv.OTEL_METRICS_EXPORTER = 'otlp'
    baseEnv.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json'
    baseEnv.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${this.otelPort}`
    baseEnv.OTEL_METRIC_EXPORT_INTERVAL = '10000'
    baseEnv.OTEL_RESOURCE_ATTRIBUTES = `wh.session=${session.meta.id}`

    const proc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...baseEnv, ...env },
    })

    session.proc = proc
    session.status = 'running'
    session.exitCode = undefined
    session.meta.generation += 1
    session.activity = { lastOutputAt: 0, activeSince: 0, lastBellAt: 0 }
    this.persistMeta()

    const id = session.meta.id
    proc.onData((data) => {
      this.appendScrollback(session, data)
      this.trackActivity(session, data)
      this.emit('output', id, data)
    })
    proc.onExit(({ exitCode }) => {
      session.status = 'exited'
      session.exitCode = exitCode
      session.proc = null
      clearTimeout(session.activity.idleTimer)
      this.allocator.release(session.meta.ports)
      this.emit('exit', id, exitCode)
      this.emit('notification', id, 'exit', `${session.meta.name}: session exited (code ${exitCode})`)
      this.emit('changed')
    })

    this.emit('changed')
  }

  /**
   * Config-free attention detection:
   * - terminal BEL -> Claude explicitly asks for attention
   * - sustained output (>8s of work) followed by >20s of silence -> the
   *   loop finished or a permission prompt is waiting for input
   */
  private trackActivity(s: Session, data: string) {
    const a = s.activity
    const now = Date.now()
    if (now - a.lastOutputAt > 5000) a.activeSince = now
    a.lastOutputAt = now

    if (data.includes('\x07') && now - a.lastBellAt > 10_000) {
      a.lastBellAt = now
      this.emit('notification', s.meta.id, 'attention', `${s.meta.name}: Claude needs your attention`)
    }

    clearTimeout(a.idleTimer)
    a.idleTimer = setTimeout(() => {
      if (s.status === 'running' && a.lastOutputAt - a.activeSince > 8000) {
        this.emit('notification', s.meta.id, 'idle', `${s.meta.name}: finished working — waiting for you`)
      }
    }, 20_000)
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
    // Replay only the recent tail, not the whole (up to 2MB) buffer: on a
    // long-running session, shipping+parsing all of it made switching chats
    // hang for ~10s. The tail is plenty of recent context and the TUI redraws
    // on the next output anyway.
    return this.tailScrollback(s, ATTACH_REPLAY_CHARS)
  }

  private tailScrollback(s: Session, maxChars: number): string {
    if (s.scrollbackLen <= maxChars) return s.scrollback.join('')
    const parts: string[] = []
    let total = 0
    for (let i = s.scrollback.length - 1; i >= 0; i--) {
      parts.unshift(s.scrollback[i])
      total += s.scrollback[i].length
      if (total >= maxChars) break
    }
    return parts.join('').slice(-maxChars)
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

  /**
   * Save an uploaded file (pasted image or attached document) to the host and
   * return its absolute path, so it can be handed to the `claude` in the
   * session. The stored name is sanitised (no spaces/separators) so the bare
   * path can be injected on the prompt line for Claude's path detection.
   */
  saveFile(id: string, name: string, buf: Buffer): string {
    this.mustGet(id)
    const dir = path.join(DATA_DIR, 'pastes')
    fs.mkdirSync(dir, { recursive: true })
    const safe = (name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
    const file = path.join(dir, `${id}-${crypto.randomBytes(3).toString('hex')}-${safe}`)
    fs.writeFileSync(file, buf)
    return file
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
