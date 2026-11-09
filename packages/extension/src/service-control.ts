import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { canonical, instanceClient, instanceConfig, type Connection } from './instances.js'
import { ApiError } from './client.js'
import { prepareLocalStart, type PreparedStart } from './setup-services.js'
interface Status { protocol: number; instanceId: string; paused: boolean; busyWorkers: number }
interface Controls { prepareStart?: typeof prepareLocalStart; waitTimeoutMs?: number; management?: 'local' }
function failureKind(error: unknown): string {
  if (error instanceof ApiError) return `HTTP ${error.status}`
  const code = (error as NodeJS.ErrnoException)?.code
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ABORT_ERR', 'EACCES', 'ENOENT', 'EISDIR'].includes(code)) return code
  if (error instanceof Error && error.message === 'Super-agent instance identity mismatch') return 'INSTANCE_MISMATCH'
  if (error instanceof Error && error.message === 'Incompatible Super-agent API protocol') return 'PROTOCOL_MISMATCH'
  return 'UNVERIFIED'
}
async function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (closed: boolean) => { socket.destroy(); resolve(closed) }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
  })
}
/** Matches the server's canonical spelling: `state/.lock` is a different file from `state.lock`. */
async function stopped(stateDir: string, port: number): Promise<boolean> {
  return !existsSync(resolve(stateDir) + '.lock') && await portClosed(port)
}
/** Human command only. Lifecycle ownership comes from a local binding, never a remote URL. */
export async function restartService(ctx: ExtensionContext, connection: Connection, controls: Controls = {}): Promise<void> {
  if (!ctx.hasUI) throw Error('重启需要交互式用户命令确认。')
  if (!connection.binding) throw Error('仅支持重启已绑定的本地实例。请先用 /superagent setup 连接本机实例；远端隧道不能作为本地服务重启。')
  const binding = { ...connection.binding }, stateDir = canonical(binding.stateDir)
  const original = instanceConfig(stateDir)
  const checkIdentity = () => {
    const current = instanceConfig(stateDir)
    if (current.instanceId !== binding.instanceId || canonical(current.repository) !== binding.repository || current.port !== original.port || connection.client.endpoint !== `http://127.0.0.1:${current.port}`) {
      throw Error('实例身份或连接已变化；未继续操作，请重新运行 /superagent setup。')
    }
  }
  checkIdentity()
  let status: Status | undefined
  try {
    status = await connection.client.request('status') as Status
    if (status.protocol !== 1 || status.instanceId !== binding.instanceId) throw Error('Identity mismatch')
  } catch (error) {
    status = undefined
    if (!await stopped(stateDir, original.port)) throw Error(`无法核对当前服务身份（${failureKind(error)}），或实例锁/端口仍被占用；未停止或启动服务。请检查连接及 service.log。`)
  }
  const description = status ? `当前${status.paused ? '已暂停派单' : '允许派单'}；忙碌 Worker：${status.busyWorkers}。` : '服务未运行；将启动此实例并保留原配置。'
  if (!await ctx.ui.confirm(controls.management ? '切换到本地模式并重启' : '重启后台服务', `${controls.management ? '本地模式信任本机所有进程，不要求管理 Token 或 Web 登录；仅监听本机，不适用于多用户共享机器。\n' : ''}仓库：${binding.repository}\n实例：${stateDir}\nWeb：${connection.client.endpoint}\n${description}\n重启会结束 Router/Worker 及其子进程；未完成工作按现有恢复机制处理。保留工单、凭据、模型和暂停状态。是否继续？`)) return
  checkIdentity()
  let start: PreparedStart
  try {
    const change = controls.management ? { mode: controls.management, instanceId: binding.instanceId } : undefined
    start = controls.prepareStart ? await controls.prepareStart(stateDir, change) : await prepareLocalStart(stateDir, change, binding.instanceId)
  }
  catch { throw Error('本地服务 CLI 启动预检失败，未停止当前服务。请构建/安装服务包后重试。') }
  checkIdentity()
  const inform = (message: string) => { try { ctx.ui.notify(message, 'info') } catch { /* UI replacement must not interrupt an already authorized restart. */ } }
  if (status) {
    inform('正在停止后台服务，等待实例锁释放和端口关闭…')
    try { if (start.stop) await start.stop(); else await connection.client.request('shutdown', 'POST') }
    catch { throw Error('停止请求未确认，未执行启动；请检查当前服务状态后再运行 /superagent restart。') }
  }
  const deadline = performance.now() + (controls.waitTimeoutMs ?? 30000)
  while (true) {
    checkIdentity()
    if (await stopped(stateDir, original.port)) break
    if (performance.now() >= deadline) throw Error('服务未完全退出，等待超时；未启动新进程，也未强杀或删除实例锁。请稍后重试 /superagent restart。')
    await sleep(100)
  }
  checkIdentity(); inform('正在启动后台服务并验证实例连接…')
  try { await start() }
  catch { throw Error(`启动未确认，请检查 ${join(stateDir, 'service.log')}，稍后可用 /superagent restart 重试。`) }
  let ready: Status
  try { checkIdentity(); ready = await instanceClient(stateDir, binding.instanceId).request('status') as Status }
  catch (error) { throw Error(`启动后未通过实例连接验证（${failureKind(error)}），服务可能已运行；请检查 ${join(stateDir, 'service.log')}。`) }
  inform(`后台服务重启完成；${ready.paused ? '保持暂停派单' : '当前允许派单'}。\nWeb：${connection.client.endpoint}\n使用 /superagent web 打开控制台。`)
}
