/** Bounded authenticated loopback transport; credential material never reaches model resources or logs. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export const DSH_MAX_BYTES = 256 * 1024
/** Reads an owner-private credential file; keep tokens outside settings, repositories and workspaces. */
export function dshToken(path: string): string {
  if (!isAbsolute(path)) throw new Error('DSH bridge credential path must be absolute')
  const file = statSync(path), directory = statSync(dirname(path))
  if (!file.isFile() || file.size > 4096 || (file.mode & 0o777) !== 0o600 || (directory.mode & 0o777) !== 0o700) {
    throw new Error('DSH bridge credentials require a private directory and file')
  }
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Invalid DSH bridge credential file')
  return token
}
export function dshAuthorized(header: string | undefined, tokenFile: string): boolean {
  const token = dshToken(tokenFile)
  const digest = (text: string) => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}
export function dshBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') throw new Error('DSH bridge requires an http://127.0.0.1:port origin')
  return url.origin
}
/** Rejects oversize responses while streaming rather than allocating an unbounded response body. */
export async function dshJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('DSH bridge returned no body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DSH_MAX_BYTES) throw new Error('DSH bridge response exceeds the size limit')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { await reader.cancel().catch(() => {}) }
}
const reading = new Map<string, number>()
/** Limits concurrent reads without accumulating a queue on the Voice Host's hot path. */
export async function dshPost(config: { voiceUrl: string; voiceTokenFile: string; timeoutMs: number; maxReaders: number },
  path: '/voice-bridge/v1/history' | '/voice-bridge/v1/replies', body: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = dshBaseUrl(config.voiceUrl), read = path.endsWith('/history'), count = reading.get(base) ?? 0
  if (read && count >= config.maxReaders) throw new Error('Voice history reader is busy; retry later')
  if (read) reading.set(base, count + 1)
  try {
    const response = await fetch(`${base}${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dshToken(config.voiceTokenFile)}` },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]) })
    if (!response.ok) throw new Error(`Voice bridge request failed (${response.status})`)
    return await dshJson(response)
  } finally {
    if (read) { const left = (reading.get(base) ?? 1) - 1; if (left) reading.set(base, left); else reading.delete(base) }
  }
}
