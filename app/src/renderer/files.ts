import type { HubClient } from './hubClient'

/** Keeps a single WebSocket frame sane (files travel base64 inside JSON). */
const MAX_FILE_BYTES = 25 * 1024 * 1024

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Upload files to the host for a session; the daemon saves each one and puts
 * its path on the prompt. Returns a short line to show the user.
 */
export async function attachFiles(client: HubClient, sessionId: string, files: File[]): Promise<string> {
  const sent: string[] = []
  const tooBig: string[] = []
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      tooBig.push(f.name)
      continue
    }
    client.send({ t: 'attach-file', sessionId, name: f.name, base64: toBase64(await f.arrayBuffer()) })
    sent.push(f.name)
  }
  const parts: string[] = []
  if (sent.length) parts.push(`Attached ${sent.join(', ')} — the path is on the prompt; add your message and send.`)
  if (tooBig.length) parts.push(`${tooBig.join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 25 MB and wasn't sent.`)
  return parts.join(' ')
}
