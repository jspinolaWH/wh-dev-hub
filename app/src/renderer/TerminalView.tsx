import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { HubClient } from './hubClient'

export function TerminalView({ client, sessionId }: { client: HubClient; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 14,
      theme: { background: '#0b1220', foreground: '#d7e0ea', cursor: '#3fd08c' },
      scrollback: 20000,
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

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      client.send({ t: 'resize', sessionId, cols: term.cols, rows: term.rows })
    })
    resizeObserver.observe(el)
    term.focus()

    return () => {
      resizeObserver.disconnect()
      offInput.dispose()
      offMsg()
      client.send({ t: 'detach', sessionId })
      term.dispose()
    }
  }, [client, sessionId])

  return <div className="terminal-container" ref={containerRef} />
}
