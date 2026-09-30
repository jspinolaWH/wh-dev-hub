// One client, the same chat in two views (split view, remounts): closing one
// view must not cut the other off; closing both stops the output.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ws = new WebSocket(`ws://${config.host}:${config.port}`)
let sessionId = null
let outputs = 0
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.t === 'created') sessionId = m.session.id
  if (m.t === 'output' && m.sessionId === sessionId) outputs++
  if (m.t === 'error') console.log('daemon error:', m.message)
})
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello', token }))
await sleep(300)
ws.send(
  JSON.stringify({
    t: 'create',
    name: 'views-test',
    cwd: 'C:\\Users\\drasm\\Desktop',
    command: 'powershell -NoProfile -Command "while ($true) { Write-Host tick; Start-Sleep -Milliseconds 250 }"',
    cols: 100,
    rows: 30,
  }),
)
while (!sessionId) await sleep(50)
const attach = () => ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 100, rows: 30 }))
const detach = () => ws.send(JSON.stringify({ t: 'detach', sessionId }))
const countFor = async (ms) => {
  const start = outputs
  await sleep(ms)
  return outputs - start
}

attach()
attach() // the same chat in a second view
await sleep(1500)
detach() // close one view
const withOne = await countFor(2000)
detach() // close the other
await sleep(300)
const withNone = await countFor(1500)

ws.send(JSON.stringify({ t: 'kill', sessionId }))
await sleep(800)
ws.send(JSON.stringify({ t: 'remove', sessionId }))
await sleep(300)
ws.close()

console.log(`output frames with one view left: ${withOne}, with none: ${withNone}`)
if (withOne < 3) throw new Error('FAIL: closing one view cut off the other')
if (withNone !== 0) throw new Error('FAIL: output still streamed after both views closed')
console.log('VIEWS TEST PASSED')
