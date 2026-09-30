import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { HubClient } from './hubClient'
import { attachFiles } from './files'
import { isMod, shortcutOf } from './shortcuts'
import { openLink } from './util'

const writeClipboard = (text: string) =>
  window.wh?.writeClipboard ? window.wh.writeClipboard(text) : navigator.clipboard.writeText(text)

// Search highlights (the addon wants #RRGGBB).
const SEARCH_COLORS = {
  matchBackground: '#2a3c58',
  matchOverviewRuler: '#75bdea',
  activeMatchBackground: '#8a6d1f',
  activeMatchColorOverviewRuler: '#facc15',
}

type KeySeq = string | ((appCursor: boolean) => string)

/** Keys a phone keyboard doesn't have, for driving Claude's TUI. */
const KEYS: { label: string; title: string; seq: KeySeq }[] = [
  { label: 'Esc', title: 'Esc — interrupt Claude', seq: '\x1b' },
  { label: '⇧Tab', title: 'Shift+Tab — switch mode', seq: '\x1b[Z' },
  { label: 'Tab', title: 'Tab', seq: '\t' },
  { label: '↑', title: 'Up', seq: (a) => (a ? '\x1bOA' : '\x1b[A') },
  { label: '↓', title: 'Down', seq: (a) => (a ? '\x1bOB' : '\x1b[B') },
  { label: '←', title: 'Left', seq: (a) => (a ? '\x1bOD' : '\x1b[D') },
  { label: '→', title: 'Right', seq: (a) => (a ? '\x1bOC' : '\x1b[C') },
  { label: '⏎', title: 'Enter', seq: '\r' },
  { label: '^C', title: 'Ctrl+C', seq: '\x03' },
]

