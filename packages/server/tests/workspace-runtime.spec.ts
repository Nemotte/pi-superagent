import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { git, nestedWorkspace } from './fixtures/workspace.js'
const resources: Array<{ dir: string; runtime: Runtime }> = []
afterEach(async () => { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } })
async function fixture(selected?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sa workspace runtime ')), root = join(dir, 'app'); mkdirSync(root)
  const repos = nestedWorkspace(root), state = join(dir, 'state')
  initialize(state, { repository: root, workspace: { repositories: repos.members.filter(m => !selected || selected.includes(m.id)) } })
  const messages: any[] = []; const driver = { send: async (target: any, delivery: any) => { messages.push({ target, delivery }) }, stop: async () => {}, close: async () => {} }
  const runtime = new Runtime(state, driver); resources.push({ dir, runtime })
  return { dir, root, repos, state, runtime, messages, driver }
}
async function accept(f: Awaited<ReturnType<typeof fixture>>) {
  const trigger = f.runtime.submit({ id: 'cross-repo', text: 'Update frontend and exam API together; verify compatibility.' }); await f.runtime.tick()
  const decision: any = await f.runtime.tool({ role: 'router', key: 'router' }, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Full stack change', scope: 'Frontend and exam compatibility', reason: 'Explicit request' })
  await f.runtime.tick(); return f.runtime.store.tickets.get(decision.ticketId)!
}
it('launches one worker over multiple repositories and requires a complete per-repository ready report', async () => {
  const f = await fixture(); const ticket = await accept(f)
  const target = f.messages.find(m => m.target.role === 'worker')?.target
  expect(target, JSON.stringify(f.runtime.overview().problems)).toBeDefined()
  expect(target.workspace.repositories).toHaveLength(3)
  const work = ticket.execution!.directory
  writeFileSync(join(work, 'frontends/portal/README.md'), 'changed front'); writeFileSync(join(work, 'backend/exam/README.md'), 'changed exam')
  await expect(f.runtime.tool(target, 'report', { state: 'ready', summary: 'done' })).rejects.toThrow(/repositories|repository/i)
  await expect(f.runtime.tool(target, 'report', { state: 'ready', summary: 'done', repositories: [{ id: 'portal', summary: 'changed', checks: [] }] })).rejects.toThrow(/exam/)
  const repositories = ['portal', 'exam'].map(id => ({ id, summary: 'Compatible change', checks: ['Verified file content; build not run'] }))
  await f.runtime.tool(target, 'report', { state: 'ready', summary: 'Frontend and exam updated together', repositories })
  expect(f.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('completed')
  expect((await (f.runtime as any).workspaceView(ticket.id)).report.repositories).toEqual(repositories)
  expect(readFileSync(join(f.repos.front, 'README.md'), 'utf8')).toBe('frontend\n')
})
it('recovers the same ticket worktrees and saved baseline after service restart and source HEAD changes', async () => {
  const f = await fixture(); const ticket = await accept(f)
  expect(f.messages.some(m => m.target.role === 'worker')).toBe(true)
  const initial: any = await (f.runtime as any).workspaceView(ticket.id)
  writeFileSync(join(ticket.execution!.directory, 'frontends/portal/README.md'), 'unfinished work')
  await f.runtime.close()
  writeFileSync(join(f.repos.front, 'README.md'), 'new source'); git(f.repos.front, 'add', '.'); git(f.repos.front, 'commit', '-m', 'source advanced')
  f.runtime = new Runtime(f.state, f.driver); resources.find(r => r.dir === f.dir)!.runtime = f.runtime
  await f.runtime.tick()
  const recovered: any = await (f.runtime as any).workspaceView(ticket.id)
  expect(recovered.repositories.map((r: any) => r.baseHead)).toEqual(initial.repositories.map((r: any) => r.baseHead))
  expect(readFileSync(join(ticket.execution!.directory, 'frontends/portal/README.md'), 'utf8')).toBe('unfinished work')
  expect(f.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
})
it('permits an explicitly selected child through an unselected parent repository', async () => {
  const f = await fixture(['exam']), router = { role: 'router' as const, key: 'router' }
  expect(await f.runtime.tool(router, 'read', { kind: 'file', path: 'backend/exam/README.md' })).toMatchObject({ text: 'new exam head\n' })
  expect(await f.runtime.tool(router, 'read', { kind: 'directory', path: 'backend' })).toMatchObject({ items: ['exam'] })
  await expect(f.runtime.tool(router, 'read', { kind: 'file', path: 'backend/pom.xml' })).rejects.toThrow(/selected/)
})
it('keeps workspace membership immutable and restricts host reads to selected repositories', async () => {
  const f = await fixture(['portal', 'backend']); const settings = f.runtime.settings()
  expect(() => f.runtime.saveSettings({ ...settings.config, workspace: { repositories: f.repos.members } }, settings.revision)).toThrow(/workspace|Workspace/)
  const router = { role: 'router' as const, key: 'router' }
  expect(await f.runtime.tool(router, 'read', { kind: 'workspace' })).toMatchObject({ total: 2 })
  expect(await f.runtime.tool(router, 'read', { kind: 'file', path: 'frontends/portal/README.md' })).toMatchObject({ text: 'frontend\n' })
  await expect(f.runtime.tool(router, 'read', { kind: 'file', path: 'backend/exam/README.md' })).rejects.toThrow(/registered|selected/i)
  const ticket = await accept(f), target = f.messages.find(m => m.target.role === 'worker').target
  expect(await f.runtime.tool(target, 'read', { kind: 'workspace' })).toMatchObject({ ticketId: ticket.id, total: 2 })
  await expect(f.runtime.tool(target, 'read', { kind: 'workspace', id: 'another-ticket' })).rejects.toThrow(/own ticket/i)
})
