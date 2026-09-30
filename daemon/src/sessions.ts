import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as pty from '@lydell/node-pty'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { CHAT_COLORS, type ChatColor, type PrRef, type SessionInfo, type SessionLink } from '@wh/shared'
import { DATA_DIR } from './config'
import { cleanName } from './folders'
import { findPrRefs, prKey } from './prs'
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
  /**
   * Auto-continue: when the session finishes a burst of work and goes idle,
   * send `prompt` to keep it going — up to `maxNudges` times (a hard runaway
   * guard). `sent` resets to 0 on any manual input. Opt-in (enabled=false).
   */
  autoContinue: { enabled: boolean; prompt: string; maxNudges: number; sent: number }
  /** Sidebar organisation (colour tag, folder id from the owner's FolderStore). */
  color?: ChatColor
  folderId?: string
  /** GitHub PRs linked in the chat's output, newest first. */
  prs?: (PrRef & { seenAt: string })[]
  /** PRs the user removed from the list, so a redrawn transcript can't re-add them. */
  prsHidden?: string[]
}

const DEFAULT_AUTO_CONTINUE = { enabled: false, prompt: 'continue', maxNudges: 25, sent: 0 }

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
  term: TermMirror
  attachedClients: number
  activity: {
    lastOutputAt: number
    activeSince: number
    lastBellAt: number
    idleTimer?: ReturnType<typeof setTimeout>
    recheckTimer?: ReturnType<typeof setTimeout>
    /** Output until then is the repaint our own resize caused, not the chat working. */
    repaintUntil?: number
  }
  /** Last non-empty, de-ANSI'd output line — the overview's "what's it doing". */
  lastLine: string
  /** Claude's latest action or message on screen (its "●" line), if any. */
  doing: string
  /** Claude shows a choice (permission prompt, question) and waits for an answer. */
  asking: boolean
  /** New output since the last activity flush. */
  dirty: boolean
  /** Activity as clients last received it, to broadcast only on change. */
  shown: string
  /** The latest de-ANSI'd chunk plus a short tail of the one before, so text
   * split across chunks still matches. */
  recentText: string
  /** Agent-reported progress, scraped from a [[WH-PROGRESS ...]] line. */
  progress?: { pct?: number; eta?: string; note?: string }
  /** Last name adopted from Claude's `/rename`, so a redrawn confirmation
   * (e.g. Claude repainting on resize) can't undo a later rename in the hub. */
  claudeName?: string
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
const stripAnsi = (s: string) => s.replace(ANSI_RE, '')
const PROGRESS_RE = /\[\[WH-PROGRESS\s+([^\]]+)\]\]/g
// Claude Code's `/rename` confirmation as rendered — "  ⎿  Session renamed to:
// X", plus a note when the name was taken or a newer rename won. Only /rename
// prints it; the terminal title can't be used because Claude also puts
// auto-generated topics there.
const RENAME_HINT = /Session (?:renamed to|is named): /
const RENAME_RE =
  /^\s*⎿\s+Session (?:renamed to|is named): (.+?)(?: \("[^"]*" is held by another live session on this machine\)| \(a newer rename[^)]*\))?$/

/** Parse the body of a WH-PROGRESS line: `pct=60 eta=4m note="fixing X"`. */
function parseProgress(body: string): { pct?: number; eta?: string; note?: string } {
  const out: { pct?: number; eta?: string; note?: string } = {}
  const pct = body.match(/\bpct=(\d{1,3})/)
  if (pct) out.pct = Math.max(0, Math.min(100, Number(pct[1])))
  const eta = body.match(/\beta=("([^"]*)"|(\S+))/)
  if (eta) out.eta = (eta[2] ?? eta[3] ?? '').slice(0, 24)
  const note = body.match(/\bnote=("([^"]*)"|(\S+))/)
  if (note) out.note = (note[2] ?? note[3] ?? '').slice(0, 160)
  return out
}

const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json')
const MAX_PRS = 50

const prRefsOf = (s: Session): PrRef[] => (s.meta.prs ?? []).map(({ owner, repo, number }) => ({ owner, repo, number }))

/**
 * Server-side mirror of a session's terminal. All output is parsed here, so an
 * attaching client gets the rendered screen + scrollback — complete, compact,
 * never cut mid-escape-sequence — rather than a tail of the raw byte stream,
 * which Claude's spinner redraws fill up within seconds.
 */
class TermMirror {
  private term: Terminal
  private serializer = new SerializeAddon()
  private cursorHidden = false

  constructor(cols: number, rows: number, scrollback: number) {
    // Same parsing options as the client's xterm (TerminalView.tsx), so the
    // mirror lays output out exactly like a client that never detached.
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true, windowsPty: { backend: 'conpty' } })
    this.term.loadAddon(this.serializer)
    // The serializer doesn't carry cursor visibility (DECTCEM); track it so a
    // replayed TUI that hides its cursor doesn't show a stray one.
    for (const final of ['h', 'l']) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) this.cursorHidden = final === 'l'
        return false
      })
    }
  }

  /** `parsed` runs once the chunk has been applied to the mirror. */
  write(data: string, parsed?: () => void) {
    this.term.write(data, parsed)
  }

  /** Returns whether the size actually changed. */
  resize(cols: number, rows: number): boolean {
    if (cols === this.term.cols && rows === this.term.rows) return false
    this.term.resize(cols, rows)
    return true
  }

  snapshot(): string {
    return this.serializer.serialize() + (this.cursorHidden ? '\x1b[?25l' : '')
  }

  /** A real terminal bell (BEL outside escape sequences like title updates). */
  onBell(cb: () => void) {
    this.term.onBell(cb)
  }

  /** The last `n` rows of content (blank screen below it skipped), top to bottom. */
  private bottomRows(n: number): string[] {
    const buf = this.term.buffer.active
    const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? ''
    let bottom = buf.baseY + this.term.rows - 1
    while (bottom > 0 && !text(bottom).trim()) bottom--
    const rows: string[] = []
    for (let y = Math.max(0, bottom - n + 1); y <= bottom; y++) rows.push(text(y))
    return rows
  }

  /** What Claude did last: its latest "●" action or message on screen. */
  doing(): string {
    for (const row of this.bottomRows(80).reverse()) {
      const m = /^\s*[●⏺]\s+(.+)$/.exec(row)
      if (m) return m[1].trim().slice(0, 160)
    }
    return ''
  }

  /** A numbered choice with a cursor (permission prompt, question) is waiting for an answer. */
  asking(): boolean {
    const rows = this.bottomRows(24)
    const cursor = rows.some((r) => /^[│\s]*❯\s*\d+\.\s/.test(r))
    return cursor && rows.filter((r) => /^[│\s]*(❯\s*)?\d+\.\s/.test(r)).length >= 2
  }

  /** The name in the latest `/rename` confirmation near the bottom of the screen. */
  renamedTo(): string | undefined {
    const buf = this.term.buffer.active
    const bottom = buf.baseY + this.term.rows - 1
    let line = ''
    for (let y = bottom; y >= Math.max(0, bottom - 200); y--) {
      const row = buf.getLine(y)
      if (!row) continue
      line = row.translateToString(!line) + line
      if (row.isWrapped) continue // soft-wrapped: keep joining the rows above
      const m = RENAME_RE.exec(line)
      if (m) return m[1].trim().slice(0, 120)
      line = ''
    }
    return undefined
  }

  dispose() {
    this.term.dispose()
  }
}

