import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Client } from '../src/client.js'
const mod = await import('../src/web-access.js').catch(() => ({} as any))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
async function fixture(status = 201, code = 'a'.repeat(43), management = 'token') {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url!); expect(req.headers.authorization).toBe(management === 'local' ? undefined : 'Bearer fixture-admin-token')
    const check = req.url === '/api/v1/status'; res.writeHead(check ? 200 : status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(check ? { protocol: 1, instanceId: 'one', management } : status === 201 ? { code, expiresIn: 60, url: 'https://evil.example' } : { error: 'private backend detail' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const url = `http://127.0.0.1:${(server.address() as any).port}`
  return { url, requests, client: new Client(url, management === 'local' ? undefined : 'fixture-admin-token', 'one'), ctx: { hasUI: true, mode: 'tui', ui: { notify: vi.fn() } } }
}
it('opens local Web directly without requesting a login grant or a credential', async () => {
  const f = await fixture(201, '', 'local'), openBrowser = vi.fn(async () => true), panel = vi.fn()
  await mod.openWeb(f.ctx, f.client, { openBrowser, panel })
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith(f.url)
  expect(f.requests.every(path => path === '/api/v1/status')).toBe(true)
  expect(panel).not.toHaveBeenCalled(); expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('/superagent token')
})
it('opens only the configured endpoint with a one-use code, not the administrator token', async () => {
  expect(mod.openWeb).toBeTypeOf('function'); const f = await fixture(), openBrowser = vi.fn(async () => true), panel = vi.fn()
  expect(await mod.openWeb(f.ctx, f.client, { openBrowser, panel })).toBeUndefined()
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith(f.url + '/#login=' + 'a'.repeat(43))
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('a'.repeat(43))
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('fixture-admin-token')
  expect(f.requests).toEqual(['/api/v1/status', '/api/v1/status', '/api/v1/login-grants']); expect(panel).not.toHaveBeenCalled()
})
it('keeps a failed opener fallback inside the private panel, without retrying grant issuance', async () => {
  expect(mod.openWeb).toBeTypeOf('function'); const f = await fixture(), panel = vi.fn(async () => {})
  await mod.openWeb(f.ctx, f.client, { openBrowser: async () => false, panel })
  expect(panel.mock.calls[0][2]).toBe(f.url + '/#login=' + 'a'.repeat(43))
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('#login=')
  expect(f.requests.filter(p => p.endsWith('login-grants'))).toHaveLength(1)
})
it('offers an actionable old-service message and refuses malformed grants without opening a browser', async () => {
  expect(mod.openWeb).toBeTypeOf('function'); const old = await fixture(404), openBrowser = vi.fn()
  await expect(mod.openWeb(old.ctx, old.client, { openBrowser })).rejects.toThrow(/\/superagent restart.*\/superagent token/)
  const bad = await fixture(201, 'unsafe private value')
  await expect(mod.openWeb(bad.ctx, bad.client, { openBrowser })).rejects.toThrow(/无效/)
  expect(openBrowser).not.toHaveBeenCalled()
})
it('keeps private credential access out of return values and requires terminal interaction before generating a grant', async () => {
  const f = await fixture(), show = vi.fn(async () => 'must not be returned')
  expect((f.client as any).withCredential).toBeTypeOf('function')
  expect(await (f.client as any).withCredential(show)).toBeUndefined(); expect(show).toHaveBeenCalledExactlyOnceWith('fixture-admin-token')
  await expect(mod.openWeb({ ...f.ctx, mode: 'rpc' }, f.client)).rejects.toThrow(/终端/)
  expect(f.requests).toEqual([])
})
