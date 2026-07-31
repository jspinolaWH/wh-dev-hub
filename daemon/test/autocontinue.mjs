// Verify auto-continue: a session that works then goes idle gets the nudge
// injected automatically (up to the cap), and only when enabled.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let output = ''
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'attached') output += m.scrollback
  if (m.t === 'output' && m.sessionId === sessionId) output += m.data
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

// A shell that echoes what it's told. It "works" for ~9s (so worked>8s), then
// goes quiet — the idle detector should fire ~20s later and auto-nudge.
ws.send(
  JSON.stringify({
    t: 'create',
    name: 'ac-test',
    cwd: 'C:\\Users\\drasm\\Desktop',
    command: '',
    cols: 100,
    rows: 30,
  }),
)
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 100, rows: 30 }))
await sleep(800)

// Enable auto-continue with a distinctive nudge.
ws.send(JSON.stringify({ t: 'set-auto-continue', sessionId, enabled: true, prompt: 'echo NUDGE_MARK_771', maxNudges: 2 }))
await sleep(300)

// Generate >8s of "work" output, then stop and wait for the idle nudge.
ws.send(JSON.stringify({ t: 'input', sessionId, data: 'powershell -NoProfile -Command "1..9 | %{ Write-Host work$_; Start-Sleep 1 }"\r' }))
// NOTE: manual input resets the nudge budget — that's fine, it re-arms.
console.log('working ~9s then waiting ~25s for auto-nudge...')
await sleep(9000 + 25000)

const nudged = (output.match(/NUDGE_MARK_771/g) || []).length
console.log('auto-nudge fired (echoed marker count):', nudged)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
// The command line itself echoes the marker once when typed; the auto-nudge
// makes it appear AGAIN (>=2 total). Require >=2 to prove the nudge ran.
if (nudged >= 2) console.log('AUTO-CONTINUE TEST PASSED')
else throw new Error(`FAIL: marker seen ${nudged} times (expected >=2 with a nudge)`)
