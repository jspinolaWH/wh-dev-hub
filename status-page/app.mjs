// Dev Hub status page: reads the hub's heartbeat (status.json on the repo's
// status branch) and the status APIs of the services it relies on, and renders
// them. Anything that comes from data reaches the DOM as text, never as HTML.
import { availability, band, days, outages, percent, timeline } from './uptime.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const params = new URLSearchParams(location.search)
const demo = params.has('demo')
const $ = (id) => document.getElementById(id)

const state = {
  cfg: { repo: '', branch: 'status', defaultBranch: 'main' },
  url: null,
  doc: null,
  loading: true,
  missing: false,
  error: null,
  fetchedAt: 0,
  upstreamAt: 0,
  /** Where the running build stands against the default branch, looked up once per commit. */
  compare: null,
  days: [],
  activeDay: -1,
  allIncidents: false,
}

// ---- tiny DOM helpers ----

/** createElement whose children are nodes or plain text: data never becomes markup. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  put(el, ...kids)
  return el
}

/** replaceChildren, skipping the null/false of conditional children (it would print them as text). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== ''))
}

const ICONS = {
  good: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.8"/>',
  warning: '<path d="M10.3 4.3 2.9 17.4A2 2 0 0 0 4.6 20.4h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  serious: '<path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z"/><path d="M12 8v5M12 16.5h.01"/>',
  critical: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  none: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  late: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  loading: '<path d="M12 3a9 9 0 1 0 9 9"/>',
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }))
    svg.setAttribute(k, v)
  svg.innerHTML = ICONS[name] ?? ICONS.none // constant markup, never data
  if (name === 'loading') svg.classList.add('spin')
  return svg
}

/** A status: the icon carries the colour, the label beside it says it. */
const mark = (tone, label, iconName = tone) => h('span', { class: `mark tone-${tone}` }, icon(iconName), h('span', { class: 'mark-label' }, label))

const tile = (label, value, sub, title) =>
  h('div', { class: 'tile', title }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub && h('div', { class: 'tile-sub' }, sub))

// ---- formatting ----

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
const fmtDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fmtWhen = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
const when = (t) => (sameDay(t, Date.now()) ? `today ${fmtTime.format(t)}` : fmtWhen.format(t))
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const gb = (bytes) => {
  const g = bytes / 1024 ** 3
  return `${g < 10 ? g.toFixed(1) : Math.round(g)} GB`
}
const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

function ago(ms) {
  if (ms < 45_000) return 'just now'
  if (ms < HOUR) return `${Math.round(ms / MIN)} min ago`
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`
  return `${plural(Math.round(ms / DAY), 'day')} ago`
}

/** "8s", "4m 10s", "2h 13m", "3d 4h" */
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return m < 10 && s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const hr = Math.floor(m / 60)
  if (hr < 24) return m % 60 ? `${hr}h ${m % 60}m` : `${hr}h`
  const d = Math.floor(hr / 24)
  return hr % 24 ? `${d}d ${hr % 24}h` : `${d}d`
}

// ---- data ----

async function loadConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-store' }) // written by the Pages workflow
    if (res.ok) Object.assign(state.cfg, await res.json())
  } catch {
    /* a local preview has none */
  }
  const repo = params.get('repo')
  if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) state.cfg.repo = repo
}

function feedUrl() {
  if (demo) return 'demo.json'
  // Local testing: a JSON file next to the page (relative paths only).
  const data = params.get('data')
  if (data && /^[\w-]+(\/[\w-]+)*\.json$/.test(data)) return data
  const { repo, branch } = state.cfg
  return repo ? `https://raw.githubusercontent.com/${repo}/${branch}/status.json` : null
}

async function refresh() {
  if (!state.url) {
    state.loading = false
    return render()
  }
  $('refresh').classList.add('spinning')
  try {
    const res = await fetch(state.url, { cache: 'no-store' })
    if (res.status === 404) Object.assign(state, { doc: null, missing: true, error: null })
    else if (!res.ok) throw new Error(`HTTP ${res.status}`)
    else {
      const doc = await res.json()
      if (doc.schema !== 1) throw new Error(`unknown status format (schema ${doc.schema})`)
      Object.assign(state, { doc: demo ? shiftDemo(doc, Date.now()) : doc, missing: false, error: null })
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err) // keep showing the last good heartbeat
  } finally {
    state.loading = false
    state.fetchedAt = Date.now()
    $('refresh').classList.remove('spinning')
  }
  render()
  void checkBehind()
}