export function TerminalView(props: {
  client: HubClient
  sessionId: string
  fontSize: number
  /** Touch screen: type in a message box (autocorrect, dictation) plus a key bar, not in the terminal. */
  touch: boolean
  /** The pane you're in (split view) takes the keyboard. */
  active: boolean
  /** Bumped by the toolbar's search button. */
  searchRequest: number
  onNotice: (text: string) => void
}) {
  const { client, sessionId, touch } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const noticeRef = useRef(props.onNotice)
  noticeRef.current = props.onNotice
  const [scrolledUp, setScrolledUp] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ index: -1, count: 0 })
  const [dropping, setDropping] = useState(false)

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => searchInputRef.current?.select())
  }

  /** Tell the pty about a new size, but only when it really changed (a resize repaints TUIs). */
  const syncSize = () => {
    const term = termRef.current
    if (!term) return
    fitRef.current?.fit()
    if (term.cols === sizeRef.current.cols && term.rows === sizeRef.current.rows) return
    sizeRef.current = { cols: term.cols, rows: term.rows }
    client.send({ t: 'resize', sessionId, cols: term.cols, rows: term.rows })
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: props.fontSize,
      theme: { background: '#0b1220', foreground: '#d7e0ea', cursor: '#75bdea', selectionBackground: '#2a4d66' },
      scrollback: 20000,
      // Hosts are Windows; tells xterm the source is ConPTY so it handles
      // its full-screen repaints and reflow correctly.
      windowsPty: { backend: 'conpty' },
      allowProposedApi: true,
      // OSC 8 hyperlinks; plain URLs are handled by the web-links addon.
      linkHandler: { activate: (_e, uri) => openLink(uri) },
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    term.open(el)
    fit.fit()
    sizeRef.current = { cols: term.cols, rows: term.rows }
    // On a touch screen the message box is for typing: tapping the terminal
    // must not pop the keyboard up.
    if (touch) term.textarea?.setAttribute('inputmode', 'none')

    client.send({ t: 'attach', sessionId, cols: term.cols, rows: term.rows })

    const offMsg = client.onMessage((msg) => {
      if (msg.t === 'attached' && msg.sessionId === sessionId) {
        term.write(msg.scrollback)
      } else if (msg.t === 'output' && msg.sessionId === sessionId) {
        term.write(msg.data)
      } else if (msg.t === 'exit' && msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[33m[session exited with code ${msg.exitCode}]\x1b[0m\r\n`)
      }
    })

    const offInput = term.onData((data) => client.send({ t: 'input', sessionId, data }))

    // "Jump to latest": you scrolled up; maybe new output arrived below since.
    // (xterm doesn't report user scrolling via onScroll, so watch the viewport.)
    const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY
    const viewport = el.querySelector('.xterm-viewport')
    const onViewportScroll = () => {
      const up = !atBottom()
      setScrolledUp(up)
      if (!up) setNewBelow(false)
    }
    viewport?.addEventListener('scroll', onViewportScroll)
    const offParsed = term.onWriteParsed(() => {
      if (!atBottom()) setNewBelow(true)
    })
    const offResults = search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount }))

    const sendImageBlob = (blob: Blob) => {
      blob.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf)
        let bin = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        client.send({ t: 'paste-image', sessionId, pngBase64: btoa(bin) })
      })
    }

    // Primary paste path: Electron main-process clipboard (no browser
    // permission; always works for text). Returns true if it handled the
    // paste. Image via main clipboard is best-effort — some sources (Snipping
    // Tool) aren't captured by readImage(), so when this returns false the
    // native paste event below picks up the image from clipboardData.
    const doPaste = (): boolean => {
      const png = window.wh?.readClipboardImage?.() ?? ''
      if (png) {
        client.send({ t: 'paste-image', sessionId, pngBase64: png })
        return true
      }
      const text = window.wh?.readClipboard?.() ?? ''
      if (text) {
        client.send({ t: 'input', sessionId, data: text })
        return true
      }
      return false
    }

    // Fallback for clipboard images the main-process read misses: Chromium
    // normalizes a pasted screenshot to an image/* item in the paste event.
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData
      if (!dt) return
      let img: File | null = null
      for (let i = 0; i < (dt.items?.length ?? 0); i++) {
        const it = dt.items[i]
        if (it.type.startsWith('image/')) img = it.getAsFile()
      }
      for (let i = 0; !img && i < (dt.files?.length ?? 0); i++) {
        if (dt.files[i].type.startsWith('image/')) img = dt.files[i]
      }
      if (img) {
        e.preventDefault()
        e.stopImmediatePropagation()
        sendImageBlob(img)
      }
    }
    el.addEventListener('paste', onPaste, true)

    // Clipboard keys, matching Windows Terminal / VS Code conventions:
    // - Ctrl+V / Ctrl+Shift+V     -> paste (text, or image if present)
    // - Ctrl+Shift+C              -> copy selection (always)
    // - Ctrl+C WITH a selection   -> copy it (and clear), like on Windows
    // - Ctrl+C with NO selection  -> falls through as SIGINT (interrupt)
    // Plus Ctrl+F (search), and the app's shortcuts go to the window instead.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (shortcutOf(ev)) return false
      if (isMod(ev) && (ev.key === 'f' || ev.key === 'F')) {
        ev.preventDefault() // not the browser's find bar
        openSearch()
        return false
      }
      if (ev.ctrlKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
        // If the main clipboard had text/image, we're done; otherwise let the
        // native paste event fire so onPaste can grab an image it missed.
        return doPaste() ? false : true
      }
      const isCopyKey =
        ev.ctrlKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C') && (ev.shiftKey || term.hasSelection())
      if (isCopyKey) {
        const sel = term.getSelection()
        if (sel) {
          writeClipboard(sel)
          term.clearSelection()
          return false // consumed as copy
        }
        if (ev.shiftKey) return false // Ctrl+Shift+C with nothing selected: no-op
        // plain Ctrl+C with no selection: fall through to SIGINT
      }
      return true
    })

    // Right-click: copy the selection if there is one, otherwise paste —
    // the convention most Windows terminals follow. (Not on touch screens,
    // where a long press is how you select.)
    const onContextMenu = (ev: MouseEvent) => {
      if (touch) return
      ev.preventDefault()
      const sel = term.getSelection()
      if (sel) {
        writeClipboard(sel)
        term.clearSelection()
      } else {
        doPaste()
      }
    }
    el.addEventListener('contextmenu', onContextMenu)

    // Debounced, change-only resize: a resize makes TUI apps repaint the
    // whole screen, so firing it on every observer tick causes a flicker
    // loop when scrollbars toggle the container size by a pixel.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(syncSize, 150)
    })
    resizeObserver.observe(el)
    if (!touch) term.focus()

    return () => {
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('contextmenu', onContextMenu)
      viewport?.removeEventListener('scroll', onViewportScroll)
      clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      offInput.dispose()
      offParsed.dispose()
      offResults.dispose()
      offMsg()
      client.send({ t: 'detach', sessionId })
      term.dispose()
      termRef.current = null
    }
  }, [client, sessionId, touch])

  // Zoom keeps your place: refit, then tell the pty if the grid changed.
  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === props.fontSize) return
    term.options.fontSize = props.fontSize
    syncSize()
  }, [props.fontSize])

  useEffect(() => {
    if (props.active && !touch) termRef.current?.focus()
  }, [props.active, touch])

  // Only presses made while this chat is showing (not an older count).
  const searchSeen = useRef(props.searchRequest)
  useEffect(() => {
    if (props.searchRequest === searchSeen.current) return
    searchSeen.current = props.searchRequest
    openSearch()
  }, [props.searchRequest])

  const find = (backwards: boolean) => {
    if (!query) return
    const opts = { decorations: SEARCH_COLORS }
    if (backwards) searchRef.current?.findPrevious(query, opts)
    else searchRef.current?.findNext(query, opts)
  }

  const closeSearch = () => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setResults({ index: -1, count: 0 })
    if (!touch) termRef.current?.focus()
  }

  const jumpToLatest = () => {
    termRef.current?.scrollToBottom()
    setScrolledUp(false)
    setNewBelow(false)
  }

  const sendMessage = (text: string) => {
    // paste() brackets it when the app asked for bracketed paste (Claude does),
    // so multi-line messages arrive as one; then Enter submits.
    if (text) termRef.current?.paste(text)
    client.send({ t: 'input', sessionId, data: '\r' })
  }

  const sendKey = (seq: KeySeq) => {
    const appCursor = termRef.current?.modes.applicationCursorKeysMode ?? false
    client.send({ t: 'input', sessionId, data: typeof seq === 'function' ? seq(appCursor) : seq })
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  return (
    <div
      className="term-wrap"
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDropping(false)
        attachFiles(client, sessionId, [...e.dataTransfer.files]).then((note) => noticeRef.current(note))
      }}
    >
      <div className="term-stage">
        <div className="terminal-container" ref={containerRef} />
        {searchOpen && (
          <div className="term-search">
            <input
              ref={searchInputRef}
              value={query}
              placeholder="Find in chat"
              onChange={(e) => {
                const q = e.target.value
                setQuery(q)
                if (q) searchRef.current?.findNext(q, { decorations: SEARCH_COLORS, incremental: true })
                else {
                  searchRef.current?.clearDecorations()
                  setResults({ index: -1, count: 0 })
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') find(e.shiftKey)
                if (e.key === 'Escape') closeSearch()
              }}
            />
            <span className="term-search-count">
              {query ? (results.count ? `${results.index + 1}/${results.count}` : 'none') : ''}
            </span>
            <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => find(true)}>
              ↑
            </button>
            <button className="icon-btn" title="Next (Enter)" onClick={() => find(false)}>
              ↓
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={closeSearch}>
              ×
            </button>
          </div>
        )}
        {scrolledUp && (
          <button className={`jump-latest ${newBelow ? 'fresh' : ''}`} onClick={jumpToLatest}>
            {newBelow ? 'New output ↓' : 'Jump to latest ↓'}
          </button>
        )}
        {dropping && <div className="drop-overlay">Drop to attach to this chat</div>}
      </div>
      {touch && <ComposeBar onSend={sendMessage} onKey={sendKey} />}
    </div>
  )
}

/** Phone input: a real text box (autocorrect, dictation) and the keys phones lack. */
function ComposeBar(props: { onSend: (text: string) => void; onKey: (seq: KeySeq) => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the message, up to about five lines.
  useLayoutEffect(() => {
    const t = ref.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 132)}px`
    t.style.overflowY = t.scrollHeight > 132 ? 'auto' : 'hidden'
  }, [text])

  const send = () => {
    props.onSend(text)
    setText('')
  }

  return (
    <div className="compose">
      <div className="keybar">
        {KEYS.map((k) => (
          <button
            key={k.label}
            className="key"
            title={k.title}
            // Keep the text box focused so the keyboard stays up.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => props.onKey(k.seq)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="compose-row">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="Message… (empty sends Enter)"
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="send" aria-label="Send" onPointerDown={(e) => e.preventDefault()} onClick={send}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.4 20.4 21 12 3.4 3.6l-.02 6.55L16 12 3.38 13.85z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  )
}
