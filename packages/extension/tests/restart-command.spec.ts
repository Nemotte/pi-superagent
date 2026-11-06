import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ configureModels: vi.fn(async () => {}), restartService: vi.fn(async () => {}), connection: { project: '/app', binding: { repository: '/app', stateDir: '/private/state', instanceId: 'test' }, client: { endpoint: 'http://127.0.0.1:4321', request: vi.fn(async () => ({ protocol: 1, instanceId: 'test' })) } } }))
vi.mock('../src/service-control.js', () => ({ restartService: fixture.restartService }))
vi.mock('../src/setup.js', () => ({ configureModels: fixture.configureModels }))
vi.mock('../src/instances.js', async importOriginal => ({ ...await importOriginal<object>(), connectionForProject: async () => fixture.connection, matchesProject: async () => true }))
const extension = await import('../src/index.js')
afterEach(() => { vi.clearAllMocks() })
function commands() {
  let command: any, tool: any, started: any
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: (value: any) => { tool = value }, on: (name: string, fn: any) => { if (name === 'session_start') started = fn } } as any)
  const ctx = { hasUI: true, mode: 'tui', cwd: '/app', ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(async () => '重启后台服务') } }
  return { command, tool, ctx, started }
}
it('offers role model configuration only to user commands, and renders readable status', async () => {
  const f = commands()
  await f.command.handler('models', f.ctx)
  expect(fixture.configureModels).toHaveBeenCalledExactlyOnceWith(f.ctx)
  await expect(f.tool.execute('models', { action: 'models' }, undefined, undefined, f.ctx)).rejects.toThrow()
  await f.command.handler('status', f.ctx)
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('\\"protocol\\"')
  expect(f.ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain('工单')
})
it('routes the restart command and menu to local lifecycle control rather than task actions', async () => {
  const f = commands()
  await f.command.handler('restart', f.ctx)
  expect(fixture.restartService).toHaveBeenCalledExactlyOnceWith(f.ctx, fixture.connection)
  fixture.restartService.mockClear()
  await f.command.handler('', f.ctx)
  expect(f.ctx.ui.select.mock.calls[0][1]).toContain('重启后台服务')
  expect(fixture.restartService).toHaveBeenCalledExactlyOnceWith(f.ctx, fixture.connection)
  fixture.restartService.mockClear(); fixture.connection.client.request.mockRejectedValueOnce(Error('offline'))
  await f.command.handler('', f.ctx)
  expect(fixture.restartService).toHaveBeenCalledExactlyOnceWith(f.ctx, fixture.connection)
})
it('keeps token and migration controls out of a local instance menu', async () => {
  const f = commands()
  fixture.connection.client.request.mockResolvedValueOnce({ protocol: 1, instanceId: 'test', management: 'local' } as any)
  await f.command.handler('', f.ctx)
  const options = f.ctx.ui.select.mock.calls[0][1]
  expect(options).not.toContain('管理员令牌（高级）'); expect(options).not.toContain('切换到本地模式')
  expect(options).toContain('打开 Web 控制台')
})
it('routes local mode changes through the same exclusive human lifecycle command', async () => {
  const f = commands()
  await f.command.handler('local', f.ctx)
  expect(fixture.restartService).toHaveBeenCalledExactlyOnceWith(f.ctx, fixture.connection, { management: 'local' })
  await expect(f.tool.execute('local', { action: 'local' }, undefined, undefined, f.ctx)).rejects.toThrow(/用户命令/)
})
it('does not restart from session startup, model tools or a non-interactive command', async () => {
  const f = commands(); await f.started({}, f.ctx)
  await expect(f.tool.execute('restart', { action: 'restart' }, undefined, undefined, f.ctx)).rejects.toThrow(/用户命令/)
  await f.command.handler('restart', { ...f.ctx, hasUI: false })
  expect(fixture.restartService).not.toHaveBeenCalled()
})
it('prevents overlapping restarts and releases the guard after success or failure', async () => {
  const f = commands(); let release!: () => void
  fixture.restartService.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const first = f.command.handler('restart', f.ctx)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await f.command.handler('restart', f.ctx)
  expect(fixture.restartService).toHaveBeenCalledTimes(1)
  await f.command.handler('setup', f.ctx); expect(f.ctx.ui.select).not.toHaveBeenCalled()
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).toContain('正在重启')
  release(); await first
  fixture.restartService.mockRejectedValueOnce(Error('Fixture failure'))
  await f.command.handler('restart', f.ctx)
  await f.command.handler('restart', f.ctx)
  expect(fixture.restartService).toHaveBeenCalledTimes(3)
})
