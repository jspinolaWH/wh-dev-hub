// Regression: opening a chat must restore its whole history. A long burst of
// spinner redraws used to push everything out of the byte-capped replay (you
// hit a "top" after a few screens) and the cut could land mid-escape-sequence
// (garbage like "144;112m" at the top).
import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xtermHeadless from '@xterm/headless'

const { Terminal } = xtermHeadless
const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const emitter = fileURLToPath(new URL('./spinner-emitter.mjs', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const COLS = 120
const ROWS = 30

const ws = new WebSocket(`ws://${config.host}:${config.port}`)
let sessionId = null
let live = ''
let replay = null
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'output' && m.sessionId === sessionId) live += m.data
  if (m.t === 'attached' && m.sessionId === sessionId) replay = m.scrollback
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(400)

ws.send(
  JSON.stringify({
    t: 'create',
    name: 'history',
    cwd: path.dirname(emitter),
    command: `node "${emitter}"`,
    cols: COLS,
    rows: ROWS,
  }),
)
let dl = Date.now() + 10_000
while (!sessionId && Date.now() < dl) await sleep(100)
if (!sessionId) throw new Error('FAIL: session not created')

// Watch it run to the end, then detach — like switching to another chat.
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: COLS, rows: ROWS }))
dl = Date.now() + 60_000
while (!live.includes('HIST_DONE') && Date.now() < dl) await sleep(200)
ws.send(JSON.stringify({ t: 'detach', sessionId }))
await sleep(300)

// Come back: the replay is all the client gets to rebuild the terminal from.
replay = null
ws.send(JSON.stringify({ t: 'attach', sessionId, cols: COLS, rows: ROWS }))
dl = Date.now() + 10_000
while (replay === null && Date.now() < dl) await sleep(100)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(600)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()

if (!live.includes('HIST_DONE')) throw new Error('FAIL: emitter never finished')
if (replay === null) throw new Error('FAIL: no replay on re-attach')

// Render the replay exactly like the client does and read the screen back.
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 20000, allowProposedApi: true, windowsPty: { backend: 'conpty' } })
await new Promise((r) => term.write(replay, r))
const buf = term.buffer.active
const lines = []
for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true))

const hist = lines.filter((l) => l.includes('HIST_LINE_'))
const expected = Array.from({ length: 300 }, (_, i) => `● HIST_LINE_${String(i + 1).padStart(4, '0')} some tool output`)
const garbage = lines.filter((l) => /\d+;\d+m/.test(l))
const done = lines.findIndex((l) => l.includes('HIST_DONE'))

console.log(`live output: ${live.length} chars, replay: ${replay.length} chars, rendered rows: ${lines.length}`)
console.log(`history lines restored: ${hist.length}/300, first rendered row: ${JSON.stringify(lines[0])}`)
if (garbage.length) throw new Error(`FAIL: escape-sequence garbage rendered, e.g. ${JSON.stringify(garbage[0])}`)
if (hist.length !== 300 || hist.some((l, i) => l !== expected[i])) {
  throw new Error(`FAIL: history not fully restored (${hist.length}/300 lines)`)
}
if (done < 0) throw new Error('FAIL: final output missing from replay')
console.log('HISTORY TEST PASSED')
