import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { inspectRepository } from './instances.js'
import type { SetupServices } from './setup-services.js'
export interface WorkspaceDiscovery { root: string; repositories: Array<{ id: string; path: string; head: string; dirty: boolean }>; unavailable: Array<{ path: string; reason: string }> }
export interface ProjectSelection { repository: string; head?: string; dirty: boolean; members?: Array<{ id: string; path: string }> }
export async function selectProject(ctx: ExtensionContext, services: SetupServices, forceWorkspace: boolean): Promise<ProjectSelection | undefined> {
  let failure: unknown
  const single = await inspectRepository(ctx.cwd).catch(error => { failure = error; return undefined })
  if (single && !forceWorkspace) return single
  if (!services.discover) throw Error(`无法发现工作区，请更新服务包。${String(failure || '')}`)
  const external = async () => {
    const value = (await ctx.ui.input('本地 Git 仓库目录（至少一次提交）', ctx.cwd))?.trim()
    if (!value) return
    return inspectRepository(resolve(ctx.cwd, value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value))
  }
  const catalog = await services.discover(forceWorkspace && single ? single.repository : ctx.cwd)
  if (catalog.unavailable.length) ctx.ui.notify('以下目录不可用，不会自动下载或提交：\n' + catalog.unavailable.map(r => `${r.path}: ${r.reason}`).join('\n'), 'warning')
  if (!catalog.repositories.length) { ctx.ui.notify(`没有可用的已提交 Git 仓库。${String(failure || '')}`, 'warning'); return external() }
  if (!forceWorkspace) {
    const choice = await ctx.ui.select('选择应用工作区或单个仓库', [`整个工作区（${catalog.repositories.length} 个仓库）`, ...catalog.repositories.map(r => r.path), '输入其他目录'])
    if (!choice) return
    if (choice === '输入其他目录') return external()
    if (!choice.startsWith('整个工作区')) return inspectRepository(join(catalog.root, choice))
  }
  const selected = new Set(catalog.repositories.map(r => r.path))
  while (true) {
    const labels = catalog.repositories.map(r => `${selected.has(r.path) ? '✓' : '○'} ${r.path}${r.dirty ? '（原目录有改动）' : ''}`)
    const finish = `确认选择（${selected.size} 个仓库）`
    const choice = await ctx.ui.select('接入工作区的仓库（选择条目可勾选/取消）', [finish, ...labels])
    if (!choice) return
    if (choice === finish) { if (selected.size) break; ctx.ui.notify('至少选择一个仓库。', 'warning'); continue }
    const member = catalog.repositories[labels.indexOf(choice)]
    if (member) { if (selected.has(member.path)) selected.delete(member.path); else selected.add(member.path) }
  }
  const members = catalog.repositories.filter(r => selected.has(r.path))
  return { repository: catalog.root, dirty: members.some(r => r.dirty), members: members.map(({ id, path }) => ({ id, path })) }
}
