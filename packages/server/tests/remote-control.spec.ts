import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomInt } from 'node:crypto'
import { initialize, readConfig } from '../src/config.js'
import { startService } from '../src/service.js'
import { repository } from './fixtures/workspace.js'
const mod: any = await import('../src/remote-control.js')
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks() })
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa remote 雲 '))); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "repo ' spaced"); repository(repo)
  return { root, repo, state: join(root, 'private state') }
}
// Do not release a port from listen(0)'s ephemeral pool and then let parallel HTTP
// connections claim it while init asynchronously validates Git. Keep fixture service
// ports below the Linux/macOS/Windows default ephemeral pools; still probe occupancy.
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const s = createServer(), port = randomInt(20000, 30000)
    try { await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve) }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue; throw error }
    await new Promise<void>(resolve => s.close(() => resolve())); return port
  }
  throw Error('No free fixture service port in 20000..29999')
}
it('creates a token-only paused remote instance without GitHub or repository mutation', async () => {
  expect(mod.remoteOperation).toBeTypeOf('function'); const f = fixture()
  const result = await mod.remoteOperation({ operation: 'init', stateDir: f.state, repository: f.repo, port: await freePort() })
  expect(result).toMatchObject({ protocol: 1, management: 'token', repository: f.repo, online: false })
  expect(result).not.toHaveProperty('token')
  expect(readConfig(f.state)).toMatchObject({ github: null, paused: true, maxWorkers: 1 })
  await expect(mod.remoteOperation({ operation: 'init', stateDir: f.state, repository: f.repo, port: result.port })).rejects.toThrow()
})
it('rejects an occupied port before creating private state and leaves the listener alive', async () => {
  const f = fixture(), listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => listener.close(() => resolve())))
  const port = (listener.address() as { port: number }).port
  await expect(mod.remoteOperation({ operation: 'init', stateDir: f.state, repository: f.repo, port })).rejects.toMatchObject({ code: 'PORT_BUSY' })
  expect(existsSync(f.state)).toBe(false)
  expect(listener.listening).toBe(true)
})
it('refuses private data in checkout and rejects arbitrary operation/invalid paths before writes', async () => {
  expect(mod.remoteOperation).toBeTypeOf('function'); const f = fixture()
  const inside = join(f.repo, 'private')
  await expect(mod.remoteOperation({ operation: 'init', stateDir: inside, repository: f.repo, port: await freePort() })).rejects.toThrow()
  expect(existsSync(inside)).toBe(false)
  await expect(mod.remoteOperation({ operation: 'exec', command: 'id' })).rejects.toThrow()
  await expect(mod.remoteOperation({ operation: 'inspect', stateDir: '../elsewhere' })).rejects.toThrow()
})
it('checks identity and mode before returning a credential; inspect never returns credentials', async () => {
  expect(mod.remoteOperation).toBeTypeOf('function'); const f = fixture()
  const c = initialize(f.state, { repository: f.repo, port: await freePort(), management: 'token', paused: true })
  const expected = { instanceId: c.instanceId, repository: f.repo, port: c.port }
  const info = await mod.remoteOperation({ operation: 'inspect', stateDir: f.state })
  expect(JSON.stringify(info)).not.toContain(readFileSync(join(f.state, 'admin.token'), 'utf8').trim())
  const connected = await mod.remoteOperation({ operation: 'connect', stateDir: f.state, expected })
  expect(connected.token).toBe(readFileSync(join(f.state, 'admin.token'), 'utf8').trim())
  await expect(mod.remoteOperation({ operation: 'connect', stateDir: f.state, expected: { ...expected, port: c.port + 1 } })).rejects.toThrow(/IDENTITY/)
  await expect(mod.remoteOperation({ operation: 'connect', stateDir: f.state })).rejects.toThrow()
  const local = join(f.root, 'local'); initialize(local, { repository: f.repo })
  const lc = readConfig(local)
  await expect(mod.remoteOperation({ operation: 'connect', stateDir: local, expected: { instanceId: lc.instanceId, repository: f.repo, port: lc.port } })).rejects.toThrow(/TOKEN/)
})
it('refuses to start another service while a lock remains and preserves configuration', async () => {
  expect(mod.remoteOperation).toBeTypeOf('function'); const f = fixture()
  const c = initialize(f.state, { repository: f.repo, port: await freePort(), management: 'token', paused: true })
  const before = readFileSync(join(f.state, 'config.json'), 'utf8')
  mkdirSync(f.state + '.lock')
  await expect(mod.remoteOperation({ operation: 'start', stateDir: f.state, expected: { instanceId: c.instanceId, repository: f.repo, port: c.port } })).rejects.toThrow(/BUSY/)
  expect(readFileSync(join(f.state, 'config.json'), 'utf8')).toBe(before)
})
it('requires bound token identity for remote supervision and forwards only its restricted action', async () => {
  const f = fixture(), c = initialize(f.state, { repository: f.repo, management: 'token' })
  const expected = { instanceId: c.instanceId, repository: f.repo, port: c.port }
  const service = await import('../src/supervision.js'), operation = vi.spyOn(service, 'serviceOperation').mockResolvedValue({ kind: 'systemd-user' })
  await expect(mod.remoteOperation({ operation: 'service', action: 'status', stateDir: f.state, expected })).resolves.toMatchObject({ instanceId: c.instanceId, service: { kind: 'systemd-user' } })
  expect(operation).toHaveBeenCalledWith(f.state, 'status', { expectedId: c.instanceId, confirmed: undefined })
  operation.mockClear()
  await expect(mod.remoteOperation({ operation: 'service', action: 'status', stateDir: f.state, expected: { ...expected, port: c.port + 1 } })).rejects.toThrow(/IDENTITY/)
  await expect(mod.remoteOperation({ operation: 'service', action: 'exec', stateDir: f.state, expected })).rejects.toThrow()
  expect(operation).not.toHaveBeenCalled()
})
it('inspects an online instance without changing paused state or starting a model', async () => {
  expect(mod.remoteOperation).toBeTypeOf('function'); const f = fixture()
  initialize(f.state, { repository: f.repo, port: await freePort(), management: 'token', paused: true })
  const s = await startService(f.state); cleanup.push(() => s.close())
  expect(await mod.remoteOperation({ operation: 'inspect', stateDir: f.state })).toMatchObject({ online: true, status: { paused: true, busyWorkers: 0 } })
})
