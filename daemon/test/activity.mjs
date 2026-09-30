// Live activity on the chat cards: the daemon pushes status changes as they
// happen (working -> idle -> needs you), shows Claude's latest "●" action as
// what the chat is doing, spots a permission prompt as "needs you", ignores
// the BEL that ends title updates, and coalesces spinner churn.
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const emitter = fileURLToPath(new URL('./activity-emitter.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ws = new WebSocket(`ws://${config.host}:${config.port}`)
let sessionId = null
const timeline = [] // [ms since start, status, doing]
const notes = []
let broadcasts = 0
const t0 = Date.now()
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'sessions' && sessionId) {
    broadcasts++
    const s = m.sessions.find((x) => x.id === sessionId)
    const last = timeline.at(-1)
    if (s && (!last || last[1] !== s.activityStatus || last[2] !== s.doing)) timeline.push([Date.now() - t0, s.activityStatus, s.doing])
  }
  if (m.t === 'notification' && m.sessionId === sessionId) notes.push(`${m.kind}: ${m.message}`)
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(300)
ws.send(JSON.stringify({ t: 'create', name: 'activity-test', cwd: path.dirname(emitter), command: `node "${emitter}"`, cols: 120, rows: 30 }))
while (!sessionId) await sleep(50)

await sleep(4500)
const workingBroadcasts = broadcasts
await sleep(18_000)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(800)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()

console.log('timeline:', JSON.stringify(timeline))
console.log('notifications:', JSON.stringify(notes))
const statuses = timeline.map(([, st]) => st)
const checks = [
  ['went working with the action as "doing"', timeline.some(([, st, d]) => st === 'working' && d === 'Reading the config')],
  ['then idle once quiet', statuses.indexOf('idle') > statuses.indexOf('working')],
  ['then "needs you" at the permission prompt', statuses.lastIndexOf('attention') > statuses.indexOf('idle') && timeline.at(-1)[2] === 'Bash(npm test)'],
  ['title updates never counted as needs-you', statuses.indexOf('attention') > statuses.indexOf('idle')],
  ['one "waiting for your answer" notification', notes.filter((n) => n.includes('waiting for your answer')).length === 1],
  [`spinner coalesced (${workingBroadcasts} broadcasts in the first 4.5s)`, workingBroadcasts <= 6],
]
for (const [label, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
if (checks.some(([, ok]) => !ok)) throw new Error('FAIL: see above')
console.log('ACTIVITY TEST PASSED')
