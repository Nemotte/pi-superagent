import { afterEach, expect, it, vi } from 'vitest'
import { realpathSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer } from 'node:net'
import { initialize, readConfig } from '../../server/src/config.js'
import { startService } from '../../server/src/service.js'
import { availablePort, instanceClient } from '../src/instances.js'
const mod = await import('../src/service-control.js').catch(() => ({} as any))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(management: 'local' | 'token' = 'token') {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa restart 中文 '))), repository = join(dir, 'repo'), stateDir = join(dir, 'state')
  mkdirSync(repository); cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  const config = initialize(stateDir, { repository, management, port: await availablePort(), paused: true, maxWorkers: 1 })
  const launch = async () => {
    const service = await startService(stateDir, { onShutdown: () => { void service.close() } })
    cleanups.push(() => service.close()); return service
  }
  const old = await launch(), connection = { project: repository, binding: { project: repository, repository, stateDir, instanceId: config.instanceId }, client: instanceClient(stateDir) }
  const ctx = { mode: 'tui', hasUI: true, ui: { confirm: vi.fn(async () => true), notify: vi.fn() } }
  let current = old
  const start = vi.fn(async () => { expect(existsSync(stateDir + '.lock')).toBe(false); current = await launch() })
  const prepareStart = vi.fn(async () => start)
  return { stateDir, config, old, connection, ctx, start, prepareStart, current: () => current }
}
it('confirms the local target, waits for full shutdown, restarts and preserves settings and tickets', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture()
  const overview = f.old.runtime.overview()
  vi.spyOn(f.old.runtime, 'overview').mockImplementation(() => ({ ...overview, busyWorkers: 2 }))
  const before = await f.connection.client.request('config')
  await f.connection.client.request('tickets', 'POST', { id: 'preserve', text: 'Do not execute this paused task' })
  const actualClose = f.old.runtime.close.bind(f.old.runtime)
  vi.spyOn(f.old.runtime, 'close').mockImplementation(async () => { await sleep(150); await actualClose() })
  await mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })
  expect(f.ctx.ui.confirm).toHaveBeenCalledOnce()
  const prompt = f.ctx.ui.confirm.mock.calls[0].join('\n')
  expect(prompt).toContain(f.stateDir); expect(prompt).toContain('忙碌 Worker：2'); expect(prompt).toContain('暂停')
  expect(f.start).toHaveBeenCalledOnce(); expect(f.current()).not.toBe(f.old)
  expect(await instanceClient(f.stateDir).request('config')).toEqual(before)
  expect(f.current().runtime.store.records('trigger').map(t => t.text)).toContain('Do not execute this paused task')
  const token = readFileSync(join(f.stateDir, 'admin.token'), 'utf8').trim()
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain(token)
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).toContain('重启完成')
})
it('uses the prepared supervisor-aware CLI stop rather than only HTTP shutdown', async () => {
  const f = await fixture(), calls = vi.spyOn(f.connection.client, 'request'), stop = vi.fn(async () => { await f.old.close() })
  const prepared = Object.assign(f.start, { stop })
  await mod.restartService(f.ctx, f.connection, { prepareStart: async () => prepared })
  expect(stop).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce()
  expect(calls.mock.calls.some(([path]) => path === 'shutdown')).toBe(false)
})
it('converts a legacy token instance to local after stopping, then restarts with no token file', async () => {
  const f = await fixture(), { configureManagement } = await import('../../server/src/management.js')
  const before = await f.connection.client.request('config')
  const prepareStart = vi.fn(async (_dir, change) => async () => { configureManagement(f.stateDir, change.mode, change.instanceId); await f.start() })
  await mod.restartService(f.ctx, f.connection, { prepareStart, management: 'local' })
  expect(prepareStart).toHaveBeenCalledWith(f.stateDir, { mode: 'local', instanceId: f.config.instanceId })
  expect(f.ctx.ui.confirm.mock.calls[0].join(' ')).toContain('本机')
  rmSync(join(f.stateDir, 'admin.token'))
  const client = instanceClient(f.stateDir)
  await mod.restartService(f.ctx, { ...f.connection, client }, { prepareStart: f.prepareStart })
  expect(await instanceClient(f.stateDir).request('config')).toEqual(before)
  expect((await instanceClient(f.stateDir).request('status') as any).management).toBe('local')
})
it('can convert an offline legacy instance even when its administrator token is missing', async () => {
  const f = await fixture(), { configureManagement } = await import('../../server/src/management.js')
  await f.old.close(); rmSync(join(f.stateDir, 'admin.token')); rmSync(join(f.stateDir, 'management.json'))
  const connection = { ...f.connection, client: instanceClient(f.stateDir) }
  await mod.restartService(f.ctx, connection, { management: 'local', prepareStart: async (_dir: string, change: any) => async () => {
    configureManagement(f.stateDir, change.mode, change.instanceId); await f.start()
  } })
  expect(existsSync(join(f.stateDir, 'admin.token'))).toBe(false)
  expect((await instanceClient(f.stateDir).request('status') as any).management).toBe('local')
})
it('cancels without stopping the service or preparing a start', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture(), calls = vi.spyOn(f.connection.client, 'request')
  f.ctx.ui.confirm.mockResolvedValue(false)
  await mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })
  expect(calls.mock.calls.some(call => call[0] === 'shutdown')).toBe(false)
  expect(f.prepareStart).not.toHaveBeenCalled(); expect((await f.connection.client.request('status') as any).paused).toBe(true)
})
it('refuses lifecycle control without a local binding or an explicit UI command', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture()
  await expect(mod.restartService(f.ctx, { ...f.connection, binding: undefined }, { prepareStart: f.prepareStart })).rejects.toThrow(/本地实例|本机实例/)
  await expect(mod.restartService({ ...f.ctx, hasUI: false }, f.connection, { prepareStart: f.prepareStart })).rejects.toThrow(/用户命令|交互/)
  expect(f.ctx.ui.confirm).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it('detects identity changes during confirmation and preflights startup before shutdown', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture(), calls = vi.spyOn(f.connection.client, 'request')
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: async () => { throw Error('private bootstrap error') } })).rejects.toThrow(/未停止/)
  expect(calls.mock.calls.some(call => call[0] === 'shutdown')).toBe(false)
  f.ctx.ui.confirm.mockImplementation(async () => { writeFileSync(join(f.stateDir, 'config.json'), JSON.stringify({ ...readConfig(f.stateDir), instanceId: 'ac052c55-aabb-4fdc-8ccf-d686f39d44bb' })); return true })
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })).rejects.toThrow(/身份|连接/)
  expect(f.start).not.toHaveBeenCalled(); expect(calls.mock.calls.some(call => call[0] === 'shutdown')).toBe(false)
})
it('does not start a second service when graceful shutdown times out', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture()
  const close = f.old.runtime.close.bind(f.old.runtime)
  vi.spyOn(f.old.runtime, 'close').mockImplementation(async () => { await sleep(300); await close() })
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart, waitTimeoutMs: 40 })).rejects.toThrow(/超时|未完全退出/)
  expect(f.start).not.toHaveBeenCalled()
})
it('starts an already stopped local instance after confirmation, but treats an occupied port as a failure', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture(); await f.old.close()
  await mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.ctx.ui.confirm.mock.calls[0].join(' ')).toContain('未运行')
  await f.current().close()
  const occupant = createServer(socket => {
    socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') throw error })
    socket.resume(); socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise<void>(resolve => occupant.listen(f.config.port, '127.0.0.1', resolve))
  cleanups.push(() => new Promise(resolve => occupant.close(() => resolve())))
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })).rejects.toThrow(/身份|占用/)
  expect(f.start).toHaveBeenCalledTimes(1)
})
it('fails closed on shutdown failure and reports startup failures without leaking subprocess errors', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture(), original = f.connection.client.request.bind(f.connection.client)
  const request = vi.spyOn(f.connection.client, 'request').mockImplementation((path, ...args) => path === 'shutdown' ? Promise.reject(Error('private stop error')) : original(path, ...args))
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: f.prepareStart })).rejects.toThrow(/停止请求/)
  expect(f.start).not.toHaveBeenCalled(); request.mockRestore()
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: async () => async () => { throw Error('private launch error') } })).rejects.toThrow(/启动未确认.*service\.log/)
})
it('does not report success when the restarted endpoint cannot be verified', async () => {
  expect(mod.restartService).toBeTypeOf('function'); const f = await fixture()
  await expect(mod.restartService(f.ctx, f.connection, { prepareStart: async () => async () => {} })).rejects.toThrow(/启动后.*验证.*ECONNREFUSED/)
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain('重启完成')
})
