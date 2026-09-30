import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CHAT_COLORS, type ChatColor, type ClientMsg, type FolderInfo, type SessionInfo } from '@wh/shared'
import { fmtCost, fmtTokens, openLink } from './util'
import { PrIcon } from './PrPanel'

/** Dark-theme palette for chat colour tags (the keys are shared with the daemon). */
export const CHAT_HEX: Record<ChatColor, string> = {
  blue: '#60a5fa',
  teal: '#2dd4bf',
  green: '#4ade80',
  yellow: '#facc15',
  orange: '#fb923c',
  red: '#f87171',
  pink: '#f472b6',
  purple: '#a78bfa',
}

/** Exposes a chat's colour to CSS as `--chat`. */
export const chatStyle = (color?: ChatColor): CSSProperties | undefined =>
  color ? ({ '--chat': CHAT_HEX[color] } as CSSProperties) : undefined

type SessionPatch = { name?: string; color?: ChatColor | null; folderId?: string | null }
type DropZone = {
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

const DRAG_TYPE = 'application/x-wh-session'
const COLLAPSED_KEY = 'wh-hub-collapsed-folders'

/** Which folders this viewer has collapsed — a per-device convenience. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        /* storage unavailable (private mode): keep it for this visit only */
      }
      return next
    })
  return [collapsed, toggle] as const
}

/** The sidebar's chats: folders (collapsible, drop targets) then loose chats. */
export function ChatList(props: {
  sessions: SessionInfo[]
  folders: FolderInfo[]
  selectedId?: string
  send: (msg: ClientMsg) => void
  onSelect: (id: string) => void
  onRelaunch: (id: string) => void
  onRemove: (id: string) => void
  onShowPrs: (id: string) => void
}) {
  const { sessions, folders, selectedId, send } = props
  const [collapsed, toggle] = useCollapsed()
  const [addingFolder, setAddingFolder] = useState(false)
  const [dragging, setDragging] = useState<string>()
  const [dropOn, setDropOn] = useState<string | null>(null) // folder id; '' = top level

  const known = new Set(folders.map((f) => f.id))
  const folderOf = (s: SessionInfo) => (s.folderId && known.has(s.folderId) ? s.folderId : '')
  const draggedIsFiled = !!dragging && sessions.some((s) => s.id === dragging && folderOf(s))

  // Drag a chat onto a folder (or back to the top level) to move it there.
  const dropZone = (target: string): DropZone => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropOn !== target) setDropOn(target)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((d) => (d === target ? null : d))
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const id = e.dataTransfer.getData(DRAG_TYPE)
      const s = sessions.find((x) => x.id === id)
      setDropOn(null)
      setDragging(undefined)
      if (s && folderOf(s) !== target) send({ t: 'update-session', sessionId: id, folderId: target || null })
    },
  })

  const card = (s: SessionInfo) => (
    <SessionCard
      key={s.id}
      session={s}
      folders={folders}
      selected={s.id === selectedId}
      dragging={dragging === s.id}
      onSelect={() => props.onSelect(s.id)}
      onDragStart={() => setDragging(s.id)}
      onDragEnd={() => {
        setDragging(undefined)
        setDropOn(null)
      }}
      onKill={() => send({ t: 'kill', sessionId: s.id })}
      onRelaunch={() => props.onRelaunch(s.id)}
      onRemove={() => props.onRemove(s.id)}
      onShowPrs={() => props.onShowPrs(s.id)}
      onUpdate={(patch) => send({ t: 'update-session', sessionId: s.id, ...patch })}
    />
  )

  return (
    <div className="chat-list">
      <div className="chat-list-head">
        <span>Chats</span>
        <button className="btn tiny" title="Group chats into a folder" onClick={() => setAddingFolder(true)}>
          + Folder
        </button>
      </div>
      {addingFolder && (
        <NameInput
          placeholder="Folder name"
          onSubmit={(name) => {
            send({ t: 'create-folder', name })
            setAddingFolder(false)
          }}
          onCancel={() => setAddingFolder(false)}
        />
      )}
      {folders.map((f) => {
        const inside = sessions.filter((s) => folderOf(s) === f.id)
        return (
          <FolderSection
            key={f.id}
            folder={f}
            count={inside.length}
            open={!collapsed.has(f.id)}
            hasSelected={inside.some((s) => s.id === selectedId)}
            dropping={dropOn === f.id}
            dropZone={dropZone(f.id)}
            onToggle={() => toggle(f.id)}
            onRename={(name) => send({ t: 'rename-folder', folderId: f.id, name })}
            onDelete={() => send({ t: 'delete-folder', folderId: f.id })}
          >
            {inside.map(card)}
          </FolderSection>
        )
      })}
      <div className={`session-list ${dropOn === '' ? 'drop' : ''}`} {...dropZone('')}>
        {sessions.filter((s) => !folderOf(s)).map(card)}
        {draggedIsFiled && <div className="drop-hint">Drop here to take it out of its folder</div>}
        {sessions.length === 0 && <div className="empty">No sessions yet</div>}
      </div>
    </div>
  )
}

