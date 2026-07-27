// Verify a pasted image is written to the host and its path injected into
// the session's input (which a shell echoes back so we can see it).
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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

// interactive shell so injected input is echoed back
ws.send(JSON.stringify({ t: 'create', name: 'paste-img', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 200, rows: 30 }))
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 200, rows: 30 }))
await sleep(1500)

output = ''
ws.send(JSON.stringify({ t: 'paste-image', sessionId, pngBase64: PNG_B64 }))
await sleep(1500)

const m = output.match(/[A-Za-z]:\\[^\s"']*paste-[^\s"']*\.png/)
const pathInjected = !!m
const fileExists = m ? fs.existsSync(m[0]) : false
console.log('path injected into terminal:', pathInjected, m ? m[0] : '(none)')
console.log('file written to host:', fileExists)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
if (pathInjected && fileExists) console.log('PASTE-IMAGE TEST PASSED')
else throw new Error(`FAIL: injected=${pathInjected} exists=${fileExists}`)
