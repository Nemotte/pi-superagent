import { basename, posix } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { availablePort, connectionsDir, loadBinding, pathKey, projectPath, saveBinding, sshBinding, type Binding } from './instances.js'
import { remotePath, sshRequest, validateSsh } from './ssh.js'
import { connectRemote, disconnectRemote, remoteEndpoint, remoteExpected } from './remote-connections.js'
import { showConnection } from './connection-ui.js'
import type { SetupServices } from './setup-services.js'
interface RemoteInfo { protocol: number; instanceId: string; repository: string; stateDir: string; port: number; management: string; online: boolean; status?: { paused: boolean; busyWorkers: number } }
interface Services { connections: string; request: typeof sshRequest; connect: typeof connectRemote; disconnect: typeof disconnectRemote }
const defaults = (): Services => ({ connections: connectionsDir(), request: sshRequest, connect: connectRemote, disconnect: disconnectRemote })
function info(value: any): RemoteInfo {
  if (!value || value.protocol !== 1 || typeof value.instanceId !== 'string' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || typeof value.online !== 'boolean') throw Error('远端返回了无效实例信息，请更新两侧服务包/插件。')
  remotePath(value.repository); remotePath(value.stateDir)
  if (value.management !== 'token') throw Error('SSH 实例需要 token 管理模式；请在远端停止服务后显式运行 management token，再连接。')
  return value
}
function verify(binding: Binding, value: any): RemoteInfo {
  const current = info(value), expected = remoteExpected(binding)
  if (current.instanceId !== expected.instanceId || current.repository !== expected.repository || current.port !== expected.port || current.stateDir !== binding.stateDir) throw Error('远端实例身份已变化；请重新运行 /superagent ssh。')
  return current
}
export async function setupRemote(ctx: ExtensionContext, services: Services = defaults()): Promise<Binding | undefined> {
  if (!ctx.hasUI) throw Error('SSH 配置需要交互式用户命令 /superagent ssh。')
  const project = await projectPath(ctx.cwd)
  const host = await ctx.ui.input('SSH 主机别名或 user@host（先在终端确认主机指纹和免交互认证）')
  if (!host?.trim()) return
  const node = await ctx.ui.input('远端 Node 命令或绝对路径（Node 24+）', 'node')
  if (node === undefined) return
  const cliPath = await ctx.ui.input('远端服务 CLI 绝对路径（已安装服务包的 dist/cli.js）')
  if (!cliPath?.trim()) return
  const target = validateSsh({ host: host.trim(), node: node.trim() || 'node', cliPath: cliPath.trim() })
  if (!await ctx.ui.confirm('连接 SSH 服务器', `目标：${target.host}\nNode：${target.node}\n服务包：${target.cliPath}\n将检查远端环境；不安装软件、不上传本机代码或凭据。使用已有 known_hosts 和 SSH 配置，禁止 agent forwarding。是否继续？`)) return
  const env = await services.request(target, { operation: 'environment' })
  if (env?.protocol !== 1) throw Error('远端控制桥协议不兼容。')
  const home = remotePath(env.home)
  const action = await ctx.ui.select('远端实例', ['连接已有实例（保留配置）', '创建远端单仓库实例', '创建远端多仓库工作区'])
  if (!action) return
  let repository: string | undefined, members: string[] | undefined
  if (!action.startsWith('连接')) {
    const value = await ctx.ui.input('远端仓库 / 工作区绝对路径（已有 checkout，不上传本机文件）')
    if (!value?.trim()) return
    repository = remotePath(value.trim())
    if (action.includes('多仓库')) {
      const found = await services.request(target, { operation: 'discover', repository })
      if (!Array.isArray(found?.repositories) || !found.repositories.length || found.repositories.length > 32) throw Error('没有可用的远端仓库成员；请在远端检查 checkout 和 HEAD。')
      const selected = new Set<number>(found.repositories.map((_: unknown, i: number) => i))
      while (true) {
        const labels = found.repositories.map((r: any, i: number) => `${selected.has(i) ? '[x]' : '[ ]'} ${String(r.path).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)}`)
        const choice = await ctx.ui.select('选择远端工作区成员', ['确认成员', ...labels])
        if (!choice) return
        if (choice === '确认成员') break
        const index = labels.indexOf(choice); if (index >= 0) { if (selected.has(index)) selected.delete(index); else selected.add(index) }
      }
      if (!selected.size) throw Error('至少选择一个仓库成员。')
      members = [...selected].sort((a, b) => a - b).map(i => found.repositories[i].path)
    }
  }
  const suggestion = posix.join(home, '.pi-superagent', `${basename(project).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40)}-${pathKey(project).slice(0, 8)}-remote`)
  const state = await ctx.ui.input('远端实例数据目录（绝对路径，位于工作区之外）', suggestion)
  if (state === undefined) return
  const stateDir = remotePath(state.trim() || suggestion)
  let current: RemoteInfo
  if (repository) {
    const port = await availablePort()
    if (!await ctx.ui.confirm('创建远端实例', `主机：${target.host}\n仓库：${repository}\n${members ? `成员：\n${members.join('\n')}\n` : ''}实例：${stateDir}\n端口：${port}（本机转发使用同端口）\ntoken 管理、单 Worker、暂停派单。使用远端已提交 HEAD 的隔离 worktree，不包含未提交文件。是否创建？`)) return
    current = info(await services.request(target, { operation: 'init', repository, stateDir, port, ...(members ? { members } : {}) }))
  } else current = info(await services.request(target, { operation: 'inspect', stateDir }))
  if (!await ctx.ui.confirm('确认远端项目绑定', `本机入口：${project}\n远端：${target.host}:${current.repository}\n实例：${current.stateDir}\n身份：${current.instanceId}\n任务在远端执行；不改变已有模型、来源或暂停状态。是否绑定？`)) return
  const binding = sshBinding({ project, repository: current.repository, stateDir: current.stateDir, instanceId: current.instanceId, ssh: { ...target, port: current.port } })
  let previous: Binding | undefined
  try { previous = loadBinding(services.connections, project) } catch { /* the confirmed setup can replace a stale binding */ }
  if (previous?.ssh) await services.disconnect(previous)
  saveBinding(services.connections, binding)
  showConnection(ctx, remoteEndpoint(binding), `${target.host}:${binding.repository}`)
  if (!current.online) {
    if (!await ctx.ui.confirm('启动远端后台服务', `主机：${target.host}\n实例：${binding.stateDir}\n关闭 Pi/断开 SSH 后服务继续运行。是否启动？`)) return binding
    current = verify(binding, await services.request(target, { operation: 'start', stateDir: binding.stateDir, expected: remoteExpected(binding) }, undefined, { timeoutMs: 75000 }))
  }
  if (!current.online) throw Error('远端启动未确认；请检查远端 service.log，再用 /superagent start。')
  await services.connect(binding)
  ctx.ui.notify(`已连接远端 ${target.host}:${binding.repository}；${current.status?.paused ? '保持暂停派单' : '当前允许派单'}。\n/superagent models 配置远端角色模型；/superagent web 打开控制台。\n/superagent disconnect 只断开连接，不停止服务。`, 'info')
  return binding
}
export async function remoteLifecycle(ctx: ExtensionContext, input: Binding, action: 'start' | 'restart' | 'shutdown', services: Services = defaults()): Promise<void> {
  if (!ctx.hasUI) throw Error('远端生命周期操作需要交互式用户确认。')
  const binding = sshBinding(input), current = verify(binding, await services.request(binding.ssh, { operation: 'inspect', stateDir: binding.stateDir }))
  const verb = action === 'start' ? '启动' : action === 'restart' ? '重启' : '停止'
  if (!await ctx.ui.confirm(`${verb}远端服务`, `主机：${binding.ssh.host}\n仓库：${binding.repository}\n实例：${binding.stateDir}\n${current.online ? `${current.status?.paused ? '已暂停派单' : '允许派单'}；忙碌 Worker：${current.status?.busyWorkers ?? '未知'}` : '服务未连接'}\n${action === 'start' ? '已有服务运行时保持原状。' : '将结束运行中的 Agent/子进程；未完成工作按恢复机制处理。'}保留配置、凭据、工单和暂停状态。是否继续？`)) return
  await services.disconnect(binding)
  const result = verify(binding, await services.request(binding.ssh, { operation: action, stateDir: binding.stateDir, expected: remoteExpected(binding) }, undefined, { timeoutMs: 75000 }))
  if (action !== 'shutdown') { if (!result.online) throw Error('远端启动未确认，请检查 service.log。'); await services.connect(binding) }
  else if (result.online) throw Error('远端停止未确认，请检查实例锁及端口。')
  ctx.ui.notify(`远端服务已${verb}；${action === 'shutdown' ? '任务数据保留' : result.status?.paused ? '保持暂停派单' : '当前允许派单'}。`, 'info')
}
export function remoteModelServices(binding: Binding, directory = connectionsDir()): SetupServices {
  const b = sshBinding(binding)
  return { connections: directory,
    async cli() { throw Error('远端服务生命周期请使用 /superagent start 或 restart。') },
    async model(_stateDir, request, ui) {
      return sshRequest(b.ssh, { operation: 'model', stateDir: b.stateDir, expected: remoteExpected(b), request }, ui, { timeoutMs: request.operation === 'login' ? 360000 : 45000 })
    },
  }
}