/** How far the running build is from the default branch. GitHub allows 60 anonymous lookups an hour, so one per commit. */
async function checkBehind() {
  const sha = state.doc?.hub?.build?.sha
  const { repo, defaultBranch } = state.cfg
  if (!sha || !repo || demo || state.compare?.sha === sha) return
  state.compare = { sha }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${sha}...${defaultBranch || 'main'}`)
    if (res.status === 404) state.compare.missing = true
    else if (res.ok) {
      const j = await res.json()
      Object.assign(state.compare, { status: j.status, ahead: j.ahead_by, behind: j.behind_by })
    }
  } catch {
    /* leave it out */
  }
  render()
}

/** The demo file is a fixed snapshot: move it to "40 seconds ago". */
function shiftDemo(doc, now) {
  const shift = now - 40_000 - Date.parse(doc.generatedAt)
  const t = (iso) => new Date(Date.parse(iso) + shift).toISOString()
  return {
    ...doc,
    generatedAt: t(doc.generatedAt),
    hub: { ...doc.hub, startedAt: t(doc.hub.startedAt) },
    uptime: { since: t(doc.uptime.since), runs: doc.uptime.runs.map((r) => ({ ...r, start: t(r.start), end: t(r.end) })) },
  }
}

// ---- rendering ----

function render() {
  const now = Date.now()
  const doc = state.doc
  const tl = doc ? timeline(doc, now) : null
  renderHero(doc, tl, now)
  renderUptime(doc, tl, now)
  renderComponents(doc, tl, now)
  renderServer(doc, tl, now)
  renderIncidents(doc, tl, now)
}

function heroModel(doc, tl, now) {
  if (!doc) {
    if (state.loading) return { tone: 'loading', icon: 'loading', title: 'Checking the hub…', detail: 'Loading the latest heartbeat.' }
    if (!state.url)
      return {
        tone: 'none',
        title: 'Not set up yet',
        detail: "This page doesn't know which repo to read. Deploy it with the repo's Status page workflow, or add ?repo=owner/name to the address.",
        demoLink: true,
      }
    if (state.missing)
      return {
        tone: 'none',
        title: 'No heartbeat yet',
        detail: "The hub hasn't published its status to this repo. Turn it on with statusPage in the hub's config (see the README).",
        demoLink: true,
      }
    return { tone: 'none', title: "Can't load the status", detail: `GitHub didn't answer this browser (${state.error}). Trying again every minute.` }
  }
  const last = Date.parse(doc.generatedAt)
  if (tl.state === 'offline') {
    const run = tl.runs.at(-1)
    if (run?.clean) return { tone: 'critical', title: 'Hub stopped', detail: `It was shut down ${when(run.end)} (${ago(now - run.end)}) and hasn't started again.` }
    return {
      tone: 'critical',
      title: 'Hub offline',
      detail: `No heartbeat since ${when(last)} (${ago(now - last)}). The office PC may be off, asleep or without internet.`,
    }
  }
  if (tl.state === 'late')
    return {
      tone: 'warning',
      icon: 'late',
      title: 'Heartbeat late',
      detail: `Last heard from ${ago(now - last)}, later than usual. Often just GitHub's cache; checking again every minute.`,
    }
  const down = (doc.components ?? []).filter((c) => !c.ok)
  const web = down.find((c) => c.id === 'web')
  if (web)
    return { tone: 'serious', title: 'Hub not answering', detail: `The daemon is running, but its web and WebSocket port isn't answering (${web.detail}).` }
  if (down.length)
    return {
      tone: 'warning',
      title: 'Partly degraded',
      detail: `${listOf(down.map((c) => c.name))} ${down.length === 1 ? 'is' : 'are'} down; the hub itself is up. Last heartbeat ${ago(now - last)}.`,
    }
  return { tone: 'good', title: 'All systems operational', detail: `The hub is up and answering. Last heartbeat ${ago(now - last)}.` }
}

function renderHero(doc, tl, now) {
  const m = heroModel(doc, tl, now)
  $('hero').dataset.tone = m.tone
  $('hero-icon').replaceChildren(icon(m.icon ?? m.tone))
  $('hero-title').textContent = m.title
  const note = doc && state.error ? ` Couldn't refresh just now (${state.error}).` : ''
  put($('hero-detail'), m.detail + note, m.demoLink && !demo && h('span', {}, ' ', h('a', { href: '?demo' }, 'See it with demo data')))
  document.title = `${m.title} · Dev Hub Status`
}

