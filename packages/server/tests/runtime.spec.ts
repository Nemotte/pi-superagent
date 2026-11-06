import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
const mod = await import('../src/runtime.js').catch(() => ({} as any))
const resources: Array<{ dir: string; runtime: any }> = []
afterEach(async () => { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } })
async function harness() {
  expect(mod.Runtime, 'Runtime must compose the domain and adapters').toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-runtime-')); initialize(dir, { repository: dir })
  const messages: any[] = [], stopped: string[] = []
  const driver = { send: async (target: any, delivery: any) => { messages.push({ target, delivery }) }, stop: async (key: string) => { stopped.push(key) }, close: async () => {} }
  const runtime = new mod.Runtime(dir, driver, { prepare: async () => {} }); resources.push({ dir, runtime })
  return { runtime, dir, messages, stopped }
}
async function accept(h: Awaited<ReturnType<typeof harness>>, id = 'request-1') {
  const trigger = h.runtime.submit({ id, text: 'Fix the button label' })
  await h.runtime.tick()
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { triggerId: trigger.id, kind: 'accept', title: 'Fix label', scope: 'Change this label only', reason: 'Administrator request' })
  await h.runtime.tick()
  return h.runtime.store.tickets.get(decision.ticketId)
}
it('routes explicit requests even in observe mode, launches an isolated worker and keeps followups on it', async () => {
  const h = await harness(); const ticket = await accept(h)
  expect(ticket.mandate.strength).toBe('explicit')
  expect(h.messages.map(m => m.target.role)).toContain('worker')
  expect(ticket.execution.directory).toContain(ticket.id)
  const followup = h.runtime.followup(ticket.id, { id: 'follow-1', text: 'Use Save instead' })
  await h.runtime.tick()
  expect(h.runtime.store.triggers.disposition(followup.id).fanout).toContain(ticket.id)
  expect(h.runtime.engine.candidate(followup.id)).toBeUndefined()
})
it('does not require publication for local work and denies optional GitHub operations', async () => {
  const h = await harness(); await accept(h)
  const target = h.messages.find(m => m.target.role === 'worker').target
  expect(target.github).toBe(false)
  expect(target.instructions).not.toMatch(/github|pull requests/i)
  await expect(h.runtime.tool(target, 'github_create_pull', { title: 'x', body: 'x' })).rejects.toThrow()
})
it('keeps request IDs idempotent and rejects conflicting reuse', async () => {
  const h = await harness(); const one = h.runtime.submit({ id: 'same-id', text: 'one' })
  expect(h.runtime.submit({ id: 'same-id', text: 'one' }).id).toBe(one.id)
  expect(() => h.runtime.submit({ id: 'same-id', text: 'different' })).toThrow(/idempotency/i)
})
it('stops a worker and rejects stale or cross-role tool calls', async () => {
  const h = await harness(); const ticket = await accept(h)
  const target = h.messages.find(m => m.target.role === 'worker').target
  await expect(h.runtime.tool(target, 'route', {})).rejects.toThrow(/role/i)
  await expect(h.runtime.tool({ ...target, assignmentId: 'stale' }, 'report', { state: 'progress', summary: 'x' })).rejects.toThrow(/assignment/i)
  h.runtime.engine.stopTicket(ticket.id); await h.runtime.tick()
  expect(h.stopped).toContain(target.key)
  await expect(h.runtime.tool(target, 'report', { state: 'ready', summary: 'done' })).rejects.toThrow()
})
it('records structured reports and ends a completed task', async () => {
  const h = await harness(); const ticket = await accept(h)
  const target = h.messages.find(m => m.target.role === 'worker').target
  await h.runtime.tool(target, 'report', { state: 'ready', summary: 'Verified the change' })
  expect(h.runtime.store.tickets.get(ticket.id).ended.outcome).toBe('completed')
})
it('holds a worker slot until the model actually settles, including after a blocked report', async () => {
  const h = await harness(); const ticket = await accept(h)
  const target = h.messages.find(m => m.target.role === 'worker').target
  await h.runtime.tool(target, 'report', { state: 'blocked', summary: 'Needs clarification' })
  expect(h.runtime.overview().busyWorkers).toBe(1)
  h.runtime.event(target, { type: 'settled' })
  expect(h.runtime.overview().busyWorkers).toBe(0)
})
it('does not deliver an old queued input before its replacement assignment launches', async () => {
  const h = await harness(); const ticket = await accept(h)
  h.runtime.followup(ticket.id, { id: 'later-input', text: 'Additional context' })
  const pending = h.runtime.store.tickets.get(ticket.id); pending.assignments.at(-1).state = 'pending'; h.runtime.store.tickets.save(pending)
  const before = h.messages.filter(m => m.target.role === 'worker').length; await h.runtime.tick()
  expect(h.messages.filter(m => m.target.role === 'worker')).toHaveLength(before)
  expect(h.runtime.store.tickets.get(ticket.id).undelivered).not.toEqual([])
})
it('persists pause, refuses stale settings revisions, and holds dispatch', async () => {
  const h = await harness(); const settings = h.runtime.settings()
  h.runtime.saveSettings({ ...settings.config, paused: true }, settings.revision)
  expect(() => h.runtime.saveSettings(settings.config, settings.revision)).toThrow(/revision/i)
  h.runtime.submit({ id: 'paused-request', text: 'wait' }); await h.runtime.tick()
  expect(h.messages).toEqual([])
})
it('reopens interrupted assignments with a recovery note and preserves unread input', async () => {
  const h = await harness(); const ticket = await accept(h)
  h.runtime.followup(ticket.id, { id: 'unread-on-restart', text: 'Keep this input' })
  const before = h.runtime.store.tickets.get(ticket.id); const unread = [...before.undelivered]
  await h.runtime.close()
  const reopened = new mod.Runtime(h.dir, { send: async () => {}, stop: async () => {}, close: async () => {} }, { prepare: async () => {} })
  resources.find(r => r.dir === h.dir)!.runtime = reopened
  const restored = reopened.store.tickets.get(ticket.id)
  expect(restored.assignments).toHaveLength(2)
  expect(restored.assignments.at(-1).id).not.toBe(before.assignments.at(-1).id)
  expect(restored.assignments.at(-1).state).toBe('pending')
  expect(restored.undelivered).toEqual(expect.arrayContaining(unread))
  expect(restored.inputs.some((input: any) => input.kind === 'text' && input.text.includes('host restarted'))).toBe(true)
})
it('locks one instance before opening its database', async () => {
  const h = await harness()
  expect(() => new mod.Runtime(h.dir, { send: async () => {}, stop: async () => {}, close: async () => {} })).toThrow()
})
