// E2E: run a real `claude -p` session under the daemon and verify output.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const token = Object.keys(config.tokens)[0]
const ws = new WebSocket(`ws://${config.host}:${config.port}`)

let sessionId = null
let output = ''
const done = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('TIMEOUT — output so far:\n' + output.slice(-2000))), 90000)
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })))
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.t === 'hello-ok') {
      ws.send(
        JSON.stringify({
          t: 'create',
          name: 'claude-e2e',
          cwd: 'C:\\Users\\drasm\\Desktop',
          command: 'claude -p "Reply with exactly: WH-HUB-OK"',
          cols: 120,
          rows: 30,
        }),
      )
    } else if (msg.t === 'created') {
      sessionId = msg.session.id
      ws.send(JSON.stringify({ t: 'attach', sessionId, cols: 120, rows: 30 }))
    } else if ((msg.t === 'output' || msg.t === 'attached') && msg.sessionId === sessionId) {
      output += msg.t === 'attached' ? msg.scrollback : msg.data
    } else if (msg.t === 'exit' && msg.sessionId === sessionId) {
      clearTimeout(timeout)
      resolve(msg.exitCode)
    } else if (msg.t === 'error') {
      clearTimeout(timeout)
      reject(new Error('daemon error: ' + msg.message))
    }
  })
})

const exitCode = await done
console.log('claude exited with', exitCode)
if (!output.includes('WH-HUB-OK')) throw new Error('FAIL: expected marker not in output:\n' + output.slice(-2000))
ws.send(JSON.stringify({ t: 'remove', sessionId }))
setTimeout(() => { ws.close(); console.log('CLAUDE E2E PASSED') }, 300)
