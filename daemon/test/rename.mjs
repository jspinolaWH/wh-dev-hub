// `/rename <name>` inside Claude renames the hub chat: the daemon adopts the
// name from Claude's "⎿  Session renamed to: X" confirmation, ignores look-alike
// text, and persists it.
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const emitter = fileURLToPath(new URL('./rename-emitter.mjs', import.meta.url))
const sessionsFile = new URL('../data/sessions.json', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ws = new WebSocket(`ws://${config.host}:${config.port}`)
let sessionId = null
const names = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') {
    sessionId = m.session.id
    names.push(m.session.name)
  }
  if (m.t === 'sessions' && sessionId) {
    const s = m.sessions.find((x) => x.id === sessionId)
    if (s && s.name !== names.at(-1)) names.push(s.name)
  }
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)
ws.send(
  JSON.stringify({ t: 'create', name: 'rename-test', cwd: path.dirname(emitter), command: `node "${emitter}"`, cols: 120, rows: 30 }),
)
let dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
if (!sessionId) throw new Error('FAIL: session not created')

dl = Date.now() + 15_000
while (!names.includes('Pricing API spike') && Date.now() < dl) await sleep(100)
const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).find((s) => s.id === sessionId)?.name
dl = Date.now() + 15_000
while (!names.includes('checkout-2') && Date.now() < dl) await sleep(100)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(800)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()

console.log('names seen:', JSON.stringify(names), '| persisted after first rename:', JSON.stringify(persisted))
const expected = ['rename-test', 'Pricing API spike', 'checkout-2']
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`FAIL: expected ${JSON.stringify(expected)}`)
if (persisted !== 'Pricing API spike') throw new Error('FAIL: rename not persisted to sessions.json')
console.log('RENAME TEST PASSED')
