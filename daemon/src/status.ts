import { exec, execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, type HubConfig } from './config'
import { ghAuthToken } from './prs'
import type { HubServer } from './server'
import type { SessionManager } from './sessions'

// Feed for the status page. GitHub Pages can't reach this host (it lives on
// the tailnet), so the hub reports out instead: every couple of minutes it
// rewrites status.json on a branch of the repo, and the page reads it from
// there. A heartbeat that stops arriving is how the page knows the hub is down.
//
// Pages sites are public, so this only ever publishes health, counts and host
// stats — never user names, chat names, paths or Claude spend.

export interface StatusPageConfig {
  /** GitHub repo ("owner/name") whose `branch` receives status.json; the Pages site reads it there. */
  repo: string
  /** Rewritten as one fresh commit on every heartbeat. Default "status". */
  branch?: string
  /** Contents read & write on `repo`. Falls back to GITHUB_TOKEN / GH_TOKEN, then the host's `gh` login. */
  token?: string
  /** Seconds between heartbeats: default 120, at least 60 (GitHub's raw CDN caches for 5 minutes anyway). */
  intervalSec?: number
  /** More things on this machine to watch, e.g. { "name": "Postgres", "tcp": "127.0.0.1:5432" }. */
  checks?: CheckSpec[]
  /** GitHub REST API base (tests point it at a mock). */
  apiUrl?: string
}

export type CheckSpec = { name: string; tcp: string } | { name: string; http: string }

interface CheckResult {
  ok: boolean
  /** What was found: "HTTP 200", "connection refused", "v2.1.0"... */
  detail: string
  /** Response time, when it answered. */
  ms?: number
}

/** A stretch the hub was up (listening). `clean`: it was stopped, rather than lost (crash, power, sleep). */
interface Run {
  start: number
  end: number
  clean?: boolean
}

/** What status.json holds: the page's whole view of the hub. */
export interface StatusDoc {
  schema: 1
  generatedAt: string
  /** Seconds between heartbeats: the page uses it to tell "late" from "down". */
  intervalSec: number
  hub: { startedAt: string; node: string; build?: { sha: string; date: string; subject: string } }
  host: {
    os: string
    arch: string
    uptimeSec: number
    cpu: { model: string; cores: number; usagePct?: number }
    memory: { totalBytes: number; usedBytes: number }
    disk?: { drive: string; totalBytes: number; freeBytes: number }
  }
  sessions: { running: number; working: number; idle: number; attention: number; stopped: number }
  people: { online: number; connections: number; registered: number }
  /** `id` is stable for the built-in checks (web, signin, usage, claude); config-added ones are "custom". */
  components: ({ id: string; name: string } & CheckResult)[]
  /** The last 90 days of runs, oldest first; tracking began at `since`. */
  uptime: { since: string; runs: { start: string; end: string; clean?: true }[] }
}

const UPTIME_PATH = path.join(DATA_DIR, 'uptime.json')
const TICK_MS = 60_000
const KEEP_MS = 90 * 86_400_000
const MAX_RUNS = 1000

const BRANCH_README = `# Dev Hub status feed

Written by the WasteHero Dev Hub daemon every couple of minutes: \`status.json\`
is what the status page shows. Each heartbeat replaces the branch with a single
fresh commit, so it has no history — don't base work on it.
`

export class StatusReporter {
  private branch: string
  private intervalMs: number
  private since = 0
  private runs: Run[] = []
  private lastTick = 0
  private timers: NodeJS.Timeout[] = []
  private cpu?: { idle: number; total: number; usagePct?: number }
  private build?: Promise<StatusDoc['hub']['build']>
  private claude?: { at: number; result: CheckResult }
  private publishing = false
  /** Last publish error (logged once until it changes); false once a publish succeeded. */
  private failing?: string | false
  private saveFailed = false

