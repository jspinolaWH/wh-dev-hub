import net from 'node:net'
import type { SessionLink } from '@wh/shared'

/**
 * A preset is a one-click environment recipe. Ports are allocated from the
 * given ranges at session-create time; every occurrence of `${NAME}` in
 * command, env values, links and cwd is replaced with the allocated port,
 * and each port is also exported to the session as env var `NAME`.
 */
export interface Preset {
  id: string
  name: string
  description: string
  cwd: string
  command: string
  env?: Record<string, string>
  ports?: Record<string, { from: number; to?: number }>
  links?: SessionLink[]
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '0.0.0.0')
  })
}

export class PortAllocator {
  /** Ports handed out to still-running sessions; freed on session exit. */
  private leased = new Set<number>()

  async allocate(range: { from: number; to?: number }): Promise<number> {
    const to = range.to ?? range.from + 99
    for (let port = range.from; port <= to; port++) {
      if (this.leased.has(port)) continue
      if (await isPortFree(port)) {
        this.leased.add(port)
        return port
      }
    }
    throw new Error(`no free port in range ${range.from}-${to}`)
  }

  release(ports: number[]) {
    for (const p of ports) this.leased.delete(p)
  }

  /**
   * Optimistically re-claim a specific port when relaunching a session.
   * Synchronous and best-effort: it does not probe the OS (the caller
   * tolerates the port being taken), it just avoids double-leasing.
   */
  reserve(port: number) {
    if (this.leased.has(port)) throw new Error(`port ${port} already leased`)
    this.leased.add(port)
  }
}

export interface ResolvedPreset {
  cwd: string
  command: string
  env: Record<string, string>
  links: SessionLink[]
  ports: number[]
}

export async function resolvePreset(preset: Preset, allocator: PortAllocator): Promise<ResolvedPreset> {
  const allocated: Record<string, number> = {}
  const ports: number[] = []
  try {
    for (const [name, range] of Object.entries(preset.ports ?? {})) {
      const port = await allocator.allocate(range)
      allocated[name] = port
      ports.push(port)
    }
  } catch (err) {
    allocator.release(ports)
    throw err
  }

  const sub = (s: string) => s.replace(/\$\{(\w+)\}/g, (m, name) => (name in allocated ? String(allocated[name]) : m))

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(preset.env ?? {})) env[k] = sub(v)
  for (const [name, port] of Object.entries(allocated)) env[name] = String(port)

  return {
    cwd: sub(preset.cwd),
    command: sub(preset.command),
    env,
    links: (preset.links ?? []).map((l) => ({ label: l.label, url: sub(l.url) })),
    ports,
  }
}
