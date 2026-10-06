// Status page feed: with config.statusPage set, the daemon publishes
// status.json as one orphan commit on a branch (created by the first
// heartbeat, force-moved after that), counts sessions and people without
// naming them, checks its own listeners plus configured extras, and keeps an
// uptime log across restarts that the page reads back as the same story.
// Without the config it does none of this.
// Self-contained: runs its own daemons against a mock GitHub.
import WebSocket from 'ws'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { availability, outages, timeline } from '../../status-page/uptime.mjs'

const daemonDir = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (label, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}

// ---- mock GitHub: just the git data API the daemon uses ----
const gh = { refs: {}, trees: {}, commits: {}, calls: [], n: 0 }
const base = '/repos/acme/hub/git'
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {}
    gh.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json })
    const send = (status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (req.method === 'POST' && req.url === `${base}/trees`) {
      const sha = `tree${++gh.n}`
      gh.trees[sha] = json.tree
      return send(201, { sha })
    }
    if (req.method === 'POST' && req.url === `${base}/commits`) {
      const sha = `commit${++gh.n}`
      gh.commits[sha] = json
      return send(201, { sha })
    }
    if (req.method === 'PATCH' && req.url.startsWith(`${base}/refs/heads/`)) {
      const ref = req.url.slice(`${base}/refs/`.length)
      if (!gh.refs[ref]) return send(422, { message: 'Reference does not exist' })
      gh.refs[ref] = json.sha
      return send(200, { ref: `refs/${ref}`, object: { sha: json.sha } })
    }
    if (req.method === 'POST' && req.url === `${base}/refs`) {
      const ref = json.ref.replace(/^refs\//, '')
      if (gh.refs[ref]) return send(422, { message: 'Reference already exists' })
      gh.refs[ref] = json.sha
      return send(201, { ref: json.ref, object: { sha: json.sha } })
    }
    send(404, { message: 'Not Found' })
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const apiUrl = `http://127.0.0.1:${mock.address().port}`

/** What the status branch holds right now. */
const published = () => {
  const commit = gh.commits[gh.refs['heads/status']]
  if (!commit) return null
  const files = Object.fromEntries(gh.trees[commit.tree].map((f) => [f.path, f.content]))
  return { sha: gh.refs['heads/status'], commit, files, doc: JSON.parse(files['status.json']) }
}
const nextPublish = async (after) => {
  for (let i = 0; i < 300; i++) {
    const p = published()
    if (p && p.sha !== after) return p
    await sleep(50)
  }
  return null
}

// ---- something listening (a "database") and a port with nothing on it ----
const db = net.createServer((s) => s.end())
await new Promise((r) => db.listen(0, '127.0.0.1', r))
const free = net.createServer()
await new Promise((r) => free.listen(0, '127.0.0.1', r))
const freePort = free.address().port
await new Promise((r) => free.close(r))

// ---- throwaway daemons ----
async function startDaemon(port, dataDir, extra) {
  const config = {
    host: '127.0.0.1',
    port,
    otelPort: port + 2,
    tokens: { 'status-test-token': 'statususer', 'second-token': 'otheruser' },
    ...extra,
  }
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config))
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: daemonDir,
    env: { ...process.env, WH_HUB_DATA: dataDir, GITHUB_TOKEN: '', GH_TOKEN: '' },
  })
  let log = ''
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => (log += d) && log.includes('daemon listening') && resolve())
    proc.stderr.on('data', (d) => (log += d))
    proc.on('exit', () => reject(new Error(`daemon exited:\n${log}`)))
  })
  // The "listening" log line comes just before the port is bound: retry.
  let ws
  for (let i = 0; ; i++) {
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const opened = await new Promise((r) => (ws.once('open', () => r(true)), ws.once('error', () => r(false))))
    if (opened) break
    if (i > 50) throw new Error(`daemon on ${port} never accepted connections`)
    await sleep(100)
  }
  const c = { proc, dataDir, ws, sessions: [], log: () => log }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.t === 'sessions' || m.t === 'hello-ok') c.sessions = m.sessions
    if (m.t === 'error') console.log('daemon error:', m.message)
  })
  c.send = (msg) => ws.send(JSON.stringify(msg))
  c.send({ t: 'hello', token: 'status-test-token' })
  await sleep(300)
  c.stop = async () => {
    for (const s of c.sessions) if (s.status === 'running') c.send({ t: 'kill', sessionId: s.id })
    await sleep(800)
    ws.close()
    proc.kill() // abrupt on Windows: the run ends as "lost", not as a clean stop
    await new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', r)))
  }
  return c
}

