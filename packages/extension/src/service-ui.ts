import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { canonical, instanceConfig, sshBinding, type Connection } from './instances.js'
import { localServiceOperation } from './setup-services.js'
import { sshRequest } from './ssh.js'
import { remoteExpected } from './remote-connections.js'
interface Services { local: typeof localServiceOperation; remote: typeof sshRequest }
const labels = { status: '查看托管状态', plan: '查看注册方案', install: '注册 systemd 用户服务', enable: '启用登录自启', disable: '关闭登录自启', uninstall: '卸载托管（保留数据）' }
const clean = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 4096)
function summary(value: any): string {
  if (value.kind === 'detached') return '当前为独立后台进程，没有系统托管或自动恢复。首版托管支持 Linux systemd 用户服务。'
  if (value.unit) return `systemd 用户服务方案\nUnit：${clean(value.unitName)}\n文件：${clean(value.unitFile)}\n注册后仍需分别启用自启、启动服务。`
  return `托管：systemd 用户服务\nUnit：${clean(value.unitName)}\n状态：${clean(value.active)} / ${clean(value.substate)} · 自动重启次数：${Number(value.restarts) || 0}\n${value.enabled ? '已启用登录自启' : '未启用自启'}；${value.linger === true ? '已开启 linger，可在无登录时运行' : '无登录开机运行需要管理员另行开启 linger（未确认开启）'}。\n/superagent restart 显式启动/重启；service.log 查看输出。`
}
/** Bound, human-only control; neither session discovery nor model tools call this. */
export async function manageService(ctx: ExtensionContext, connection: Connection, requested?: string, services: Services = { local: localServiceOperation, remote: sshRequest }): Promise<void> {
  if (!ctx.hasUI) throw Error('系统托管仅支持交互式用户命令。')
  const binding = connection.binding
  if (!binding) throw Error('系统托管需要明确项目绑定，请先 setup 或 ssh。')
  const invoke = async (action: string, confirmed = false) => {
    if (binding.ssh) {
      const b = sshBinding(binding)
      const result = await services.remote(b.ssh, { operation: 'service', action, stateDir: b.stateDir, expected: remoteExpected(b), ...(confirmed ? { confirmed: true } : {}) }, undefined, { timeoutMs: 75000 })
      if (result?.instanceId !== b.instanceId || !result.service) throw Error('远端托管实例身份已变化。')
      return result.service
    }
    const config = instanceConfig(binding.stateDir)
    if (config.instanceId !== binding.instanceId || canonical(config.repository) !== binding.repository) throw Error('本地托管实例身份已变化。')
    return services.local(binding.stateDir, action, binding.instanceId, confirmed)
  }
  let action = requested
  if (!action) {
    const choice = await ctx.ui.select('系统托管 · Linux systemd 用户服务', Object.values(labels))
    if (!choice) return
    action = Object.entries(labels).find(([, label]) => label === choice)?.[0]
  }
  if (!action || !Object.hasOwn(labels, action)) throw Error('使用 /superagent service [plan|status|install|enable|disable|uninstall]。')
  if (!['status', 'plan'].includes(action)) {
    const plan = await invoke('plan')
    const detail = action === 'install' ? '实例必须先停止。只注册，不启动、不启用自启；崩溃后按 35 秒间隔恢复，5 分钟最多 5 次。' : action === 'enable' ? '只启用登录自启，不启动当前服务；无登录开机运行需要管理员另行开启 linger。' : action === 'disable' ? '只关闭自启，不停止当前服务。' : '实例必须先停止。移除本产品托管，不删除实例、凭据或任务数据。'
    if (!await ctx.ui.confirm(labels[action as keyof typeof labels], `目标：${clean(binding.ssh?.host || '本机')}\n实例：${clean(binding.stateDir)}\nUnit：${clean(plan.unitName)}\n${detail}\nsystemd 停止时会在 30 秒宽限后清理本 unit 子进程。保留模型、工单与暂停状态；仅使用实例凭据和 service.env.json，不继承终端环境。不 sudo、不修改 linger。是否继续？`)) return
  }
  const result = await invoke(action, !['status', 'plan'].includes(action))
  ctx.ui.notify(summary(result), 'info')
}
