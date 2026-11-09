import { key, type Ticket, type Trigger } from './core/index.js'
import type { Store } from './store.js'

export function recordAttentionResponse(store: Store, ticket: Ticket, trigger: Trigger): void {
  if (!ticket.attention || !trigger.human || ticket.origin.triggerId === trigger.id || ticket.origin.triggerIds.includes(trigger.id)) return
  const responseKey = `attention-response:${ticket.attention.id}`
  if (store.get<{ triggerId: string }>(responseKey)?.triggerId === trigger.id) return
  store.set(responseKey, { triggerId: trigger.id, at: trigger.at })
  const replyKey = `reply:${key('attention-reply', ticket.attention.id)}`, reply = store.get<{ status: string }>(replyKey)
  if (reply?.status === 'pending') store.set(replyKey, { ...reply, status: 'dropped' })
  store.audit({ type: 'attention.responded', ticketId: ticket.id, attentionId: ticket.attention.id, triggerId: trigger.id })
}
/** Upgrade existing tickets from durable reports and owned human inputs, without inferring an execution change. */
export function recoverAttentionResponse(store: Store, ticket: Ticket): void {
  if (!ticket.attention || store.get(`attention-response:${ticket.attention.id}`)) return
  const reports = store.db.prepare("SELECT value FROM kv WHERE key GLOB 'report:*' AND json_extract(value, '$.ticketId') = ? AND json_extract(value, '$.report.question') = ?")
    .all(ticket.id, ticket.attention.question).map(row => JSON.parse(String(row.value)))
  const opened = reports.find(row => key('attention', ticket.id, ticket.attention!.question, row.at) === ticket.attention!.id)?.at
  if (!opened) return
  const origin = new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds])
  for (const input of [...ticket.inputs].reverse()) {
    if (input.kind !== 'trigger' || input.context || !input.human || origin.has(input.triggerId)) continue
    const trigger = store.triggers.get(input.triggerId)
    if (trigger && trigger.at >= opened) { recordAttentionResponse(store, ticket, trigger); return }
  }
}
