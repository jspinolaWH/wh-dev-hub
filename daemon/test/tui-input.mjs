// Repro: does typed input reach Claude Code's full TUI through our pipeline?
// Creates a `claude` session, waits for the TUI, types a marker, and checks
// whether the marker is echoed into the input box.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let output = ''
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.t === 'created') sessionId = msg.session.id
  if (msg.t === 'attached') output += msg.scrollback
  if (msg.t === 'output' && msg.sessionId === sessionId) output += msg.data
  if (msg.t === 'error') console.log('daemon error:', msg.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

ws.send(JSON.stringify({ t: 'create', name: 'tui-input', cwd: 'C:\\Users\\drasm\\Desktop', command: 'claude', cols: 120, rows: 30 }))
const deadline = Date.now() + 10_000
while (!sessionId && Date.now() < deadline) await sleep(100)
if (!sessionId) throw new Error('session was never created')
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 120, rows: 30 }))

console.log('waiting 12s for the TUI to boot...')
await sleep(12000)
const flickerFree = output.includes('flicker-free')
console.log('boot output length:', output.length, '| flicker-free banner seen:', flickerFree)
console.log('boot output tail:', JSON.stringify(output.slice(-300)))

output = ''
const MARKER = 'zqxj'
for (const ch of MARKER) {
  ws.send(JSON.stringify({ t: 'input', sessionId, data: ch }))
  await sleep(150)
}
await sleep(2500)

const echoed = output.includes(MARKER) || [...MARKER].every((c) => output.includes(c))
console.log('typed marker echoed back:', echoed)
if (!echoed) {
  console.log('--- last 600 chars of raw output after typing:')
  console.log(JSON.stringify(output.slice(-600)))
}

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(800)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
console.log(echoed ? 'INPUT OK' : 'INPUT FROZEN (reproduced)')
