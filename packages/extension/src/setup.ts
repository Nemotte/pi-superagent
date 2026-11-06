import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { availablePort, canonical, connectionForProject, instanceClient, instanceConfig, loadBinding, privateStatePath, projectPath, saveBinding, suggestedStateDir, type Binding } from './instances.js'
import { localSetupServices, type SetupServices } from './setup-services.js'
import { loginUI } from './setup-ui.js'
import { showConnection } from './connection-ui.js'
import { selectProject } from './setup-project.js'
import type { Client } from './client.js'
interface ModelChoice { provider: string; id: string; name?: string }
interface Catalog { providers: Array<{ id: string; name: string; methods: string[] }>; models: ModelChoice[] }
interface Settings { revision: number; config: Record<string, unknown> & { repository: string; paused: boolean; routerModel: ModelChoice | null; workerModel: ModelChoice | null } }
const expandPath = (value: string, cwd: string) => resolve(cwd, value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value)
async function chooseModel(ctx: ExtensionContext, catalog: Catalog): Promise<ModelChoice | undefined> {
  const current = ctx.model && catalog.models.find(m => m.provider === ctx.model!.provider && m.id === ctx.model!.id)
  const preferred = current ? `使用当前 Pi 型号：${current.provider}/${current.id}（实例单独认证）` : undefined
  if (preferred) {
    const choice = await ctx.ui.select('Router / Worker 模型', [preferred, '选择其他型号'])
    if (!choice) return
    if (choice === preferred) return current
  }
  const providers = catalog.providers.filter(p => catalog.models.some(m => m.provider === p.id))
  const providerLabels = providers.map(p => `${p.name} (${p.id})`)
  const providerLabel = await ctx.ui.select('选择模型提供商', providerLabels)
  if (!providerLabel) return
  const provider = providers[providerLabels.indexOf(providerLabel)]
  const models = catalog.models.filter(m => m.provider === provider.id)
  const label = await ctx.ui.select('选择该账号支持的型号（目录不保证账号可用）', models.map(m => m.id))
  return models.find(m => m.id === label)
}
export async function setup(ctx: ExtensionContext, services: SetupServices = localSetupServices()): Promise<Binding | undefined> {
  if (!ctx.hasUI) throw Error('请在交互式 Pi 中运行 /superagent setup。')
  const project = await projectPath(ctx.cwd)
  let connected: Binding | undefined
  try { connected = (await connectionForProject(ctx.cwd, services.connections))?.binding } catch { /* setup can repair a stale binding explicitly */ }
  const action = await ctx.ui.select('Super-agent 初始化 / 连接', [...connected ? ['配置当前实例模型（保留工作区）'] : [], '创建或继续配置本地实例', '连接已有实例（保留配置）', '以工作区模式创建（包含当前仓库及嵌套服务）', '通过 SSH 管理远端服务'])
  if (!action) return
  if (action.startsWith('配置当前实例')) return configureModels(ctx, services)
  if (action.startsWith('通过 SSH')) return (await import('./remote.js')).setupRemote(ctx)
  const remember = (stateDir: string) => {
    const config = instanceConfig(stateDir)
    const binding: Binding = { project, stateDir: canonical(stateDir), repository: canonical(config.repository), instanceId: config.instanceId }
    saveBinding(services.connections, binding)
    showConnection(ctx, `http://127.0.0.1:${config.port}`, binding.repository)
    return binding
  }
  const start = async (stateDir: string) => {
    const client = instanceClient(stateDir)
    try { await client.request('status') }
    catch {
      if (!await ctx.ui.confirm('启动后台服务', `实例：${stateDir}\n启动后关闭 Pi，服务仍会运行。`)) return
      await services.cli(stateDir, ['start']); await client.request('status')
    }
    return client
  }
  if (action.startsWith('连接已有')) {
    const value = await ctx.ui.input('已有实例目录（不是仓库目录）', process.env.PI_SUPERAGENT_HOME || join(homedir(), '.pi-superagent', 'default'))
    if (value === undefined || !value.trim()) return
    const stateDir = expandPath(value.trim(), ctx.cwd); const config = instanceConfig(stateDir)
    if (!await ctx.ui.confirm('确认项目连接', `当前项目：${project}\n服务仓库：${config.repository}\n实例：${stateDir}\n不更改现有模型、来源或暂停状态。`)) return
    if (!await start(stateDir)) return
    const binding = remember(stateDir); ctx.ui.notify(`已连接 ${binding.repository}。/superagent 打开任务菜单。`, 'info'); return binding
  }
  const repository = await selectProject(ctx, services, action.startsWith('以工作区'))
  if (!repository) return
  let previous: Binding | undefined
  try { previous = loadBinding(services.connections, project) } catch { /* explicit setup can replace a stale binding after confirmation */ }
  const suggestion = previous && !previous.ssh && previous.repository === repository.repository ? previous.stateDir : suggestedStateDir(repository.repository) + (repository.members ? '-workspace' : '')
  const value = await ctx.ui.input('实例数据目录（回车使用建议值）', suggestion)
  if (value === undefined) return
  const stateDir = await privateStatePath(expandPath(value.trim() || suggestion, ctx.cwd))
  const inside = relative(repository.repository, stateDir)
  if (repository.members && (!inside || inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) throw Error('工作区实例包含凭据，请选择工作区根目录外的数据目录。')
  const existing = existsSync(join(stateDir, 'config.json'))
  if (existing && canonical(instanceConfig(stateDir).repository) !== repository.repository) throw Error('该实例属于另一个仓库，请选择新实例目录，或使用“连接已有实例”。')
  if (existing) {
    const saved = instanceConfig(stateDir).workspace
    if (JSON.stringify(saved?.repositories.map(r => r.path).sort() || null) !== JSON.stringify(repository.members?.map(r => r.path).sort() || null)) throw Error('该实例的工作区成员已固定；请保留原选择，或选择新实例目录。')
  }
  const port = existing ? instanceConfig(stateDir).port : await availablePort()
  if (!await ctx.ui.confirm(existing ? '继续配置现有实例' : '创建本地实例', `${repository.members ? `工作区：${repository.repository}\n${repository.members.length} 个仓库：\n${repository.members.map(r => r.path).join('\n')}` : `仓库：${repository.repository}\nHEAD：${repository.head!.slice(0, 12)}`}\n实例：${stateDir}\nWeb：http://127.0.0.1:${port}\nWorker 在独立 worktree 中执行；${repository.dirty ? '检测到未提交改动，它们不会进入任务目录。' : '使用已提交的 HEAD。'}\n${existing ? '不会覆盖实例；模型配置阶段保持暂停。' : '1 个 Worker，先暂停派单；可直接通过 Pi/Web 提交任务。'}`)) return
  if (!existing) await services.cli(stateDir, ['init', '--repo', repository.repository, ...(repository.members ? ['--workspace', ...repository.members.flatMap(r => ['--member', r.path])] : []), '--port', String(port), '--paused', '--max-workers', '1'])
  const binding = remember(stateDir)
  const client = await start(stateDir)
  if (!client) return binding
  return configureBoundModels(ctx, services, binding, client, 'both', existing)
}
export async function configureModels(ctx: ExtensionContext, services: SetupServices = localSetupServices()): Promise<Binding | undefined> {
  if (!ctx.hasUI) throw Error('请在交互式 Pi 中运行 /superagent models。')
  const connection = await connectionForProject(ctx.cwd, services.connections, true)
  const binding = connection?.binding
  if (!binding) throw Error('请先用 /superagent setup 或 /superagent ssh 绑定实例，再配置模型。')
  if (binding.ssh) services = (await import('./remote.js')).remoteModelServices(binding, services.connections)
  const client = connection.client
  showConnection(ctx, client.endpoint, binding.repository)
  await client.request('status')
  const choice = await ctx.ui.select('配置哪些执行角色？', ['Router 和 Worker 使用同一型号', '仅 Router', '仅 Worker'])
  if (!choice) return binding
  return configureBoundModels(ctx, services, binding, client, choice === '仅 Router' ? 'router' : choice === '仅 Worker' ? 'worker' : 'both')
}
async function configureBoundModels(ctx: ExtensionContext, services: SetupServices, binding: Binding, client: Client, role: 'both' | 'router' | 'worker', offerKeep = false): Promise<Binding> {
  const stateDir = binding.stateDir
  let settings = await client.request('config') as Settings
  if (offerKeep && settings.config.routerModel && settings.config.workerModel) {
    const choice = await ctx.ui.select('实例已有模型配置（新型号用于新启动的 Agent；已有进程需重启服务）', ['保留现有配置，完成连接', '暂停派单并重新配置模型'])
    if (choice !== '暂停派单并重新配置模型') return binding
  }
  if (!settings.config.paused) {
    if (!await ctx.ui.confirm('暂停派单后配置', '将暂停此实例的派单，再进行模型配置。是否继续？')) return binding
    settings = await client.request('config', 'PUT', { ...settings, config: { ...settings.config, paused: true } }) as Settings
  }
  const catalog = await services.model(stateDir, { operation: 'catalog' }) as Catalog
  const model = await chooseModel(ctx, catalog)
  if (!model) return binding
  const ready = await services.model(stateDir, { operation: 'check', provider: model.provider })
  if (!ready.ready) {
    const provider = catalog.providers.find(p => p.id === model.provider)!
    const labels: string[] = provider.methods.map(m => m === 'oauth' ? '浏览器 / 订阅登录（OAuth）' : '输入实例 API key（遮罩）')
    const method = await ctx.ui.select(`为此实例单独认证：${provider.name}`, [...labels, '稍后配置，保持暂停'])
    const index = method ? labels.indexOf(method) : -1
    if (index < 0) { ctx.ui.notify(`实例已保存且暂停。稍后运行 /superagent setup 继续；凭据目录：${join(stateDir, 'agent')}`, 'info'); return binding }
    const interaction = loginUI(ctx)
    const auth = await services.model(stateDir, { operation: 'login', provider: model.provider, method: provider.methods[index] }, interaction).finally(() => interaction.dispose?.())
    if (!auth.ready) throw Error('认证尚未就绪，实例保持暂停。')
  }
  let verified = false
  if (await ctx.ui.confirm('验证模型连接', `向 ${model.provider}/${model.id} 发起一次简短请求，会使用少量模型额度。失败不自动重试。`)) {
    await services.model(stateDir, { operation: 'probe', provider: model.provider, model: model.id }); verified = true
  }
  // Optimistic revision prevents overwriting settings changed by Web/CLI during login.
  const selected = { provider: model.provider, id: model.id }
  settings = await client.request('config', 'PUT', { ...settings, config: { ...settings.config, ...(role !== 'worker' ? { routerModel: selected } : {}), ...(role !== 'router' ? { workerModel: selected } : {}) } }) as Settings
  if (!settings.config.routerModel || !settings.config.workerModel) { ctx.ui.notify('此角色的模型已保存；另一角色尚未配置，保持暂停。运行 /superagent models 继续。', 'info'); return binding }
  const resume = await ctx.ui.confirm('开始接收任务', `${verified ? '所选型号的模型请求验证通过。' : '所选提供商认证就绪，尚未验证模型推理。'}\n是否恢复派单？已有待处理请求也可能开始运行。新型号用于新启动的 Agent；已有进程需显式重启服务。`)
  if (resume) await client.request('config', 'PUT', { ...settings, config: { ...settings.config, paused: false } })
  ctx.ui.notify(`实例已配置${resume ? '并恢复派单' : '，保持暂停'}。\n仓库：${binding.repository}\nWeb：${client.endpoint}\n使用 /superagent web 打开控制台；/superagent models 调整角色型号或认证。\n使用 /superagent request <任务描述> 提交任务。`, 'info')
  return binding
}
