import { useEffect, useMemo, useRef, useState } from 'react'
import type { FolderInfo, PresetInfo, SessionInfo } from '@wh/shared'
import { HubClient, type ConnState } from './hubClient'
import { TerminalView } from './TerminalView'
import { ChatList, chatStyle } from './ChatList'
import { fmtCost, fmtTokens, openLink } from './util'
import whMark from './assets/wh-mark.svg'

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
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [showOverview, setShowOverview] = useState(false)
  const [, setTick] = useState(0)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()

  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.t === 'hello-ok' || msg.t === 'sessions') setSessions(client.sessions)
        if (msg.t === 'hello-ok') setPresets(client.presets)
        if (msg.t === 'hello-ok' || msg.t === 'folders') setFolders(client.folders)
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

  // Keep the overview's relative timers fresh even when sessions are quiet.
  useEffect(() => {
    if (!showOverview) return
    const id = setInterval(() => setTick((t) => t + 1), 5000)
    return () => clearInterval(id)
  }, [showOverview])

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

  // On a phone, show one pane at a time (list / overview / open session).
  const narrow = useMediaQuery('(max-width: 760px)')
  const showSidebar = !narrow || (!selected && !showOverview)
  const showMain = !narrow || showOverview || !!selected

  const openSession = (id: string) => {
    setShowOverview(false)
    setSelectedId(id)
  }

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
            <button
              className={`btn ${showOverview ? 'primary' : ''}`}
              onClick={() => setShowOverview((o) => !o)}
            >
              ▦ Overview
            </button>
            <ChatList
              sessions={sessions}
              folders={folders}
              selectedId={selectedId}
              send={(msg) => client.send(msg)}
              onSelect={setSelectedId}
              onRelaunch={(id) => {
                setSelectedId(id)
                client.send({ t: 'relaunch', sessionId: id, cols: 120, rows: 30 })
              }}
              onRemove={(id) => {
                client.send({ t: 'remove', sessionId: id })
                if (selectedId === id) setSelectedId(undefined)
              }}
            />
          </>
        )}
      </aside>
      )}

      {showMain && showOverview ? (
        <main className="main">
          <div className="main-toolbar">
            {narrow && (
              <button className="btn tiny" onClick={() => setShowOverview(false)}>
                ‹ Sessions
              </button>
            )}
            <span className="toolbar-name">Overview — {sessions.length} sessions</span>
          </div>
          <OverviewPanel
            sessions={sessions}
            onOpen={openSession}
            onKill={(id) => client.send({ t: 'kill', sessionId: id })}
            onRelaunch={(id) => client.send({ t: 'relaunch', sessionId: id, cols: 120, rows: 30 })}
          />
        </main>
      ) : showMain ? (
      <main className="main">
        {selected && (
          <div className="main-toolbar">
            {narrow && (
              <button className="btn tiny" onClick={() => setSelectedId(undefined)}>
                ‹ Sessions
              </button>
            )}
            <span className="toolbar-name">
              {selected.color && <span className="chat-dot" style={chatStyle(selected.color)} />}
              {selected.name}
            </span>
            {selected.status === 'running' && (
              <AutoContinueControl
                session={selected}
                onSet={(enabled, prompt) =>
                  client.send({ t: 'set-auto-continue', sessionId: selected.id, enabled, prompt })
                }
              />
            )}
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
      ) : null}

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

const timeAgo = (iso: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

const STATUS_META: Record<string, { label: string; cls: string; rank: number }> = {
  attention: { label: 'Needs you', cls: 'attention', rank: 0 },
  idle: { label: 'Waiting', cls: 'idle', rank: 1 },
  working: { label: 'Working', cls: 'working', rank: 2 },
  offline: { label: 'Stopped', cls: 'offline', rank: 3 },
}

function OverviewPanel(props: {
  sessions: SessionInfo[]
  onOpen: (id: string) => void
  onKill: (id: string) => void
  onRelaunch: (id: string) => void
}) {
  const eff = (s: SessionInfo) => (s.status === 'running' ? s.activityStatus : s.status === 'lost' ? 'offline' : 'offline')
  const sorted = [...props.sessions].sort(
    (a, b) =>
      (STATUS_META[eff(a)].rank - STATUS_META[eff(b)].rank) ||
      new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  )
  const count = (st: string) => props.sessions.filter((s) => eff(s) === st).length

  return (
    <div className="overview">
      <div className="ov-summary">
        <span className="ov-chip attention">{count('attention')} need you</span>
        <span className="ov-chip idle">{count('idle')} waiting</span>
        <span className="ov-chip working">{count('working')} working</span>
        <span className="ov-chip offline">{count('offline')} stopped</span>
      </div>
      <div className="ov-list">
        {sorted.map((s) => {
          const st = eff(s)
          const meta = STATUS_META[st]
          return (
            <div
              key={s.id}
              className={`ov-row ${meta.cls} ${s.color ? 'tagged' : ''}`}
              style={chatStyle(s.color)}
              onClick={() => props.onOpen(s.id)}
            >
              <div className="ov-row-main">
                <span className={`ov-badge ${meta.cls}`}>{meta.label}</span>
                <span className="ov-name">{s.name}</span>
                <span className="ov-time">{s.status === 'running' ? timeAgo(s.lastActivityAt) : s.status}</span>
              </div>
              <div className="ov-doing">
                {s.progress ? (
                  <>
                    {typeof s.progress.pct === 'number' && (
                      <span className="ov-pct">
                        <span className="ov-bar" style={{ width: `${s.progress.pct}%` }} />
                        <span className="ov-pct-num">{s.progress.pct}%</span>
                      </span>
                    )}
                    {s.progress.eta && <span className="ov-eta">~{s.progress.eta} (agent est.)</span>}
                    <span className="ov-note">{s.progress.note || s.lastLine}</span>
                  </>
                ) : (
                  <span className="ov-note dim">{s.lastLine || '—'}</span>
                )}
              </div>
              <div className="ov-meta">
                <span>{fmtCost(s.costUsd)}</span>
                <span className="usage-sep">·</span>
                <span>{fmtTokens(s.tokens)} tok</span>
                {s.autoContinue.enabled && <span className="ov-ac">♻ {s.autoContinue.sent}/{s.autoContinue.maxNudges}</span>}
                <span className="ov-actions">
                  <button className="btn tiny" onClick={(e) => (e.stopPropagation(), props.onOpen(s.id))}>
                    open
                  </button>
                  {s.status === 'running' ? (
                    <button className="btn tiny danger" onClick={(e) => (e.stopPropagation(), props.onKill(s.id))}>
                      kill
                    </button>
                  ) : (
                    <button className="btn tiny" onClick={(e) => (e.stopPropagation(), props.onRelaunch(s.id))}>
                      relaunch
                    </button>
                  )}
                </span>
              </div>
            </div>
          )
        })}
        {props.sessions.length === 0 && <div className="empty">No sessions yet</div>}
      </div>
    </div>
  )
}

function AutoContinueControl(props: { session: SessionInfo; onSet: (enabled: boolean, prompt: string) => void }) {
  const ac = props.session.autoContinue
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(ac.prompt)

  return (
    <div className="autocont">
      <button
        className={`btn tiny ${ac.enabled ? 'primary' : ''}`}
        title="When the session finishes and goes idle, keep it going by sending your nudge automatically (capped)."
        onClick={() => (ac.enabled ? props.onSet(false, ac.prompt) : setOpen((o) => !o))}
      >
        {ac.enabled ? `♺ Auto-continue ${ac.sent}/${ac.maxNudges}` : '♺ Auto-continue'}
      </button>
      {open && !ac.enabled && (
        <div className="autocont-pop" onClick={(e) => e.stopPropagation()}>
          <label>
            Nudge to send when idle
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="continue" />
          </label>
          <div className="autocont-actions">
            <button className="btn tiny" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn tiny primary"
              onClick={() => {
                props.onSet(true, prompt.trim() || 'continue')
                setOpen(false)
              }}
            >
              Start
            </button>
          </div>
        </div>
      )}
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
