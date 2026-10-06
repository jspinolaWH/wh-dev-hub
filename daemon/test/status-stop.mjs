// Helper for status.mjs: starts the status reporter in-process and stops it the
// way the daemon's shutdown handler does. A test can't make a daemon process
// run its shutdown on Windows (killing a child never runs its handlers).
// Run under tsx with WH_HUB_DATA set.
import { EventEmitter } from 'node:events'

const { StatusReporter } = await import('../src/status.ts')
const http = Object.assign(new EventEmitter(), { listening: true })
const reporter = new StatusReporter({
  statusPage: { repo: 'acme/hub', apiUrl: 'http://127.0.0.1:9' },
  config: { host: '127.0.0.1', port: 9, tokens: {} },
  sessions: { list: () => [] },
  server: { http, connections: () => ({ clients: 0, users: 0 }) },
  otelPort: 9,
})
reporter.stop()
process.exit(0)