  constructor(
    private opts: { statusPage: StatusPageConfig; config: HubConfig; sessions: SessionManager; server: HubServer; otelPort: number },
  ) {
    this.branch = opts.statusPage.branch || 'status'
    this.intervalMs = Math.max(60, opts.statusPage.intervalSec ?? 120) * 1000
    // Uptime counts from when clients can actually connect: a daemon that
    // can't bind its port (crash-looping on EADDRINUSE) is down, not up.
    if (opts.server.http.listening) this.start()
    else opts.server.http.once('listening', () => this.start())
  }

  private start() {
    const now = Date.now()
    this.load()
    if (!this.since) this.since = now // tracking starts with this run
    this.runs.push({ start: now, end: now })
    this.lastTick = now
    this.save()
    this.sampleCpu()
    this.build = buildInfo()
    this.timers.push(setInterval(() => this.tick(), TICK_MS), setInterval(() => void this.beat(), this.intervalMs))
    // First heartbeat soon, so a restart shows up quickly, but not before the
    // Slack callback (started asynchronously) has had a chance to listen.
    this.timers.push(setTimeout(() => void this.beat(), 5000))
    for (const t of this.timers) t.unref()
    console.log(`[wh-dev-hub] status page: publishing to ${this.opts.statusPage.repo}@${this.branch} every ${this.intervalMs / 1000}s`)
  }

