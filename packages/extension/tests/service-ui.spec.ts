import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../../server/src/config.js'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
const load = async () => { expect(existsSync(new URL('../src/service-ui.ts', import.meta.url))).toBe(true); return import('../src/service-ui.js') }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa service ui ')); dirs.push(dir)
  const config = initialize(join(dir, 'state'), { repository: dir })
  const binding = { project: dir, repository: dir, stateDir: join(dir, 'state'), instanceId: config.instanceId }
  const ctx: any = { hasUI: true, ui: { select: vi.fn(), confirm: vi.fn(async () => true), notify: vi.fn() } }
  const io = { local: vi.fn(async (_state: string, action: string) => action === 'plan' ? { unitName: 'fixture.service', unitFile: '/private/unit' } : { kind: 'systemd-user', installed: true, active: 'inactive', enabled: false, linger: false }), remote: vi.fn() }
  return { binding, ctx, io, config }
}
it('confirms installation on an explicit local binding and never turns install into enable/start', async () => {
  const mod = await load(), f = fixture()
  await mod.manageService(f.ctx, { binding: f.binding } as any, 'install', f.io)
  expect(f.ctx.ui.confirm).toHaveBeenCalledOnce()
  expect(f.ctx.ui.confirm.mock.calls[0].join(' ')).toContain('不启动')
  expect(f.io.local.mock.calls.map(a => a[1])).toEqual(['plan', 'install'])
  expect(f.io.local).toHaveBeenLastCalledWith(f.binding.stateDir, 'install', f.binding.instanceId, true)
  expect(f.io.remote).not.toHaveBeenCalled()
})
it('cancels without mutation, and rejects model/non-UI or unbound control', async () => {
  const mod = await load(), f = fixture(); f.ctx.ui.confirm.mockResolvedValue(false)
  await mod.manageService(f.ctx, { binding: f.binding } as any, 'enable', f.io)
  expect(f.io.local.mock.calls.map(a => a[1])).toEqual(['plan'])
  await expect(mod.manageService({ ...f.ctx, hasUI: false }, { binding: f.binding } as any, 'install', f.io)).rejects.toThrow(/用户|交互/)
  await expect(mod.manageService(f.ctx, {} as any, 'install', f.io)).rejects.toThrow(/绑定/)
})
it('uses only the bounded SSH bridge for a remote binding and verifies its returned identity', async () => {
  const mod = await load(), f = fixture()
  const binding = { ...f.binding, repository: '/srv/app', stateDir: '/srv/private', ssh: { host: 'cloud', node: 'node', cliPath: '/srv/sa/dist/cli.js', port: 4317 } }
  f.io.remote.mockResolvedValue({ instanceId: binding.instanceId, service: { kind: 'systemd-user', installed: true, enabled: true, active: 'active', linger: false } })
  await mod.manageService(f.ctx, { binding } as any, 'status', f.io)
  expect(f.io.local).not.toHaveBeenCalled()
  expect(f.io.remote.mock.calls[0][1]).toMatchObject({ operation: 'service', action: 'status', stateDir: '/srv/private', expected: { instanceId: binding.instanceId, repository: '/srv/app', port: 4317 } })
  expect(f.ctx.ui.notify.mock.calls[0][0]).toContain('登录')
  f.io.remote.mockResolvedValue({ instanceId: 'different', service: {} })
  await expect(mod.manageService(f.ctx, { binding } as any, 'status', f.io)).rejects.toThrow(/身份/)
})
