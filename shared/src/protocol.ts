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
  | { t: 'resize'; sessionId: string; cols: number; rows: number }
  | { t: 'kill'; sessionId: string }
  | { t: 'remove'; sessionId: string }

export type ServerMsg =
  | { t: 'hello-ok'; user: string; sessions: SessionInfo[]; presets: PresetInfo[] }
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