  /** On shutdown: the run ends now, and on purpose. */
  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const run = this.runs.at(-1)
    if (!run) return
    run.end = Date.now()
    run.clean = true
    this.save()
  }

  private tick() {
    const now = Date.now()
    const run = this.runs.at(-1)!
    // Minutes passed without a tick: the machine was suspended (sleep or
    // hibernate), so the hub was unreachable since the last one.
    if (now - this.lastTick > 3 * TICK_MS) this.runs.push({ start: now, end: now })
    else run.end = Math.max(run.end, now) // a clock stepped back must not end the run before it began
    this.lastTick = now
    this.prune(now)
    this.save()
    this.sampleCpu()
  }

  private prune(now: number) {
    this.runs = this.runs.filter((r) => r.end >= now - KEEP_MS).slice(-MAX_RUNS)
    // Older history dropped by the cap mustn't read as downtime on the page.
    if (this.runs.length === MAX_RUNS) this.since = Math.max(this.since, this.runs[0].start)
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(UPTIME_PATH, 'utf8')) as { since: string; runs: { start: string; end: string; clean?: boolean }[] }
      this.since = Date.parse(raw.since)
      this.runs = raw.runs
        .map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end), ...(r.clean && { clean: true }) }))
        .filter((r) => r.end >= r.start)
      if (Number.isNaN(this.since)) throw new Error('bad "since"')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[wh-dev-hub] status page: ${UPTIME_PATH} unreadable, starting a new uptime log:`, errText(err))
      }
      this.since = 0
      this.runs = []
    }
  }

  private save() {
    try {
      fs.writeFileSync(UPTIME_PATH, JSON.stringify(this.uptime(), null, 1))
      this.saveFailed = false
    } catch (err) {
      if (!this.saveFailed) console.error('[wh-dev-hub] status page: could not save the uptime log:', errText(err))
      this.saveFailed = true
    }
  }

  private uptime(): StatusDoc['uptime'] {
    return {
      since: new Date(this.since).toISOString(),
      runs: this.runs.map((r) => ({
        start: new Date(r.start).toISOString(),
        end: new Date(r.end).toISOString(),
        ...(r.clean && { clean: true as const }),
      })),
    }
  }

  /** CPU busy share across all cores since the previous sample (os.loadavg() is always 0 on Windows). */
  private sampleCpu() {
    let idle = 0
    let total = 0
    for (const { times } of os.cpus()) {
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const prev = this.cpu
    const usagePct = prev && total > prev.total ? Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total))) : prev?.usagePct
    this.cpu = { idle, total, usagePct }
  }

  private async beat() {
    if (this.publishing) return
    this.publishing = true
    const { repo } = this.opts.statusPage
    try {
      // Through tick(), so the run reaches "now" only if we weren't asleep since the last one.
      this.tick()
      await this.publish(await this.snapshot())
      if (this.failing) console.log(`[wh-dev-hub] status page: publishing to ${repo} again`)
      this.failing = false
    } catch (err) {
      const message = errText(err)
      if (this.failing !== message) console.error(`[wh-dev-hub] status page: publish failed: ${message}`)
      this.failing = message
    } finally {
      this.publishing = false
    }
  }

  private async snapshot(): Promise<StatusDoc> {
    const { config, sessions, server } = this.opts
    const list = sessions.list()
    const running = list.filter((s) => s.status === 'running')
    const doing = (a: string) => running.filter((s) => s.activityStatus === a).length
    const { clients, users } = server.connections()
    const now = Date.now()

    let disk: StatusDoc['host']['disk']
    try {
      const st = fs.statfsSync(DATA_DIR)
      disk = { drive: path.parse(DATA_DIR).root.replace(/[\\/]+$/, '') || '/', totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize }
    } catch {
      /* no statfs on this platform */
    }
    const cpus = os.cpus()

    return {
      schema: 1,
      generatedAt: new Date(now).toISOString(),
      intervalSec: this.intervalMs / 1000,
      hub: { startedAt: new Date(this.runs.at(-1)!.start).toISOString(), node: process.version, build: await this.build },
      host: {
        os: osName(),
        arch: os.arch(),
        uptimeSec: Math.round(os.uptime()),
        cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length, usagePct: this.cpu?.usagePct },
        memory: { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() },
        disk,
      },
      sessions: {
        running: running.length,
        working: doing('working'),
        idle: doing('idle'),
        attention: doing('attention'),
        stopped: list.length - running.length,
      },
      people: { online: users, connections: clients, registered: new Set(Object.values(config.tokens)).size },
      components: await this.checkComponents(),
      uptime: this.uptime(),
    }
  }

  /** The hub's own listeners, the Claude CLI sessions run, and whatever the config adds. */
  private checkComponents(): Promise<StatusDoc['components']> {
    const { config, statusPage, otelPort } = this.opts
    const host = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host
    const checks: [id: string, name: string, run: () => Promise<CheckResult>][] = [
      ['web', 'Web client & WebSocket', () => httpCheck(`http://${host.includes(':') ? `[${host}]` : host}:${config.port}/`)],
    ]
    if (config.slack?.clientId) checks.push(['signin', 'Slack sign-in callback', () => tcpCheck('127.0.0.1', config.slack!.httpsPort)])
    checks.push(['usage', 'Usage receiver (OTLP)', () => tcpCheck('127.0.0.1', otelPort)], ['claude', 'Claude Code CLI', () => this.claudeCheck()])
    for (const c of statusPage.checks ?? []) {
      if ('http' in c) checks.push(['custom', c.name, () => httpCheck(c.http)])
      else {
        const at = c.tcp.lastIndexOf(':')
        checks.push(['custom', c.name, () => tcpCheck(c.tcp.slice(0, at), Number(c.tcp.slice(at + 1)))])
      }
    }
    return Promise.all(checks.map(async ([id, name, run]) => ({ id, name, ...(await run()) })))
  }

  /** `claude --version` the way sessions launch it (through the shell); rechecked every 10 minutes. */
  private async claudeCheck(): Promise<CheckResult> {
    if (this.claude && Date.now() - this.claude.at < 10 * 60_000) return this.claude.result
    const result = await new Promise<CheckResult>((resolve) =>
      exec('claude --version', { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
        const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0]
        if (version) return resolve({ ok: true, detail: `v${version}` })
        // Not stderr itself: it can carry local paths, and this is published.
        if (err?.killed) return resolve({ ok: false, detail: 'timed out' })
        const missing = /not recognized|not found/i.test(stderr)
        resolve({ ok: false, detail: missing ? 'not found on PATH' : `failed (exit code ${err?.code ?? '?'})` })
      }),
    )
    this.claude = { at: Date.now(), result }
    return result
  }

  /**
   * Replace the branch with one fresh commit holding status.json: three API
   * calls, no checkout, and the branch never grows (old heartbeats are just
   * unreferenced objects GitHub collects).
   */
  private async publish(doc: StatusDoc) {
    const cfg = this.opts.statusPage
    const token = cfg.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (await ghAuthToken())
    if (!token) throw new Error('no GitHub token: set statusPage.token, or log in with `gh auth login` on this host')
    const api = async (method: string, route: string, body: unknown): Promise<{ sha: string }> => {
      const res = await fetch(`${cfg.apiUrl ?? 'https://api.github.com'}/repos/${cfg.repo}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'wh-dev-hub',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      const json = (await res.json().catch(() => ({}))) as { sha?: string; object?: { sha: string }; message?: string }
      if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${route}: ${json.message ?? `HTTP ${res.status}`}`), { status: res.status })
      return { sha: json.sha ?? json.object?.sha ?? '' }
    }
    const file = (name: string, content: string) => ({ path: name, mode: '100644', type: 'blob', content })
    const tree = await api('POST', '/git/trees', {
      tree: [file('status.json', `${JSON.stringify(doc, null, 2)}\n`), file('README.md', BRANCH_README)],
    })
    const commit = await api('POST', '/git/commits', { message: `Hub heartbeat ${doc.generatedAt}`, tree: tree.sha, parents: [] })
    try {
      await api('PATCH', `/git/refs/heads/${this.branch}`, { sha: commit.sha, force: true })
    } catch (err) {
      // The very first heartbeat: the branch doesn't exist yet.
      const status = (err as { status?: number }).status
      if (status !== 404 && status !== 422) throw err
      await api('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: commit.sha })
    }
  }
}

