import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo } from '@wh/shared'
import { HubClient, type ConnState } from './hubClient'
import { TerminalView } from './TerminalView'

const SETTINGS_KEY = 'wh-hub-settings'

interface Settings {
  url: string
  token: string
}

function loadSettings(): Settings {
  try {
    return { url: 'ws://127.0.0.1:7811', token: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return { url: 'ws://127.0.0.1:7811', token: '' }
  }
}

export function App() {
  const client = useMemo(() => new HubClient(), [])
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string>()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showCreate, setShowCreate] = useState(false)

  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.t === 'hello-ok' || msg.t === 'sessions') setSessions(client.sessions)
        if (msg.t === 'created') setSelectedId(msg.session.id)
      }),
    [client],
  )

  const connect = () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    setConnError(undefined)
    client.connect(settings.url, settings.token, (s, error) => {
      setConnState(s)
      if (error) setConnError(error)
      if (s === 'connected') setSessions(client.sessions)
      if (s === 'disconnected') setSelectedId(undefined)
    })
  }

  const selected = sessions.find((s) => s.id === selectedId)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">WH</div>
          <div>
            <div className="brand-name">WasteHero</div>
            <div className="brand-sub">Dev Hub</div>
          </div>
        </div>

        {connState !== 'connected' ? (
          <ConnectForm
            settings={settings}
            setSettings={setSettings}
            onConnect={connect}
            connecting={connState === 'connecting'}
            error={connError}
          />
        ) : (
          <>
            <div className="conn-status">
              <span className="dot ok" /> {client.user} @ {settings.url.replace('ws://', '')}
            </div>
            <button className="btn primary" onClick={() => setShowCreate(true)}>
              + New session
            </button>
            <div className="session-list">
              {sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  selected={s.id === selectedId}
                  onSelect={() => setSelectedId(s.id)}
                  onKill={() => client.send({ t: 'kill', sessionId: s.id })}
                  onRemove={() => {
                    client.send({ t: 'remove', sessionId: s.id })
                    if (selectedId === s.id) setSelectedId(undefined)
                  }}
                />
              ))}
              {sessions.length === 0 && <div className="empty">No sessions yet</div>}
            </div>
          </>
        )}
      </aside>

      <main className="main">
        {selected && selected.status !== 'lost' ? (
          <TerminalView key={selected.id} client={client} sessionId={selected.id} />
        ) : (
          <div className="placeholder">
            {connState === 'connected'
              ? selected?.status === 'lost'
                ? 'This session was lost in a daemon restart. Remove it, or recreate it (resume support coming).'
                : 'Select or create a session — it keeps running on the host even when you close this app.'
              : 'Connect to a WasteHero Dev Hub daemon to get started.'}
          </div>
        )}
      </main>

      {showCreate && (
        <CreateDialog
          onClose={() => setShowCreate(false)}
          onCreate={(name, cwd, command) => {
            client.send({ t: 'create', name, cwd, command, cols: 120, rows: 30 })
            setShowCreate(false)
          }}
        />
      )}
    </div>
  )
}

function ConnectForm(props: {
  settings: Settings
  setSettings: (s: Settings) => void
  onConnect: () => void
  connecting: boolean
  error?: string
}) {
  const { settings, setSettings, onConnect, connecting, error } = props
  return (
    <div className="connect-form">
      <label>
        Daemon address
        <input
          value={settings.url}
          onChange={(e) => setSettings({ ...settings, url: e.target.value })}
          placeholder="ws://office-pc:7811"
        />
      </label>
      <label>
        Access token
        <input
          type="password"
          value={settings.token}
          onChange={(e) => setSettings({ ...settings, token: e.target.value })}
          placeholder="token from daemon config"
        />
      </label>
      <button className="btn primary" onClick={onConnect} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function SessionCard(props: {
  session: SessionInfo
  selected: boolean
  onSelect: () => void
  onKill: () => void
  onRemove: () => void
}) {
  const { session: s, selected, onSelect, onKill, onRemove } = props
  return (
    <div className={`session-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="session-top">
        <span className={`dot ${s.status === 'running' ? 'ok' : 'off'}`} />
        <span className="session-name">{s.name}</span>
      </div>
      <div className="session-meta">
        {s.owner} · {s.status}
        {s.status === 'running' && s.attachedClients > 0 && ` · ${s.attachedClients} attached`}
      </div>
      <div className="session-meta path">{s.cwd}</div>
      <div className="session-actions">
        {s.status === 'running' ? (
          <button className="btn tiny danger" onClick={(e) => (e.stopPropagation(), onKill())}>
            kill
          </button>
        ) : (
          <button className="btn tiny" onClick={(e) => (e.stopPropagation(), onRemove())}>
            remove
          </button>
        )}
      </div>
    </div>
  )
}

function CreateDialog(props: { onClose: () => void; onCreate: (name: string, cwd: string, command: string) => void }) {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [command, setCommand] = useState('claude')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <label>
          Name
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="invoicing loop" />
        </label>
        <label>
          Working directory (on the host)
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\\repos\\wastehero" />
        </label>
        <label>
          Command
          <input value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!cwd.trim()} onClick={() => props.onCreate(name, cwd.trim(), command)}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
