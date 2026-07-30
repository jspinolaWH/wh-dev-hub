import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Serves the built web client (app/dist) so a phone/browser can open the Dev
// Hub over Tailscale — same UI as the desktop app, same WebSocket on the same
// port. SPA: unknown non-file routes fall back to index.html.

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

export function createWebHandler(distDir: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const hasDist = fs.existsSync(path.join(distDir, 'index.html'))
    if (!hasDist) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Web client not built. Run: npm run build -w app')
      return
    }

    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    // Resolve within distDir; reject path traversal.
    let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath)
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403).end('forbidden')
      return
    }
    // SPA fallback: no extension and not a real file -> index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html')
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        // Assets are content-hashed by Vite; index.html must never cache.
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
      })
      res.end(buf)
    })
  }
}

/** app/dist relative to the daemon bundle at daemon/dist/index.cjs. */
export function defaultDistDir(): string {
  return path.resolve(__dirname, '..', '..', 'app', 'dist')
}