/** The commit the running bundle was built from (stamped by scripts/build.mjs); under tsx, the checkout's. */
function buildInfo(): Promise<StatusDoc['hub']['build']> {
  try {
    const stamped = JSON.parse(process.env.WH_BUILD || '{}') as NonNullable<StatusDoc['hub']['build']>
    if (stamped.sha) return Promise.resolve(stamped)
  } catch {
    /* fall through to git */
  }
  return new Promise((resolve) =>
    execFile('git', ['log', '-1', '--format=%H%n%cI%n%s'], { cwd: __dirname, timeout: 5000, windowsHide: true }, (err, stdout) => {
      const [sha, date, subject] = stdout.trim().split('\n')
      resolve(err || !sha ? undefined : { sha, date, subject })
    }),
  )
}

function osName(): string {
  let name = os.version()
  // Windows 11 still calls itself "Windows 10" here; its builds start at 22000.
  if (process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000) name = name.replace('Windows 10', 'Windows 11')
  return `${name} (${os.release()})`
}

function tcpCheck(host: string, port: number): Promise<CheckResult> {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, detail: 'bad address in config (want "host:port")' })
  }
  return new Promise((resolve) => {
    const t0 = performance.now()
    const sock = net.connect({ host, port })
    const done = (result: CheckResult) => {
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(3000, () => done({ ok: false, detail: 'timed out' }))
    sock.once('connect', () => done({ ok: true, detail: `port ${port} open`, ms: Math.round(performance.now() - t0) }))
    sock.once('error', (err: NodeJS.ErrnoException) =>
      done({ ok: false, detail: err.code === 'ECONNREFUSED' ? `nothing listening on ${port}` : (err.code ?? err.message) }),
    )
  })
}

async function httpCheck(url: string): Promise<CheckResult> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    await res.body?.cancel()
    return { ok: res.status < 400, detail: `HTTP ${res.status}`, ms: Math.round(performance.now() - t0) }
  } catch (err) {
    return { ok: false, detail: errText(err) }
  }
}

/** Short, human error text; fetch hides the real reason (ECONNREFUSED...) in `cause`. */
function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'TimeoutError') return 'timed out'
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
  return cause?.code ?? cause?.message ?? err.message
}
