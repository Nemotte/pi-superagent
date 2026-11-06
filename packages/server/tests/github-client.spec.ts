import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
const mod = await import('../src/sources/github-client.js').catch(() => ({} as any))
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })
async function fixture(handler: (req: any, res: any, base: string) => void) {
  expect(mod.GitHubClient).toBeTypeOf('function')
  let base = ''; const server = createServer((q, r) => handler(q, r, base))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`
  closers.push(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return new mod.GitHubClient('owner/project', 'test-token', { baseUrl: base })
}
it('paginates all items, uses a bearer token and validates the authenticated identity', async () => {
  const client = await fixture((req, res, base) => {
    expect(req.headers.authorization).toBe('Bearer test-token')
    res.setHeader('content-type', 'application/json')
    if (req.url === '/user') return res.end(JSON.stringify({ login: 'worker-bot' }))
    if (!req.url.includes('page=2')) res.setHeader('link', `<${base}/repos/owner/project/issues?page=2>; rel="next"`)
    res.end(JSON.stringify([{ id: req.url.includes('page=2') ? 2 : 1 }]))
  })
  await client.verify('WORKER-BOT'); expect(await client.pages('issues')).toEqual([{ id: 1 }, { id: 2 }])
  await expect(client.verify('someone-else')).rejects.toThrow(/identity/i)
})
it('counts UTF-8 bytes rather than characters toward the total stream limit', async () => {
  const page = JSON.stringify([{ body: '界'.repeat(2 * 1024 * 1024) }]); let pages = 0
  const client = await fixture((_req, res, base) => {
    if (++pages < 6) res.setHeader('link', `<${base}/repos/owner/project/issues?page=${pages + 1}>; rel="next"`)
    res.end(page)
  })
  let message = ''; try { await client.pages('issues') } catch (error) { message = String(error) }
  expect(message).toMatch(/stream exceeded size limit/)
})
it('does not follow external or cross-repository pagination links', async () => {
  const client = await fixture((_req, res, base) => { res.setHeader('link', `<${base}/repos/other/project/issues>; rel="next"`); res.end('[]') })
  await expect(client.pages('issues')).rejects.toThrow(/pagination|repository/i)
})
it('does not forward credentials across a redirect', async () => {
  const client = await fixture((_req, res) => { res.writeHead(302, { location: 'https://example.com' }); res.end() })
  await expect(client.get('issues')).rejects.toThrow()
})
it('honors rate-limit delays without leaking remote bodies or credentials into errors', async () => {
  const client = await fixture((_req, res) => { res.writeHead(429, { 'retry-after': '120' }); res.end('test-token should not be logged') })
  try { await client.get('issues'); throw Error('Expected rate limit') } catch (error: any) {
    expect(error.status).toBe(429); expect(error.retryAt).toBeGreaterThan(Date.now() + 110000); expect(String(error)).not.toContain('test-token')
  }
})
