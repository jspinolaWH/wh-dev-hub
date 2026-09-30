import type { SessionInfo } from '@wh/shared'

export type Activity = SessionInfo['activityStatus']

/** A lost or exited chat is offline whatever its last activity was. */
export const activityOf = (s: SessionInfo): Activity => (s.status === 'running' ? s.activityStatus : 'offline')

export const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'Working',
  attention: 'Needs you',
  idle: 'Waiting for you',
  offline: 'Stopped',
}

/** A chat's one-line "what it's doing". */
export function doingLine(s: SessionInfo): string {
  if (s.status === 'lost') return 'Lost when the hub restarted — relaunch to start it again'
  if (s.status === 'exited') return `Exited${s.exitCode !== undefined ? ` (code ${s.exitCode})` : ''}`
  return s.progress?.note || s.doing || s.lastLine || ''
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Spinner while working, a pulsing dot when it needs you, a plain dot otherwise. */
export function StatusIcon({ activity }: { activity: Activity }) {
  return <span className={`status-icon ${activity}`} role="img" aria-label={ACTIVITY_LABEL[activity]} title={ACTIVITY_LABEL[activity]} />
}
