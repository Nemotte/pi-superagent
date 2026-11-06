import { afterEach, expect, it, vi } from 'vitest'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadBinding, saveBinding } from '../src/instances.js'
const mod = await import('../src/remote.js').catch(() => ({} as any))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function fixture() {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa ssh ui '))); roots.push(project)
  const info = { protocol: 1, instanceId: randomUUID(), stateDir: '/srv/private', repository: '/srv/app', port: 4317, management: 'token', online: true, status: { paused: true, busyWorkers: 0 } }
  const ctx = { cwd: project, hasUI: true, ui: { input: vi.fn().mockResolvedValueOnce('cloud').mockResolvedValueOnce('node').mockResolvedValueOnce('/opt/sa/dist/cli.js').mockResolvedValueOnce('/srv/private'), select: vi.fn(async (_title: string, choices: string[]) => choices[0]), confirm: vi.fn(async () => true), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } }
  const services = { connections: join(project, 'connections'), request: vi.fn(async (_target: unknown, request: any) => request.operation === 'environment' ? { protocol: 1, home: '/home/test' } : info), connect: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:4317' })), disconnect: vi.fn(async () => {}) }
  return { ctx, info, services, project }
}
it('explicitly binds an existing remote instance without changing its config or starting it', async () => {
  expect(mod.setupRemote).toBeTypeOf('function'); const f = fixture()
  const binding = await mod.setupRemote(f.ctx, f.services)
  expect(binding).toMatchObject({ project: f.project, repository: '/srv/app', ssh: { host: 'cloud', port: 4317 } })
  expect(loadBinding(f.services.connections, f.project)).toEqual(binding)
  expect(f.services.request.mock.calls.map(([, r]: any) => r.operation)).toEqual(['environment', 'inspect'])
  expect(f.services.connect).toHaveBeenCalledOnce()
})
it('does not start SSH or create a binding when the initial connection confirmation is cancelled', async () => {
  expect(mod.setupRemote).toBeTypeOf('function'); const f = fixture(); f.ctx.ui.confirm.mockResolvedValue(false)
  expect(await mod.setupRemote(f.ctx, f.services)).toBeUndefined()
  expect(f.services.request).not.toHaveBeenCalled(); expect(f.services.connect).not.toHaveBeenCalled()
  expect(loadBinding(f.services.connections, f.project)).toBeUndefined()
})
it('can replace an explicitly confirmed stale local binding with a remote instance', async () => {
  const f = fixture()
  saveBinding(f.services.connections, { project: f.project, repository: f.project, stateDir: join(f.project, 'removed-instance'), instanceId: f.info.instanceId })
  const binding = await mod.setupRemote(f.ctx, f.services)
  expect(binding.ssh.host).toBe('cloud')
})
it('rejects local-mode remote instances without silently changing their access mode', async () => {
  expect(mod.setupRemote).toBeTypeOf('function'); const f = fixture(); f.info.management = 'local'
  await expect(mod.setupRemote(f.ctx, f.services)).rejects.toThrow(/token/)
  expect(f.services.connect).not.toHaveBeenCalled()
})
it('creates a remote workspace with only explicitly selected members, paused and no automatic model call', async () => {
  expect(mod.setupRemote).toBeTypeOf('function'); const f = fixture()
  f.ctx.ui.select.mockImplementation(async (title, choices) => title === '远端实例' ? choices[2] : choices[0])
  f.ctx.ui.input.mockReset(); f.ctx.ui.input.mockImplementation(async (title: string) => title.includes('SSH') ? 'cloud' : title.includes('Node') ? 'node' : title.includes('CLI') ? '/opt/sa/dist/cli.js' : title.includes('工作区') ? '/srv/app' : '/srv/private')
  f.services.request.mockImplementation(async (_target, r) => {
    if (r.operation === 'environment') return { protocol: 1, home: '/home/test' } as any
    if (r.operation === 'discover') return { repositories: [{ id: 'front', path: 'front' }, { id: 'back', path: 'back' }], diagnostics: [] } as any
    if (r.operation === 'init') { expect(r.members).toEqual(['front', 'back']); f.info.port = r.port; return { ...f.info, online: false } }
    return f.info
  })
  const binding = await mod.setupRemote(f.ctx, f.services)
  expect(binding.repository).toBe('/srv/app')
  expect(f.services.request.mock.calls.map(([, r]: any) => r.operation)).toEqual(['environment', 'discover', 'init', 'start'])
})
it('gates remote lifecycle on human confirmation and preserves paused state', async () => {
  expect(mod.remoteLifecycle).toBeTypeOf('function'); const f = fixture()
  const binding = { project: f.project, repository: f.info.repository, stateDir: f.info.stateDir, instanceId: f.info.instanceId, ssh: { host: 'cloud', node: 'node', cliPath: '/opt/sa/dist/cli.js', port: f.info.port } }
  f.ctx.ui.confirm.mockResolvedValueOnce(false)
  await mod.remoteLifecycle(f.ctx, binding, 'restart', f.services)
  expect(f.services.request.mock.calls.map(([, r]: any) => r.operation)).toEqual(['inspect'])
  expect(f.services.disconnect).not.toHaveBeenCalled()
  f.services.request.mockClear()
  await mod.remoteLifecycle(f.ctx, binding, 'restart', f.services)
  expect(f.services.request.mock.calls.map(([, r]: any) => r.operation)).toEqual(['inspect', 'restart'])
  expect(f.services.request.mock.calls[1][1]).toMatchObject({ expected: { instanceId: binding.instanceId, repository: '/srv/app', port: 4317 } })
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).toContain('暂停')
  f.services.request.mockClear()
  await expect(mod.remoteLifecycle({ ...f.ctx, hasUI: false }, binding, 'start', f.services)).rejects.toThrow(/交互/)
  expect(f.services.request).not.toHaveBeenCalled()
})
