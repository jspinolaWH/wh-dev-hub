// Wire protocol between the WH Dev Hub daemon and clients.
// All messages are JSON text frames over a single WebSocket.

export interface SessionLink {
  label: string
  url: string
}

export type SessionStatus = 'running' | 'exited' | 'lost'

export interface SessionInfo {
  id: string
  name: string
  cwd: string
  owner: string
  status: SessionStatus
  exitCode?: number
  createdAt: string
  attachedClients: number
  links: SessionLink[]
  /** Increments on each (re)launch so the client remounts the terminal. */
  generation: number
  /** Accumulated Claude usage for this session (from OpenTelemetry). */
  costUsd: number
  tokens: number
  /** Auto-continue: nudge the session to keep going when it goes idle. */
  autoContinue: { enabled: boolean; prompt: string; maxNudges: number; sent: number }
  /** Overview: derived activity state (running sessions only; else 'offline'). */
  activityStatus: 'working' | 'idle' | 'attention' | 'offline'
  /** ISO timestamp of the last output (or created time if none yet). */
  lastActivityAt: string
  /** Last meaningful output line — a glanceable "what's it doing". */
  lastLine: string
  /** Agent-reported progress, scraped from a [[WH-PROGRESS ...]] line. */
  progress?: { pct?: number; eta?: string; note?: string }
  /** Sidebar organisation, owned by the session's user. */
  color?: ChatColor
  folderId?: string
  /** GitHub pull requests linked in this chat's output, newest first (absent from older daemons). */
  prs?: PrRef[]
}

export interface PrRef {
  owner: string
  repo: string
  number: number
}

/** A Linear issue a pull request is attached to. */
export interface PrTask {
  identifier: string
  title: string
  url: string
  state: string
  /** Linear state type: triage | backlog | unstarted | started | completed | canceled. */
  stateType: string
  stateColor: string
  assignee?: string
}

/** A pull request with what GitHub and Linear currently say about it. */
export interface PrStatus extends PrRef {
  url: string
  title?: string
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  draft?: boolean
  /** Combined CI state of the head commit. */
  checks?: 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED'
  review?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
  author?: string
  tasks: PrTask[]
}

/** Whether a status source answered: no token on the daemon, or what failed. */
export type SourceStatus = 'ok' | 'not-configured' | { error: string }

/** Colour tags a chat can carry (the client maps them to its palette). */
export const CHAT_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const
export type ChatColor = (typeof CHAT_COLORS)[number]

/** A user's sidebar folder for grouping chats. */
export interface FolderInfo {
  id: string
  name: string
}

export interface PresetInfo {
  id: string
  name: string
  description: string
}

export interface CreateSessionRequest {
  name: string
  /** When set, cwd/command come from the daemon-side preset instead. */
  presetId?: string
  cwd?: string
  /** Full command line; defaults to `claude` when omitted. */
  command?: string
  cols: number
  rows: number
}

export type ClientMsg =
  | { t: 'hello'; token: string; client?: string }
  | { t: 'login-start' }
  | { t: 'list' }
  | ({ t: 'create' } & CreateSessionRequest)
  | { t: 'attach'; sessionId: string; cols: number; rows: number }
  | { t: 'relaunch'; sessionId: string; cols: number; rows: number }
  | { t: 'detach'; sessionId: string }
  | { t: 'input'; sessionId: string; data: string }
  | { t: 'paste-image'; sessionId: string; pngBase64: string }
  | { t: 'attach-file'; sessionId: string; name: string; base64: string }
  | { t: 'set-auto-continue'; sessionId: string; enabled: boolean; prompt?: string; maxNudges?: number }
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  | { t: 'kill'; sessionId: string }
  | { t: 'remove'; sessionId: string }
  /** Rename / recolour / move a chat; `null` clears the colour or folder. */
  | { t: 'update-session'; sessionId: string; name?: string; color?: ChatColor | null; folderId?: string | null }
  | { t: 'create-folder'; name: string }
  | { t: 'rename-folder'; folderId: string; name: string }
  /** Deletes only the folder; its chats move back out to the top level. */
  | { t: 'delete-folder'; folderId: string }
  /** Look up a chat's PRs on GitHub + their Linear tasks (cached briefly unless `refresh`). */
  | { t: 'get-prs'; sessionId: string; refresh?: boolean }
  | { t: 'forget-pr'; sessionId: string; pr: PrRef }

export type ServerMsg =
  | { t: 'hello-ok'; user: string; sessions: SessionInfo[]; presets: PresetInfo[]; folders: FolderInfo[] }
  | { t: 'folders'; folders: FolderInfo[] }
  | { t: 'prs'; sessionId: string; prs: PrStatus[]; github: SourceStatus; linear: SourceStatus }
  | { t: 'login-url'; url: string }
  | { t: 'login-ok'; token: string; user: string }
  | { t: 'error'; message: string }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'created'; session: SessionInfo }
  | { t: 'attached'; sessionId: string; scrollback: string }
  | { t: 'output'; sessionId: string; data: string }
  | { t: 'exit'; sessionId: string; exitCode: number }
  | { t: 'notification'; sessionId: string; kind: string; message: string }

export const DEFAULT_DAEMON_PORT = 7811
