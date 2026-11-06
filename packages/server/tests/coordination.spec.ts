import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import type { AgentTarget, Delivery } from '../src/agent-protocol.js'
const resources: Array<{ dir: string; runtime: Runtime }> = []
// These tests drive ticks explicitly; OS wall-clock corrections must not move freshly queued effects into the future.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T00:00:00Z')) })
afterEach(async () => { try { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } } finally { vi.useRealTimers() } })
const router = { role: 'router' as const, key: 'router' }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-coordinate-')); initialize(dir, { repository: dir })
  const messages: Array<{ target: AgentTarget; delivery: Delivery }> = []
  const runtime = new Runtime(dir, { send: async (target, delivery) => { messages.push({ target, delivery }) }, stop: async () => {}, close: async () => {} }, { prepare: async () => {} })
  resources.push({ dir, runtime })
  const trigger = runtime.submit({ id: 'first', text: 'Fix spelling only' }); await runtime.tick()
  const decision = await runtime.tool(router, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Spelling', scope: 'One spelling correction', reason: 'Requested' }) as any
  await runtime.tick()
  const worker = messages.find(m => m.target.role === 'worker')!.target
  return { runtime, messages, worker, trigger, ticketId: decision.ticketId as string, dir }
}
it('notifies Router of an owned follow-up so a human stop can be decided without creating new work', async () => {
  const h = await fixture(); h.messages.length = 0
  const followup = h.runtime.followup(h.ticketId, { id: 'stop-in-discussion', text: 'Stop this task now' }); await h.runtime.tick()
  expect(h.messages.some(m => m.target.role === 'worker')).toBe(true)
  const notice = h.messages.find(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === 'follow_up')
  expect(notice).toBeDefined(); expect(JSON.parse(notice!.delivery.text).trigger.id).toBe(followup.id)
  await h.runtime.tool(router, 'route', { kind: 'stop', triggerId: followup.id, ticketId: h.ticketId, reason: 'Human asked to stop' })
  expect(h.runtime.store.tickets.get(h.ticketId)?.ended?.by).toBe('human')
})
it('relays questions and outcomes but keeps ordinary progress internal', async () => {
  const h = await fixture(); h.messages.length = 0
  await h.runtime.tool(h.worker, 'report', { state: 'progress', summary: 'Reading files' }); await h.runtime.tick()
  expect(h.messages.filter(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === 'worker_report')).toHaveLength(0)
  await h.runtime.tool(h.worker, 'report', { state: 'blocked', summary: 'Need a decision', question: 'Keep the existing spelling?' }); await h.runtime.tick()
  const messages = h.messages.filter(m => m.target.role === 'router').map(m => JSON.parse(m.delivery.text))
  expect(messages.some(m => m.kind === 'worker_attention' && m.question === 'Keep the existing spelling?')).toBe(true)
})
it('requires Router to forward the saved human question without rewriting it', async () => {
  const h = await fixture()
  await h.runtime.tool(h.worker, 'report', { state: 'blocked', summary: 'Decision needed', question: 'Keep the existing spelling?' })
  await expect(h.runtime.tool(router, 'reply', { purpose: 'attention', ticketId: h.ticketId, question: 'Keep the existing spelling?', text: 'Authorize a complete redesign instead.' })).rejects.toThrow(/question|unchanged/)
  await expect(h.runtime.tool(router, 'reply', { purpose: 'attention', ticketId: h.ticketId, question: 'Keep the existing spelling?', text: 'Keep the existing spelling?' })).resolves.toBeDefined()
})
it('does not manufacture acknowledgements or publish dropped reports without a model reply decision', async () => {
  const h = await fixture()
  const receipts = () => h.runtime.store.db.prepare("SELECT value FROM kv WHERE key LIKE 'reply:%'").all()
  expect(receipts()).toHaveLength(0)
  await h.runtime.tool(h.worker, 'report', { state: 'dropped', summary: 'Already fixed' }); await h.runtime.tick()
  expect(receipts()).toHaveLength(0)
  expect(h.messages.some(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === 'worker_report')).toBe(true)
})
it('rolls back relays with their domain transaction and retains committed relays across restart', async () => {
  const h = await fixture()
  expect(() => h.runtime.store.atomic(() => { h.runtime.followup(h.ticketId, { id: 'rolled-back', text: 'No' }); throw Error('rollback') })).toThrow('rollback')
  expect(h.runtime.store.pendingEffects().filter(e => e.kind === 'relay')).toHaveLength(0)
  h.runtime.followup(h.ticketId, { id: 'committed', text: 'Please stop' })
  expect(h.runtime.store.pendingEffects().filter(e => e.kind === 'relay')).toHaveLength(1)
  await h.runtime.close()
  const messages: any[] = []
  const reopened = new Runtime(h.dir, { send: async (target, delivery) => { messages.push({ target, delivery }) }, stop: async () => {}, close: async () => {} }, { prepare: async () => {} })
  resources.find(r => r.dir === h.dir)!.runtime = reopened
  await reopened.tick()
  const diagnostic = JSON.stringify({ now: Date.now(), routerStarted: reopened.store.get('router-started'), effects: reopened.store.pendingEffects(), events: reopened.store.events(), tickets: reopened.store.tickets.list(), messages })
  expect(messages.some(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === 'follow_up'), diagnostic).toBe(true)
})
it('uses background notices for ended tickets, without waking Router', async () => {
  const h = await fixture(); h.messages.length = 0
  h.runtime.engine.stopTicket(h.ticketId); await h.runtime.tick()
  const notice = h.messages.find(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === 'ticket_ended')
  const diagnostic = JSON.stringify({ now: Date.now(), routerStarted: h.runtime.store.get('router-started'), effects: h.runtime.store.pendingEffects(), events: h.runtime.store.events(), messages: h.messages })
  expect(notice, diagnostic).toBeDefined(); expect(notice!.delivery.wake).toBe(false)
})
it.each(['follow_up', 'ticket_ended'])('retains %s through a backwards wall-clock step and delivers it once when due', async kind => {
  const h = await fixture(); h.messages.length = 0
  if (kind === 'follow_up') h.runtime.followup(h.ticketId, { id: 'clock-step', text: 'Please stop' })
  else h.runtime.engine.stopTicket(h.ticketId)
  const now = Date.now(), effect = h.runtime.store.pendingEffects().find(e => (e.payload as any).kind === kind)!
  expect(effect.due).toBe(now)
  vi.setSystemTime(now - 1300)
  if (kind === 'follow_up') {
    await h.runtime.close()
    h.runtime = new Runtime(h.dir, { send: async (target, delivery) => { h.messages.push({ target, delivery }) }, stop: async () => {}, close: async () => {} }, { prepare: async () => {} })
    resources.find(r => r.dir === h.dir)!.runtime = h.runtime
  }
  await h.runtime.tick()
  expect(h.messages.filter(m => m.target.role === 'router')).toHaveLength(0)
  expect(h.runtime.store.pendingEffects().find(e => e.seq === effect.seq)).toEqual(effect)
  vi.setSystemTime(now)
  await h.runtime.tick(); await h.runtime.tick()
  const notices = h.messages.filter(m => m.target.role === 'router' && JSON.parse(m.delivery.text).kind === kind)
  expect(notices).toHaveLength(1)
  if (kind === 'ticket_ended') expect(notices[0].delivery.wake).toBe(false)
  expect(h.runtime.store.pendingEffects().find(e => e.seq === effect.seq)).toBeUndefined()
})
it('keeps a later reply behind the same conversation first retry, without blocking another conversation', async () => {
  const h = await fixture()
  const channel = { source: 'manual', thread: 'same', address: {} }
  for (const [id, thread] of [['first', 'same'], ['second', 'same'], ['elsewhere', 'other']]) {
    h.runtime.store.set(`reply:${id}`, { id, text: id, kind: 'reply', ticketId: h.ticketId, channel: { ...channel, thread }, status: 'pending' })
    h.runtime.store.enqueue('reply', id, {})
  }
  const first = h.runtime.store.pendingEffects().find(e => e.key === 'first')!
  h.runtime.store.failEffect(first, 'temporary')
  await h.runtime.tick()
  expect(h.runtime.store.get<any>('reply:second').status).toBe('pending')
  expect(h.runtime.store.get<any>('reply:elsewhere').status).toBe('sent')
  h.runtime.store.db.prepare('UPDATE effect SET due=0 WHERE kind=?').run('reply')
  await h.runtime.tick(); await h.runtime.tick()
  expect(h.runtime.store.get<any>('reply:first').status).toBe('sent')
  h.runtime.store.db.prepare('UPDATE effect SET due=0 WHERE kind=?').run('reply'); await h.runtime.tick()
  expect(h.runtime.store.get<any>('reply:second').status).toBe('sent')
})
it('exposes role-scoped notes, status, context follows and unrelated-thread handback', async () => {
  const h = await fixture()
  await h.runtime.tool(router, 'note', { ticketId: h.ticketId, text: 'Other work changed the spelling standard.' })
  expect(h.runtime.store.tickets.get(h.ticketId)?.inputs.some(i => i.kind === 'note' && i.text.includes('standard'))).toBe(true)
  await h.runtime.tool(h.worker, 'follow', { source: 'manual', id: 'related', reason: 'Reference only' })
  expect(h.runtime.store.threads.get('manual:related')?.context).toContain(h.ticketId)
  await h.runtime.tool(h.worker, 'unrelated', { thread: 'manual:related', reason: 'Not relevant after reading' })
  expect(h.runtime.store.threads.get('manual:related')?.subscriptions).not.toContain(h.ticketId)
  await expect(h.runtime.tool(h.worker, 'note', { ticketId: 'someone-else', text: 'No' })).rejects.toThrow(/role/)
  await h.runtime.tool(h.worker, 'report', { state: 'waiting', summary: 'Waiting' })
  expect(await h.runtime.tool(router, 'status', { ticketId: h.ticketId })).toBe(true)
})