const SPANS = [
  ['Last 24 hours', DAY],
  ['Last 7 days', 7 * DAY],
  ['Last 30 days', 30 * DAY],
  ['Last 90 days', 90 * DAY],
]

const EVENT_NAMES = {
  outage: ['outage', 'outages'],
  'unexpected-restart': ['unexpected restart', 'unexpected restarts'],
  stopped: ['stop', 'stops'],
  restart: ['restart', 'restarts'],
}

function eventsText(events) {
  return Object.entries(EVENT_NAMES)
    .filter(([kind]) => events[kind])
    .map(([kind, [one, many]]) => `${events[kind]} ${events[kind] === 1 ? one : many}`)
    .join(', ')
}

const dayLabel = (d, now) => (sameDay(d.start, now) ? 'Today, so far' : fmtDay.format(d.start))

function renderUptime(doc, tl, now) {
  const strip = $('strip')
  if (!doc) {
    $('uptime-tiles').replaceChildren(...SPANS.map(([label]) => tile(label, '—', state.loading ? 'loading' : 'no data')))
    $('uptime-note').textContent = ''
    state.days = []
    strip.replaceChildren(...Array.from({ length: 90 }, () => h('span', { class: 'cell', 'data-band': 'none' })))
    $('uptime-table').replaceChildren()
    return hideTip()
  }
  $('uptime-note').textContent = `tracked since ${fmtDate.format(tl.from)}`
  $('uptime-tiles').replaceChildren(
    ...SPANS.map(([label, span]) => {
      const a = availability(tl, now - span, now)
      if (!a) return tile(label, '—', 'no data yet')
      const partial = a.sinceMs > now - span + HOUR // tracking began inside this window
      return tile(label, percent(a.ratio), partial ? `since ${fmtDate.format(a.sinceMs)}` : a.downMs >= 1000 ? `${dur(a.downMs)} down` : 'no downtime')
    }),
  )

  const gaps = outages(tl, now)
  state.days = days(tl, now, 90).map((d) => {
    const events = {}
    for (const g of gaps) if (g.start < d.end && g.end > d.start) events[g.kind] = (events[g.kind] ?? 0) + 1
    return { ...d, band: band(d.uptime), events }
  })
  strip.replaceChildren(
    ...state.days.map((d, i) => h('span', { class: i === state.activeDay ? 'cell is-active' : 'cell', 'data-band': d.band, 'data-i': i })),
  )
  if (state.activeDay >= 0) showTip(state.activeDay) // keep an open tooltip current

  const rows = state.days.filter((d) => d.uptime).reverse()
  $('uptime-table').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', { class: 'num' }, 'Uptime'), h('th', { class: 'num' }, 'Down'), h('th', {}, 'Events'))),
    h(
      'tbody',
      {},
      rows.map((d) =>
        h(
          'tr',
          {},
          h('td', {}, dayLabel(d, now)),
          h('td', { class: 'num' }, percent(d.uptime.ratio)),
          h('td', { class: 'num' }, d.uptime.downMs >= 1000 ? dur(d.uptime.downMs) : '–'),
          h('td', {}, eventsText(d.events) || '–'),
        ),
      ),
    ),
  )
}

const BAND_LABELS = [
  ['good', 'Up (at most a minute down)'],
  ['warning', 'Up to 15 min down'],
  ['serious', 'Up to 2 h down'],
  ['critical', 'More than 2 h down'],
  ['none', 'No data'],
]

function renderLegend() {
  $('legend').replaceChildren(...BAND_LABELS.map(([b, label]) => h('li', {}, h('span', { class: 'swatch', style: b === 'none' ? null : `--band: var(--${b})` }), label)))
}

/** Phones show only the last 30 cells. */
const firstVisible = () => (matchMedia('(max-width: 639px)').matches ? 60 : 0)

function showTip(i) {
  const d = state.days[i]
  if (!d) return hideTip()
  state.activeDay = i
  const strip = $('strip')
  for (const c of strip.children) c.classList.toggle('is-active', Number(c.dataset.i) === i)
  const tip = $('strip-tip')
  const down = d.uptime && (d.uptime.downMs >= 1000 ? `${dur(d.uptime.downMs)} down` : 'No downtime')
  tip.replaceChildren(
    h('div', { class: 'tip-date' }, dayLabel(d, Date.now())),
    h('div', { class: 'tip-value' }, d.uptime ? mark(d.band, `${percent(d.uptime.ratio)} up`) : 'No data'),
    h('div', { class: 'tip-detail' }, d.uptime ? [down, eventsText(d.events)].filter(Boolean).join(' · ') : 'Before tracking began'),
  )
  tip.hidden = false
  const cell = strip.children[i].getBoundingClientRect()
  const wrap = strip.parentElement.getBoundingClientRect()
  const left = cell.left + cell.width / 2 - wrap.left - tip.offsetWidth / 2
  tip.style.left = `${Math.max(0, Math.min(left, wrap.width - tip.offsetWidth))}px`
}

