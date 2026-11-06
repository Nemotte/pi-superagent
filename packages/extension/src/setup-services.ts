import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setupRpc, type SetupBackend, type LoginUI } from './setup-rpc.js'
import type { WorkspaceDiscovery } from './setup-project.js'
import { connectionsDir } from './instances.js'
export interface SetupServices {
  connections: string
  discover?(root: string): Promise<WorkspaceDiscovery>
  cli(stateDir: string, args: string[]): Promise<void>
  model(stateDir: string, request: { operation: string; provider?: string; method?: string; model?: string }, ui?: LoginUI): Promise<any>
}
interface Bootstrap extends SetupBackend { protocol: number; supervisionProtocol?: number; cliPath: string; discoverWorkspace?(root: string): Promise<WorkspaceDiscovery> }
const exec = promisify(execFile)
export async function loadBootstrap(): Promise<Bootstrap> {
  let entry: string
  if (process.env.PI_SUPERAGENT_SERVER) {
    if (!isAbsolute(process.env.PI_SUPERAGENT_SERVER)) throw Error('PI_SUPERAGENT_SERVER 必须是服务 CLI 的绝对路径。')
    entry = join(dirname(process.env.PI_SUPERAGENT_SERVER), 'bootstrap.js')
  } else {
    try { entry = createRequire(import.meta.url).resolve('@nemotte/pi-superagent/bootstrap') }
    catch { entry = fileURLToPath(new URL('../../server/dist/bootstrap.js', import.meta.url)) }
  }
  if (!existsSync(entry)) throw Error('未找到 Super-agent 服务包。请先构建/安装 @nemotte/pi-superagent，或将 PI_SUPERAGENT_SERVER 设为其 dist/cli.js 绝对路径；插件仍可连接已有服务。')
  const backend = await import(pathToFileURL(entry).href) as Bootstrap
  if (backend.protocol !== 1 || typeof backend.setupEnvironment !== 'function') throw Error('服务包与插件的初始化协议不兼容。')
  return backend
}
async function runCli(backend: Bootstrap, stateDir: string, args: string[]): Promise<string> {
  try { return (await exec(process.execPath, [backend.cliPath, ...args, '--state-dir', stateDir], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true, env: backend.setupEnvironment(join(stateDir, 'agent', 'home')) })).stdout }
  catch (error) {
    const code = String((error as { stderr?: string }).stderr || '').trim()
    if (/^(SERVICE_[A-Z_]{1,40}|INSTANCE_BUSY)$/.test(code)) throw Error(`系统托管操作未完成（${code}）；检查 systemd 用户会话、实例停机状态及 unit 归属，未自动重试。`)
    throw Error(`服务操作 ${args[0]} 未完成；检查实例 ${stateDir} 的配置和 service.log。`)
  }
}
/** Preflight the installed CLI before stopping a service. Does not start an instance. */
export type PreparedStart = (() => Promise<void>) & { stop?: () => Promise<void> }
export async function prepareLocalStart(stateDir: string, change?: { mode: 'local' | 'token'; instanceId: string }, expectedId?: string): Promise<PreparedStart> {
  const backend = await loadBootstrap()
  if (!isAbsolute(backend.cliPath) || !existsSync(backend.cliPath)) throw Error('服务 CLI 不可用。')
  await runCli(backend, stateDir, ['--version'])
  if (change && !(await runCli(backend, stateDir, ['--help'])).includes('management local|token')) throw Error('服务 CLI 尚不支持本地模式 management，请更新服务包。')
  const identity = expectedId ?? change?.instanceId
  const expected = identity ? ['--expected-instance-id', identity] : []
  const start: PreparedStart = async () => {
    if (change) await runCli(backend, stateDir, ['management', change.mode, '--expected-instance-id', change.instanceId])
    await runCli(backend, stateDir, ['start', ...expected])
  }
  if (backend.supervisionProtocol === 1) start.stop = async () => { await runCli(backend, stateDir, ['shutdown', ...expected]) }
  return start
}
export async function localServiceOperation(stateDir: string, action: string, instanceId: string, confirmed = false): Promise<any> {
  if (!['plan', 'status', 'install', 'enable', 'disable', 'uninstall'].includes(action)) throw Error('未知托管操作。')
  const backend = await loadBootstrap()
  if (backend.supervisionProtocol !== 1) throw Error('服务包尚不支持系统托管，请更新服务包。')
  return JSON.parse(await runCli(backend, stateDir, ['service', action, '--expected-instance-id', instanceId, ...confirmed ? ['--yes'] : []]))
}
export function localSetupServices(): SetupServices {
  return {
    connections: connectionsDir(),
    async discover(root) {
      const backend = await loadBootstrap()
      if (!backend.discoverWorkspace) throw Error('服务包尚不支持工作区发现，请构建或更新服务包。')
      return backend.discoverWorkspace(root)
    },
    async cli(stateDir, args) {
      await runCli(await loadBootstrap(), stateDir, args)
    },
    async model(stateDir, request, ui) { return setupRpc(await loadBootstrap(), stateDir, request, ui, request.operation === 'login' ? 360000 : 45000) },
  }
}
