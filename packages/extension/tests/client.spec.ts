import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
vi.mock('../src/browser.js', () => ({ openBrowser: vi.fn(async () => true) }))
const mod = await import('../src/client.js').catch(() => ({} as any))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function endpoint(protocol: number) {
  const requests: any[] = []
  const server = createServer((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/api/v1/status' ? { protocol, instanceId: 'test-endpoint' } : req.url === '/api/v1/config' ? { config: { repository: '/remote/other-project' } } : req.url === '/api/v1/login-grants' ? { code: 'a'.repeat(43), expiresIn: 60 } : { accepted: true })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests }
}
it('checks protocol before allowing a write and sends bearer credentials', async () => {
  expect(mod.Client).toBeTypeOf('function'); const h = await endpoint(1)
  const client = new mod.Client(h.url, 'secret'); await client.request('tickets', 'POST', { id: 'one', text: 'test' })
  expect(h.requests.map(r => r.url)).toEqual(['/api/v1/status', '/api/v1/tickets'])
  expect(h.requests[1].authorization).toBe('Bearer secret')
})
it('connects locally without a token and ignores the host model fetch dispatcher', async () => {
  const h = await endpoint(1)
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('host model proxy must not handle local management') }))
  await expect(new mod.Client(h.url, undefined, 'test-endpoint').request('tickets', 'POST', { id: 'local', text: 'test' })).resolves.toEqual({ accepted: true })
  expect(h.requests[1].authorization).toBeUndefined(); expect(globalThis.fetch).not.toHaveBeenCalled()
})
it('refuses incompatible services and non-loopback URLs', async () => {
  expect(mod.Client).toBeTypeOf('function'); const h = await endpoint(2)
  await expect(new mod.Client(h.url, 'secret').request('tickets', 'POST', {})).rejects.toThrow(/protocol/i)
  expect(h.requests).toHaveLength(1)
  expect(() => new mod.Client('http://example.com', 'secret')).toThrow(/loopback/i)
})
it('rejects a different instance before a write even when the protocol is compatible', async () => {
  const h = await endpoint(1)
  await expect(new mod.Client(h.url, 'secret', 'expected-instance').request('tickets', 'POST', {})).rejects.toThrow(/instance/i)
  expect(h.requests).toHaveLength(1)
})
it('exposes source health and ticket diagnostics through the same authenticated client', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'); let tool: any
  extension.default({ registerCommand: () => {}, registerTool: (value: any) => { tool = value }, on: () => {} } as any)
  await tool.execute('one', { action: 'sources' }); await tool.execute('two', { action: 'diagnostics', ticketId: 'ticket-1' })
  expect(h.requests.map(r => r.url)).toContain('/api/v1/sources')
  expect(h.requests.map(r => r.url)).toContain('/api/v1/tickets/ticket-1/diagnostics')
})
it('rejects model-issued writes to an unbound cross-project endpoint', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'); let tool: any
  extension.default({ registerCommand: () => {}, registerTool: (value: any) => { tool = value }, on: () => {} } as any)
  await expect(tool.execute('one', { action: 'request', text: 'wrong project' }, undefined, undefined, { cwd: process.cwd() })).rejects.toThrow(/setup|项目/)
  expect(h.requests.map(r => r.url)).not.toContain('/api/v1/tickets')
})
it('allows a remote environment connection only after a command confirms it for this session and project', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'); let tool: any, command: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: (value: any) => { tool = value }, on: () => {} } as any)
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { confirm: vi.fn(async () => true), notify: vi.fn(), setStatus: vi.fn() } }
  await command.handler('request explicitly authorized remote task', ctx)
  expect(ctx.ui.confirm).toHaveBeenCalled()
  expect(h.requests.map(r => r.url)).toContain('/api/v1/tickets')
  await expect(tool.execute('two', { action: 'request', text: 'same approved target' }, undefined, undefined, ctx)).resolves.toBeDefined()
  await expect(tool.execute('three', { action: 'request', text: 'different project' }, undefined, undefined, { cwd: '/' })).rejects.toThrow(/setup|项目/)
})
it('routes explicit setup commands into the guide rather than asking for a ticket ID', async () => {
  const extension = await import('../src/index.js'); let command: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: () => {}, on: () => {} } as any)
  const ui = { select: vi.fn(async () => undefined), notify: vi.fn() }
  await command.handler('setup', { cwd: process.cwd(), hasUI: true, mode: 'tui', ui })
  expect(ui.select).toHaveBeenCalled(); expect(ui.notify).not.toHaveBeenCalled()
})
it('exposes the Web address directly, in status, and in the persistent connection widget', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'); let command: any, tool: any, started: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: (value: any) => { tool = value }, on: (name: string, handler: any) => { if (name === 'session_start') started = handler } } as any)
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } }
  await command.handler('web url', ctx)
  expect(h.requests).toHaveLength(0) // Showing the address never starts or contacts the service.
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).toContain(h.url)
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain('secret')
  const status = await tool.execute('status', { action: 'status' }, undefined, undefined, ctx)
  expect(JSON.parse(status.content[0].text).webUrl).toBe(h.url)
  await started({}, ctx)
  expect(JSON.stringify(ctx.ui.setWidget.mock.calls)).toContain(h.url)
})
it('opens Web only from an explicit user command and keeps model web actions read-only', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'), { openBrowser } = await import('../src/browser.js'); vi.mocked(openBrowser).mockClear()
  let tool: any, command: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: (value: any) => { tool = value }, on: () => {} } as any)
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), setStatus: vi.fn(), setWidget: vi.fn() } }
  const result = await tool.execute('address', { action: 'web' }, undefined, undefined, ctx)
  expect(JSON.parse(result.content[0].text)).toEqual({ webUrl: h.url }); expect(h.requests).toHaveLength(0)
  await expect(tool.execute('secret', { action: 'token' }, undefined, undefined, ctx)).rejects.toThrow(/用户命令/)
  await expect(tool.execute('browser', { action: 'open-web' }, undefined, undefined, ctx)).rejects.toThrow(/用户命令/)
  await command.handler('web', ctx)
  expect(ctx.ui.confirm).toHaveBeenCalled(); expect(openBrowser).toHaveBeenCalledExactlyOnceWith(h.url + '/#login=' + 'a'.repeat(43))
  expect(h.requests.filter(r => r.url.endsWith('login-grants'))).toHaveLength(1)
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain('secret'); expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain('#login=')
})
it('makes administrator credentials available only after confirmation in a private terminal panel', async () => {
  const h = await endpoint(1); vi.stubEnv('PI_SUPERAGENT_URL', h.url); vi.stubEnv('PI_SUPERAGENT_TOKEN', 'secret')
  const extension = await import('../src/index.js'), { getKeybindings } = await import('@earendil-works/pi-tui'); let command: any, component: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: () => {}, on: () => {} } as any)
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn(async () => false), setStatus: vi.fn(), custom: vi.fn((factory: any) => new Promise<void>(resolve => {
    component = factory({ requestRender: vi.fn() }, {}, getKeybindings(), () => { component.dispose(); resolve() })
  })) } }
  await command.handler('token', ctx); expect(ctx.ui.custom).not.toHaveBeenCalled()
  ctx.ui.confirm.mockResolvedValue(true)
  const pending = command.handler('token', ctx)
  await vi.waitFor(() => expect(component).toBeDefined())
  expect(component.render(80).join('\n')).not.toContain('secret')
  component.handleInput('v'); expect(component.render(80).join('\n')).toContain('secret')
  component.handleInput('\x1b'); await pending
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain('secret')
})
it('registers a lightweight command and tool without starting a service', async () => {
  const extension = await import('../src/index.js').catch(() => ({} as any))
  expect(extension.default).toBeTypeOf('function'); const commands: any[] = [], tools: any[] = [], events: string[] = []
  extension.default({ registerCommand: (name: string) => commands.push(name), registerTool: (tool: any) => tools.push(tool), on: (event: string) => events.push(event) })
  expect(commands).toContain('superagent'); expect(tools[0].name).toBe('superagent'); expect(events).toContain('session_start')
})