function hideTip() {
  state.activeDay = -1
  $('strip-tip').hidden = true
  for (const c of $('strip').children) c.classList.remove('is-active')
}

function wireStrip() {
  const strip = $('strip')
  const cellAt = (e) => e.target.closest?.('.cell[data-i]')
  const point = (e) => {
    const c = cellAt(e)
    if (c) showTip(Number(c.dataset.i))
  }
  strip.addEventListener('pointermove', point)
  strip.addEventListener('pointerdown', point) // a tap, on touch screens
  strip.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && document.activeElement !== strip) hideTip()
  })
  strip.addEventListener('focus', () => showTip(state.activeDay >= firstVisible() ? state.activeDay : state.days.length - 1))
  strip.addEventListener('blur', hideTip)
  strip.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key]
    if (step === undefined || !state.days.length) return
    e.preventDefault()
    const from = state.activeDay < 0 ? state.days.length - 1 : state.activeDay
    showTip(Math.max(firstVisible(), Math.min(state.days.length - 1, from + step)))
  })
  document.addEventListener('pointerdown', (e) => {
    if (!strip.contains(e.target)) hideTip()
  })
}

function staleNote(card, doc, tl, now, liveText) {
  const stale = !!doc && tl.state !== 'live'
  $(card).classList.toggle('is-stale', stale)
  return stale ? `as of the last heartbeat, ${ago(now - Date.parse(doc.generatedAt))}` : liveText
}

const placeholder = () => h('li', { class: 'empty' }, state.loading ? 'Loading…' : 'Shown once the hub reports in.')

function renderComponents(doc, tl, now) {
  $('components-note').textContent = staleNote('components-card', doc, tl, now, 'checked on the office PC')
  if (!doc) return $('components').replaceChildren(placeholder())
  $('components').replaceChildren(
    ...(doc.components ?? []).map((c) =>
      h(
        'li',
        { class: 'row' },
        h('span', { class: 'row-name' }, c.name),
        h(
          'span',
          { class: 'row-end' },
          h('span', { class: 'row-detail' }, [c.detail, c.ok && c.ms != null ? `${c.ms} ms` : null].filter(Boolean).join(' · ')),
          mark(c.ok ? 'good' : 'critical', c.ok ? 'Up' : 'Down'),
        ),
      ),
    ),
  )
}

function versionTile(hub) {
  const b = hub.build
  if (!b?.sha) return tile('Hub version', 'unknown', 'built outside git')
  const short = b.sha.slice(0, 7)
  const value = state.cfg.repo && !demo ? h('a', { href: `https://github.com/${state.cfg.repo}/commit/${b.sha}` }, short) : short
  const c = state.compare?.sha === b.sha ? state.compare : null
  const main = state.cfg.defaultBranch || 'main'
  // compare(build...main): `ahead` = on main but not running here; `behind` = running here but not on main.
  const standing = demo
    ? 'demo build'
    : c?.missing
      ? 'not on GitHub (local build)'
      : c?.status &&
        ([c.ahead && `${plural(c.ahead, 'commit')} behind ${main}`, c.behind && `${c.behind} not on ${main}`].filter(Boolean).join(', ') || `latest ${main}`)
  return tile('Hub version', value, [standing, b.date && `built from ${fmtDate.format(Date.parse(b.date))}`].filter(Boolean).join(' · '), b.subject)
}

function meter(label, value, pct, sub) {
  const p = Math.max(0, Math.min(100, pct))
  const [fill, word] = p >= 95 ? ['var(--critical)', 'almost full'] : p >= 85 ? ['var(--warning)', 'running high'] : ['var(--accent)', null]
  return h(
    'div',
    { class: 'meter' },
    h('div', { class: 'meter-head' }, h('span', {}, label), h('strong', {}, value)),
    h(
      'div',
      { class: 'meter-track', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p) },
      h('div', { class: 'meter-fill', style: `width: ${p}%; --fill: ${fill}` }),
    ),
    h('div', { class: 'meter-sub' }, [sub, word].filter(Boolean).join(' · ')),
  )
}

