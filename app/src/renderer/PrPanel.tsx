import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { PrRef, PrStatus, SessionInfo, SourceStatus } from '@wh/shared'
import type { HubClient } from './hubClient'
import { openLink } from './util'

type PrsReply = { prs: PrStatus[]; github: SourceStatus; linear: SourceStatus }

const key = (p: PrRef) => `${p.owner}/${p.repo}#${p.number}`.toLowerCase()

const STATE_LABEL: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed', unknown: 'PR' }
const REVIEW_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
}
const CHECKS: Record<string, [string, string]> = {
  SUCCESS: ['ok', '✓ Checks passed'],
  FAILURE: ['bad', '✗ Checks failed'],
  ERROR: ['bad', '✗ Checks failed'],
  PENDING: ['pending', '● Checks running'],
  EXPECTED: ['pending', '● Checks running'],
}

/** Why a source has no data, in words the hub's owner can act on. */
function sourceNote(s: SourceStatus | undefined, fix: string) {
  if (s === 'not-configured') return fix
  if (s && typeof s === 'object') return s.error
  return null
}

/** A chat's pull requests with their GitHub state and the Linear tasks they belong to. */
export function PrPanel(props: { client: HubClient; session: SessionInfo; onClose: () => void }) {
  const { client, session, onClose } = props
  const [reply, setReply] = useState<PrsReply>()
  const [loading, setLoading] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)
  const refs = session.prs ?? []
  const count = refs.length

  useEffect(
    () =>
      client.onMessage((m) => {
        if (m.t !== 'prs' || m.sessionId !== session.id) return
        setReply(m)
        setLoading(false)
      }),
    [client, session.id],
  )

  const load = (refresh = false) => {
    setLoading(true)
    client.send({ t: 'get-prs', sessionId: session.id, refresh })
  }
  // On open, and again whenever the chat links another PR meanwhile.
  useEffect(() => load(), [session.id, count])

  useEffect(() => {
    // Take focus so keys (Escape!) never reach the terminal behind.
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const listed = new Set(refs.map(key))
  const prs = (reply?.prs ?? []).filter((p) => listed.has(key(p))) // minus ones removed since
  const open = prs.filter((p) => p.state !== 'MERGED' && p.state !== 'CLOSED')
  const done = prs.filter((p) => p.state === 'MERGED' || p.state === 'CLOSED')
  const notes = [
    sourceNote(reply?.github, 'PR status needs GitHub access on the hub server: sign in with `gh auth login` there, or set github.token in its config.json.'),
    sourceNote(reply?.linear, 'Linked tasks need a Linear API key: set linear.apiKey in the hub server’s config.json.'),
  ].filter(Boolean)

  const row = (pr: PrStatus) => (
    <PrRow
      key={key(pr)}
      pr={pr}
      onForget={() => client.send({ t: 'forget-pr', sessionId: session.id, pr: { owner: pr.owner, repo: pr.repo, number: pr.number } })}
    />
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="pr-panel" ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="pr-panel-head">
          <PrIcon size={18} />
          <div className="pr-panel-title">
            <h3>Pull requests</h3>
            <div className="pr-panel-sub">{session.name}</div>
          </div>
          <button className="icon-btn" title="Refresh from GitHub and Linear" onClick={() => load(true)}>
            <span className={loading ? 'spin' : ''}>↻</span>
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="pr-panel-body">
          {count === 0 ? (
            <div className="pr-empty">
              No pull requests yet. PR links that show up in this chat — for example when Claude opens one — are
              collected here.
            </div>
          ) : !reply ? (
            <div className="pr-empty">Checking GitHub and Linear…</div>
          ) : (
            <>
              {open.length > 0 && <div className="pr-group">Open · {open.length}</div>}
              {open.map(row)}
              {done.length > 0 && <div className="pr-group">Merged / closed · {done.length}</div>}
              {done.map(row)}
            </>
          )}
        </div>
        {notes.length > 0 && (
          <div className="pr-notes">
            {notes.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PrRow({ pr, onForget }: { pr: PrStatus; onForget: () => void }) {
  const state = pr.state === 'OPEN' && pr.draft ? 'draft' : (pr.state ?? 'unknown').toLowerCase()
  const checks = pr.state === 'OPEN' && pr.checks ? CHECKS[pr.checks] : undefined
  return (
    <div className={`pr-row ${state}`}>
      <div className="pr-head">
        <span className={`pr-state ${state}`}>{STATE_LABEL[state]}</span>
        <button className="pr-link" title={pr.url} onClick={() => openLink(pr.url)}>
          <span className="pr-repo">{pr.repo}</span> #{pr.number}
        </button>
        {checks && <span className={`pr-checks ${checks[0]}`}>{checks[1]}</span>}
        {pr.state === 'OPEN' && pr.review && (
          <span className={`pr-review ${pr.review.toLowerCase()}`}>{REVIEW_LABEL[pr.review]}</span>
        )}
        <button className="pr-forget" title="Hide from this chat's list (doesn't change the PR)" onClick={onForget}>
          Hide
        </button>
      </div>
      {pr.title && (
        <button className="pr-title" onClick={() => openLink(pr.url)}>
          {pr.title}
        </button>
      )}
      {pr.tasks.map((t) => (
        <button key={t.identifier} className="pr-task" title={t.assignee ? `${t.title} — ${t.assignee}` : t.title} onClick={() => openLink(t.url)}>
          <span className="pr-task-id">{t.identifier}</span>
          <span className="pr-task-title">{t.title}</span>
          <span className="pr-task-state" style={{ '--state': t.stateColor } as CSSProperties}>
            {t.state}
          </span>
        </button>
      ))}
    </div>
  )
}

export const PrIcon = ({ size = 12 }: { size?: number }) => (
  <svg className="pr-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3 7.25 4.5 9 6" />
    </g>
  </svg>
)
