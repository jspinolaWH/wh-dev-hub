// Folders + colour tags + hub-side rename: per-user, validated, persisted, and
// deleting a folder only moves its chats back out.
import WebSocket from 'ws'
import fs from 'node:fs'

const config = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url)))
const tokenOf = (user) => Object.entries(config.tokens).find(([, u]) => u === user)[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (file) => JSON.parse(fs.readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'))

async function connect(user) {
  const ws = new WebSocket(`ws://${config.host}:${config.port}`)
  const c = { ws, folders: null, sessions: [], errors: [], created: null }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.t === 'hello-ok') Object.assign(c, { folders: m.folders, sessions: m.sessions })
    if (m.t === 'folders') c.folders = m.folders
    if (m.t === 'sessions') c.sessions = m.sessions
    if (m.t === 'created') c.created = m.session
    if (m.t === 'error') c.errors.push(m.message)
  })
  await new Promise((r) => ws.on('open', r))
  ws.send(JSON.stringify({ t: 'hello', token: tokenOf(user) }))
  await sleep(400)
  c.send = async (msg) => {
    ws.send(JSON.stringify(msg))
    await sleep(250)
  }
  return c
}

const checks = []
const check = (label, ok, detail = '') => {
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const dev = await connect('dev')
const joao = await connect('joao')

await dev.send({ t: 'create-folder', name: '  Invoicing   work ' })
const folder = dev.folders.find((f) => f.name === 'Invoicing work')
check('folder created (name tidied)', !!folder, JSON.stringify(dev.folders.at(-1)))

await dev.send({ t: 'create', name: 'folders-test', cwd: 'C:\\Users\\drasm\\Desktop', command: '', cols: 100, rows: 30 })
const id = dev.created?.id
await dev.send({ t: 'update-session', sessionId: id, color: 'green', folderId: folder.id })
let s = dev.sessions.find((x) => x.id === id)
check('chat coloured + moved into folder', s?.color === 'green' && s?.folderId === folder.id)

await dev.send({ t: 'update-session', sessionId: id, name: 'Renamed in hub' })
s = dev.sessions.find((x) => x.id === id)
check('chat renamed from the hub', s?.name === 'Renamed in hub')

dev.errors.length = 0
await dev.send({ t: 'update-session', sessionId: id, color: 'chartreuse' })
await dev.send({ t: 'update-session', sessionId: id, folderId: 'nope' })
await dev.send({ t: 'update-session', sessionId: id, name: '   ' })
check('bad colour / folder / empty name rejected', dev.errors.length === 3, JSON.stringify(dev.errors))

check("joao doesn't see dev's folders", !(joao.folders ?? []).some((f) => f.id === folder.id))
await joao.send({ t: 'update-session', sessionId: id, color: 'red' })
await joao.send({ t: 'rename-folder', folderId: folder.id, name: 'hijacked' })
check("joao can't touch dev's chat or folder", joao.errors.length === 2, JSON.stringify(joao.errors))

await dev.send({ t: 'rename-folder', folderId: folder.id, name: 'Billing' })
check('folder renamed', dev.folders.find((f) => f.id === folder.id)?.name === 'Billing')

const onDisk = readJson('sessions.json').find((x) => x.id === id)
check(
  'persisted to disk',
  readJson('folders.json').dev?.some((f) => f.id === folder.id && f.name === 'Billing') &&
    onDisk?.color === 'green' &&
    onDisk?.folderId === folder.id &&
    onDisk?.name === 'Renamed in hub',
)

await dev.send({ t: 'delete-folder', folderId: folder.id })
s = dev.sessions.find((x) => x.id === id)
check('deleting the folder keeps the chat, moved out', !dev.folders.some((f) => f.id === folder.id) && !!s && !s.folderId)

await dev.send({ t: 'update-session', sessionId: id, color: null })
check('colour cleared', !dev.sessions.find((x) => x.id === id)?.color)

await dev.send({ t: 'kill', sessionId: id })
await sleep(600)
await dev.send({ t: 'remove', sessionId: id })
dev.ws.close()
joao.ws.close()
if (checks.some((ok) => !ok)) throw new Error('FAIL: see above')
console.log('FOLDERS TEST PASSED')