function renderServer(doc, tl, now) {
  $('server-note').textContent = staleNote('server-card', doc, tl, now, '')
  if (!doc) {
    $('server-tiles').replaceChildren()
    $('meters').replaceChildren()
    $('host-line').textContent = state.loading ? 'Loading…' : 'Shown once the hub reports in.'
    return
  }
  const { sessions: s, people: p, host, hub } = doc
  const busy = [s.working && `${s.working} working`, s.idle && `${s.idle} idle`, s.attention && `${s.attention} ${s.attention === 1 ? 'needs' : 'need'} you`]
  const started = Date.parse(hub.startedAt)
  const claude = doc.components?.find((c) => c.id === 'claude')
  const sinceBeat = tl.state === 'live' ? now - Date.parse(doc.generatedAt) : 0
  $('server-tiles').replaceChildren(
    tile('Chats running', String(s.running), [...busy, s.stopped && `${s.stopped} stopped`].filter(Boolean).join(' · ') || 'none right now'),
    tile('People online', String(p.online), `${plural(p.connections, 'connection')} · ${p.registered} with access`),
    versionTile(hub),
    tile('Claude Code', claude?.ok ? claude.detail : claude ? 'unavailable' : '—', 'CLI on the office PC'),
    tile('Hub up for', tl.state === 'offline' ? '—' : dur(now - started), `since ${when(started)}`),
    tile('Office PC up for', dur(host.uptimeSec * 1000 + sinceBeat), 'since its last boot'),
  )
  const mem = host.memory
  const disk = host.disk
  put(
    $('meters'),
    meter('CPU', host.cpu.usagePct == null ? '—' : `${host.cpu.usagePct}%`, host.cpu.usagePct ?? 0, plural(host.cpu.cores, 'core')),
    meter('Memory', `${Math.round((100 * mem.usedBytes) / mem.totalBytes)}%`, (100 * mem.usedBytes) / mem.totalBytes, `${gb(mem.usedBytes)} of ${gb(mem.totalBytes)}`),
    disk &&
      meter(
        `Disk ${disk.drive}`,
        `${gb(disk.freeBytes)} free`,
        100 * (1 - disk.freeBytes / disk.totalBytes),
        `${gb(disk.totalBytes - disk.freeBytes)} of ${gb(disk.totalBytes)} used`,
      ),
  )
  $('host-line').textContent = [host.os, `${host.cpu.model}`, `Node ${hub.node}`, host.arch].join(' · ')
}

const KINDS = {
  restart: { tone: 'info', label: 'Restarted' },
  stopped: { tone: 'warning', label: 'Stopped' },
  'unexpected-restart': { tone: 'warning', label: 'Unexpected restart' },
  outage: { tone: 'critical', label: 'Outage' },
}

function renderIncidents(doc, tl, now) {
  const list = $('incidents')
  if (!doc) return list.replaceChildren(placeholder())
  const gaps = outages(tl, now).filter((g) => g.end > now - 90 * DAY)
  if (!gaps.length) return list.replaceChildren(h('li', { class: 'empty' }, `None since tracking began, ${fmtDate.format(tl.from)}.`))
  const shown = state.allIncidents ? gaps : gaps.slice(0, 8)
  put(
    list,
    ...shown.map((g) => {
      const k = KINDS[g.kind]
      const tone = g.kind === 'outage' && g.ms < 15 * MIN ? 'serious' : k.tone
      return h(
        'li',
        { class: 'row' },
        mark(tone, g.ongoing ? (g.kind === 'stopped' ? 'Stopped, still down' : 'Offline now') : k.label),
        h('span', { class: 'row-detail' }, g.ongoing ? `since ${when(g.start)}` : when(g.start)),
        h('span', { class: 'row-end' }, g.ongoing ? `${dur(g.ms)} so far` : dur(g.ms)),
      )
    }),
    gaps.length > shown.length &&
      h(
        'li',
        {},
        h(
          'button',
          {
            class: 'more',
            type: 'button',
            onclick: () => {
              state.allIncidents = true
              render()
            },
          },
          `Show all ${gaps.length}`,
        ),
      ),
  )
}

// ---- services the hub relies on (their public status APIs allow browsers) ----

