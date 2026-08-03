// Verify per-user isolation: user B does not see or attach to user A's sessions.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const tokens = config.tokens
const devToken = Object.entries(tokens).find(([, u]) => u === 'dev')?.[0]
// pick a second, different user token; add one if missing
let otherToken = Object.entries(tokens).find(([, u]) => u !== 'dev')?.[0]
if (!otherToken) {
  otherToken = 'isolation-test-token'
  tokens[otherToken] = 'tester2'
  fs.writeFileSync(new URL('../data/config.json', import.meta.url), JSON.stringify(config, null, 2))
  console.log('NOTE: added a tester2 token; restart the daemon before running. Re-run after restart.')
  process.exit(2)
}
const otherUser = tokens[otherToken]
const url = `ws://${config.host}:${config.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const q = []
    const w = []
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (w.length) w.shift()(m)
      else q.push(m)
    })
    const next = () => new Promise((r) => (q.length ? r(q.shift()) : w.push(r)))
    ws.on('open', () => resolve({ ws, next }))
  })
}

const dev = await connect(devToken)
dev.ws.send(JSON.stringify({ t: 'hello', token: devToken }))
let m = await dev.next()
while (m.t !== 'hello-ok') m = await dev.next()

// dev creates a private session
dev.ws.send(JSON.stringify({ t: 'create', name: 'dev-private', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 80, rows: 24 }))
while (m.t !== 'created') m = await dev.next()
const devSession = m.session.id
console.log('dev created', devSession)

// other user connects
const other = await connect(otherToken)
other.ws.send(JSON.stringify({ t: 'hello', token: otherToken }))
m = await other.next()
while (m.t !== 'hello-ok') m = await other.next()
const otherSeesDev = m.sessions.some((s) => s.id === devSession)
console.log(`${otherUser} sees dev's session in hello-ok:`, otherSeesDev)

// other user explicitly lists
other.ws.send(JSON.stringify({ t: 'list' }))
m = await other.next()
while (m.t !== 'sessions') m = await other.next()
const otherListsDev = m.sessions.some((s) => s.id === devSession)
console.log(`${otherUser} sees dev's session in list:`, otherListsDev)

// other user tries to attach (should be rejected)
other.ws.send(JSON.stringify({ t: 'attach', sessionId: devSession, cols: 80, rows: 24 }))
m = await other.next()
while (m.t !== 'error' && m.t !== 'attached') m = await other.next()
const attachRejected = m.t === 'error'
console.log(`${otherUser} attach to dev's session rejected:`, attachRejected, m.t === 'error' ? `(${m.message})` : '')

// cleanup
dev.ws.send(JSON.stringify({ t: 'kill', sessionId: devSession }))
await sleep(500)
dev.ws.send(JSON.stringify({ t: 'remove', sessionId: devSession }))
await sleep(300)
dev.ws.close()
other.ws.close()

if (!otherSeesDev && !otherListsDev && attachRejected) console.log('ISOLATION TEST PASSED')
else throw new Error(`FAIL: sees(hello)=${otherSeesDev} sees(list)=${otherListsDev} attachRejected=${attachRejected}`)
