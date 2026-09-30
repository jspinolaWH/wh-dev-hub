import { useEffect, useMemo, useRef, useState } from 'react'
import type { FolderInfo, SessionInfo } from '@wh/shared'
import { MOD } from './shortcuts'
import { StatusIcon, activityOf, doingLine } from './status'

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

type Item = { kind: 'chat'; s: SessionInfo } | { kind: 'cmd'; c: Command }

// Chats that need you first, then the most recently active.
const rank = (s: SessionInfo) => (activityOf(s) === 'attention' ? 0 : 1)
const byUrgency = (a: SessionInfo, b: SessionInfo) =>
  rank(a) - rank(b) || new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()

/** Ctrl+K: jump to any chat by name, folder or what it's doing — or run a command. */
export function QuickSwitcher(props: {
  sessions: SessionInfo[]
  folders: FolderInfo[]
  commands: Command[]
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const folderName = useMemo(() => new Map(props.folders.map((f) => [f.id, f.name])), [props.folders])

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo((): Item[] => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w))
    const chats = [...props.sessions]
      .sort(byUrgency)
      .filter((s) => hit(`${s.name} ${folderName.get(s.folderId ?? '') ?? ''} ${doingLine(s)}`))
      .map((s): Item => ({ kind: 'chat', s }))
    const cmds = props.commands.filter((c) => hit(c.label)).map((c): Item => ({ kind: 'cmd', c }))
    return [...chats, ...cmds]
  }, [query, props.sessions, props.commands, folderName])

  useEffect(() => setSel(0), [query])
  useEffect(() => listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' }), [sel])

  const run = (i: number) => {
    const it = items[i]
    if (!it) return
    props.onClose()
    if (it.kind === 'chat') props.onOpen(it.s.id)
    else it.c.run()
  }

  return (
    <div className="modal-backdrop switcher-backdrop" onClick={props.onClose}>
      <div className="switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Jump to a chat, or run a command…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((i) => Math.min(i + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(sel)
            } else if (e.key === 'Escape') {
              props.onClose()
            }
          }}
        />
        <div className="switcher-list" ref={listRef}>
          {items.map((it, i) =>
            it.kind === 'chat' ? (
              <button
                key={it.s.id}
                className={`switcher-item ${i === sel ? 'sel' : ''}`}
                onMouseMove={() => setSel(i)}
                onClick={() => run(i)}
              >
                <StatusIcon activity={activityOf(it.s)} />
                <span className="switcher-name">{it.s.name}</span>
                {it.s.folderId && folderName.get(it.s.folderId) && (
                  <span className="switcher-folder">{folderName.get(it.s.folderId)}</span>
                )}
                <span className="switcher-doing">{doingLine(it.s)}</span>
              </button>
            ) : (
              <button
                key={it.c.id}
                className={`switcher-item cmd ${i === sel ? 'sel' : ''}`}
                onMouseMove={() => setSel(i)}
                onClick={() => run(i)}
              >
                <span className="switcher-cmd">›</span>
                <span className="switcher-name">{it.c.label}</span>
                {it.c.hint && <span className="switcher-hint">{it.c.hint}</span>}
              </button>
            ),
          )}
          {!items.length && <div className="switcher-empty">Nothing matches “{query}”</div>}
        </div>
        <div className="switcher-foot">↑↓ move · Enter open · Esc close · {MOD}+K</div>
      </div>
    </div>
  )
}
