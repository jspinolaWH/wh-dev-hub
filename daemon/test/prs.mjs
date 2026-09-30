// A chat's PRs: links in its output are collected (deduped, newest first,
// persisted); get-prs fills in GitHub state/checks/review and the Linear tasks
// each PR is attached to; results are cached; a removed PR stays removed; and
// without keys the list still works, just without statuses.
// Self-contained: runs its own daemons against a mock GitHub + Linear.
import WebSocket from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const daemonDir = fileURLToPath(new URL('..', import.meta.url))
const emitter = fileURLToPath(new URL('./pr-emitter.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (label, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}

// ---- mock GitHub + Linear GraphQL ----
const task = (identifier, state, color) => ({
  identifier,
  title: `${identifier} title`,
  url: `https://linear.app/wastehero/issue/${identifier}`,
  state: { name: state, type: 'started', color },
  assignee: { name: 'Jack Spinola' },
})
const GITHUB = {
  'wastehero/wastehero_frontend#1099': {
    title: 'fix(operations): washing approver role (COMPASS-1193)',
    url: 'https://github.com/WasteHero/wastehero_frontend/pull/1099',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    author: { login: 'kokas340' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  },
  'wastehero/wastehero_backend_v1#2132': {
    title: 'fix(routes): wash lists scope bins by zone',
    url: 'https://github.com/WasteHero/wastehero_backend_v1/pull/2132',
    state: 'MERGED',
    isDraft: false,
    reviewDecision: null,
    author: { login: 'kokas340' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  },
}
const LINEAR = {
  // Only the canonical (GitHub-cased) URLs are attached in Linear.
  'https://github.com/WasteHero/wastehero_frontend/pull/1099': [task('COMPASS-1193', 'In QA', '#f2c94c'), task('COMPASS-1193', 'In QA', '#f2c94c')],
  'https://github.com/WasteHero/wastehero_backend_v1/pull/2132': [task('COMPASS-1193', 'In QA', '#f2c94c'), task('COMPASS-1692', 'Done', '#5e6ad2')],
}
const seen = { github: 0, linear: 0, linearUrls: [], auth: [] }
const mock = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const { query } = JSON.parse(body)
    const data = {}
    const errors = []
    seen.auth.push(`${req.url} ${req.headers.authorization}`)
    if (req.url === '/github') {
      seen.github++
      if (req.headers.authorization !== 'bearer gh-test-token') return res.writeHead(401).end('{"message":"Bad credentials"}')
      for (const m of query.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
        const pr = GITHUB[`${m[2]}/${m[3]}#${m[4]}`.toLowerCase()]
        data[m[1]] = pr ? { pullRequest: pr } : null
        if (!pr) errors.push({ type: 'NOT_FOUND', path: [m[1]], message: `Could not resolve to a Repository ${m[2]}/${m[3]}` })
      }
    } else {
      seen.linear++
      if (req.headers.authorization !== 'lin-test-key') return res.writeHead(400).end('{"errors":[{"message":"Authentication required"}]}')
      for (const m of query.matchAll(/(a\d+): attachmentsForURL\(url: "([^"]+)"\)/g)) {
        seen.linearUrls.push(m[2])
        data[m[1]] = { nodes: (LINEAR[m[2]] ?? []).map((issue) => ({ issue })) }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, ...(errors.length && { errors }) }))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}`

// ---- throwaway daemons ----
async function startDaemon(port, extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prs-test-'))
  const config = { host: '127.0.0.1', port, otelPort: port + 2, tokens: { 'prs-test-token': 'dev' }, ...extra }
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config))
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: daemonDir,
    env: { ...process.env, WH_HUB_DATA: dataDir, GITHUB_TOKEN: '', GH_TOKEN: '', LINEAR_API_KEY: '' },
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
  const c = { proc, dataDir, ws, sessions: [], prs: null, created: null }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.t === 'sessions') c.sessions = m.sessions
    if (m.t === 'created') c.created = m.session
    if (m.t === 'prs') c.prs = m
    if (m.t === 'error') console.log('daemon error:', m.message)
  })
  ws.send(JSON.stringify({ t: 'hello', token: 'prs-test-token' }))
  await sleep(300)
  c.send = (msg) => ws.send(JSON.stringify(msg))
  c.getPrs = async (sessionId, refresh) => {
    c.prs = null
    c.send({ t: 'get-prs', sessionId, refresh })
    for (let i = 0; i < 100 && !c.prs; i++) await sleep(50)
    return c.prs
  }
  c.chat = async () => {
    c.send({ t: 'create', name: 'prs-test', cwd: path.dirname(emitter), command: `node "${emitter}"`, cols: 160, rows: 30 })
    for (let i = 0; i < 100 && !c.created; i++) await sleep(50)
    return c.created.id
  }
  c.refsOf = (id) => (c.sessions.find((s) => s.id === id)?.prs ?? []).map((p) => `${p.owner}/${p.repo}#${p.number}`)
  c.stop = async () => {
    for (const s of c.sessions) c.send({ t: 'kill', sessionId: s.id })
    await sleep(800)
    ws.close()
    proc.kill()
    await sleep(300)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return c
}

const a = await startDaemon(7931, {
  github: { token: 'gh-test-token', graphqlUrl: `${mockUrl}/github` },
  linear: { apiKey: 'lin-test-key', graphqlUrl: `${mockUrl}/linear` },
})
try {
  const id = await a.chat()
  for (let i = 0; i < 60 && a.refsOf(id).length < 3; i++) await sleep(100)
  check(
    'links collected once each, newest first (create-PR link ignored)',
    JSON.stringify(a.refsOf(id)) === JSON.stringify(['other/private#7', 'WasteHero/wastehero_backend_v1#2132', 'wastehero/wastehero_frontend#1099']),
    a.refsOf(id),
  )
  const saved = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'sessions.json'), 'utf8')).find((s) => s.id === id)
  check('persisted to sessions.json', saved?.prs?.length === 3)

  const r = await a.getPrs(id)
  const [priv, be, fe] = r.prs
  check('both sources answered', r.github === 'ok' && r.linear === 'ok', [r.github, r.linear])
  check(
    'GitHub state/checks/review mapped',
    fe.state === 'OPEN' && fe.review === 'APPROVED' && fe.checks === 'SUCCESS' && fe.author === 'kokas340' && be.state === 'MERGED' && be.checks === 'FAILURE',
    { fe: [fe.state, fe.review, fe.checks], be: [be.state, be.checks] },
  )
  check('canonical URL from GitHub', fe.url === 'https://github.com/WasteHero/wastehero_frontend/pull/1099', fe.url)
  check(
    'Linear tasks attached (deduped), looked up by canonical URL',
    fe.tasks.map((t) => `${t.identifier}:${t.state}`).join() === 'COMPASS-1193:In QA' &&
      be.tasks.map((t) => t.identifier).join() === 'COMPASS-1193,COMPASS-1692' &&
      seen.linearUrls.includes(fe.url),
    { fe: fe.tasks.map((t) => t.identifier), be: be.tasks.map((t) => t.identifier) },
  )
  check('PR we cannot see: listed, no status, no tasks', !priv.state && priv.tasks.length === 0 && priv.url.endsWith('/other/private/pull/7'))

  const calls = seen.github + seen.linear
  await a.getPrs(id)
  const cachedOk = seen.github + seen.linear === calls
  await a.getPrs(id, true)
  check('cached for a minute; refresh re-fetches', cachedOk && seen.github + seen.linear === calls + 2)

  a.send({ t: 'forget-pr', sessionId: id, pr: { owner: 'other', repo: 'private', number: 7 } })
  await sleep(6000) // the emitter prints that link again meanwhile
  check('removed PR stays removed when printed again', !a.refsOf(id).includes('other/private#7'), a.refsOf(id))
} finally {
  await a.stop()
}

// Without keys: the list still works, only without statuses.
const b = await startDaemon(7941, { github: { graphqlUrl: `${mockUrl}/github` } })
try {
  const id = await b.chat()
  for (let i = 0; i < 60 && b.refsOf(id).length < 3; i++) await sleep(100)
  const r = await b.getPrs(id)
  check(
    'no keys: PRs listed with links, Linear not configured, GitHub not ok',
    r.prs.length === 3 && r.prs.every((p) => p.url && !p.state) && r.linear === 'not-configured' && r.github !== 'ok',
    [r.github, r.linear],
  )
} finally {
  await b.stop()
  mock.close()
}

if (checks.some((ok) => !ok)) throw new Error('FAIL: see above')
console.log('PRS TEST PASSED')
