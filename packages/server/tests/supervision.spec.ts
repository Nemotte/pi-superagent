import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { initialize, readConfig } from '../src/config.js'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
const load = async () => { expect(existsSync(new URL('../src/supervision.ts', import.meta.url))).toBe(true); return import('../src/supervision.js') }
async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa systemd %$ 雲 '))); dirs.push(root)
  const state = join(root, 'state'), home = join(root, 'home'); mkdirSync(home)
  const socket = createServer(); await new Promise<void>(r => socket.listen(0, '127.0.0.1', r)); const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()))
  const config = initialize(state, { repository: root, port, paused: true, management: 'token' })
  const cliPath = join(root, 'cli.js'); writeFileSync(cliPath, '// fixture\n')
  const unit = `pi-superagent-${config.instanceId}.service`, unitFile = join(home, '.config/systemd/user', unit)
  let active = 'inactive', enabled = false, dropIns = '', foreign = false, reload = false
  const host = { platform: 'linux', uid: process.getuid?.() ?? 1000, home, node: process.execPath, cliPath, run: vi.fn(async (args: string[]) => {
    if (args[0] === '--version') return 'systemd 252\n'
    if (args[0] === 'daemon-reload') reload = false
    if (args[0] === 'show') return `LoadState=${existsSync(unitFile) ? 'loaded' : 'not-found'}\nFragmentPath=${existsSync(unitFile) ? foreign ? '/unowned.service' : unitFile : ''}\nDropInPaths=${dropIns}\nNeedDaemonReload=${reload ? 'yes' : 'no'}\nActiveState=${active}\nSubState=${active === 'active' ? 'running' : 'dead'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nMainPID=0\nNRestarts=0\nResult=success\n`
    if (args[0] === 'enable') enabled = true
    if (args[0] === 'disable') enabled = false
    if (args[0] === 'start') active = 'active'
    if (args[0] === 'stop') active = 'inactive'
    return ''
  }) }
  const options = { host, confirmed: true, expectedId: config.instanceId }
  return { root, state, config, unitFile, host, options, setActive: (v: string) => { active = v }, setDropIns: (v: string) => { dropIns = v }, setForeign: () => { foreign = true }, setReload: () => { reload = true } }
}
it('plans a literal systemd argv with bounded restart and no ambient credentials, without writes or manager calls', async () => {
  const mod = await load(), f = await fixture(), before = readFileSync(join(f.state, 'config.json'), 'utf8')
  const plan = await mod.serviceOperation(f.state, 'plan', f.options)
  expect(plan.unit).toContain('Restart=on-failure'); expect(plan.unit).toContain('RestartSec=35s'); expect(plan.unit).toContain('KillMode=control-group')
  expect(plan.unit).toContain('ExecStart=:/usr/bin/env "-i"'); expect(plan.unit).toContain('%%$'); expect(plan.unit).toContain('--supervised')
  expect(plan.unit).not.toContain(readFileSync(join(f.state, 'admin.token'), 'utf8').trim())
  expect(existsSync(f.unitFile)).toBe(false); expect(existsSync(join(f.state, 'supervision.json'))).toBe(false); expect(f.host.run).not.toHaveBeenCalled()
  expect(readFileSync(join(f.state, 'config.json'), 'utf8')).toBe(before)
})
it('requires confirmation and Linux before registering, and rejects changed identities', async () => {
  const mod = await load(), f = await fixture()
  await expect(mod.serviceOperation(f.state, 'install', { ...f.options, confirmed: false })).rejects.toThrow(/CONFIRM/)
  await expect(mod.serviceOperation(f.state, 'install', { ...f.options, expectedId: 'other' })).rejects.toThrow(/IDENTITY/)
  await expect(mod.serviceOperation(f.state, 'install', { ...f.options, host: { ...f.host, platform: 'win32' } })).rejects.toThrow(/UNSUPPORTED/)
  expect(existsSync(f.unitFile)).toBe(false); expect(f.host.run).not.toHaveBeenCalled()
})
it('rejects systemd older than 245 before creating a registration', async () => {
  const mod = await load(), f = await fixture(), run = f.host.run.getMockImplementation()!
  f.host.run.mockImplementation(args => args[0] === '--version' ? Promise.resolve('systemd 219\n') : run(args))
  await expect(mod.serviceOperation(f.state, 'install', f.options)).rejects.toThrow(/VERSION/)
  expect(existsSync(join(f.state, 'supervision.json'))).toBe(false); expect(existsSync(f.unitFile)).toBe(false)
})
it('reloads a verified unchanged partial registration, while lifecycle refuses a stale manager view', async () => {
  const mod = await load(), f = await fixture(); await mod.serviceOperation(f.state, 'install', f.options)
  f.setReload()
  await expect(mod.serviceOperation(f.state, 'start', f.options)).rejects.toThrow(/OWNERSHIP/)
  await mod.serviceOperation(f.state, 'install', f.options)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ active: 'inactive' })
})
it('registers without starting or enabling, preserves data, and separates autostart from lifecycle', async () => {
  const mod = await load(), f = await fixture()
  await mod.serviceOperation(f.state, 'install', f.options)
  expect(existsSync(f.unitFile)).toBe(true)
  expect(f.host.run.mock.calls.some(([a]) => ['start', 'enable'].includes(a[0]))).toBe(false)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ kind: 'systemd-user', active: 'inactive', enabled: false })
  await mod.serviceOperation(f.state, 'enable', f.options)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ enabled: true, active: 'inactive' })
  await mod.serviceOperation(f.state, 'start', f.options)
  await mod.serviceOperation(f.state, 'disable', f.options)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ enabled: false, active: 'active' })
  await expect(mod.serviceOperation(f.state, 'uninstall', f.options)).rejects.toThrow(/BUSY/)
  await mod.serviceOperation(f.state, 'stop', f.options)
  await mod.serviceOperation(f.state, 'uninstall', f.options)
  expect(existsSync(f.unitFile)).toBe(false); expect(readConfig(f.state)).toEqual(f.config)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ kind: 'detached' })
})
it('refuses live instance locks and unowned units without overwriting either', async () => {
  const mod = await load(), f = await fixture()
  mkdirSync(f.state + '.lock')
  await expect(mod.serviceOperation(f.state, 'install', f.options)).rejects.toThrow()
  expect(existsSync(f.unitFile)).toBe(false); rmSync(f.state + '.lock', { recursive: true })
  mkdirSync(join(f.host.home, '.config/systemd/user'), { recursive: true }); writeFileSync(f.unitFile, 'unowned')
  await expect(mod.serviceOperation(f.state, 'install', f.options)).rejects.toThrow(/OWNERSHIP/)
  expect(readFileSync(f.unitFile, 'utf8')).toBe('unowned')
})
it('refuses symlinks, unit edits, drop-ins and foreign fragments before lifecycle commands', async () => {
  const mod = await load(), f = await fixture(); await mod.serviceOperation(f.state, 'install', f.options)
  const original = readFileSync(f.unitFile, 'utf8'); writeFileSync(f.unitFile, original + '# edited\n')
  await expect(mod.serviceOperation(f.state, 'start', f.options)).rejects.toThrow(/OWNERSHIP/)
  writeFileSync(f.unitFile, original); f.setDropIns('/tmp/override.conf')
  await expect(mod.serviceOperation(f.state, 'start', f.options)).rejects.toThrow(/OWNERSHIP/)
  f.setDropIns(''); f.setForeign()
  await expect(mod.serviceOperation(f.state, 'stop', f.options)).rejects.toThrow(/OWNERSHIP/)
  expect(f.host.run.mock.calls.some(([a]) => ['start', 'stop'].includes(a[0]))).toBe(false)
  if (process.platform !== 'win32') {
    const copy = join(f.root, 'other.service'); writeFileSync(copy, original); rmSync(f.unitFile); symlinkSync(copy, f.unitFile)
    await expect(mod.serviceOperation(f.state, 'uninstall', f.options)).rejects.toThrow(/OWNERSHIP/)
    expect(readFileSync(copy, 'utf8')).toBe(original)
  }
})
it('retains a partial registration after reload failure for an explicit, idempotent retry', async () => {
  const mod = await load(), f = await fixture(), run = f.host.run.getMockImplementation()!
  f.host.run.mockImplementation(async args => { if (args[0] === 'daemon-reload') throw Error('private manager detail'); return run(args) })
  await expect(mod.serviceOperation(f.state, 'install', f.options)).rejects.toThrow(/MANAGER/)
  expect(existsSync(f.unitFile)).toBe(true); expect(existsSync(join(f.state, 'supervision.json'))).toBe(true)
  f.host.run.mockImplementation(run); await mod.serviceOperation(f.state, 'install', f.options)
  expect(await mod.serviceOperation(f.state, 'status', f.options)).toMatchObject({ kind: 'systemd-user', active: 'inactive' })
})
it('exposes registration in API status without invoking the user manager during polling', async () => {
  const mod = await load(), f = await fixture(); await mod.serviceOperation(f.state, 'install', f.options)
  const { Runtime } = await import('../src/runtime.js')
  const runtime = new Runtime(f.state, { send: async () => {}, stop: async () => {}, close: async () => {} })
  f.host.run.mockClear()
  try { expect(runtime.overview()).toMatchObject({ supervision: { kind: 'systemd-user', unitName: `pi-superagent-${f.config.instanceId}.service` } }); expect(f.host.run).not.toHaveBeenCalled() }
  finally { await runtime.close() }
})
it('does not start a detached replacement while systemd is recovering or registration is incomplete', async () => {
  const mod = await load(), f = await fixture(); await mod.serviceOperation(f.state, 'install', f.options)
  f.setActive('activating')
  await expect(mod.serviceOperation(f.state, 'start', f.options)).rejects.toThrow(/RECOVERING/)
  rmSync(f.unitFile)
  await expect(mod.serviceOperation(f.state, 'start', f.options)).rejects.toThrow(/OWNERSHIP/)
  expect(f.host.run.mock.calls.some(([args]) => args[0] === 'start')).toBe(false)
})
it('stops further control steps on cancellation and preserves a recoverable registration', async () => {
  const mod = await load(), f = await fixture(); await mod.serviceOperation(f.state, 'install', f.options)
  const controller = new AbortController(), run = f.host.run.getMockImplementation()!
  f.host.run.mockClear().mockImplementation(async args => { const value = await run(args); if (args[0] === 'disable') controller.abort(); return value })
  await expect(mod.serviceOperation(f.state, 'uninstall', { ...f.options, signal: controller.signal })).rejects.toThrow(/abort/i)
  expect(f.host.run.mock.calls.some(([args]) => args[0] === 'stop')).toBe(false)
  expect(existsSync(f.unitFile)).toBe(true); expect(existsSync(join(f.state, 'supervision.json'))).toBe(true)
})
it('loads only explicitly allowed private service environment and never reflects secret values', async () => {
  const mod = await load(), f = await fixture()
  writeFileSync(join(f.state, 'service.env.json'), JSON.stringify({ HTTPS_PROXY: 'http://user:secret@proxy:8080', NO_PROXY: 'localhost' }), { mode: 0o600 })
  expect(mod.serviceEnvironment(f.state)).toEqual({ HTTPS_PROXY: 'http://user:secret@proxy:8080', NO_PROXY: 'localhost' })
  const plan = await mod.serviceOperation(f.state, 'plan', f.options); expect(JSON.stringify(plan)).not.toContain('secret')
  writeFileSync(join(f.state, 'service.env.json'), JSON.stringify({ NODE_OPTIONS: '--import private-secret' }))
  expect(() => mod.serviceEnvironment(f.state)).toThrow(/SERVICE_ENV/)
  expect(() => mod.serviceEnvironment(f.state)).not.toThrow(/private-secret/)
})
