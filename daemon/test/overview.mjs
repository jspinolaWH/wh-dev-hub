// Verify overview fields: activityStatus, lastLine, and scraped WH-PROGRESS.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let latest = null
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if ((m.t === 'sessions' || m.t === 'created') && sessionId) {
    const list = m.sessions ?? [m.session]
    const s = list.find((x) => x.id === sessionId)
    if (s) latest = s
  }
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)
ws.send(JSON.stringify({ t: 'create', name: 'ov-test', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 100, rows: 30 }))
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 100, rows: 30 }))
await sleep(800)

// Emit a normal line + a WH-PROGRESS line.
ws.send(JSON.stringify({ t: 'input', sessionId, data: 'echo Fixing the CRM picker company mismatch\r' }))
await sleep(600)
ws.send(JSON.stringify({ t: 'input', sessionId, data: 'echo [[WH-PROGRESS pct=60 eta=4m note="wiring the price API"]]\r' }))
await sleep(1500)
ws.send(JSON.stringify({ t: 'list' }))
await sleep(800)

const snap = latest // capture while still running (before kill flips it offline)
console.log('activityStatus:', snap?.activityStatus)
console.log('lastLine:', JSON.stringify(snap?.lastLine))
console.log('progress:', JSON.stringify(snap?.progress))

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()

const p = snap?.progress
const ok =
  snap &&
  ['working', 'idle', 'attention'].includes(snap.activityStatus) &&
  typeof snap.lastLine === 'string' &&
  p &&
  p.pct === 60 &&
  p.eta === '4m' &&
  p.note === 'wiring the price API'
if (ok) console.log('OVERVIEW TEST PASSED')
else throw new Error('FAIL: ' + JSON.stringify({ status: snap?.activityStatus, line: snap?.lastLine, progress: p }))
