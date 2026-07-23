// Verify: empty command => interactive shell that accepts typed commands.
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

// command '' => shell
ws.send(JSON.stringify({ t: 'create', name: 'shell-test', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 100, rows: 30 }))
const deadline = Date.now() + 10_000
while (!sessionId && Date.now() < deadline) await sleep(100)
if (!sessionId) throw new Error('no session created')
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 100, rows: 30 }))
await sleep(2000)

// type an echo command
output = ''
ws.send(JSON.stringify({ t: 'input', sessionId, data: 'echo SHELL_MARK_9931\r' }))
await sleep(2500)
const ok = output.includes('SHELL_MARK_9931')
console.log('shell echoed command output:', ok)
if (!ok) console.log('tail:', JSON.stringify(output.slice(-400)))

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(800)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
console.log(ok ? 'SHELL MODE OK' : 'SHELL MODE FAILED')