function FolderSection(props: {
  folder: FolderInfo
  count: number
  open: boolean
  hasSelected: boolean
  dropping: boolean
  dropZone: DropZone
  onToggle: () => void
  onRename: (name: string) => void
  onDelete: () => void
  children: ReactNode
}) {
  const { folder, count, open } = props
  const [editing, setEditing] = useState(false)
  const [menuFor, setMenuFor] = useState<HTMLElement | null>(null)
  const cls = ['folder', open && 'open', props.dropping && 'drop', props.hasSelected && !open && 'has-selected']
  return (
    <section className={cls.filter(Boolean).join(' ')} {...props.dropZone}>
      <div
        className="folder-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => !editing && props.onToggle()}
        onKeyDown={(e) => {
          if (editing || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          props.onToggle()
        }}
      >
        <ChevronIcon />
        <FolderIcon open={open} />
        {editing ? (
          <NameInput
            initial={folder.name}
            onSubmit={(name) => {
              props.onRename(name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="folder-name"
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {folder.name}
          </span>
        )}
        <CountBadge count={count} />
        <button
          className="icon-btn"
          aria-label={`${folder.name} options`}
          onClick={(e) => {
            e.stopPropagation()
            setMenuFor(menuFor ? null : e.currentTarget)
          }}
        >
          ⋯
        </button>
      </div>
      <div className="folder-body">
        <div className="folder-inner">
          <div className="folder-items">
            {props.children}
            {count === 0 && <div className="folder-empty">Empty — drag a chat here</div>}
          </div>
        </div>
      </div>
      {menuFor && (
        <Menu anchor={menuFor} onClose={() => setMenuFor(null)}>
          <button
            className="menu-item"
            onClick={() => {
              setMenuFor(null)
              setEditing(true)
            }}
          >
            Rename folder
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              setMenuFor(null)
              props.onDelete()
            }}
          >
            Delete folder <span className="menu-hint">chats are kept</span>
          </button>
        </Menu>
      )}
    </section>
  )
}

function SessionCard(props: {
  session: SessionInfo
  folders: FolderInfo[]
  selected: boolean
  dragging: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onKill: () => void
  onRelaunch: () => void
  onRemove: () => void
  onShowPrs: () => void
  onUpdate: (patch: SessionPatch) => void
}) {
  const { session: s, selected, onSelect, onKill, onRelaunch, onRemove, onShowPrs } = props
  const prCount = s.prs?.length ?? 0
  const [editing, setEditing] = useState(false)
  const [menuFor, setMenuFor] = useState<HTMLElement | null>(null)
  const pick = (patch: SessionPatch) => {
    setMenuFor(null)
    props.onUpdate(patch)
  }
  const cls = ['session-card', selected && 'selected', s.color && 'tagged', props.dragging && 'dragging']
  return (
    <div
      className={cls.filter(Boolean).join(' ')}
      style={chatStyle(s.color)}
      onClick={onSelect}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id)
        e.dataTransfer.effectAllowed = 'move'
        props.onDragStart()
      }}
      onDragEnd={props.onDragEnd}
    >
      <div className="session-top">
        <span className={`dot ${s.status === 'running' ? 'ok' : 'off'}`} />
        {editing ? (
          <NameInput
            initial={s.name}
            onSubmit={(name) => {
              props.onUpdate({ name })
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="session-name"
            title="Double-click to rename"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {s.name}
          </span>
        )}
        <button
          className="icon-btn"
          aria-label={`${s.name} options`}
          onClick={(e) => {
            e.stopPropagation()
            setMenuFor(menuFor ? null : e.currentTarget)
          }}
        >
          ⋯
        </button>
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
        {prCount > 0 && (
          <button className="pr-chip" title="Pull requests from this chat" onClick={(e) => (e.stopPropagation(), onShowPrs())}>
            <PrIcon /> {prCount} PR{prCount === 1 ? '' : 's'}
          </button>
        )}
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
      {menuFor && (
        <Menu anchor={menuFor} onClose={() => setMenuFor(null)}>
          <div className="menu-label">Colour</div>
          <div className="swatches">
            <button
              className={`swatch none ${s.color ? '' : 'on'}`}
              aria-label="No colour"
              title="No colour"
              onClick={() => pick({ color: null })}
            />
            {CHAT_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${s.color === c ? 'on' : ''}`}
                style={chatStyle(c)}
                aria-label={c}
                title={c}
                onClick={() => pick({ color: c })}
              />
            ))}
          </div>
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setMenuFor(null)
              setEditing(true)
            }}
          >
            Rename
          </button>
          <button
            className="menu-item"
            onClick={() => {
              setMenuFor(null)
              onShowPrs()
            }}
          >
            <PrIcon /> Pull requests <span className="menu-hint">{prCount}</span>
          </button>
          {props.folders.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Move to folder</div>
              {props.folders.map((f) => (
                <button
                  key={f.id}
                  className={`menu-item ${s.folderId === f.id ? 'current' : ''}`}
                  onClick={() => pick({ folderId: f.id })}
                >
                  <FolderIcon open={false} /> {f.name}
                </button>
              ))}
              {s.folderId && (
                <button className="menu-item" onClick={() => pick({ folderId: null })}>
                  Take out of folder
                </button>
              )}
            </>
          )}
        </Menu>
      )}
    </div>
  )
}

/** A folder's chat count; bumps when a chat lands in or leaves the folder. */
function CountBadge({ count }: { count: number }) {
  const prev = useRef(count)
  const [bumps, setBumps] = useState(0)
  useEffect(() => {
    if (prev.current !== count) setBumps((b) => b + 1)
    prev.current = count
  }, [count])
  return (
    <span key={bumps} className={`folder-count ${bumps ? 'bump' : ''}`}>
      {count}
    </span>
  )
}

/** Popover under a button. Closes on an outside press, Escape, scroll or resize. */
function Menu(props: { anchor: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  const [pos, setPos] = useState<{ top: number; left: number }>()

  // Right-align under the anchor; flip above it when there's no room below.
  useLayoutEffect(() => {
    const a = props.anchor.getBoundingClientRect()
    const m = ref.current!.getBoundingClientRect()
    const left = Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8))
    const top = a.bottom + 4 + m.height > window.innerHeight - 8 ? Math.max(8, a.top - m.height - 4) : a.bottom + 4
    setPos({ top, left })
  }, [props.anchor])

  useEffect(() => {
    // Focus the menu so keys (Escape!) never reach the terminal behind it.
    ref.current?.focus()
    const outside = (t: EventTarget | null) => !ref.current?.contains(t as Node) && !props.anchor.contains(t as Node)
    const onPress = (e: PointerEvent) => outside(e.target) && close.current()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && close.current()
    const onResize = () => close.current()
    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [props.anchor])

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      style={pos ?? { top: 0, left: 0, visibility: 'hidden' }}
      // Portal clicks still bubble up the React tree (to the card) — stop them.
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </div>,
    document.body,
  )
}

/** Inline name field: Enter or clicking away saves, Escape cancels. */
function NameInput(props: {
  initial?: string
  placeholder?: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(props.initial ?? '')
  const done = useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (save && name && name !== props.initial) props.onSubmit(name)
    else props.onCancel()
  }
  return (
    <input
      className="name-input"
      autoFocus
      value={value}
      placeholder={props.placeholder}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation() // keep Space/Enter from toggling the folder around it
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

const ChevronIcon = () => (
  <svg className="folder-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg className="folder-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    {open ? (
      <path
        d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7M2 12.5 3.6 7.7a1 1 0 0 1 .95-.7h9.2a.75.75 0 0 1 .71 1l-1.4 4.2a1 1 0 0 1-.95.8H3a1 1 0 0 1-1-.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    ) : (
      <path
        d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    )}
  </svg>
)
