import type { ClientMsg, ServerMsg, SessionInfo, PresetInfo } from '@wh/shared'

type Listener = (msg: ServerMsg) => void

export type ConnState = 'disconnected' | 'connecting' | 'connected'

export class HubClient {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  state: ConnState = 'disconnected'
  user = ''
  sessions: SessionInfo[] = []
  presets: PresetInfo[] = []

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  connect(url: string, token: string, onStateChange: (s: ConnState, error?: string) => void) {
    this.disconnect()
    this.state = 'connecting'
    onStateChange(this.state)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => this.send({ t: 'hello', token, client: 'wh-dev-hub-app' })
    ws.onmessage = (ev) => {
      const msg: ServerMsg = JSON.parse(ev.data)
      if (msg.t === 'hello-ok') {
        this.state = 'connected'
        this.user = msg.user
        this.sessions = msg.sessions
        this.presets = msg.presets
        onStateChange(this.state)
      } else if (msg.t === 'sessions') {
        this.sessions = msg.sessions
      } else if (msg.t === 'error' && this.state !== 'connected') {
        onStateChange('disconnected', msg.message)
        ws.close()
        return
      }
      for (const fn of this.listeners) fn(msg)
    }
    ws.onclose = () => {
      if (this.state !== 'disconnected') {
        this.state = 'disconnected'
        onStateChange(this.state)
      }
      this.ws = null
    }
    ws.onerror = () => {
      if (this.state === 'connecting') onStateChange('disconnected', 'could not reach daemon')
    }
  }

  disconnect() {
    this.state = 'disconnected'
    this.ws?.close()
    this.ws = null
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}
