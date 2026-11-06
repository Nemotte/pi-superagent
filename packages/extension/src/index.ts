import { randomUUID } from 'node:crypto'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readManagement, type Client } from './client.js'
import { present, taskLabel } from './presentation.js'
import { showConnection } from './connection-ui.js'
import { openWeb } from './web-access.js'
import { secretPanel } from './secret-panel.js'
import { restartService } from './service-control.js'
import { connectionForProject, matchesProject } from './instances.js'
interface Action { action: string; ticketId?: string; text?: string; requestId?: string }
async function run(input: Action, cwd: string, approvals: Set<string>, ctx?: ExtensionContext): Promise<unknown> {
  if (input.action === 'models') throw Error('模型配置仅支持交互式用户命令 /superagent models。')
  if (['ssh', 'connect', 'disconnect', 'start', 'shutdown', 'restart', 'local', 'service'].includes(input.action) && !ctx?.hasUI) throw Error('连接和生命周期操作仅支持交互式用户命令，不能由模型工具调用。')
  if (['open-web', 'token'].includes(input.action) && (!ctx?.hasUI || ctx.mode !== 'tui')) throw Error('此操作仅支持 Pi 终端用户命令，不能由模型工具调用。')
  const connection = await connectionForProject(cwd, undefined, !!ctx?.hasUI && !['restart', 'local', 'start', 'shutdown', 'disconnect', 'web', 'service'].includes(input.action))
  if (!connection) throw Error('当前项目尚未配置 Super-agent，请运行 /superagent setup。')
  if (ctx) showConnection(ctx, connection.client.endpoint, connection.binding?.ssh ? `${connection.binding.ssh.host}:${connection.binding.repository}` : connection.binding?.repository)
  if (input.action === 'service') return (await import('./service-ui.js')).manageService(ctx!, connection, input.text)
  if (['connect', 'disconnect'].includes(input.action)) {
    if (!connection.binding?.ssh) throw Error('当前不是 SSH 绑定；请运行 /superagent ssh。')
    if (input.action === 'disconnect') await (await import('./remote-connections.js')).disconnectRemote(connection.binding)
    ctx!.ui.notify(input.action === 'connect' ? 'SSH 已连接；远端配置和暂停状态不变。' : 'SSH 已断开；远端后台服务继续运行。', 'info'); return
  }
  if (connection.binding?.ssh && ['start', 'restart', 'shutdown'].includes(input.action)) return (await import('./remote.js')).remoteLifecycle(ctx!, connection.binding, input.action as 'start' | 'restart' | 'shutdown')
  if (input.action === 'start' || input.action === 'shutdown') throw Error('此命令用于 SSH 实例。本地启动可用 /superagent restart，停止请使用服务 CLI shutdown。')
  if (input.action === 'restart') return restartService(ctx!, connection)
  if (input.action === 'local') {
    if (connection.binding?.ssh) throw Error('SSH 实例保留 token 管理模式，不能切换成本机免登录模式。')
    return restartService(ctx!, connection, { management: 'local' })
  }
  if (['request', 'followup', 'stop', 'retry', 'open-web', 'token'].includes(input.action) && !await matchesProject(connection)) {
    const status = await connection.client.request('status') as { instanceId?: string }
    const key = JSON.stringify([connection.project, connection.client.endpoint, status.instanceId])
    if (!status.instanceId || !approvals.has(key)) {
      if (!ctx?.hasUI || !status.instanceId) throw Error('当前服务未绑定到此项目；请运行 /superagent setup，或用命令明确确认远程连接。')
      const settings = await connection.client.request('config') as { config?: { repository?: string } }
      if (!settings.config?.repository) throw Error('无法确认服务仓库，请运行 /superagent setup。')
      if (!await ctx.ui.confirm('确认跨项目 / 远程连接', `当前项目：${connection.project}\n目标仓库：${settings.config.repository}\n服务：${connection.client.endpoint}\n允许本次 Pi 会话管理此目标（任务、Web 控制台及凭据）？`)) return { cancelled: true }
      approvals.add(key)
    }
  }
  if (input.action === 'open-web') return openWeb(ctx!, connection.client)
  if (input.action === 'token') {
    const status = await connection.client.request('status') as { management?: string }
    if (status.management === 'local') { ctx!.ui.notify('当前是本地模式，无需管理员令牌，使用 /superagent web 打开控制台。', 'info'); return }
    if (await ctx!.ui.confirm('管理员令牌（高级）', `服务：${connection.client.endpoint}\n令牌拥有此实例的管理权限。将在临时面板中显示，只有按 C 才会复制到系统剪贴板；不会写入聊天。`)) {
      await connection.client.withCredential(value => secretPanel(ctx!, `管理员令牌 · ${connection.client.endpoint}`, value))
    }
    return
  }
  return action(connection.client, input)
}
async function action(client: Client, input: Action): Promise<unknown> {
  if (input.action === 'web') return { webUrl: client.endpoint }
  if (input.action === 'status') return { ...await client.request('status') as object, webUrl: client.endpoint }
  if (input.action === 'workspace') return client.request(input.ticketId ? `tickets/${encodeURIComponent(input.ticketId)}/workspace` : 'workspace')
  if (['tickets', 'sources', 'decisions', 'triggers'].includes(input.action)) return client.request(input.action)
  if (input.action === 'request') {
    if (!input.text?.trim()) throw Error('Task text is required')
    return client.request('tickets', 'POST', { id: input.requestId || randomUUID(), text: input.text })
  }
  if (!input.ticketId) throw Error('Ticket ID is required')
  const path = `tickets/${encodeURIComponent(input.ticketId)}`
  if (input.action === 'show') return client.request(path)
  if (input.action === 'diagnostics') return client.request(`${path}/diagnostics`)
  if (input.action === 'followup') {
    if (!input.text?.trim()) throw Error('Followup text is required')
    return client.request(`${path}/followup`, 'POST', { id: input.requestId || randomUUID(), text: input.text })
  }
  if (['stop', 'retry'].includes(input.action)) return client.request(`${path}/${input.action}`, 'POST')
  throw Error('Use setup, models, restart, local, web [url], token, status, workspace [id], tickets, sources, decisions, triggers, request <text>, show <id>, diagnostics <id>, followup <id> <text>, stop <id>, retry <id>')
}
export default function superagent(pi: ExtensionAPI): void {
  let settingUp = false, restarting = false
  const approvals = new Set<string>()
  const guide = async (ctx: ExtensionContext, mode: 'setup' | 'models' | 'ssh' = 'setup') => {
    if (restarting) { ctx.ui.notify('后台服务正在重启，请等待完成后再配置。', 'warning'); return }
    if (settingUp) { ctx.ui.notify('初始化向导正在运行。', 'warning'); return }
    settingUp = true
    try {
      if (mode === 'ssh') await (await import('./remote.js')).setupRemote(ctx)
      else { const setup = await import('./setup.js'); await (mode === 'models' ? setup.configureModels(ctx) : setup.setup(ctx)) }
    } finally { settingUp = false }
  }
  pi.registerCommand('superagent', { description: 'Initialize/connect this project or control persistent tasks', handler: async (args, ctx) => {
    try {
      let [command, ...rest] = args.trim().split(/\s+/).filter(Boolean)
      if (command === 'setup' || command === 'models' || command === 'ssh') { await guide(ctx, command); return }
      if (!command) {
        if (!ctx.hasUI) { ctx.ui.notify(present('status', await run({ action: 'status' }, ctx.cwd, approvals)), 'info'); return }
        const connection = await connectionForProject(ctx.cwd).catch(() => undefined)
        if (!connection) { await guide(ctx); return }
        showConnection(ctx, connection.client.endpoint, connection.binding?.repository)
        const status = await connection.client.request('status').catch(() => undefined) as { management?: string } | undefined
        const remote = !!connection.binding?.ssh, online = !!status, local = !remote && (status?.management === 'local' || !status && !!connection.binding && readManagement(connection.binding.stateDir) === 'local')
        if (!online) ctx.ui.notify(remote ? 'SSH 未连接；可连接 SSH 或启动远端服务。关闭连接不表示远端服务停止。' : '服务未连接；已绑定的本地实例可选“重启后台服务”，或进入初始化 / 连接设置。', 'info')
        if (online && !await matchesProject(connection)) {
          const choice = await ctx.ui.select('当前环境连接指向其他项目', ['为当前项目初始化 / 连接实例', '查看当前服务（写操作需确认）'])
          if (!choice) return
          if (choice.startsWith('为当前项目')) { await guide(ctx); return }
        }
        const choice = await ctx.ui.select(`Super-agent · ${connection.binding?.repository || connection.project}`, ['查看状态', '查看工单', '提交任务', '配置角色模型', '查看工作区', '打开 Web 控制台', 'Web 地址', ...local ? [] : ['管理员令牌（高级）'], ...remote ? ['连接 SSH', '断开 SSH 连接', '启动远端服务', '停止远端服务'] : [], '重启后台服务', '系统托管', ...local || remote ? [] : ['切换到本地模式'], '初始化 / 连接设置'])
        if (!choice) return
        if (choice === '初始化 / 连接设置') { await guide(ctx); return }
        if (choice === '配置角色模型') { await guide(ctx, 'models'); return }
        command = choice === '查看状态' ? 'status' : choice === '查看工单' ? 'tickets' : choice === '查看工作区' ? 'workspace' : choice === 'Web 地址' || choice === '打开 Web 控制台' ? 'web' : choice === '管理员令牌（高级）' ? 'token' : choice === '重启后台服务' ? 'restart' : choice === '系统托管' ? 'service' : choice === '切换到本地模式' ? 'local' : choice === '连接 SSH' ? 'connect' : choice === '断开 SSH 连接' ? 'disconnect' : choice === '启动远端服务' ? 'start' : choice === '停止远端服务' ? 'shutdown' : 'request'
        if (choice === 'Web 地址') rest = ['url']
        if (command === 'request') {
          const text = await ctx.ui.editor('描述目标、约束和验收条件（不会自动附带前台聊天）')
          if (!text?.trim()) return
          rest = [text]
        }
      }
      if (['restart', 'local', 'connect', 'disconnect', 'start', 'shutdown', 'service'].includes(command)) {
        if (command === 'service' ? rest.length > 1 : rest.length > 0) throw Error('连接和生命周期命令参数无效；service 可带一个托管操作。')
        if (restarting || settingUp) { ctx.ui.notify(restarting ? '后台服务正在重启，请等待完成。' : '初始化向导正在运行，请完成或退出后再重启。', 'warning'); return }
        restarting = true
        try { await run({ action: command, ...(command === 'service' ? { text: rest[0] } : {}) }, ctx.cwd, approvals, ctx) } finally { restarting = false }
        return
      }
      if (command === 'web' && (rest.length > 1 || rest.length === 1 && rest[0] !== 'url')) throw Error('使用 /superagent web 打开并登录，或 /superagent web url 查看地址。')
      if (command === 'token' || command === 'web' && rest.length === 0) {
        await run({ action: command === 'web' ? 'open-web' : 'token' }, ctx.cwd, approvals, ctx); return
      }
      if (command === 'tickets' && ctx.hasUI) {
        const rows = await run({ action: 'tickets' }, ctx.cwd, approvals, ctx) as Array<{ id: string; title: string }>
        if (!rows.length) { ctx.ui.notify(present('tickets', rows), 'info'); return }
        const choices = rows.slice(0, 50).map((t, i) => `${i + 1}. ${taskLabel(t)} · ${t.title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 120)}`)
        const chosen = await ctx.ui.select('选择工单查看摘要（完整沟通记录在 Web）', choices)
        if (!chosen || !choices.includes(chosen)) return
        command = 'show'; rest = [rows[choices.indexOf(chosen)].id]
      }
      const result = await run({ action: command, ...(command === 'request' ? { text: rest.join(' ') } : { ticketId: rest[0], text: rest.slice(1).join(' ') }) }, ctx.cwd, approvals, ctx)
      ctx.ui.notify(present(command, result), 'info')
    } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error') }
  } })
  pi.registerTool({ name: 'superagent', label: 'Super-agent', description: 'Manage persistent tasks on this project’s connected application workspace service. If unconfigured, ask the user to run /superagent setup. Request acceptance is not task completion. stop revokes a ticket; retry is for failed work. Supply a stable requestId when retrying a request or followup.',
    parameters: Type.Object({ action: Type.Union(['status', 'web', 'workspace', 'tickets', 'sources', 'decisions', 'triggers', 'request', 'show', 'diagnostics', 'followup', 'stop', 'retry'].map(v => Type.Literal(v))), ticketId: Type.Optional(Type.String()), text: Type.Optional(Type.String()), requestId: Type.Optional(Type.String()) }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => { const value = await run(args, ctx?.cwd || process.cwd(), approvals); return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: {} } },
  })
  pi.on('session_shutdown', async () => { approvals.clear(); await (await import('./remote-connections.js')).closeRemoteConnections() })
  pi.on('session_start', async (_event, ctx) => {
    approvals.clear()
    ctx.ui.setWidget?.('superagent-connection', undefined)
    try {
      const connection = await connectionForProject(ctx.cwd)
      if (!connection) { ctx.ui.setStatus('superagent', 'SA 未配置 · /superagent'); return }
      showConnection(ctx, connection.client.endpoint, connection.binding?.repository)
      await connection.client.request('status')
      if (!await matchesProject(connection)) ctx.ui.setStatus('superagent', `SA 未绑定此项目 · ${connection.client.endpoint}`)
    } catch { ctx.ui.setStatus('superagent', 'SA offline · /superagent setup') }
  })
}
