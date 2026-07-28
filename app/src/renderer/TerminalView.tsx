import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { HubClient } from './hubClient'

const writeClipboard = (text: string) =>
  window.wh?.writeClipboard ? window.wh.writeClipboard(text) : navigator.clipboard.writeText(text)

export function TerminalView({ client, sessionId }: { client: HubClient; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 14,
      theme: { background: '#0b1220', foreground: '#d7e0ea', cursor: '#75bdea' },
      scrollback: 20000,
      // Hosts are Windows; tells xterm the source is ConPTY so it handles
      // its full-screen repaints and reflow correctly.
      windowsPty: { backend: 'conpty' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()

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

    // Paste via the Electron main-process clipboard (no browser permission,
    // always works — xterm's own paste and the DOM paste event are unreliable
    // in this Electron/ConPTY setup). Image first (best-effort; the Attach
    // button is the guaranteed image route), then text.
    const doPaste = () => {
      const png = window.wh?.readClipboardImage?.() ?? ''
      if (png) {
        client.send({ t: 'paste-image', sessionId, pngBase64: png })
        return
      }
      const text = window.wh?.readClipboard?.() ?? ''
      if (text) client.send({ t: 'input', sessionId, data: text })
    }

    // Clipboard keys, matching Windows Terminal / VS Code conventions:
    // - Ctrl+V / Ctrl+Shift+V     -> paste (text, or image if present)
    // - Ctrl+Shift+C              -> copy selection (always)
    // - Ctrl+C WITH a selection   -> copy it (and clear), like on Windows
    // - Ctrl+C with NO selection  -> falls through as SIGINT (interrupt)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (ev.ctrlKey && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
        doPaste()
        return false
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
    // the convention most Windows terminals follow.
    const onContextMenu = (ev: MouseEvent) => {
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
    let lastCols = term.cols
    let lastRows = term.rows
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        fit.fit()
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols
          lastRows = term.rows
          client.send({ t: 'resize', sessionId, cols: term.cols, rows: term.rows })
        }
      }, 150)
    })
    resizeObserver.observe(el)
    term.focus()

    return () => {
      el.removeEventListener('contextmenu', onContextMenu)
      clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      offInput.dispose()
      offMsg()
      client.send({ t: 'detach', sessionId })
      term.dispose()
    }
  }, [client, sessionId])

  return <div className="terminal-container" ref={containerRef} />
}
