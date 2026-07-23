// Preset test: create a session from a preset, verify port allocation,
// ${PORT} substitution in links, env injection, and that the service the
// session started actually answers on the allocated port.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const queue = []
const waiters = []
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (waiters.length) waiters.shift()(msg)
  else queue.push(msg)
})
const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res)))
await new Promise((r) => ws.on('open', r))

ws.send(JSON.stringify({ t: 'hello', token }))
let msg = await next()
if (msg.t !== 'hello-ok') throw new Error('auth failed')
if (!msg.presets.some((p) => p.id === 'demo-web')) throw new Error('FAIL: preset not advertised in hello-ok')
console.log('presets advertised:', msg.presets.map((p) => p.id).join(','))

ws.send(JSON.stringify({ t: 'create', name: 'preset-test', presetId: 'demo-web', cols: 100, rows: 30 }))
while (msg.t !== 'created' && msg.t !== 'error') msg = await next()
if (msg.t === 'error') throw new Error('FAIL create: ' + msg.message)
const session = msg.session
const link = session.links[0]
if (!link || !/^http:\/\/127\.0\.0\.1:\d+$/.test(link.url)) throw new Error('FAIL: bad link: ' + JSON.stringify(session.links))
console.log('session created, link:', link.label, link.url)

await sleep(2500) // give the web server a moment to boot
const res = await fetch(link.url)
const body = await res.text()
const port = link.url.split(':')[2]
if (!body.includes('WH hub demo on port ' + port)) throw new Error('FAIL: unexpected body: ' + body)
console.log('service responded on allocated port:', body)

ws.send(JSON.stringify({ t: 'kill', sessionId: session.id }))
await sleep(1000)
ws.send(JSON.stringify({ t: 'remove', sessionId: session.id }))
await sleep(300)
ws.close()
console.log('PRESET TEST PASSED')
