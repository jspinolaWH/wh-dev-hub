// E2E: a real claude session under the daemon reports cost + tokens via OTel.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let latest = null
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if ((m.t === 'sessions' || m.t === 'created') && sessionId) {
    const list = m.sessions ?? [m.session]
    const s = list.find((x) => x.id === sessionId)
    if (s) latest = s
  }
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

// Run a real headless-style claude query inside a session and let it exit.
ws.send(
  JSON.stringify({
    t: 'create',
    name: 'usage-test',
    cwd: 'C:\\Users\\drasm\\Desktop',
    command: 'claude -p "say hi in 3 words" --dangerously-skip-permissions',
    cols: 100,
    rows: 30,
  }),
)
const dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)

// Wait for the run to finish + OTel to flush (10s export interval) + a margin.
console.log('waiting up to 40s for claude to run and OTel to flush...')
const deadline = Date.now() + 40_000
while (Date.now() < deadline && !(latest && latest.costUsd > 0)) {
  ws.send(JSON.stringify({ t: 'list' }))
  await sleep(2000)
}

console.log('session cost $:', latest?.costUsd, '| tokens:', latest?.tokens)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
if (latest && latest.costUsd > 0 && latest.tokens > 0) console.log('USAGE TEST PASSED')
else throw new Error('FAIL: no usage recorded')
