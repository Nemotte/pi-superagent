import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get } from 'node:http'
import { initialize, readToken } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
const mod = await import('../src/http.js').catch(() => ({} as any))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0)) await fn() })
async function server() {
  expect(mod.serveApi, 'Authenticated management API is required').toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-http-')); initialize(dir, { repository: dir, management: 'token' })
  const runtime = new Runtime(dir, { send: async () => {}, stop: async () => {}, close: async () => {} })
  const token = readToken(dir); const control = { stops: 0 }
  const api = await mod.serveApi(runtime, token, 0, { shutdown: () => control.stops++ })
  cleanups.push(async () => { await api.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  return { api, runtime, token, headers, control, dir, url: api.url }
}
it('exposes only liveness anonymously and requires authentication for records', async () => {
  const h = await server()
  expect((await fetch(h.url + '/health')).status).toBe(200)
  for (const path of ['status', 'requests', 'requests/one', 'search?q=test', 'config/history', 'models', 'threads/manual%3Aone', 'tickets/one/conversation']) expect((await fetch(h.url + '/api/v1/' + path)).status).toBe(401)
  expect((await fetch(h.url + '/api/v1/status', { headers: h.headers })).status).toBe(200)
})
it('exposes authenticated workspace and per-ticket execution views', async () => {
  const h = await server()
  expect((await fetch(h.url + '/api/v1/workspace')).status).toBe(401)
  const view = await fetch(h.url + '/api/v1/workspace', { headers: h.headers })
  expect(view.status).toBe(200); expect(await view.json()).toMatchObject({ kind: 'repository', root: h.dir })
  const trigger = h.runtime.submit({ id: 'workspace-view', text: 'Read files' }); h.runtime.engine.evaluateDue()
  const d = h.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Inspect', scope: 'Read', reason: 'Request' })!
  const response = await fetch(h.url + `/api/v1/tickets/${d.ticketId}/workspace`, { headers: h.headers })
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ticketId: d.ticketId })
})
it('validates write requests, deduplicates submissions and rejects conflicting IDs', async () => {
  const h = await server(); const post = (body: unknown) => fetch(h.url + '/api/v1/tickets', { method: 'POST', headers: h.headers, body: JSON.stringify(body) })
  expect((await post({ text: '' })).status).toBe(400)
  expect((await post({ id: 'one', text: 'Fix label' })).status).toBe(202)
  expect((await post({ id: 'one', text: 'Fix label' })).status).toBe(202)
  expect((await post({ id: 'one', text: 'Another task' })).status).toBe(409)
  expect(h.runtime.store.records('trigger')).toHaveLength(1)
})
it('rejects foreign Origin and DNS-rebinding hosts, including bearer requests', async () => {
  const h = await server()
  expect((await fetch(h.url + '/api/v1/tickets', { method: 'POST', headers: { ...h.headers, origin: 'https://evil.example' }, body: '{"text":"no"}' })).status).toBe(403)
  const status = await new Promise<number | undefined>((resolve, reject) => get(h.url + '/health', { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject))
  expect(status).toBe(403)
})
it('exchanges the token for an HttpOnly cookie and requires CSRF on cookie writes', async () => {
  const h = await server()
  const login = await fetch(h.url + '/api/v1/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: h.url }, body: JSON.stringify({ token: h.token }) })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get('set-cookie')!; expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict')
  const { csrf } = await login.json() as any
  const headers = { cookie: setCookie.split(';')[0], 'content-type': 'application/json', origin: h.url }
  const url = h.url + '/api/v1/tickets'; const body = JSON.stringify({ text: 'test' })
  expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(403)
  expect((await fetch(url, { method: 'POST', headers: { ...headers, 'x-csrf-token': csrf }, body })).status).toBe(202)
})
async function grant(h: Awaited<ReturnType<typeof server>>) {
  const response = await fetch(h.url + '/api/v1/login-grants', { method: 'POST', headers: h.headers })
  expect(response.status).toBe(201)
  const value = await response.json() as any
  expect(value.code).toMatch(/^[\w-]{43}$/); expect(value.expiresIn).toBe(60); expect(JSON.stringify(value)).not.toContain(h.token)
  return value.code as string
}
async function redeem(url: string, code: string, origin: string | undefined = url) {
  return fetch(url + '/api/v1/login', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ code }) })
}
it('mints browser login grants only for bearer clients, and consumes them once even with concurrent requests', async () => {
  const h = await server()
  expect((await fetch(h.url + '/api/v1/login-grants', { method: 'POST' })).status).toBe(401)
  const code = await grant(h), results = await Promise.all([redeem(h.url, code), redeem(h.url, code)])
  expect(results.map(r => r.status).sort()).toEqual([200, 401])
  const login = results.find(r => r.ok)!, cookie = login.headers.get('set-cookie')!.split(';')[0], { csrf } = await login.json() as any
  expect(login.headers.get('set-cookie')).toContain('HttpOnly'); expect(login.headers.get('set-cookie')).toContain('SameSite=Strict')
  expect((await fetch(h.url + '/api/v1/status', { headers: { cookie } })).status).toBe(200)
  expect((await fetch(h.url + '/api/v1/login-grants', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } })).status).toBe(403)
  expect((await fetch(h.url + '/api/v1/logout', { method: 'POST', headers: { cookie } })).status).toBe(403)
  expect((await fetch(h.url + '/api/v1/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } })).status).toBe(200)
  expect((await fetch(h.url + '/api/v1/status', { headers: { cookie } })).status).toBe(401)
  expect((await redeem(h.url, code)).status).toBe(401)
})
it('expires browser grants and rejects wrong or absent origins without consuming valid grants', async () => {
  const h = await server(), code = await grant(h)
  expect((await redeem(h.url, code, 'https://evil.example')).status).toBe(403)
  expect((await redeem(h.url, code, '')).status).toBe(403)
  const alias = h.url.replace('127.0.0.1', 'localhost')
  expect((await redeem(alias, code)).status).toBe(401)
  expect((await redeem(h.url, code)).status).toBe(200)
  const expired = await grant(h), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60001)
  const response = await redeem(h.url, expired)
  expect(response.status).toBe(401); expect(await response.text()).not.toContain(expired)
})
it('bounds outstanding login grants and keeps their authority separate from bearer authentication', async () => {
  const h = await server(), oldest = await grant(h); let latest = ''
  for (let i = 0; i < 32; i++) latest = await grant(h)
  expect((await redeem(h.url, oldest)).status).toBe(401)
  expect((await fetch(h.url + '/api/v1/status', { headers: { authorization: `Bearer ${latest}` } })).status).toBe(401)
  expect((await redeem(h.url, latest)).status).toBe(200)
})
it('isolates grants and browser cookies between instances on the same loopback host', async () => {
  const a = await server(), b = await server(), code = await grant(a)
  expect((await redeem(b.url, code)).status).toBe(401)
  const loginA = await redeem(a.url, code), loginB = await redeem(b.url, await grant(b))
  const cookieA = loginA.headers.get('set-cookie')!.split(';')[0], cookieB = loginB.headers.get('set-cookie')!.split(';')[0]
  expect(cookieA.split('=')[0]).not.toBe(cookieB.split('=')[0])
  for (const h of [a, b]) expect((await fetch(h.url + '/api/v1/status', { headers: { cookie: `${cookieA}; ${cookieB}` } })).status).toBe(200)
})
it('does not persist browser login grants across API restarts', async () => {
  const h = await server(), code = await grant(h)
  await h.api.close(); h.api.close = async () => {}
  const replacement = await mod.serveApi(h.runtime, h.token, Number(new URL(h.url).port)); cleanups.unshift(() => replacement.close())
  expect((await redeem(replacement.url, code)).status).toBe(401)
})
it('requires administrator authentication to stop the service', async () => {
  const h = await server()
  expect((await fetch(h.url + '/api/v1/shutdown', { method: 'POST' })).status).toBe(401)
  expect(h.control.stops).toBe(0)
  expect((await fetch(h.url + '/api/v1/shutdown', { method: 'POST', headers: h.headers })).status).toBe(200)
  expect(h.control.stops).toBe(1)
})
it('exposes source health and protected manual polling, with Feishu deferred', async () => {
  const h = await server()
  const response = await fetch(h.url + '/api/v1/sources', { headers: h.headers }); expect(response.status).toBe(200)
  const sources = await response.json() as any[]
  expect(sources.find(s => s.id === 'github').state).toBe('disabled'); expect(sources.find(s => s.id === 'feishu').state).toBe('deferred')
  expect((await fetch(h.url + '/api/v1/sources/github/poll', { method: 'POST' })).status).toBe(401)
  expect((await fetch(h.url + '/api/v1/sources/github/poll', { method: 'POST', headers: h.headers })).status).toBe(200)
})
it('filters tickets before pagination and exposes bounded ticket diagnostics', async () => {
  const h = await server(); const trigger = h.runtime.submit({ id: 'diagnostics', text: 'Test details' }); h.runtime.engine.evaluateDue()
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Search target', scope: 'Test', reason: 'Request' }) as any
  const session = join(h.dir, 'sessions', decision.ticketId); mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 'test.jsonl'), JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] } }) + '\n')
  expect(await (await fetch(h.url + '/api/v1/tickets?q=missing', { headers: h.headers })).json()).toEqual([])
  expect((await (await fetch(h.url + '/api/v1/tickets?q=target&state=open', { headers: h.headers })).json() as any[])).toHaveLength(1)
  h.runtime.engine.stopTicket(decision.ticketId)
  expect(await (await fetch(h.url + '/api/v1/tickets?state=open', { headers: h.headers })).json()).toEqual([])
  const diagnostic = await fetch(h.url + `/api/v1/tickets/${decision.ticketId}/diagnostics`, { headers: h.headers })
  expect(diagnostic.status).toBe(200)
  const data = await diagnostic.json() as any
  expect(data.session.file).toBe('test.jsonl'); expect(JSON.stringify(data.messages).length).toBeLessThan(4000)
})
it('puts human questions first and exposes evaluation recovery without diagnostic noise', async () => {
  const h = await server(), router = { role: 'router' as const, key: 'router' }
  const trigger = h.runtime.submit({ id: 'attention', text: 'Choose a label' }); h.runtime.engine.evaluateDue()
  const decision = await h.runtime.tool(router, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Label', scope: 'Label only', reason: 'Request' }) as any
  h.runtime.engine.report(decision.ticketId, { state: 'blocked', summary: 'Need casing', question: 'Use Title Case or lowercase?' })
  const failed = h.runtime.submit({ id: 'unavailable', text: 'Another task' }); h.runtime.engine.evaluateDue()
  const unavailable = h.runtime.engine.decide(failed.id, { kind: 'unavailable', reason: 'Provider temporarily unavailable' })!
  const getAttention = () => fetch(h.url + '/api/v1/attention', { headers: h.headers }).then(r => r.json()) as Promise<any>
  const attention = await getAttention()
  expect(attention.tickets[0]).toMatchObject({ id: decision.ticketId, action: 'answer', question: 'Use Title Case or lowercase?' }); expect(attention.evaluations[0].id).toBe(unavailable.id)
  expect((await fetch(h.url + `/api/v1/decisions/${unavailable.id}/dismiss`, { method: 'POST' })).status).toBe(401)
  expect((await fetch(h.url + `/api/v1/decisions/${unavailable.id}/dismiss`, { method: 'POST', headers: h.headers })).status).toBe(200)
  expect((await getAttention()).evaluations).toEqual([])
  expect((await fetch(h.url + `/api/v1/triggers/${failed.id}/reevaluate`, { method: 'POST', headers: h.headers })).status).toBe(202)
  expect(h.runtime.store.threads.get('manual:unavailable')?.pending).toContain(failed.id)
})
it('unsubscribes a Thread by its key rather than mistaking a Ticket id for a Thread', async () => {
  const h = await server(), t = h.runtime.submit({ id: 'subscription', text: 'One task' }); h.runtime.engine.evaluateDue()
  const d = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { kind: 'accept', triggerId: t.id, title: 'Task', scope: 'One task', reason: 'Request' }) as any
  expect((await fetch(h.url + `/api/v1/tickets/${d.ticketId}/subscriptions`, { method: 'DELETE', headers: h.headers })).status).toBe(400)
  expect((await fetch(h.url + '/api/v1/threads/manual%3Asubscription/subscriptions', { method: 'DELETE', headers: h.headers })).status).toBe(200)
  expect(h.runtime.store.threads.get('manual:subscription')?.subscriptions).toEqual([])
})
it('serves its bundled web entry with a CSP and bounds list queries', async () => {
  const h = await server(); const page = await fetch(h.url)
  expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
  expect(await page.text()).toContain('Pi Super-agent')
  expect((await fetch(h.url + '/api/v1/tickets?limit=-1', { headers: h.headers })).status).toBe(400)
  expect((await fetch(h.url + '/api/v1/tickets?limit=101', { headers: h.headers })).status).toBe(400)
  expect((await fetch(h.url + '/api/v1/config', { headers: h.headers })).status).toBe(200)
})
