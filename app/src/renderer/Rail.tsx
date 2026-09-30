import type { SessionInfo } from '@wh/shared'
import whMark from './assets/wh-mark.svg'
import { chatStyle } from './ChatList'
import { GridIcon, PlusIcon, SearchIcon, SidebarIcon } from './icons'
import { MOD } from './shortcuts'
import { ACTIVITY_LABEL, activityOf, doingLine } from './status'

const initials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase()
}

/** The collapsed sidebar: a bubble per chat that still shows its live status. */
export function Rail(props: {
  sessions: SessionInfo[]
  selectedId?: string
  unread: Set<string>
  showOverview: boolean
  onExpand: () => void
  onNew: () => void
  onSearch: () => void
  onOverview: () => void
  onSelect: (id: string) => void
}) {
  return (
    <aside className="rail">
      <button className="rail-brand" title="Expand sidebar" onClick={props.onExpand}>
        <img src={whMark} alt="WasteHero" />
      </button>
      <button className="rail-btn" title={`New chat (${MOD}+N)`} onClick={props.onNew}>
        <PlusIcon />
      </button>
      <button className="rail-btn" title={`Find a chat (${MOD}+K)`} onClick={props.onSearch}>
        <SearchIcon />
      </button>
      <button className={`rail-btn ${props.showOverview ? 'on' : ''}`} title="Overview" onClick={props.onOverview}>
        <GridIcon />
      </button>
      <div className="rail-sep" />
      <div className="rail-chats">
        {props.sessions.map((s) => {
          const activity = activityOf(s)
          const badge = activity === 'attention' ? 'attention' : props.unread.has(s.id) ? 'unread' : undefined
          return (
            <button
              key={s.id}
              className={['rail-chat', activity, s.id === props.selectedId && 'selected', s.color && 'tagged'].filter(Boolean).join(' ')}
              style={chatStyle(s.color)}
              title={`${s.name} — ${ACTIVITY_LABEL[activity]}\n${doingLine(s)}`}
              onClick={() => props.onSelect(s.id)}
            >
              {initials(s.name)}
              {badge && <span className={`rail-badge ${badge}`} />}
            </button>
          )
        })}
      </div>
      <button className="rail-btn" title="Expand sidebar" onClick={props.onExpand}>
        <SidebarIcon />
      </button>
    </aside>
  )
}
