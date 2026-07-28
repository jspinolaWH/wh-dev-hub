import http from 'node:http'
import type { SessionManager } from './sessions'

// Minimal OTLP/HTTP-JSON metrics receiver. Claude Code (with telemetry on)
// POSTs metric exports here as JSON; we pull out cost + token counts and
// attribute them to the hub session via the `wh.session` resource attribute
// the daemon injects. Metrics are DELTA temporality, so we sum every export.
//
// Only claude_code.cost.usage (USD) and claude_code.token.usage (tokens) are
// used; everything else is ignored. Bound to localhost — sessions run on the
// same host, so nothing is exposed on the network.

interface OtlpKeyValue {
  key: string
  value?: { stringValue?: string; intValue?: string | number; asInt?: string | number; asDouble?: number }
}
interface OtlpDataPoint {
  attributes?: OtlpKeyValue[]
  asDouble?: number
  asInt?: string | number
}
interface OtlpMetric {
  name: string
  sum?: { dataPoints?: OtlpDataPoint[] }
  gauge?: { dataPoints?: OtlpDataPoint[] }
}
interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpKeyValue[] }
  scopeMetrics?: Array<{ metrics?: OtlpMetric[] }>
}

const dpValue = (dp: OtlpDataPoint): number =>
  typeof dp.asDouble === 'number' ? dp.asDouble : Number(dp.asInt ?? 0)

export function startOtelReceiver(port: number, sessions: SessionManager) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/v1/metrics')) {
      res.writeHead(req.url?.includes('/v1/') ? 200 : 404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { resourceMetrics?: OtlpResourceMetrics[] }
        for (const rm of body.resourceMetrics ?? []) {
          const whSession = rm.resource?.attributes?.find((a) => a.key === 'wh.session')?.value?.stringValue
          if (!whSession) continue
          let cost = 0
          let tokens = 0
          for (const sm of rm.scopeMetrics ?? []) {
            for (const m of sm.metrics ?? []) {
              const dps = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? []
              if (m.name === 'claude_code.cost.usage') for (const dp of dps) cost += dpValue(dp)
              else if (m.name === 'claude_code.token.usage') for (const dp of dps) tokens += dpValue(dp)
            }
          }
          if (cost > 0 || tokens > 0) sessions.addUsage(whSession, cost, tokens)
        }
      } catch (err) {
        console.error('[wh-dev-hub] otel parse error:', err instanceof Error ? err.message : err)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  server.on('error', (err) => console.error('[wh-dev-hub] otel receiver error:', err))
  server.listen(port, '127.0.0.1', () => {
    console.log(`[wh-dev-hub] OTLP usage receiver on http://127.0.0.1:${port}/v1/metrics`)
  })
  return server
}
