import { useRef, useState } from 'react'
import type { SessionInfo } from '@wh/shared'
import type { HubClient } from './hubClient'
import { TerminalView } from './TerminalView'
import { chatStyle } from './ChatList'
import { PrIcon } from './PrPanel'
import { attachFiles } from './files'
import { BackIcon, ClipIcon, LoopIcon, SearchIcon, SinglePaneIcon, SplitIcon } from './icons'
import { MOD } from './shortcuts'
import { StatusIcon, activityOf, doingLine } from './status'

/** One side of the main area: a chat's toolbar and its terminal. */
export function SessionPane(props: {
  client: HubClient
  session?: SessionInfo
  active: boolean
  split: boolean
  canSplit: boolean
  touch: boolean
  compact: boolean
  fontSize: number
  onFocus: () => void
  onBack?: () => void
  onToggleSplit: () => void
  onClosePane?: () => void
  onShowPrs: (id: string) => void
  onNotice: (text: string) => void
}) {
  const { client, session: s } = props
  const [searchRequest, setSearchRequest] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const prCount = s?.prs?.length ?? 0

  const attach = async () => {
    if (!s) return
    if (!window.wh?.pickFiles) return fileInput.current?.click()
    const files = await window.wh.pickFiles()
    if (!files.length) return
    for (const f of files) client.send({ t: 'attach-file', sessionId: s.id, name: f.name, base64: f.base64 })
    props.onNotice(`Attached ${files.map((f) => f.name).join(', ')} — the path is on the prompt; add your message and send.`)
  }

  return (
    <section
      className={['pane', props.active && 'active', props.split && 'split'].filter(Boolean).join(' ')}
      onMouseDown={props.onFocus}
      onFocusCapture={props.onFocus}
    >
      <div className={`main-toolbar ${s?.color ? 'tagged' : ''}`} style={chatStyle(s?.color)}>
        {props.onBack && (
          <button className="icon-btn back" aria-label="Back to chats" onClick={props.onBack}>
            <BackIcon />
          </button>
        )}
        {s ? (
          <>
            <StatusIcon activity={activityOf(s)} />
            <div className="toolbar-title">
              <span className="toolbar-name">{s.name}</span>
              <span className="toolbar-doing">{doingLine(s)}</span>
            </div>
            <div className="toolbar-actions">
              {prCount > 0 && (
                <button className="tool-btn" title="Pull requests from this chat" onClick={() => props.onShowPrs(s.id)}>
                  <PrIcon size={14} /> {prCount}
                </button>
              )}
              <button className="tool-btn" title={`Find in chat (${MOD}+F)`} onClick={() => setSearchRequest((n) => n + 1)}>
                <SearchIcon />
              </button>
              {s.status === 'running' && (
                <button className="tool-btn" title="Attach files (or drop them on the terminal)" onClick={attach}>
                  <ClipIcon />
                </button>
              )}
              {s.status === 'running' && (
                <AutoContinueControl
                  compact={props.compact || props.split}
                  session={s}
                  onSet={(enabled, prompt) => client.send({ t: 'set-auto-continue', sessionId: s.id, enabled, prompt })}
                />
              )}
              {props.canSplit && <SplitToggle split={props.split} onToggle={props.onToggleSplit} />}
              {props.onClosePane && (
                <button className="tool-btn" title="Close this side" onClick={props.onClosePane}>
                  ×
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <span className="toolbar-name muted">{props.split ? 'Pick a chat for this side' : 'No chat open'}</span>
            <div className="toolbar-actions">
              {props.canSplit && props.split && <SplitToggle split onToggle={props.onToggleSplit} />}
              {props.onClosePane && (
                <button className="tool-btn" title="Close this side" onClick={props.onClosePane}>
                  ×
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="pane-body">
        {!s ? (
          <div className="placeholder">
            {props.split
              ? 'Click a chat in the sidebar to show it here.'
              : 'Select or create a session — it keeps running on the host even when you close this app.'}
          </div>
        ) : s.status === 'lost' ? (
          <div className="placeholder">
            <div>
              This chat was lost when the hub restarted.
              <br />
              Relaunch it to run <code>{s.name}</code> again in {s.cwd}.
              <div style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => client.send({ t: 'relaunch', sessionId: s.id, cols: 120, rows: 30 })}>
                  Relaunch
                </button>
              </div>
            </div>
          </div>
        ) : (
          <TerminalView
            key={`${s.id}:${s.generation}`}
            client={client}
            sessionId={s.id}
            fontSize={props.fontSize}
            touch={props.touch}
            active={props.active}
            searchRequest={searchRequest}
            onNotice={props.onNotice}
          />
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (s && files.length) props.onNotice(await attachFiles(client, s.id, files))
        }}
      />
    </section>
  )
}

function SplitToggle(props: { split: boolean; onToggle: () => void }) {
  return (
    <button className={`tool-btn ${props.split ? 'on' : ''}`} title={props.split ? 'Back to one chat' : 'Split view: two chats side by side'} onClick={props.onToggle}>
      {props.split ? <SinglePaneIcon /> : <SplitIcon />}
    </button>
  )
}

function AutoContinueControl(props: { session: SessionInfo; compact: boolean; onSet: (enabled: boolean, prompt: string) => void }) {
  const ac = props.session.autoContinue
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(ac.prompt)

  return (
    <div className="autocont">
      <button
        className={`tool-btn ${ac.enabled ? 'on' : ''}`}
        title="Auto-continue: when the chat finishes and goes idle, send your nudge automatically (capped)."
        onClick={() => (ac.enabled ? props.onSet(false, ac.prompt) : setOpen((o) => !o))}
      >
        <LoopIcon />
        {ac.enabled ? ` ${ac.sent}/${ac.maxNudges}` : props.compact ? '' : ' Auto-continue'}
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
