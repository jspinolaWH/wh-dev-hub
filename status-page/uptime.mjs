// What the hub's heartbeat (status.json) says about now, about each past day,
// and about the times it was down. No DOM here, so the daemon's tests can check
// that the page reads exactly what the daemon writes.

const MIN = 60_000
const SHORT_GAP = 2 * MIN

/**
 * Is the heartbeat current? GitHub's raw CDN can serve status.json up to five
 * minutes old on top of the heartbeat interval, so allow for both before
 * calling it late, and wait a good while longer before calling the hub offline.
 * @returns {'live' | 'late' | 'offline'}
 */
export function freshness(doc, now) {
  const age = now - Date.parse(doc.generatedAt)
  const interval = (doc.intervalSec || 120) * 1000
  if (age <= interval + 6 * MIN) return 'live'
  if (age <= 3 * interval + 10 * MIN) return 'late'
  return 'offline'
}

/**
 * The hub's up-time as runs of epoch-ms, and the span the data speaks for
 * ([from, to)). While live, the hub is up to this moment; once offline, the
 * silence since the last heartbeat counts as down; while merely late, that
 * silence is left out (it may just be the CDN).
 */
export function timeline(doc, now) {
  const state = freshness(doc, now)
  const runs = (doc.uptime?.runs ?? []).map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end), clean: !!r.clean }))
  const last = runs.at(-1)
  if (last && state === 'live') last.end = Math.max(last.end, now)
  const from = Date.parse(doc.uptime?.since ?? doc.generatedAt)
  return { state, runs, from, to: state === 'late' && last ? last.end : now }
}

/** How much of [from, to) the hub was up, out of the part the data covers; null if it covers none. */
export function availability(tl, from, to) {
  const lo = Math.max(from, tl.from)
  const hi = Math.min(to, tl.to)
  if (!(hi > lo)) return null
  let up = 0
  for (const r of tl.runs) up += Math.max(0, Math.min(r.end, hi) - Math.max(r.start, lo))
  return { ratio: up / (hi - lo), downMs: hi - lo - up, sinceMs: lo }
}

/** The last `count` local calendar days, oldest first (today is partial). */
export function days(tl, now, count = 90) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const out = []
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(today)
    start.setDate(today.getDate() - i) // calendar days, so DST's 23/25-hour days come out right
    const end = new Date(start)
    end.setDate(start.getDate() + 1)
    out.push({ start: start.getTime(), end: end.getTime(), uptime: availability(tl, start.getTime(), Math.min(end.getTime(), now)) })
  }
  return out
}

/**
 * The times the hub wasn't up, newest first: every gap between runs, plus the
 * current silence once the hub reads as offline. How the run before a gap
 * ended tells what it was: stopped on purpose (a restart, or a longer stop),
 * or lost (crash, power cut, sleep).
 * @returns {{ start: number, end: number, ms: number, kind: 'restart' | 'stopped' | 'unexpected-restart' | 'outage', ongoing?: true }[]}
 */
export function outages(tl, now) {
  const out = []
  for (let i = 1; i < tl.runs.length; i++) {
    const prev = tl.runs[i - 1]
    if (tl.runs[i].start > prev.end) out.push(gap(prev, tl.runs[i].start))
  }
  const last = tl.runs.at(-1)
  if (tl.state === 'offline' && last) out.push({ ...gap(last, now), ongoing: true })
  return out.reverse()
}

function gap(prev, end) {
  const ms = end - prev.end
  const kind = prev.clean ? (ms < SHORT_GAP ? 'restart' : 'stopped') : ms < SHORT_GAP ? 'unexpected-restart' : 'outage'
  return { start: prev.end, end, ms, kind }
}

/**
 * Status band for a day (or any span) by how long the hub was down: a quick
 * restart is fine, an afternoon offline is not. Minutes, rather than a share,
 * so a partial "today" doesn't look worse than it is.
 * @returns {'good' | 'warning' | 'serious' | 'critical' | 'none'}
 */
export function band(uptime) {
  if (!uptime) return 'none'
  const down = uptime.downMs / MIN
  if (down <= 1) return 'good'
  if (down <= 15) return 'warning'
  if (down <= 120) return 'serious'
  return 'critical'
}

/** 99.99% style: truncated, never rounded up to a 100% (or 99%) it wasn't. */
export function percent(ratio) {
  if (ratio >= 1) return '100%'
  const digits = ratio >= 0.99 ? 2 : 1
  const scale = 10 ** digits
  return `${(Math.floor(ratio * 100 * scale + 1e-9) / scale).toFixed(digits)}%`
}
