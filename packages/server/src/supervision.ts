import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync, linkSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { lockSync } from 'proper-lockfile'
import { readConfig, supervisionLockPath } from './config.js'
import { hostIdentity, planService, registeredService, renderUnit, serviceEnvironment, ServiceError, verifyUnit, type Registration, type ServiceHost } from './supervision-config.js'
export { registeredService, serviceEnvironment } from './supervision-config.js'
const exec = promisify(execFile)
const properties = ['LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'NRestarts', 'Result']
export function systemdHost(signal?: AbortSignal): ServiceHost {
  const identity = hostIdentity(), runtime = `/run/user/${identity.uid}`
  const env = { HOME: identity.home, PATH: '/usr/bin:/bin', LANG: 'C', XDG_CONFIG_HOME: join(identity.home, '.config'), XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` }
  return { ...identity, async run(args) {
    try { return (await exec('/usr/bin/systemctl', ['--user', '--no-pager', ...args], { env, signal, timeout: 40000, maxBuffer: 65536 })).stdout }
    catch (error) { const output = (error as { stdout?: string }).stdout; if (args[0] === 'show' && output?.includes('LoadState=not-found\n')) return output; throw new ServiceError('SERVICE_MANAGER_UNAVAILABLE') }
  }, async linger() {
    try { const value = (await exec('/usr/bin/loginctl', ['show-user', String(identity.uid), '--property=Linger', '--value'], { env, signal, timeout: 5000, maxBuffer: 1024 })).stdout.trim(); return value === 'yes' ? true : value === 'no' ? false : undefined }
    catch { return undefined }
  } }
}
async function run(host: ServiceHost, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  try { const value = await host.run(args); signal?.throwIfAborted(); return value }
  catch { signal?.throwIfAborted(); throw new ServiceError('SERVICE_MANAGER_UNAVAILABLE') }
}
async function inspect(host: ServiceHost, unitName: string, signal?: AbortSignal) {
  const output = await run(host, ['show', unitName, `--property=${properties.join(',')}`], signal)
  const values: Record<string, string> = Object.create(null)
  for (const line of output.split('\n')) { const i = line.indexOf('='); if (properties.includes(line.slice(0, i))) values[line.slice(0, i)] = line.slice(i + 1) }
  if (!['loaded', 'not-found'].includes(values.LoadState)) throw new ServiceError('SERVICE_OWNERSHIP')
  return values
}
function ownership(r: Registration, values: Record<string, string>, missing = false, reloading = false) {
  if (missing && values.LoadState === 'not-found' && !values.FragmentPath && !values.DropInPaths) return
  if (values.LoadState !== 'loaded' || values.FragmentPath !== r.unitFile || values.DropInPaths || !(reloading ? ['no', 'yes'] : ['no']).includes(values.NeedDaemonReload)) throw new ServiceError('SERVICE_OWNERSHIP')
}
async function offline(stateDir: string): Promise<() => void> {
  let unlock: () => void
  try { unlock = lockSync(stateDir, { stale: 30000 }) } catch { throw new ServiceError('INSTANCE_BUSY') }
  try {
    const socket = createServer(), port = readConfig(stateDir).port
    await new Promise<void>((resolve, reject) => { socket.once('error', () => reject(new ServiceError('INSTANCE_BUSY'))); socket.listen(port, '127.0.0.1', resolve) })
    await new Promise<void>(resolve => socket.close(() => resolve())); return unlock
  } catch (error) { unlock(); throw error }
}
/** Publish a complete private file without ever replacing an existing destination. */
function createPrivate(path: string, text: string) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); const fd = openSync(temp, 'r+'); try { fsyncSync(fd) } finally { closeSync(fd) }; linkSync(temp, path) }
  finally { rmSync(temp, { force: true }) }
}
function fileExists(path: string): boolean { try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
export async function serviceOperation(stateDir: string, action: string, options: { host?: ServiceHost; confirmed?: boolean; expectedId?: string; signal?: AbortSignal } = {}): Promise<any> {
  if (!['plan', 'status', 'install', 'enable', 'disable', 'uninstall', 'start', 'stop'].includes(action)) throw new ServiceError('SERVICE_ACTION')
  options.signal?.throwIfAborted()
  const host = options.host ?? systemdHost(options.signal), config = readConfig(stateDir)
  const perform = (args: string[]) => run(host, args, options.signal)
  const view = () => inspect(host, r.unitName, options.signal)
  if (options.expectedId && options.expectedId !== config.instanceId) throw new ServiceError('SERVICE_IDENTITY')
  if (!['plan', 'status'].includes(action) && !options.confirmed) throw new ServiceError('SERVICE_CONFIRM_REQUIRED')
  const saved = registeredService(stateDir)
  if (action === 'status' && !saved) return { kind: 'detached', supported: host.platform === 'linux', installed: false }
  if (host.platform !== 'linux') throw new ServiceError('SERVICE_UNSUPPORTED')
  if (saved && (saved.uid !== host.uid || saved.home !== realpathSync(host.home))) throw new ServiceError('SERVICE_IDENTITY')
  const r = saved ?? planService(stateDir, host)
  if (action === 'plan') return { kind: r.kind, instanceId: r.instanceId, unitName: r.unitName, unitFile: r.unitFile, unit: renderUnit(r), autostart: 'enable starts at user login; boot without login requires administrator-enabled linger' }
  const result = async () => {
    verifyUnit(r); const v = await view(); ownership(r, v)
    return { kind: r.kind, installed: true, instanceId: r.instanceId, unitName: r.unitName, active: v.ActiveState, substate: v.SubState, enabled: v.UnitFileState === 'enabled', mainPid: Number(v.MainPID) || 0, restarts: Number(v.NRestarts) || 0, result: /^[a-z-]{1,50}$/.test(v.Result) ? v.Result : 'unknown', linger: await host.linger?.() ?? null }
  }
  if (action === 'status') return result()
  let release: () => void
  try { release = lockSync(supervisionLockPath(stateDir), { realpath: false, stale: 120000 }) } catch { throw new ServiceError('SERVICE_CONTROL_BUSY') }
  let unlock: (() => void) | undefined
  try {
    if (readConfig(stateDir).instanceId !== r.instanceId) throw new ServiceError('SERVICE_IDENTITY')
    if (action === 'install') {
      const version = Number((await perform(['--version'])).match(/^systemd (\d+)/)?.[1])
      if (!Number.isInteger(version) || version < 245) throw new ServiceError('SERVICE_VERSION_UNSUPPORTED')
      unlock = await offline(stateDir)
      if (saved) { verifyUnit(r, true); if (r.digest !== planService(stateDir, host).digest) throw new ServiceError('SERVICE_IDENTITY') }
      else if (fileExists(r.unitFile)) throw new ServiceError('SERVICE_OWNERSHIP')
      const before = await view()
      if (saved) ownership(r, before, true, true)
      else if (before.LoadState !== 'not-found' || before.FragmentPath || before.DropInPaths) throw new ServiceError('SERVICE_OWNERSHIP')
      if (!['inactive', 'failed'].includes(before.ActiveState)) throw new ServiceError('INSTANCE_BUSY')
      serviceEnvironment(stateDir)
      if (!saved) createPrivate(join(stateDir, 'supervision.json'), JSON.stringify(r) + '\n')
      mkdirSync(dirname(r.unitFile), { recursive: true, mode: 0o700 })
      if (!fileExists(r.unitFile)) createPrivate(r.unitFile, renderUnit(r))
      await perform(['daemon-reload']); return result()
    }
    if (!saved) throw new ServiceError('SERVICE_NOT_INSTALLED')
    verifyUnit(r, action === 'uninstall')
    const before = await view(); ownership(r, before, action === 'uninstall', action === 'uninstall')
    if (action === 'uninstall') {
      if (!['inactive', 'failed'].includes(before.ActiveState)) throw new ServiceError('INSTANCE_BUSY')
      unlock = await offline(stateDir)
      if (before.LoadState !== 'not-found') { await perform(['disable', r.unitName]); await perform(['stop', r.unitName]) }
      verifyUnit(r, true); rmSync(r.unitFile, { force: true }); await perform(['daemon-reload'])
      rmSync(join(stateDir, 'supervision.json')); return { kind: 'detached', installed: false }
    }
    if (action === 'start') {
      if (before.ActiveState === 'active') return result()
      if (!['inactive', 'failed'].includes(before.ActiveState)) throw new ServiceError('SERVICE_RECOVERING')
      const releaseInstance = await offline(stateDir); releaseInstance()
      serviceEnvironment(stateDir)
      await perform(['reset-failed', r.unitName])
    }
    await perform([action, r.unitName]); return result()
  } finally { unlock?.(); release() }
}
