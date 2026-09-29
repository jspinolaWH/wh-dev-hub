// Verify attach replays a bounded snapshot: the most recent `scrollbackLines`
// (+ one screen) of history, contiguous and ending at the latest output —
// and that it goes over the wire compressed.
import WebSocket from 'ws'
import fs from 'node:fs'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const scrollbackLines = config.scrollbackLines ?? 10_000
const TOTAL = scrollbackLines + 5000
const COLS = 120
const ROWS = 30
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let sessionId = null
let live = ''
let replay = null
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'output' && m.sessionId === sessionId) live = (live + m.data).slice(-4000)
  if (m.t === 'attached' && m.sessionId === sessionId) replay = m.scrollback
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

ws.send(
  JSON.stringify({
    t: 'create',
    name: 'replay-cap',
    cwd: 'C:\\Users\\drasm\\Desktop',
    command: `powershell -NoProfile -Command "1..${TOTAL} | ForEach-Object { 'LINE_' + $_ + '_' + ('x' * 90) }"`,
    cols: COLS,
    rows: ROWS,
  }),
)
let dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: COLS, rows: ROWS }))
dl = Date.now() + 60_000
while (!live.includes(`LINE_${TOTAL}_`) && Date.now() < dl) await sleep(200)
ws.send(JSON.stringify({ t: 'detach', sessionId }))
await sleep(300)

const t0 = Date.now()
replay = null
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: COLS, rows: ROWS }))
dl = Date.now() + 10_000
while (replay === null && Date.now() < dl) await sleep(20)
const attachMs = Date.now() - t0
const compressed = ws.extensions.includes('permessage-deflate')

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()
if (replay === null) throw new Error('FAIL: no replay on attach')

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 20000, allowProposedApi: true, windowsPty: { backend: 'conpty' } })
await new Promise((r) => term.write(replay, r))
const buf = term.buffer.active
const nums = []
for (let i = 0; i < buf.length; i++) {
  const m = buf.getLine(i).translateToString(true).match(/^LINE_(\d+)_x{90}$/)
  if (m) nums.push(Number(m[1]))
}
const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
console.log(
  `replay: ${replay.length} chars in ${attachMs}ms (deflate: ${compressed}), ` +
    `restored LINE_${nums[0]}..LINE_${nums.at(-1)} (${nums.length} rows)`,
)
if (!compressed) throw new Error('FAIL: permessage-deflate not negotiated')
if (nums.at(-1) !== TOTAL || !contiguous) throw new Error('FAIL: replay is not the contiguous latest history')
if (buf.length > scrollbackLines + ROWS + 1) throw new Error(`FAIL: replay not bounded (${buf.length} rows)`)
if (nums.length < scrollbackLines) throw new Error(`FAIL: expected ~${scrollbackLines} rows of history`)
console.log('REPLAY CAP TEST PASSED')
