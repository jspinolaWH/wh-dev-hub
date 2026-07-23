// Notification test: a session that works for ~10s then goes silent should
// produce an 'idle' notification ~20s later; a BEL should produce 'attention'.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const notifications = []
let sessionId = null

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.t === 'created') sessionId = msg.session.id
  if (msg.t === 'notification' && msg.sessionId === sessionId) {
    notifications.push(msg)
    console.log('notification:', msg.kind, '-', msg.message)
  }
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(500)

// Bell first, then 10s of steady work, then silence.
ws.send(
  JSON.stringify({
    t: 'create',
    name: 'notify-test',
    cwd: process.cwd(),
    command:
      'powershell -NoProfile -Command "Write-Host ([char]7); 1..20 | ForEach-Object { Write-Host work-$_; Start-Sleep -Milliseconds 500 }; Start-Sleep 45"',
    cols: 80,
    rows: 24,
  }),
)

await sleep(38_000) // 10s work + 20s idle threshold + buffer

const kinds = notifications.map((n) => n.kind)
if (!kinds.includes('attention')) throw new Error('FAIL: no bell/attention notification: ' + kinds.join(','))
if (!kinds.includes('idle')) throw new Error('FAIL: no idle notification: ' + kinds.join(','))

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(1500)
if (!notifications.some((n) => n.kind === 'exit')) throw new Error('FAIL: no exit notification')
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
console.log('NOTIFY TEST PASSED')
