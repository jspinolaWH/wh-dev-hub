import { useEffect, useMemo, useRef, useState } from 'react'
import type { FolderInfo, PresetInfo, SessionInfo } from '@wh/shared'
import { HubClient, type ConnState } from './hubClient'
import { ChatList, chatStyle, sidebarOrder } from './ChatList'
import { PrPanel } from './PrPanel'
import { QuickSwitcher, type Command } from './QuickSwitcher'
import { Rail } from './Rail'
import { SessionPane } from './SessionPane'
import { BackIcon, GridIcon, PlusIcon, SearchIcon, SidebarIcon } from './icons'
import { MOD, shortcutOf } from './shortcuts'
import { activityOf, doingLine, timeAgo } from './status'
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

/** A per-device preference in localStorage; blocked storage just means defaults. */
function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = (next: T | ((prev: T) => T)) =>
    setValue((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        /* private mode: keep it for this visit */
      }
      return v
    })
  return [value, set] as const
}

/** The latest value, for handlers that are set up once. */
function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** Size the app to the visible screen, so a phone keyboard never covers the message box. */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const apply = () => {
      root.style.setProperty('--vvh', `${vv.height}px`)
      root.style.setProperty('--vvt', `${vv.offsetTop}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [])
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

const byRecent = (a: SessionInfo, b: SessionInfo) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()

export function App() {
  const client = useMemo(() => new HubClient(), [])
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [connState, setConnState] = useState<ConnState>('disconnected')
  const [connError, setConnError] = useState<string>()
  const [loginUrl, setLoginUrl] = useState<string>()
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'info' }>()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [folders, setFolders] = useState<FolderInfo[]>([])
  // The main area shows one chat, or two side by side; `activePane` is the one you're in.
  const [panes, setPanes] = useState<(string | undefined)[]>([undefined])
  const [activePane, setActivePane] = useState(0)
  const [prsFor, setPrsFor] = useState<string>()
  const [showOverview, setShowOverview] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string>()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [, setTick] = useState(0)

  const narrow = useMediaQuery('(max-width: 760px)')
  const touch = useMediaQuery('(pointer: coarse)')
  const defaultFont = narrow ? 12 : 14
  const [fontSize, setFontSize] = useStored('wh-hub-font-size', defaultFont)
  const [sidebarCollapsed, setSidebarCollapsed] = useStored('wh-hub-sidebar-collapsed', false)
  const [unreadList, setUnreadList] = useStored<string[]>('wh-hub-unread', [])
  const unread = useMemo(() => new Set(unreadList), [unreadList])
  useVisualViewport()

  const connected = connState === 'connected'
  const split = !narrow && panes.length === 2
  const visiblePanes = split ? [0, 1] : [narrow ? activePane : Math.min(activePane, panes.length - 1)]
  const visibleIds = visiblePanes.map((i) => panes[i]).filter((id): id is string => !!id)
  const selectedId = panes[activePane]
  const ordered = useMemo(() => sidebarOrder(sessions, folders), [sessions, folders])

  const latest = useLatest({ panes, activePane, sessions, ordered, narrow, connected, creating, visibleIds, split })

  const markRead = (id: string) => setUnreadList((l) => (l.includes(id) ? l.filter((x) => x !== id) : l))

  /** Show a chat in the pane you're in (or focus the side that already shows it). */
  const openChat = (id: string) => {
    const { panes: p, activePane: a, narrow: n } = latest.current
    setShowOverview(false)
    markRead(id)
    const elsewhere = n ? -1 : p.findIndex((x, i) => x === id && i !== a)
    if (elsewhere >= 0) return setActivePane(elsewhere)
    const next = [...p]
    next[a] = id
    setPanes(next)
  }

  const openInSplit = (id: string) => {
    const { panes: p, activePane: a } = latest.current
    setShowOverview(false)
    markRead(id)
    const shown = p.indexOf(id)
    if (p.length === 2 && shown >= 0) return setActivePane(shown)
    // Already the open chat: keep it and bring another one up beside it —
    // never the same chat on both sides.
    if (shown >= 0) return toggleSplit()
    const other = p.length === 2 ? 1 - a : 1
    const next = p.length === 2 ? [...p] : [p[0], undefined]
    next[other] = id
    setPanes(next)
    setActivePane(other)
  }

  const toggleSplit = () => {
    const { panes: p, activePane: a, sessions: all } = latest.current
    if (p.length === 2) {
      setPanes([p[a]])
      setActivePane(0)
      return
    }
    // Fill the new side with the most recently active other chat.
    const other = [...all].filter((s) => s.id !== p[0] && s.status === 'running').sort(byRecent)[0]
    setPanes([p[0], other?.id])
    setActivePane(1)
  }

  const closePane = (i: number) => {
    const rest = latest.current.panes.filter((_, j) => j !== i)
    setPanes(rest.length ? rest : [undefined])
    setActivePane(0)
  }

  const stepChat = (dir: 1 | -1) => {
    const { ordered: order, panes: p, activePane: a } = latest.current
    if (!order.length) return
    const at = order.findIndex((s) => s.id === p[a])
    const next = order[at < 0 ? 0 : (at + dir + order.length) % order.length]
    openChat(next.id)
  }

  const zoom = (delta: number) => setFontSize((f) => (delta ? Math.min(24, Math.max(9, f + delta)) : defaultFont))

  useEffect(
    () =>
      client.onMessage((msg) => {
        if (msg.t === 'hello-ok' || msg.t === 'sessions') setSessions(client.sessions)
        if (msg.t === 'hello-ok') setPresets(client.presets)
        if (msg.t === 'hello-ok' || msg.t === 'folders') setFolders(client.folders)
        if (msg.t === 'created') {
          openChat(msg.session.id)
          setShowCreate(false)
          setCreating(false)
          setCreateError(undefined)
        }
        if (msg.t === 'error') {
          if (latest.current.creating) {
            setCreating(false)
            setCreateError(msg.message)
          } else {
            setToast({ text: msg.message, kind: 'error' })
          }
        }
        if (msg.t === 'notification') {
          const looking = document.hasFocus() && latest.current.visibleIds.includes(msg.sessionId)
          if (looking) return
          // Something happened in a chat you're not looking at: mark it.
          setUnreadList((l) => (l.includes(msg.sessionId) ? l : [...l, msg.sessionId]))
          // Notification API is absent/gated on mobile Safari — guard so a
          // notification event never throws and breaks session updates.
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              // Daemon sends "<session name>: <status>" — split so the session
              // is the title and the status is the body.
              const sep = msg.message.indexOf(': ')
              const title = sep > 0 ? msg.message.slice(0, sep) : 'WasteHero Dev Hub'
              const body = sep > 0 ? msg.message.slice(sep + 2) : msg.message
              const n = new Notification(title, { body })
              n.onclick = () => {
                window.focus()
                openChat(msg.sessionId)
              }
            } catch {
              /* notifications unavailable on this platform */
            }
          }
        }
      }),
    [client],
  )

  // Coming back to the window clears the dots of the chats you're looking at.
  useEffect(() => {
    const onFocus = () => latest.current.visibleIds.forEach(markRead)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Forget unread marks for chats that are gone.
  useEffect(() => {
    if (!connected) return
    const ids = new Set(sessions.map((s) => s.id))
    if (unreadList.some((id) => !ids.has(id))) setUnreadList(unreadList.filter((id) => ids.has(id)))
  }, [sessions, connected])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(undefined), 6000)
    return () => clearTimeout(t)
  }, [toast])

  // Keep "2m ago" fresh even when nothing else changes.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // The window / tab title counts chats that need you or have news.
  const needsYou = sessions.filter((s) => activityOf(s) === 'attention' || unread.has(s.id)).length
  useEffect(() => {
    document.title = needsYou ? `(${needsYou}) WasteHero Dev Hub` : 'WasteHero Dev Hub'
  }, [needsYou])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = shortcutOf(e)
      if (!sc || !latest.current.connected) return
      e.preventDefault()
      if (sc === 'switcher') setSwitcherOpen((o) => !o)
      else if (sc === 'new-chat') setShowCreate(true)
      else if (sc === 'prev-chat') stepChat(-1)
      else if (sc === 'next-chat') stepChat(1)
      else if (sc === 'zoom-in') zoom(1)
      else if (sc === 'zoom-out') zoom(-1)
      else zoom(0)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        if (s === 'disconnected') setPanes([undefined])
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

  const commands: Command[] = [
    { id: 'new', label: 'New chat', hint: `${MOD}+N`, run: () => setShowCreate(true) },
    { id: 'overview', label: showOverview ? 'Close overview' : 'Open overview', run: () => setShowOverview((o) => !o) },
    ...(!narrow
      ? [
          { id: 'split', label: split ? 'Back to one chat' : 'Split view', run: toggleSplit },
          {
            id: 'sidebar',
            label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
            run: () => setSidebarCollapsed((c) => !c),
          },
        ]
      : []),
    { id: 'zoom-in', label: 'Bigger text', hint: `${MOD}+=`, run: () => zoom(1) },
    { id: 'zoom-out', label: 'Smaller text', hint: `${MOD}+-`, run: () => zoom(-1) },
    { id: 'zoom-reset', label: 'Reset text size', hint: `${MOD}+0`, run: () => zoom(0) },
  ]

  // On a phone, one screen at a time: the list, the overview, or a chat.
  const phoneList = narrow && (!connected || (!selectedId && !showOverview))
  const showSidebar = narrow ? phoneList : !connected || !sidebarCollapsed
  const showRail = !narrow && connected && sidebarCollapsed
  const showMain = !narrow || !phoneList
  const totalCost = sessions.reduce((a, s) => a + (s.costUsd || 0), 0)
  const totalTokens = sessions.reduce((a, s) => a + (s.tokens || 0), 0)

  return (
    <div className={['app', touch && 'touch', narrow && 'narrow'].filter(Boolean).join(' ')}>
      {showRail && (
        <Rail
          sessions={ordered}
          selectedId={selectedId}
          unread={unread}
          showOverview={showOverview}
          onExpand={() => setSidebarCollapsed(false)}
          onNew={() => setShowCreate(true)}
          onSearch={() => setSwitcherOpen(true)}
          onOverview={() => setShowOverview((o) => !o)}
          onSelect={openChat}
        />
      )}
      {showSidebar && (
        <aside className="sidebar">
          <div className="brand">
            <img className="brand-mark" src={whMark} alt="WasteHero" />
            <div className="brand-text">
              <div className="brand-name">WasteHero</div>
              <div className="brand-sub">Dev Hub</div>
            </div>
            {connected && (
              <button className="tool-btn" title={`Find a chat (${MOD}+K)`} onClick={() => setSwitcherOpen(true)}>
                <SearchIcon />
              </button>
            )}
            {connected && !narrow && (
              <button className="tool-btn" title="Collapse sidebar" onClick={() => setSidebarCollapsed(true)}>
                <SidebarIcon />
              </button>
            )}
          </div>

          {!connected ? (
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
              <div className="conn-row">
                <span className="conn-status">
                  <span className="dot ok" /> {client.user}
                </span>
                <span className="usage-total" title="Total Claude usage across all sessions">
                  {fmtCost(totalCost)} · {fmtTokens(totalTokens)}
                </span>
              </div>
              <div className="side-actions">
                <button className="btn primary" title={`New chat (${MOD}+N)`} onClick={() => setShowCreate(true)}>
                  <PlusIcon /> New chat
                </button>
                <button className={`btn ${showOverview ? 'on' : ''}`} onClick={() => setShowOverview((o) => !o)}>
                  <GridIcon /> Overview
                </button>
              </div>
              <ChatList
                sessions={sessions}
                folders={folders}
                selectedId={selectedId}
                unread={unread}
                canSplit={!narrow}
                send={(msg) => client.send(msg)}
                onSelect={openChat}
                onOpenSplit={openInSplit}
                onRelaunch={(id) => {
                  openChat(id)
                  client.send({ t: 'relaunch', sessionId: id, cols: 120, rows: 30 })
                }}
                onRemove={(id) => {
                  client.send({ t: 'remove', sessionId: id })
                  setPanes((p) => p.map((x) => (x === id ? undefined : x)))
                }}
                onShowPrs={setPrsFor}
              />
            </>
          )}
        </aside>
      )}

      {showMain && (
        <main className={['main', split && !showOverview && 'split'].filter(Boolean).join(' ')}>
          {showOverview ? (
            <div className="pane active">
              <div className="main-toolbar">
                {narrow && (
                  <button className="icon-btn back" aria-label="Back to chats" onClick={() => setShowOverview(false)}>
                    <BackIcon />
                  </button>
                )}
                <span className="toolbar-name">Overview — {sessions.length} chats</span>
              </div>
              <OverviewPanel
                sessions={sessions}
                onOpen={openChat}
                onKill={(id) => client.send({ t: 'kill', sessionId: id })}
                onRelaunch={(id) => client.send({ t: 'relaunch', sessionId: id, cols: 120, rows: 30 })}
              />
            </div>
          ) : !connected ? (
            <div className="placeholder">Connect to a WasteHero Dev Hub daemon to get started.</div>
          ) : (
            visiblePanes.map((i) => (
              <SessionPane
                key={i}
                client={client}
                session={sessions.find((s) => s.id === panes[i])}
                active={i === activePane || !split}
                split={split}
                canSplit={!narrow}
                touch={touch}
                compact={narrow}
                fontSize={fontSize}
                onFocus={() => {
                  if (i !== activePane) setActivePane(i)
                  const id = panes[i]
                  if (id) markRead(id)
                }}
                onBack={narrow ? () => setPanes([undefined]) : undefined}
                onToggleSplit={toggleSplit}
                onClosePane={split ? () => closePane(i) : undefined}
                onShowPrs={setPrsFor}
                onNotice={(text) => setToast({ text, kind: 'info' })}
              />
            ))
          )}
        </main>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(undefined)}>
          {toast.text} <span className="toast-dismiss">×</span>
        </div>
      )}

      {switcherOpen && (
        <QuickSwitcher
          sessions={sessions}
          folders={folders}
          commands={commands}
          onOpen={openChat}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {prsFor && sessions.some((s) => s.id === prsFor) && (
        <PrPanel client={client} session={sessions.find((s) => s.id === prsFor)!} onClose={() => setPrsFor(undefined)} />
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
  const sorted = [...props.sessions].sort(
    (a, b) => STATUS_META[activityOf(a)].rank - STATUS_META[activityOf(b)].rank || byRecent(a, b),
  )
  const count = (st: string) => props.sessions.filter((s) => activityOf(s) === st).length

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
          const meta = STATUS_META[activityOf(s)]
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
                {s.progress && typeof s.progress.pct === 'number' && (
                  <span className="ov-pct">
                    <span className="ov-bar" style={{ width: `${s.progress.pct}%` }} />
                    <span className="ov-pct-num">{s.progress.pct}%</span>
                  </span>
                )}
                {s.progress?.eta && <span className="ov-eta">~{s.progress.eta} (agent est.)</span>}
                <span className={`ov-note ${s.progress || s.doing ? '' : 'dim'}`}>{doingLine(s) || '—'}</span>
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
