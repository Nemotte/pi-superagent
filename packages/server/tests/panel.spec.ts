import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { serveApi } from '../src/http.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanups.splice(0)) await f() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-panel-')); initialize(dir, { repository: dir, paused: true })
  const runtime = new Runtime(dir, { send: async () => {}, stop: async () => {}, close: async () => {} })
  const server = await serveApi(runtime, undefined, 0, { catalog: async () => ({ providers: [{ id: 'fixture', name: 'Fixture', methods: [] }], models: [{ provider: 'fixture', id: 'test-model', name: 'Test' }] }) })
  cleanups.push(async () => { await server.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const get = async (path: string) => { const r = await fetch(server.url + '/api/v1/' + path); expect(r.status).toBe(200); return r.json() as Promise<any> }
  const accept = (id: string) => {
    const t = runtime.submit({ id, text: `需求 ${id} <script>not HTML</script>` }); runtime.engine.evaluateDue()
    const decision = runtime.engine.decide(t.id, { kind: 'accept', title: `任务 ${id}`, scope: 'Read only', reason: 'Explicit request' })!
    return { trigger: t, decision, ticket: runtime.store.tickets.get(decision.ticketId!)! }
  }
  return { dir, runtime, server, get, accept }
}
it('reports setup before pause and healthy dispatch without treating config as verified authentication', async () => {
  const f = await fixture()
  expect((await f.get('status')).readiness).toMatchObject({ state: 'setup', missingModels: ['router', 'worker'] })
  let s = f.runtime.settings(); s = f.runtime.saveSettings({ ...s.config, routerModel: { provider: 'fixture', id: 'x' }, workerModel: { provider: 'fixture', id: 'y' } }, s.revision)
  expect((await f.get('status')).readiness.state).toBe('paused')
  f.runtime.saveSettings({ ...s.config, paused: false }, s.revision)
  expect((await f.get('status')).readiness).toEqual({ state: 'ready', missingModels: [] })
})
it('exposes model metadata without model login, session or probe operations', async () => {
  const f = await fixture(), before = f.runtime.settings()
  expect(await f.get('models')).toEqual({ providers: [{ id: 'fixture', name: 'Fixture', methods: [] }], models: [{ provider: 'fixture', id: 'test-model', name: 'Test' }] })
  expect(f.runtime.settings()).toEqual(before)
  expect(f.runtime.store.records('ticket')).toEqual([])
})
it('projects core action eligibility and latest result rather than offering retry on any ticket', async () => {
  const f = await fixture(), { ticket } = f.accept('one'), path = `tickets/${ticket.id}`
  expect((await f.get(path)).actions).toEqual({ stop: true, retry: false, followup: true })
  f.runtime.engine.report(ticket.id, { state: 'blocked', summary: 'Need decision', question: 'Which API?' })
  expect((await f.get(path)).actions.retry).toBe(true)
  expect((await f.get(path)).latestReport.summary).toBe('Need decision')
  f.runtime.engine.stopTicket(ticket.id)
  expect((await f.get(path)).actions).toEqual({ stop: false, retry: false, followup: false })
})
it('reads bounded durable user conversation, excludes another ticket and context-only input, and preserves status', async () => {
  const f = await fixture(), { ticket, trigger } = f.accept('conversation'), other = f.accept('other')
  const input = f.runtime.followup(ticket.id, { id: 'follow', text: '补充要求' })
  const saved = f.runtime.store.tickets.get(ticket.id)!
  saved.inputs.push({ id: 'context', kind: 'trigger', triggerId: other.trigger.id, context: true, at: other.trigger.at }); f.runtime.store.tickets.save(saved)
  f.runtime.store.set('reply:one', { id: 'one', ticketId: ticket.id, channel: trigger.channel, kind: 'reply', text: '结果已整理', status: 'sent', createdAt: '2099-01-01T00:00:00Z' })
  f.runtime.store.set('reply:two', { id: 'two', ticketId: ticket.id, channel: trigger.channel, kind: 'reply', text: '待发送', status: 'pending', createdAt: '2099-01-02T00:00:00Z' })
  f.runtime.store.set('reply:foreign', { id: 'foreign', ticketId: other.ticket.id, channel: other.trigger.channel, text: 'FOREIGN', status: 'sent' })
  const view = await f.get(`tickets/${ticket.id}/conversation`)
  expect(view.total).toBe(4); expect(view.items.map((m: any) => m.text)).toEqual([trigger.text, input.text, '结果已整理', '待发送'])
  expect(view.items.at(-1)).toMatchObject({ role: 'router', status: 'pending' })
  expect(await f.get(`tickets/${ticket.id}/conversation?offset=1&limit=2`)).toMatchObject({ total: 4, items: [{ text: input.text }, { text: '结果已整理' }] })
  expect(JSON.stringify(view)).not.toContain('FOREIGN')
  f.runtime.store.set('reply:legacy', { id: 'legacy', ticketId: ticket.id, channel: trigger.channel, text: 'Legacy reply', status: 'sent' })
  f.runtime.store.audit({ type: 'reply.sent', message: { id: 'legacy' } })
  const legacy = (await f.get(`tickets/${ticket.id}/conversation`)).items.find((m: any) => m.id === 'reply:legacy')
  expect(legacy.at).toBeTruthy(); expect(legacy.text).toBe('Legacy reply')
  expect((await fetch(f.server.url + `/api/v1/tickets/${ticket.id}/conversation?limit=101`)).status).toBe(400)
})
it('links accepted and unjudged requests to persisted dispositions and paged thread history', async () => {
  const f = await fixture(), accepted = f.accept('linked'); const pending = f.runtime.submit({ id: 'pending', text: '还未接单' })
  const requests = await f.get('requests')
  expect(requests.find((r: any) => r.id === accepted.trigger.id)).toMatchObject({ ticketIds: [accepted.ticket.id], state: 'accepted' })
  expect(requests.find((r: any) => r.id === pending.id)).toMatchObject({ ticketIds: [], state: 'pending' })
  const thread = await f.get('threads/' + encodeURIComponent('manual:linked') + '?limit=1')
  expect(thread.thread.key).toBe('manual:linked'); expect(thread.triggers).toHaveLength(1); expect(thread.decisions[0].ticketId).toBe(accepted.ticket.id)
  expect((await fetch(f.server.url + '/api/v1/threads/missing')).status).toBe(404)
})
it('can inspect a filtered request without linking to a nonexistent thread', async () => {
  const f = await fixture(), t = { id: 'filtered', source: 'not-installed', actor: { source: 'not-installed', id: 'outsider' }, human: true, at: new Date().toISOString(), text: 'filtered input', threads: [{ source: 'not-installed', id: 'one' }], meta: {} }
  f.runtime.engine.receive(t)
  const view = await f.get('requests/filtered')
  expect(view).toMatchObject({ id: t.id, state: 'filtered', threadKeys: [] })
})
it('offers bounded settings history and literal search across requests, threads and tickets', async () => {
  const f = await fixture(), { ticket, trigger } = f.accept('search')
  const settings = f.runtime.settings(); f.runtime.saveSettings({ ...settings.config, maxWorkers: 2 }, settings.revision)
  expect((await f.get('config/history?limit=1'))[0]).toMatchObject({ revision: 2, config: { maxWorkers: 2 } })
  const found = await f.get('search?q=' + encodeURIComponent('search'))
  expect(found.some((r: any) => r.kind === 'ticket' && r.id === ticket.id)).toBe(true)
  expect(found.some((r: any) => r.kind === 'trigger' && r.id === trigger.id)).toBe(true)
  expect(found.some((r: any) => r.kind === 'thread' && r.id === 'manual:search')).toBe(true)
  expect(await f.get('search?q=' + encodeURIComponent("' OR 1=1 --"))).toEqual([])
  expect((await fetch(f.server.url + '/api/v1/search?q=' + 'x'.repeat(201))).status).toBe(400)
})
