import { followupOwners, key, latestAssignment, ticketStage, type DomainEvent, type Ticket, type Trigger, type WorkerReport } from './core/index.js'
import type { Store } from './store.js'
import { recordAttentionResponse } from './attention-response.js'
export const clip = (text: string, limit = 600) => text.length > limit ? { text: text.slice(0, limit), chars: text.length } : { text }
export const ticketCard = (ticket: Ticket) => ({ id: ticket.id, title: ticket.title, state: ticket.ended?.outcome || ticketStage(ticket).stage, stage: ticketStage(ticket), scope: clip(ticket.mandate.scope, 400), read: { kind: 'ticket', id: ticket.id } })
export const triggerCard = (trigger: Trigger) => ({ id: trigger.id, source: trigger.source, human: trigger.human, addressed: trigger.addressed, actor: trigger.actor, at: trigger.at, ...clip(trigger.text), url: trigger.url, threads: trigger.threads, read: { kind: 'trigger', id: trigger.id } })
/** Domain mutations and their Router messages share the same transaction. */
export function domainNotice(store: Store, event: DomainEvent): void {
  store.audit(event)
  if (event.type === 'trigger.received' || event.type === 'trigger.followup') {
    const trigger = store.triggers.get(event.data.triggerId)
    if (trigger?.human) {
      const owners = followupOwners(trigger, store)
      for (const id of owners) { const ticket = store.tickets.get(id); if (ticket) recordAttentionResponse(store, ticket, trigger) }
      if (owners.length) store.enqueue('relay', `followup:${trigger.id}`, { kind: 'follow_up', triggerId: trigger.id })
    }
  } else if (event.type === 'ticket.ended') {
    const ticket = store.tickets.get(event.data.ticketId)!
    store.enqueue('notice', `ended:${ticket.id}`, { kind: 'ticket_ended', ticket: ticketCard(ticket) })
  } else if (event.type === 'trigger.requeued' || event.type === 'thread.unsubscribed') {
    store.enqueue('notice', key(event.type, JSON.stringify(event.data)), { kind: event.type.replace('.', '_'), ...event.data })
  }
}
export function followupRelay(store: Store, triggerId: string): unknown | undefined {
  const trigger = store.triggers.get(triggerId)
  if (!trigger) return
  const owners = followupOwners(trigger, store).flatMap(id => { const t = store.tickets.get(id); return t && !t.ended ? [ticketCard(t)] : [] })
  if (!owners.length) return
  return { kind: 'follow_up', trigger: triggerCard(trigger), delivered_to: owners, instruction: 'Workers own this message. Only decide stop if the person requests it; do not accept, attach, ignore, or requeue it. They will hand back out-of-scope work.' }
}
export function reportRelay(store: Store, ticket: Ticket, report: WorkerReport): string | undefined {
  if (report.state === 'progress' && !report.question && !report.answers) return
  const id = key('report', ticket.id, latestAssignment(ticket)?.id || '', ticket.updatedAt, JSON.stringify(report))
  store.set(`report:${id}`, { ticketId: ticket.id, report, at: ticket.updatedAt })
  store.enqueue('relay', id, { kind: report.question ? 'worker_attention' : 'worker_report', ticket: ticketCard(ticket), state: report.state,
    summary: clip(report.summary), ...(report.question ? { question: report.question, attentionId: ticket.attention?.id } : {}), ...(report.answers ? { answerTo: report.answers } : {}), read: { kind: 'report', id }, instructions: { kind: 'instructions', id: ticket.id } })
  return id
}
