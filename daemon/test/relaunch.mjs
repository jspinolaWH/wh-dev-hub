// Relaunch test: a session that exits (like double Ctrl-C) can be brought
// back with the same command; generation bumps; scrollback keeps the marker.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let session = null
let output = ''
let lastExit = null
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.t === 'created') session = msg.session
  if (msg.t === 'sessions' && session) session = msg.sessions.find((s) => s.id === session.id) ?? session
  if (msg.t === 'attached') output += msg.scrollback
  if (msg.t === 'output' && session && msg.sessionId === session.id) output += msg.data
  if (msg.t === 'exit' && session && msg.sessionId === session.id) lastExit = msg.exitCode
  if (msg.t === 'error') console.log('daemon error:', msg.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

// A short-lived command that exits on its own (simulates the process ending).
ws.send(JSON.stringify({ t: 'create', name: 'relaunch-test', cwd: 'C:\\Users\\drasm\\Desktop', command: 'powershell -NoProfile -Command "Write-Host FIRST_RUN_5521"', cols: 100, rows: 30 }))
const dl = Date.now() + 10_000
while (!session && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId: session.id, cols: 100, rows: 30 }))

// wait for it to exit
const exitDl = Date.now() + 15_000
while (lastExit === null && Date.now() < exitDl) await sleep(200)
console.log('first run exit code:', lastExit, '| gen:', session.generation)
const sawFirst = output.includes('FIRST_RUN_5521')

// relaunch
output = ''
lastExit = null
ws.send(JSON.stringify({ t: 'relaunch', sessionId: session.id, cols: 100, rows: 30 }))
await sleep(600)
ws.send(JSON.stringify({ t: 'attach', sessionId: session.id, cols: 100, rows: 30 }))
const relDl = Date.now() + 15_000
while (lastExit === null && Date.now() < relDl) await sleep(200)
await sleep(500)

const sawMarker = output.includes('relaunched')
const sawSecond = output.includes('FIRST_RUN_5521') // same command runs again
const genBumped = session.generation >= 1
console.log('after relaunch — marker:', sawMarker, '| command re-ran:', sawSecond, '| generation:', session.generation)

ws.send(JSON.stringify({ t: 'kill', sessionId: session.id }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId: session.id }))
await sleep(300)
ws.close()

if (sawFirst && sawMarker && sawSecond && genBumped) console.log('RELAUNCH TEST PASSED')
else throw new Error(`FAIL: first=${sawFirst} marker=${sawMarker} second=${sawSecond} gen=${genBumped}`)
