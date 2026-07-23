// Smoke test: session keeps producing output while no client is connected.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.keys(config.tokens)[0]
const url = `ws://${config.host}:${config.port}`

function connect() {
  const ws = new WebSocket(url)
  const queue = []
  const waiters = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (waiters.length) waiters.shift()(msg)
    else queue.push(msg)
  })
  const next = () =>
    new Promise((resolve) => {
      if (queue.length) resolve(queue.shift())
      else waiters.push(resolve)
    })
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, next })))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Phase 1: create a 12-second ticking session, then disconnect immediately.
let { ws, next } = await connect()
ws.send(JSON.stringify({ t: 'hello', token }))
let msg = await next()
if (msg.t !== 'hello-ok') throw new Error('auth failed: ' + JSON.stringify(msg))
console.log('auth ok as', msg.user)

ws.send(
  JSON.stringify({
    t: 'create',
    name: 'smoke',
    cwd: process.cwd(),
    command: 'powershell -NoProfile -Command "1..12 | ForEach-Object { Write-Host tick-$_; Start-Sleep 1 }"',
    cols: 80,
    rows: 24,
  }),
)
while (msg.t !== 'created') msg = await next()
const sessionId = msg.session.id
console.log('created session', sessionId)
ws.close()
console.log('disconnected; sleeping 6s with NO client attached...')
await sleep(6000)

// --- Phase 2: reconnect, attach, verify scrollback has ticks emitted while away.
;({ ws, next } = await connect())
ws.send(JSON.stringify({ t: 'hello', token }))
msg = await next()
if (msg.t !== 'hello-ok') throw new Error('re-auth failed')
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 80, rows: 24 }))
while (msg.t !== 'attached') msg = await next()
const ticksInScrollback = [...msg.scrollback.matchAll(/tick-(\d+)/g)].map((m) => +m[1])
console.log('scrollback ticks on reattach:', ticksInScrollback.join(','))
if (Math.max(...ticksInScrollback, 0) < 4) {
  throw new Error('FAIL: session did not keep running while disconnected')
}

// --- Phase 3: keep attached until exit, confirm live streaming + exit event.
let sawExit = false
const deadline = Date.now() + 15000
while (Date.now() < deadline && !sawExit) {
  msg = await next()
  if (msg.t === 'exit' && msg.sessionId === sessionId) {
    console.log('exit event, code', msg.exitCode)
    sawExit = true
  }
}
if (!sawExit) throw new Error('FAIL: no exit event')
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
console.log('SMOKE TEST PASSED')
