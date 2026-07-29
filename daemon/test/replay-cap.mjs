// Verify attach replays only the recent tail (~256KB), not the whole buffer.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let scrollbackLen = null
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'attached' && m.sessionId === sessionId) scrollbackLen = m.scrollback.length
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

// Emit ~1MB of output (10000 lines of ~100 chars).
ws.send(
  JSON.stringify({
    t: 'create',
    name: 'replay-cap',
    cwd: 'C:\\Users\\drasm\\Desktop',
    command: 'powershell -NoProfile -Command "1..10000 | ForEach-Object { \'LINE_\' + $_ + \'_\' + (\'x\' * 90) }"',
    cols: 120,
    rows: 30,
  }),
)
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
await sleep(6000) // let it finish emitting

ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 120, rows: 30 }))
const adl = Date.now() + 8000
while (scrollbackLen === null && Date.now() < adl) await sleep(200)
console.log('replayed scrollback chars:', scrollbackLen)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
// Should be capped near 256KB, well under the ~1MB produced.
if (scrollbackLen !== null && scrollbackLen <= 300_000 && scrollbackLen > 100_000) console.log('REPLAY CAP TEST PASSED')
else throw new Error(`FAIL: replayed ${scrollbackLen} chars (expected ~256KB)`)