const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-status-test-'))
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-status-off-'))
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cwd-'))
const statusPage = {
  repo: 'acme/hub',
  token: 'gh-status-token',
  apiUrl,
  checks: [
    { name: 'Fake DB', tcp: `127.0.0.1:${db.address().port}` },
    { name: 'Gone service', tcp: `127.0.0.1:${freePort}` },
    { name: 'Typo', tcp: 'nonsense' },
  ],
}

let a = await startDaemon(7951, dataA, { statusPage })
const b = await startDaemon(7961, dataB, {})
try {
  a.send({ t: 'create', name: 'Top Secret Chat', cwd: secretDir, command: 'node -e "setInterval(()=>{},1000)"', cols: 100, rows: 30 })

  // ---- first heartbeat: creates the branch ----
  const first = await nextPublish()
  check('first heartbeat published within seconds of start', !!first)
  const calls = gh.calls.map((c) => `${c.method} ${c.url.slice(base.length)}`)
  check(
    'branch created on first heartbeat (tree, orphan commit, ref)',
    calls.join() === 'POST /trees,POST /commits,PATCH /refs/heads/status,POST /refs' && first.commit.parents.length === 0,
    calls,
  )
  check('authenticated with the configured token', gh.calls.every((c) => c.auth === 'Bearer gh-status-token'))
  check('branch holds status.json + README.md', Object.keys(first.files).sort().join() === 'README.md,status.json')
  check('log says where it publishes', a.log().includes('status page: publishing to acme/hub@status every 120s'))

  const doc = first.doc
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: daemonDir, encoding: 'utf8' }).trim()
  check(
    'heartbeat basics: schema, cadence, fresh, build commit, host stats',
    doc.schema === 1 &&
      doc.intervalSec === 120 &&
      Date.now() - Date.parse(doc.generatedAt) < 30_000 &&
      doc.hub.build?.sha === head &&
      doc.host.cpu.cores > 0 &&
      doc.host.memory.totalBytes > doc.host.memory.usedBytes &&
      doc.host.disk?.totalBytes > doc.host.disk?.freeBytes,
    { build: doc.hub.build?.sha, cpu: doc.host.cpu, disk: doc.host.disk },
  )
  check(
    'counts sessions and people',
    doc.sessions.running === 1 && doc.sessions.stopped === 0 && doc.people.online === 1 && doc.people.registered === 2,
    { sessions: doc.sessions, people: doc.people },
  )
  const text = first.files['status.json']
  const leaks = ['Top Secret Chat', path.basename(secretDir), 'statususer', 'otheruser', 'status-test-token', 'second-token', 'gh-status-token'].filter(
    (s) => text.includes(s),
  )
  check('publishes no names, paths or tokens', leaks.length === 0, leaks)

  const comp = Object.fromEntries(doc.components.map((c) => [c.name, c]))
  const ids = doc.components.map((c) => c.id).join()
  check('components carry stable ids', ids === 'web,usage,claude,custom,custom,custom', ids)
  check('own web listener answered', /^HTTP \d{3}$/.test(comp['Web client & WebSocket']?.detail ?? ''), comp['Web client & WebSocket'])
  check('usage receiver up', comp['Usage receiver (OTLP)']?.ok === true, comp['Usage receiver (OTLP)'])
  check('configured check up', comp['Fake DB']?.ok === true && comp['Fake DB'].ms >= 0, comp['Fake DB'])
  check('configured check down', comp['Gone service']?.ok === false && /nothing listening/.test(comp['Gone service'].detail), comp['Gone service'])
  check('bad check entry reported, not fatal', comp['Typo']?.ok === false && /bad address/.test(comp['Typo'].detail), comp['Typo'])
  check('Claude CLI checked', 'Claude Code CLI' in comp && !!comp['Claude Code CLI'].detail, comp['Claude Code CLI'])
  check('no Slack check without Slack', !('Slack sign-in callback' in comp))
  check('one uptime run so far', doc.uptime.runs.length === 1 && Date.parse(doc.uptime.since) <= Date.parse(doc.uptime.runs[0].start))

  check('without statusPage: says so, tracks nothing', b.log().includes('status page not configured') && !fs.existsSync(path.join(dataB, 'uptime.json')))

  // ---- restart: the next heartbeat force-moves the branch; the gap is an outage ----
  await a.stop()
  const before = published().sha
  gh.calls = []
  a = await startDaemon(7951, dataA, { statusPage })
  const second = await nextPublish(before)
  check(
    'after a restart, the branch is force-moved to a new orphan commit',
    gh.calls.some((c) => c.method === 'PATCH' && c.body.force === true) &&
      !gh.calls.some((c) => c.url === `${base}/refs`) &&
      second?.commit.parents.length === 0,
    gh.calls.map((c) => `${c.method} ${c.url.slice(base.length)}`),
  )
  const runs = second.doc.uptime.runs
  check(
    'uptime log kept across the restart; the killed run ended unclean',
    runs.length === 2 && !runs[0].clean && Date.parse(runs[1].start) > Date.parse(runs[0].end),
    runs,
  )
  check('lost session counted as stopped', second.doc.sessions.running === 0 && second.doc.sessions.stopped === 1, second.doc.sessions)

  const now = Date.now()
  const tl = timeline(second.doc, now)
  const gaps = outages(tl, now)
  check('page: reads as live', tl.state === 'live', tl.state)
  check('page: the restart is one unexpected restart', gaps.length === 1 && gaps[0].kind === 'unexpected-restart' && gaps[0].ms > 0, gaps)
  const avail = availability(tl, tl.from, now)
  check('page: availability just under 100%', avail.ratio > 0.5 && avail.ratio < 1, avail)
  await a.stop()

  // ---- clean stops (in-process: a test can't signal a daemon on Windows) ----
  const stopRun = () =>
    spawnSync(process.execPath, ['--import', 'tsx', 'test/status-stop.mjs'], { cwd: daemonDir, env: { ...process.env, WH_HUB_DATA: dataA } })
  stopRun()
  await sleep(1500)
  stopRun()
  const log = JSON.parse(fs.readFileSync(path.join(dataA, 'uptime.json'), 'utf8'))
  check('shutdown marks the run as a clean stop', log.runs.length === 4 && log.runs[2].clean && log.runs[3].clean, log.runs)
  const end = Date.parse(log.runs[3].end)
  const story = outages(timeline({ generatedAt: new Date(end).toISOString(), intervalSec: 120, uptime: log }, end + 1000), end + 1000)
  check(
    'page: clean stop + start reads as a restart, lost runs as unexpected',
    story.map((o) => o.kind).join() === 'restart,unexpected-restart,unexpected-restart',
    story.map((o) => o.kind),
  )
  const offline = timeline({ generatedAt: new Date(end).toISOString(), intervalSec: 120, uptime: log }, end + 60 * 60_000)
  const offlineGaps = outages(offline, end + 60 * 60_000)
  check(
    'page: an hour without heartbeats reads as offline, stopped',
    offline.state === 'offline' && offlineGaps[0]?.ongoing && offlineGaps[0].kind === 'stopped',
    offlineGaps[0],
  )
} finally {
  await a.stop().catch(() => {})
  await b.stop()
  mock.close()
  db.close()
  for (const dir of [dataA, dataB, secretDir]) fs.rmSync(dir, { recursive: true, force: true })
}

if (checks.some((ok) => !ok)) throw new Error('FAIL: see above')
console.log('STATUS TEST PASSED')
