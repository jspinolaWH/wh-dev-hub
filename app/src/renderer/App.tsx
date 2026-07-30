import { useEffect, useMemo, useRef, useState } from 'react'
import type { PresetInfo, SessionInfo } from '@wh/shared'
import { HubClient, type ConnState } from './hubClient'
import { TerminalView } from './TerminalView'
import whMark from './assets/wh-mark.svg'

const openLink = (url: string) => (window.wh ? window.wh.openExternal(url) : window.open(url))

function useMediaQuery(q: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const handler = () => setMatches(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [q])
  return matches
}

const fmtCost = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

const SETTINGS_KEY = 'wh-hub-settings'

// In the Electron app there's no server host; default to localhost. In the
// web build (served BY the daemon and opened on a phone/browser), connect back
// to the same host/port that served the page.
const IS_WEB = !window.wh
const DEFAULT_URL = IS_WEB
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
  : 'ws://127.0.0.1:7811'

interface Settings {
  url: string
  token: string
}

function loadSettings(): Settings {
  try {
    return { url: DEFAULT_URL, token: '', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return { url: DEFAULT_URL, token: '' }
  }
}

export function App() {
  const client = useMemo(() => new HubClient(), [])
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string>()
  const [loginUrl, setLoginUrl] = useState<string>()
  const [toast, setToast] = useState<string>()
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
        if (msg.t === 'error') {
          if (creating) {
            setCreating(false)
            setCreateError(msg.message)
          } else {
            setToast(msg.message)
          }
        }
        if (msg.t === 'notification') {
          const alreadyLooking = document.hasFocus() && selectedId === msg.sessionId
          // Notification API is absent/gated on mobile Safari — guard so a
          // notification event never throws and breaks session updates.
          if (!alreadyLooking && 'Notification' in window && Notification.permission === 'granted') {
            try {
              // Daemon sends "<session name>: <status>" — split so the session
              // is the title and the status is the body.
              const sep = msg.message.indexOf(': ')
              const title = sep > 0 ? msg.message.slice(0, sep) : 'WasteHero Dev Hub'
              const body = sep > 0 ? msg.message.slice(sep + 2) : msg.message
              const n = new Notification(title, { body })
              n.onclick = () => {
                window.focus()
                setSelectedId(msg.sessionId)
              }
            } catch {
              /* notifications unavailable on this platform */
            }
          }
        }
      }),
    [client, creating, selectedId],
  )

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(undefined), 6000)
    return () => clearTimeout(t)
  }, [toast])

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

  // On a phone, show either the session list OR the open session (with a back
  // button), not both side by side.
  const narrow = useMediaQuery('(max-width: 760px)')
  const showSidebar = !narrow || !selected
  const showMain = !narrow || !!selected

  const attachFiles = async () => {
    if (!selected || !window.wh?.pickFiles) return
    const files = await window.wh.pickFiles()
    if (!files.length) return
    for (const f of files) client.send({ t: 'attach-file', sessionId: selected.id, name: f.name, base64: f.base64 })
    const names = files.map((f) => f.name).join(', ')
    setToast(`Attached ${names} — the file path(s) are on the prompt; type your message and press Enter.`)
  }

  return (
    <div className="app">
      {showSidebar && (
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
            <div className="usage-total" title="Total Claude usage across all sessions">
              <span>{fmtCost(sessions.reduce((a, s) => a + (s.costUsd || 0), 0))}</span>
              <span className="usage-sep">·</span>
              <span>{fmtTokens(sessions.reduce((a, s) => a + (s.tokens || 0), 0))} tokens</span>
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
                  onRelaunch={() => {
                    setSelectedId(s.id)
                    client.send({ t: 'relaunch', sessionId: s.id, cols: 120, rows: 30 })
                  }}
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
      )}

      {showMain && (
      <main className="main">
        {selected && (
          <div className="main-toolbar">
            {narrow && (
              <button className="btn tiny" onClick={() => setSelectedId(undefined)}>
                ‹ Sessions
              </button>
            )}
            <span className="toolbar-name">{selected.name}</span>
            {selected.status === 'running' && !IS_WEB && (
              <button className="btn tiny" onClick={attachFiles}>
                📎 Attach file
              </button>
            )}
          </div>
        )}
        {selected && selected.status === 'lost' ? (
          <div className="placeholder">
            <div>
              This session was lost when the daemon restarted.
              <br />
              Relaunch it to run <code>{selected.name}</code> again in {selected.cwd}.
              <div style={{ marginTop: 14 }}>
                <button
                  className="btn primary"
                  onClick={() => client.send({ t: 'relaunch', sessionId: selected.id, cols: 120, rows: 30 })}
                >
                  Relaunch session
                </button>
              </div>
            </div>
          </div>
        ) : selected ? (
          <TerminalView key={`${selected.id}:${selected.generation}`} client={client} sessionId={selected.id} />
        ) : (
          <div className="placeholder">
            {connState === 'connected'
              ? 'Select or create a session — it keeps running on the host even when you close this app.'
              : 'Connect to a WasteHero Dev Hub daemon to get started.'}
          </div>
        )}
      </main>
      )}

      {toast && (
        <div className="toast" onClick={() => setToast(undefined)}>
          {toast} <span className="toast-dismiss">×</span>
        </div>
      )}

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
  onRelaunch: () => void
  onRemove: () => void
}) {
  const { session: s, selected, onSelect, onKill, onRelaunch, onRemove } = props
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
      {(s.costUsd > 0 || s.tokens > 0) && (
        <div className="session-meta usage">
          {fmtCost(s.costUsd)} · {fmtTokens(s.tokens)} tokens
        </div>
      )}
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
          <>
            <button className="btn tiny" onClick={(e) => (e.stopPropagation(), onRelaunch())}>
              relaunch
            </button>
            <button className="btn tiny" onClick={(e) => (e.stopPropagation(), onRemove())}>
              remove
            </button>
          </>
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
  const [cwd, setCwd] = useState('C:\\Users\\jacks\\Desktop\\RemoteServer')
  // Launch mode maps to the command sent to the daemon.
  // '' = interactive shell (run claude/claude --resume/git yourself).
  const LAUNCH: Record<string, string> = {
    claude: 'claude',
    yolo: 'claude --dangerously-skip-permissions',
    resume: 'claude --resume',
    shell: '',
    custom: '',
  }
  const [launch, setLaunch] = useState<keyof typeof LAUNCH>('claude')
  const [customCommand, setCustomCommand] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  const command = launch === 'custom' ? customCommand : LAUNCH[launch]
  const preset = props.presets.find((p) => p.id === presetId)
  const valid = preset ? true : !!cwd.trim() && (launch !== 'custom' || !!customCommand.trim())

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
              Start with
              <select value={launch} onChange={(e) => setLaunch(e.target.value as keyof typeof LAUNCH)}>
                <option value="claude">Claude (fresh)</option>
                <option value="yolo">Claude — skip permissions (build loops)</option>
                <option value="resume">Claude — resume last session</option>
                <option value="shell">Shell (type your own commands)</option>
                <option value="custom">Custom command…</option>
              </select>
            </label>
            {launch === 'custom' && (
              <label>
                Command
                <input
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="npm run dev"
                />
              </label>
            )}
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
