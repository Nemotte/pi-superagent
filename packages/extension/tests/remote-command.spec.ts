import { afterEach, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ setupRemote: vi.fn(async () => {}), remoteLifecycle: vi.fn(async () => {}), disconnectRemote: vi.fn(async () => {}), closeRemoteConnections: vi.fn(async () => {}), lookup: vi.fn(), binding: { project: '/local', repository: '/srv/repo', stateDir: '/srv/private', instanceId: 'remote-id', ssh: { host: 'cloud', node: 'node', cliPath: '/srv/sa/dist/cli.js', port: 4317 } } }))
vi.mock('../src/remote.js', () => ({ setupRemote: f.setupRemote, remoteLifecycle: f.remoteLifecycle }))
vi.mock('../src/remote-connections.js', () => ({ disconnectRemote: f.disconnectRemote, closeRemoteConnections: f.closeRemoteConnections }))
vi.mock('../src/instances.js', async original => ({ ...await original<object>(), connectionForProject: f.lookup, matchesProject: async () => true }))
const extension = await import('../src/index.js')
afterEach(() => vi.clearAllMocks())
function harness() {
  let command: any, tool: any; const events: Record<string, any> = {}
  extension.default({ registerCommand: (_: string, c: any) => { command = c }, registerTool: (t: any) => { tool = t }, on: (name: string, fn: any) => { events[name] = fn } } as any)
  const client = { endpoint: 'http://127.0.0.1:4317', request: vi.fn(async () => ({ protocol: 1, instanceId: 'remote-id', management: 'token' })) }
  f.lookup.mockResolvedValue({ project: '/local', binding: f.binding, client })
  const ctx = { cwd: '/local', mode: 'tui', hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(async () => undefined) } }
  return { command, tool, events, ctx, client }
}
it('offers SSH setup and only user commands may establish a connection or manage remote lifecycle', async () => {
  const h = harness()
  await h.command.handler('ssh', h.ctx); expect(f.setupRemote).toHaveBeenCalledExactlyOnceWith(h.ctx)
  await h.command.handler('connect', h.ctx); expect(f.lookup.mock.calls.at(-1)?.[2]).toBe(true)
  for (const action of ['start', 'restart', 'shutdown']) await h.command.handler(action, h.ctx)
  expect(f.remoteLifecycle.mock.calls.map(call => call[2])).toEqual(['start', 'restart', 'shutdown'])
  for (const action of ['ssh', 'connect', 'disconnect', 'start', 'shutdown']) await expect(h.tool.execute('x', { action }, undefined, undefined, h.ctx)).rejects.toThrow(/用户命令|交互/)
})
it('never starts SSH during session discovery and closes only local tunnel resources on shutdown', async () => {
  const h = harness()
  await h.events.session_start({}, h.ctx)
  expect(f.lookup.mock.calls.at(-1)?.[2]).not.toBe(true)
  expect(f.remoteLifecycle).not.toHaveBeenCalled()
  expect(h.events.session_shutdown).toBeTypeOf('function')
  await h.events.session_shutdown({}, h.ctx)
  expect(f.closeRemoteConnections).toHaveBeenCalledOnce()
  expect(f.remoteLifecycle).not.toHaveBeenCalled()
})
it('keeps remote metadata on an offline menu and never offers local-mode conversion', async () => {
  const h = harness(); h.client.request.mockRejectedValueOnce(Error('offline'))
  await h.command.handler('', h.ctx)
  const choices = h.ctx.ui.select.mock.calls[0]?.[1]
  expect(choices).toContain('启动远端服务'); expect(choices).toContain('断开 SSH 连接')
  expect(choices).not.toContain('切换到本地模式')
  await h.command.handler('local', h.ctx)
  expect(f.remoteLifecycle).not.toHaveBeenCalled()
  expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).toContain('token')
})