export interface SessionEvents {
  output: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  changed: () => void
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(
    private scrollbackLines: number,
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
        if (!meta.autoContinue) meta.autoContinue = { ...DEFAULT_AUTO_CONTINUE }
        this.addSession(meta, 'lost', 120, 30)
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
      autoContinue: { ...s.meta.autoContinue },
      activityStatus: this.activityStatus(s),
      lastActivityAt: s.activity.lastOutputAt ? new Date(s.activity.lastOutputAt).toISOString() : s.meta.createdAt,
      lastLine: s.lastLine,
      doing: s.doing,
      progress: s.progress,
      color: s.meta.color,
      folderId: s.meta.folderId,
      prs: prRefsOf(s),
    }
  }

  prRefs(id: string): PrRef[] {
    return prRefsOf(this.mustGet(id))
  }

  /** Drop a PR from the chat's list for good (it was only mentioned, say). */
  forgetPr(id: string, ref: PrRef) {
    const s = this.mustGet(id)
    const key = prKey(ref)
    s.meta.prs = (s.meta.prs ?? []).filter((p) => prKey(p) !== key)
    s.meta.prsHidden = [...new Set([...(s.meta.prsHidden ?? []), key])]
    this.persistMeta()
    this.emit('changed')
  }

  /** Remember GitHub PR links the chat printed (e.g. `gh pr create` output). */
  private notePrs(s: Session) {
    const list = (s.meta.prs ??= [])
    const known = new Set([...list.map(prKey), ...(s.meta.prsHidden ?? [])])
    const added: PrRef[] = []
    for (const ref of findPrRefs(s.recentText)) {
      if (known.has(prKey(ref))) continue
      known.add(prKey(ref))
      added.push(ref)
    }
    if (!added.length) return
    list.unshift(...added.reverse().map((ref) => ({ ...ref, seenAt: new Date().toISOString() })))
    list.splice(MAX_PRS)
    this.persistMeta()
    this.emit('changed')
  }

  /** Rename, recolour or move a chat (`null` clears colour / folder). */
  update(id: string, patch: { name?: string; color?: ChatColor | null; folderId?: string | null }) {
    const s = this.mustGet(id)
    if (patch.color != null && !CHAT_COLORS.includes(patch.color)) throw new Error(`unknown colour: ${patch.color}`)
    if (patch.name !== undefined) s.meta.name = cleanName(patch.name, 'Chat')
    if (patch.color !== undefined) s.meta.color = patch.color ?? undefined
    if (patch.folderId !== undefined) s.meta.folderId = patch.folderId ?? undefined
    this.persistMeta()
    this.emit('changed')
  }

  /** A deleted folder's chats move back out to the top level. */
  unfile(owner: string, folderId: string) {
    let moved = false
    for (const s of this.sessions.values()) {
      if (s.meta.owner === owner && s.meta.folderId === folderId) {
        s.meta.folderId = undefined
        moved = true
      }
    }
    if (!moved) return
    this.persistMeta()
    this.emit('changed')
  }

  private activityStatus(s: Session): 'working' | 'idle' | 'attention' | 'offline' {
    if (s.status !== 'running') return 'offline'
    const now = Date.now()
    if (s.asking || now - s.activity.lastBellAt < 30_000) return 'attention'
    if (now - s.activity.lastOutputAt < 10_000) return 'working'
    return 'idle'
  }

  setAutoContinue(id: string, opts: { enabled: boolean; prompt?: string; maxNudges?: number }) {
    const s = this.mustGet(id)
    const ac = s.meta.autoContinue
    ac.enabled = opts.enabled
    if (opts.prompt !== undefined) ac.prompt = opts.prompt
    if (opts.maxNudges !== undefined) ac.maxNudges = Math.max(1, Math.min(1000, opts.maxNudges))
    ac.sent = 0 // fresh budget whenever toggled
    this.persistMeta()
    this.emit('changed')
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

    const meta: SessionMeta = {
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
      autoContinue: { ...DEFAULT_AUTO_CONTINUE },
    }
    const session = this.addSession(meta, 'exited', spec.cols, spec.rows)
    this.spawn(session, spec.cols, spec.rows)
    return this.toInfo(session)
  }

  /** Runtime state around a session's metadata; spawn() attaches the pty. */
  private addSession(meta: SessionMeta, status: Session['status'], cols: number, rows: number): Session {
    const s: Session = {
      meta,
      proc: null,
      status,
      term: new TermMirror(cols, rows, this.scrollbackLines),
      attachedClients: 0,
      activity: { lastOutputAt: 0, activeSince: 0, lastBellAt: 0 },
      lastLine: '',
      recentText: '',
      doing: '',
      asking: false,
      dirty: false,
      shown: '',
    }
    s.term.onBell(() => this.noteBell(s))
    this.sessions.set(meta.id, s)
    return s
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
    // ConPTY opens every new process with a clear-screen, which would wipe the
    // previous run's last screen and this marker: scroll both into history.
    session.term.resize(cols, rows)
    session.term.write(marker + '\r\n'.repeat(rows))
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
    session.doing = ''
    session.asking = false
    session.term.resize(cols, rows)
    this.persistMeta()

    const id = session.meta.id
    proc.onData((data) => {
      this.trackActivity(session, data)
      const renamed = RENAME_HINT.test(session.recentText)
      // Forward only once the mirror has parsed it: a snapshot taken at attach
      // time then lines up exactly with the live output that follows it.
      session.term.write(data, () => {
        this.emit('output', id, data)
        if (renamed) this.syncName(session)
      })
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
    const repaint = now < (a.repaintUntil ?? 0)
    if (!repaint) {
      if (now - a.lastOutputAt > 5000) a.activeSince = now
      a.lastOutputAt = now
    }

    // Track the last meaningful line for the overview's "what's it doing".
    const clean = stripAnsi(data)
    s.recentText = s.recentText.slice(-120) + clean
    this.notePrs(s)
    const lines = clean.split(/\r?\n/).map((l) => l.trim())
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]) {
        s.lastLine = lines[i].slice(0, 160)
        break
      }
    }

    // Scrape agent-reported progress: [[WH-PROGRESS pct=60 eta=4m note="..."]]
    let m: RegExpExecArray | null
    PROGRESS_RE.lastIndex = 0
    let lastMatch: string | null = null
    while ((m = PROGRESS_RE.exec(clean))) lastMatch = m[1]
    if (lastMatch) s.progress = parseProgress(lastMatch)

    s.dirty = true
    this.scheduleFlush()
    // Working turns into idle once output stops for 10s: look again then.
    clearTimeout(a.recheckTimer)
    a.recheckTimer = setTimeout(() => this.scheduleFlush(), 10_500)

    if (repaint) return
    clearTimeout(a.idleTimer)
    a.idleTimer = setTimeout(() => {
      if (s.status !== 'running' || a.lastOutputAt - a.activeSince <= 8000) return
      const ac = s.meta.autoContinue
      if (ac.enabled && ac.sent < ac.maxNudges && s.proc) {
        // Keep the loop going instead of waiting for the human.
        ac.sent += 1
        s.proc.write(ac.prompt + '\r')
        this.emit('changed')
        this.emit(
          'notification',
          s.meta.id,
          'auto-continue',
          `${s.meta.name}: auto-continued (${ac.sent}/${ac.maxNudges})`,
        )
      } else {
        this.emit('notification', s.meta.id, 'idle', `${s.meta.name}: finished working — waiting for you`)
      }
    }, 20_000)
  }

  /** A real bell (the mirror's parser ignores the BEL that ends title updates). */
  private noteBell(s: Session) {
    const now = Date.now()
    if (now - s.activity.lastBellAt < 10_000) return
    s.activity.lastBellAt = now
    this.emit('notification', s.meta.id, 'attention', `${s.meta.name}: Claude needs your attention`)
    this.scheduleFlush()
    setTimeout(() => this.scheduleFlush(), 30_500) // attention wears off after 30s
  }

  private flushTimer?: ReturnType<typeof setTimeout>

  /** Coalesce activity updates into at most one broadcast every 1.5s. */
  private scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushActivity()
    }, 1500)
  }

  /**
   * Keep clients' live view current (status icon, "what it's doing") without
   * streaming every spinner frame: read the rendered screen of chats that
   * printed something, and broadcast only if what a card shows changed.
   */
  private flushActivity() {
    let changed = false
    for (const s of this.sessions.values()) {
      if (s.dirty) {
        s.dirty = false
        s.doing = s.term.doing()
        const asking = s.term.asking()
        if (asking && !s.asking) this.emit('notification', s.meta.id, 'attention', `${s.meta.name}: waiting for your answer`)
        s.asking = asking
      }
      const shown = `${this.activityStatus(s)}|${s.doing || s.lastLine}|${JSON.stringify(s.progress ?? null)}`
      if (shown !== s.shown) {
        s.shown = shown
        changed = true
      }
    }
    if (changed) this.emit('changed')
  }

  /** Follow Claude's `/rename`: the chat takes the name from its confirmation. */
  private syncName(s: Session) {
    const name = s.term.renamedTo()
    if (!name || name === s.claudeName) return
    s.claudeName = name
    if (name === s.meta.name) return
    s.meta.name = name
    this.persistMeta()
    this.emit('changed')
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  attach(id: string, cols: number, rows: number): string {
    const s = this.mustGet(id)
    s.attachedClients += 1
    this.resize(id, cols, rows)
    this.emit('changed')
    // The rendered screen + full scrollback at the client's size: its size
    // follows the lines of history, not how much the spinner has redrawn.
    return s.term.snapshot()
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
    // Manual input means the human is steering — reset the auto-continue
    // budget so it can help again after this fresh interaction.
    s.meta.autoContinue.sent = 0
    s.proc.write(data)
  }

  /**
   * Kill every live pty child. Called on daemon shutdown so the service stop
   * doesn't have to reach into a live process tree (which crashed winsw and
   * orphaned the daemon). Sessions come back as "lost" (relaunchable).
   */
  killAllProcs() {
    for (const s of this.sessions.values()) {
      if (s.proc) {
        try {
          s.proc.kill()
        } catch {
          /* already gone */
        }
      }
    }
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
    if (!s) return
    // ConPTY (and the TUI) redraw right after a resize; opening a chat must
    // not make it look busy.
    if (s.term.resize(cols, rows)) s.activity.repaintUntil = Date.now() + 1500
    try {
      s.proc?.resize(cols, rows)
    } catch {
      // The process exited but onExit hasn't fired yet (ConPTY reports exit
      // late) — nothing left to resize, and attaching must still succeed.
    }
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
    s.term.dispose()
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
