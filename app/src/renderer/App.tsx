import { useEffect, useMemo, useRef, useState } from 'react'
import type { PresetInfo, SessionInfo } from '@wh/shared'
import { HubClient, type ConnState } from './hubClient'
import { TerminalView } from './TerminalView'
import whMark from './assets/wh-mark.svg'

const openLink = (url: string) => (window.wh ? window.wh.openExternal(url) : window.open(url))

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
  const [loginUrl, setLoginUrl] = useState<string>()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()

  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.t === 'hello-ok' || msg.t === 'sessions') setSessions(client.sessions)
        if (msg.t === 'hello-ok') setPresets(client.presets)
        if (msg.t === 'created') {
          setSelectedId(msg.session.id)
          setShowCreate(false)
          setCreating(false)
          setCreateError(undefined)
        }
        if (msg.t === 'error' && creating) {
          setCreating(false)
          setCreateError(msg.message)
        }
        if (msg.t === 'notification') {
          const alreadyLooking = document.hasFocus() && selectedId === msg.sessionId
          if (!alreadyLooking) {
            const n = new Notification('WasteHero Dev Hub', { body: msg.message })
            n.onclick = () => {
              window.focus()
              setSelectedId(msg.sessionId)
            }
          }
        }
      }),
    [client, creating, selectedId],
  )

  const connect = (viaSlack = false) => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    setConnError(undefined)
    client.connect(
      settings.url,
      settings.token,
      (s, error) => {
        setConnState(s)
        if (error) setConnError(error)
        if (s === 'connected') setSessions(client.sessions)
        if (s === 'disconnected') setSelectedId(undefined)
      },
      viaSlack
        ? {
            slack: true,
            onLoginUrl: (url) => {
              setLoginUrl(url)
              openLink(url)
            },
            onToken: (token) => {
              const next = { ...settings, token }
              setSettings(next)
              localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
            },
          }
        : undefined,
    )
  }

  const selected = sessions.find((s) => s.id === selectedId)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={whMark} alt="WasteHero" />
          <div>
            <div className="brand-name">WasteHero</div>
            <div className="brand-sub">Dev Hub</div>
          </div>
        </div>

        {connState !== 'connected' ? (
          <ConnectForm
            settings={settings}
            setSettings={setSettings}
            onConnect={() => connect(false)}
            onSlack={() => connect(true)}
            connecting={connState === 'connecting'}
            error={connError}
            loginUrl={loginUrl}
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
          busy={creating}
          error={createError}
          presets={presets}
          onClose={() => {
            setShowCreate(false)
            setCreating(false)
            setCreateError(undefined)
          }}
          onCreate={(req) => {
            setCreating(true)
            setCreateError(undefined)
            client.send({ t: 'create', ...req, cols: 120, rows: 30 })
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
  onSlack: () => void
  connecting: boolean
  error?: string
  loginUrl?: string
}) {
  const { settings, setSettings, onConnect, onSlack, connecting, error, loginUrl } = props
  const [copied, setCopied] = useState(false)
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
      <button className="btn primary" onClick={onSlack} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Sign in with Slack'}
      </button>
      {connecting && loginUrl && (
        <button
          className="btn"
          onClick={() => {
            navigator.clipboard.writeText(loginUrl)
            setCopied(true)
          }}
        >
          {copied ? 'Link copied — paste it in your browser' : "Browser didn't open? Copy sign-in link"}
        </button>
      )}
      <details>
        <summary className="muted-summary">Connect with a token instead</summary>
        <label>
          Access token
          <input
            type="password"
            value={settings.token}
            onChange={(e) => setSettings({ ...settings, token: e.target.value })}
            placeholder="token from daemon config"
          />
        </label>
        <button className="btn" onClick={onConnect} disabled={connecting || !settings.token}>
          Connect with token
        </button>
      </details>
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
      {s.links.length > 0 && (
        <div className="session-links">
          {s.links.map((l) => (
            <button key={l.url} className="btn tiny link" onClick={(e) => (e.stopPropagation(), openLink(l.url))}>
              {l.label} ↗
            </button>
          ))}
        </div>
      )}
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

function CreateDialog(props: {
  busy: boolean
  error?: string
  presets: PresetInfo[]
  onClose: () => void
  onCreate: (req: { name: string; presetId?: string; cwd?: string; command?: string }) => void
}) {
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState('')
  const [cwd, setCwd] = useState('')
  const [command, setCommand] = useState('claude')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const preset = props.presets.find((p) => p.id === presetId)
  const valid = preset ? true : !!cwd.trim()

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <label>
          Name
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="invoicing loop" />
        </label>
        {props.presets.length > 0 && (
          <label>
            Environment
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              <option value="">Custom (folder + command)</option>
              {props.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {preset ? (
          <div className="preset-desc">{preset.description}</div>
        ) : (
          <>
            <label>
              Working directory (a folder on the host machine)
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={'C:\\Users\\drasm\\Desktop\\wasteheroRepo'}
              />
            </label>
            <label>
              Command
              <input value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
          </>
        )}
        {props.error && <div className="error">{props.error}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!valid || props.busy}
            onClick={() =>
              props.onCreate(
                preset ? { name, presetId } : { name, cwd: cwd.trim(), command },
              )
            }
          >
            {props.busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
