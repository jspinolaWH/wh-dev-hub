// Multi-user test: second user can peek (attach) but not type/kill,
// and their sessions get an isolated CLAUDE_CONFIG_DIR.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const devToken = Object.entries(config.tokens).find(([, u]) => u === 'dev')[0]
const joaoToken = Object.entries(config.tokens).find(([, u]) => u === 'joao')[0]
const url = `ws://${config.host}:${config.port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const queue = []
    const waiters = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (waiters.length) waiters.shift()(msg)
      else queue.push(msg)
    })
    const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res)))
    ws.on('open', async () => {
      ws.send(JSON.stringify({ t: 'hello', token }))
      const msg = await next()
      if (msg.t !== 'hello-ok') return reject(new Error('auth failed'))
      resolve({ ws, next, user: msg.user })
    })
  })
}

const dev = await connect(devToken)
const joao = await connect(joaoToken)
console.log('connected as', dev.user, 'and', joao.user)

// dev creates a session
dev.ws.send(JSON.stringify({ t: 'create', name: 'owned-by-dev', cwd: process.cwd(), command: 'powershell -NoProfile -Command "Start-Sleep 30"', cols: 80, rows: 24 }))
let msg = await dev.next()
while (msg.t !== 'created') msg = await dev.next()
const sid = msg.session.id
console.log('dev created session', sid)

// Per-user isolation: joao cannot even attach to dev's session (not just
// read-only — fully hidden/blocked).
joao.ws.send(JSON.stringify({ t: 'attach', sessionId: sid, cols: 80, rows: 24 }))
msg = await joao.next()
while (msg.t !== 'attached' && msg.t !== 'error') msg = await joao.next()
if (msg.t !== 'error') throw new Error('FAIL: joao could attach to dev session')
console.log('joao attach rejected: ok —', msg.message)

// joao cannot type or kill dev's session either
joao.ws.send(JSON.stringify({ t: 'input', sessionId: sid, data: 'echo hacked\r' }))
msg = await joao.next()
while (msg.t !== 'error') msg = await joao.next()
console.log('joao input rejected: ok —', msg.message)

joao.ws.send(JSON.stringify({ t: 'kill', sessionId: sid }))
msg = await joao.next()
while (msg.t !== 'error') msg = await joao.next()
console.log('joao kill rejected: ok')

// joao's own session gets an isolated profile dir
joao.ws.send(JSON.stringify({ t: 'create', name: 'joao-env-check', cwd: process.cwd(), command: 'powershell -NoProfile -Command "Write-Host PROFILE=$env:CLAUDE_CONFIG_DIR"', cols: 100, rows: 24 }))
msg = await joao.next()
while (msg.t !== 'created') msg = await joao.next()
const sid2 = msg.session.id
joao.ws.send(JSON.stringify({ t: 'attach', sessionId: sid2, cols: 100, rows: 24 }))
let out = ''
const deadline = Date.now() + 15000
while (Date.now() < deadline && !/PROFILE=\S+/.test(out)) {
  msg = await joao.next()
  if (msg.t === 'attached' && msg.sessionId === sid2) out += msg.scrollback
  if (msg.t === 'output' && msg.sessionId === sid2) out += msg.data
}
const m = out.match(/PROFILE=(\S+)/)
if (!m || !m[1].includes('profiles')) throw new Error('FAIL: no isolated profile, got: ' + (m?.[1] ?? out.slice(-500)))
console.log('joao CLAUDE_CONFIG_DIR:', m[1])

// dev (owner) kills own session; cleanup
dev.ws.send(JSON.stringify({ t: 'kill', sessionId: sid }))
await sleep(1000)
dev.ws.send(JSON.stringify({ t: 'remove', sessionId: sid }))
await sleep(500)
joao.ws.send(JSON.stringify({ t: 'remove', sessionId: sid2 }))
await sleep(500)
dev.ws.close(); joao.ws.close()
console.log('MULTIUSER TEST PASSED')
