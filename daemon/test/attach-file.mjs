// Verify attach-file: bytes -> host file with sanitized name -> path injected.
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

ws.send(JSON.stringify({ t: 'create', name: 'attach-test', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 200, rows: 30 }))
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 200, rows: 30 }))
await sleep(1500)

output = ''
const content = Buffer.from('hello wastehero doc').toString('base64')
ws.send(JSON.stringify({ t: 'attach-file', sessionId, name: 'My Report v2.pdf', base64: content }))
await sleep(1500)

const m = output.match(/[A-Za-z]:\\[^\s"']*My_Report_v2\.pdf/)
const injected = !!m
const exists = m ? fs.existsSync(m[0]) : false
const body = exists ? fs.readFileSync(m[0], 'utf8') : ''
console.log('path injected (name sanitized):', injected, m ? m[0] : '(none)')
console.log('file on host + content ok:', exists && body === 'hello wastehero doc')

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(700)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
if (injected && exists && body === 'hello wastehero doc') console.log('ATTACH-FILE TEST PASSED')
else throw new Error('FAIL')
