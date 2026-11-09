import { existsSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
function files(directory: string, suffix: string) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(n => n.endsWith(suffix)).map(file => ({ file, path: join(directory, file), stat: lstatSync(join(directory, file)) })).filter(f => f.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
}
function tail(path: string, size: number, max: number): string {
  const fd = openSync(path, 'r')
  try {
    const length = Math.min(size, max), data = Buffer.alloc(length)
    readSync(fd, data, 0, length, Math.max(0, size - length))
    // A window that starts inside a multi-byte character must skip the sequence it cuts, so no U+FFFD reaches the reader.
    let offset = 0
    while (offset < data.length && (data[offset]! & 0xc0) === 0x80) offset++
    return data.subarray(offset).toString('utf8')
  } finally { closeSync(fd) }
}
/** Bounded, read-only diagnostics for an existing ticket. Never accepts a caller-supplied file path. */
export function ticketDiagnostics(stateDir: string, ticketId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ticketId)) throw Error('Invalid ticket ID')
  const directory = join(stateDir, 'sessions', ticketId), latest = files(directory, '.jsonl')[0]
  const messages: Array<{ role: string; text: string; timestamp?: string }> = []
  if (latest) {
    const lines = tail(latest.path, latest.stat.size, 512 * 1024).split('\n'); if (latest.stat.size > 512 * 1024) lines.shift()
    for (const line of lines) {
      try {
        const entry = JSON.parse(line), msg = entry.message
        if (entry.type !== 'message' || !msg) continue
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        messages.push({ role: String(msg.role), text: String(text).slice(0, 2000), timestamp: entry.timestamp })
      } catch { /* A trailing entry can be mid-write. */ }
    }
  }
  const jobs = files(join(directory, 'jobs'), '.job.json').slice(0, 20).map(file => {
    if (file.stat.size > 128 * 1024) return { file: file.file, error: 'Job record exceeds diagnostic size limit' }
    try { const job = JSON.parse(tail(file.path, file.stat.size, 128 * 1024)); return { ...job, output: String(job.output || '').slice(-8000) } }
    catch { return { file: file.file, error: 'Unreadable job record' } }
  })
  return { session: latest ? { file: latest.file, bytes: latest.stat.size, modifiedAt: latest.stat.mtime.toISOString() } : null, messages: messages.slice(-30), jobs }
}