const UPSTREAM = [
  { name: 'Claude Code', page: 'https://status.claude.com', api: 'https://status.claude.com/api/v2/summary.json', component: 'Claude Code' },
  { name: 'GitHub', page: 'https://www.githubstatus.com', api: 'https://www.githubstatus.com/api/v2/status.json' },
  { name: 'Slack', page: 'https://slack-status.com', api: 'https://slack-status.com/api/v2.0.0/current', slack: true },
  { name: 'Tailscale', page: 'https://status.tailscale.com', api: 'https://status.tailscale.com/api/v2/status.json' },
]
const INDICATOR = {
  none: { tone: 'good', label: 'Operational' },
  minor: { tone: 'warning', label: 'Minor issues' },
  major: { tone: 'serious', label: 'Major outage' },
  critical: { tone: 'critical', label: 'Critical outage' },
  maintenance: { tone: 'info', label: 'Maintenance' },
}
const COMPONENT = {
  operational: { tone: 'good', label: 'Operational' },
  degraded_performance: { tone: 'warning', label: 'Degraded' },
  partial_outage: { tone: 'serious', label: 'Partial outage' },
  major_outage: { tone: 'critical', label: 'Major outage' },
  under_maintenance: { tone: 'info', label: 'Maintenance' },
}
const UNKNOWN = { tone: 'none', label: 'Unknown' }

function readUpstream(u, j) {
  if (u.slack) {
    if (j.status === 'ok') return INDICATOR.none
    return { tone: j.status === 'broken' ? 'critical' : 'warning', label: j.status === 'broken' ? 'Outage' : 'Incident', detail: j.active_incidents?.[0]?.title }
  }
  const c = u.component && j.components?.find((x) => x.name === u.component)
  if (c) {
    const incident = j.incidents?.find((i) => i.components?.some((x) => x.id === c.id))
    return { ...(COMPONENT[c.status] ?? UNKNOWN), detail: incident?.name }
  }
  const s = j.status ?? {}
  return { ...(INDICATOR[s.indicator] ?? UNKNOWN), detail: s.indicator === 'none' ? undefined : s.description }
}

async function refreshUpstream() {
  state.upstreamAt = Date.now()
  const rows = await Promise.all(
    UPSTREAM.map(async (u) => {
      try {
        const res = await fetch(u.api, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return { u, ...readUpstream(u, await res.json()) }
      } catch {
        return { u, ...UNKNOWN, detail: "couldn't reach its status page" }
      }
    }),
  )
  $('upstream').replaceChildren(
    ...rows.map((r) =>
      h(
        'li',
        { class: 'row' },
        h('a', { class: 'row-name', href: r.u.page, rel: 'noopener' }, r.u.name),
        h('span', { class: 'row-end' }, r.detail && h('span', { class: 'row-detail' }, r.detail), mark(r.tone, r.label)),
      ),
    ),
  )
}

// ---- page chrome ----

function linkRepo() {
  const { repo, branch, defaultBranch } = state.cfg
  if (!repo) return
  for (const a of document.querySelectorAll('[data-doc]')) {
    a.href = a.dataset.doc ? `https://github.com/${repo}/blob/${defaultBranch || 'main'}/${a.dataset.doc}` : `https://github.com/${repo}`
  }
  $('feed-link').href = `https://github.com/${repo}/tree/${branch}`
}

function wireChrome() {
  $('refresh').addEventListener('click', () => {
    void refresh()
    void refreshUpstream()
  })
  $('theme').addEventListener('click', () => {
    const root = document.documentElement
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    root.dataset.theme = dark ? 'light' : 'dark'
    try {
      localStorage.setItem('wh-status-theme', root.dataset.theme)
    } catch {
      /* private mode: just not remembered */
    }
  })
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy)
        b.textContent = 'Copied'
      } catch {
        b.textContent = 'Select and copy'
      }
      setTimeout(() => (b.textContent = 'Copy'), 1500)
    })
  }
}

async function main() {
  wireChrome()
  wireStrip()
  renderLegend()
  render()
  await loadConfig()
  state.url = feedUrl()
  linkRepo()
  $('demo-banner').hidden = !demo
  void refreshUpstream()
  await refresh()
  setInterval(() => !document.hidden && refresh(), MIN)
  setInterval(() => !document.hidden && refreshUpstream(), 5 * MIN)
  setInterval(() => !document.hidden && render(), 15_000) // "2 min ago" keeps moving
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    if (Date.now() - state.fetchedAt > 30_000) void refresh()
    if (Date.now() - state.upstreamAt > 5 * MIN) void refreshUpstream()
  })
}

void main()
