import { afterEach, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ manage: vi.fn(async () => {}), lookup: vi.fn() }))
vi.mock('../src/service-ui.js', () => ({ manageService: f.manage }))
vi.mock('../src/instances.js', async original => ({ ...await original<object>(), connectionForProject: f.lookup, matchesProject: async () => true }))
const extension = await import('../src/index.js')
afterEach(() => vi.clearAllMocks())
function harness() {
  let command: any, tool: any; const events: any = {}
  extension.default({ registerCommand: (_name: string, value: any) => { command = value }, registerTool: (value: any) => { tool = value }, on: (name: string, value: any) => { events[name] = value } } as any)
  const connection = { project: '/project', binding: { repository: '/repo' }, client: { endpoint: 'http://127.0.0.1:4317', request: async () => ({}) } }
  f.lookup.mockResolvedValue(connection)
  const ctx = { hasUI: true, cwd: '/project', ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } }
  return { command, tool, events, connection, ctx }
}
it('routes explicit service commands without opening an SSH tunnel and rejects model tools', async () => {
  const h = harness()
  await h.command.handler('service install', h.ctx)
  expect(f.manage).toHaveBeenCalledExactlyOnceWith(h.ctx, h.connection, 'install')
  expect(f.lookup.mock.calls[0][2]).toBe(false)
  await expect(h.tool.execute('x', { action: 'service' }, undefined, undefined, h.ctx)).rejects.toThrow(/用户命令|交互/)
})
it('does not manage supervision during passive discovery and rejects extra service arguments', async () => {
  const h = harness()
  await h.events.session_start({}, h.ctx)
  await h.command.handler('service install extra', h.ctx)
  expect(f.manage).not.toHaveBeenCalled()
})
