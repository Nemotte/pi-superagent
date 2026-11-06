import { existsSync, openSync, closeSync, fsyncSync, readFileSync } from 'node:fs'
import type { Delivery } from './agent-protocol.js'
export function encodeDelivery(delivery: Delivery): string { return JSON.stringify({ superagentDelivery: delivery.id, payload: delivery.text }) }
/** Consult the on-disk transcript, never the SDK's in-memory queue. */
export function persistedDeliveryIds(path: string | undefined): Set<string> {
  const ids = new Set<string>()
  if (!path || !existsSync(path)) return ids
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue
    let entry
    try { entry = JSON.parse(lines[i]) } catch { if (i === lines.length - 1) break; throw Error('Corrupted session transcript') }
    const notice = entry.type === 'custom_message' && entry.customType === 'superagent-notice'
    if (!notice && (entry.type !== 'message' || entry.message?.role !== 'user')) continue
    const content = notice ? entry.content : entry.message.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('') : ''
    try { const data = JSON.parse(text); if (typeof data.superagentDelivery === 'string') ids.add(data.superagentDelivery) } catch {}
  }
  // The parent can now commit its acknowledgement after the transcript has reached disk.
  const fd = openSync(path, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }
  return ids
}
