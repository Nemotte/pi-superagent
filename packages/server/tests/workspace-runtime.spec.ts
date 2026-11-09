import { afterEach, expect, it } from 'vitest'
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { git, nestedWorkspace } from './fixtures/workspace.js'
const resources: Array<{ dir: string; runtime: Runtime }> = []
afterEach(async () => { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } })
async function fixture(selected?: string[]) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa workspace runtime '))), root = join(dir, 'app'); mkdirSync(root)
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
it('moves a paused ticket to existing repositories only after confirming a fresh plan, preserving branches and dirty files', { timeout: 60000 }, async () => {
  const f = await fixture(), ticket = await accept(f)
  const oldDirectory = ticket.execution!.directory
  for (const repo of [f.repos.front, f.repos.back, f.repos.child]) git(repo, 'switch', '-c', 'fix/existing')
  rmSync(join(f.repos.front, 'README.md'))
  const before = git(f.repos.front, 'status', '--porcelain')
  const runtime = f.runtime as any
  expect(runtime.executionPlan).toBeTypeOf('function')
  const plan = await runtime.executionPlan(ticket.id)
  await expect(runtime.useExistingExecution(ticket.id, { confirmed: true, planId: plan.planId })).rejects.toThrow(/paused/i)
  const settings = runtime.settings(); runtime.saveSettings({ ...settings.config, paused: true }, settings.revision)
  await expect(runtime.useExistingExecution(ticket.id, { confirmed: false, planId: plan.planId })).rejects.toThrow(/confirm/i)
  await expect(runtime.useExistingExecution(ticket.id, { confirmed: true, planId: 'stale' })).rejects.toThrow(/changed|stale/i)
  await runtime.useExistingExecution(ticket.id, { confirmed: true, planId: plan.planId })
  expect(runtime.store.tickets.get(ticket.id).execution.directory).toBe(f.root)
  const { lockExistingExecution } = await import('../src/existing-execution.js')
  expect(() => lockExistingExecution(plan)).toThrow(/busy/)
  await runtime.tick() // an obsolete stop effect must not release the newly reserved original checkout
  expect(() => lockExistingExecution(plan)).toThrow(/busy/)
  await expect(runtime.useExistingExecution(ticket.id, { confirmed: true, planId: plan.planId })).resolves.toMatchObject({ changed: false })
  expect(readFileSync(join(oldDirectory, 'frontends/portal/README.md'), 'utf8')).toBe('frontend\n')
  const paused = runtime.settings(); runtime.saveSettings({ ...paused.config, paused: false }, paused.revision)
  f.messages.length = 0
  for (let i = 0; i < 60 && !f.messages.some(m => m.target.role === 'worker'); i++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 25)) }
  const target = f.messages.find(m => m.target.role === 'worker')?.target
  expect(target?.cwd, JSON.stringify(runtime.overview().problems)).toBe(f.root)
  expect(target.instructions).toContain('fix/existing'); expect(target.sessionDir).toContain('existing')
  for (const repo of [f.repos.front, f.repos.back, f.repos.child]) expect(git(repo, 'branch', '--show-current')).toBe('fix/existing')
  expect(git(f.repos.front, 'status', '--porcelain')).toBe(before)
  expect(await runtime.workspaceView(ticket.id)).toMatchObject({ executionMode: 'existing', executionDirectory: f.root })
  git(f.repos.front, 'switch', '-c', 'unexpected')
  await expect(runtime.tool(target, 'report', { state: 'ready', summary: 'done', repositories: [] })).rejects.toThrow(/branch/i)
})
it('retains existing execution across restart and rejects stale branch previews before changing a ticket', { timeout: 60000 }, async () => {
  const f = await fixture(), ticket = await accept(f), runtime = f.runtime as any
  const settings = runtime.settings(); runtime.saveSettings({ ...settings.config, paused: true }, settings.revision)
  const stale = await runtime.executionPlan(ticket.id)
  git(f.repos.front, 'switch', '-c', 'new-branch')
  await expect(runtime.useExistingExecution(ticket.id, { confirmed: true, planId: stale.planId })).rejects.toThrow(/changed/)
  expect(runtime.store.tickets.get(ticket.id).execution.directory).not.toBe(f.root)
  const plan = await runtime.executionPlan(ticket.id)
  await runtime.useExistingExecution(ticket.id, { confirmed: true, planId: plan.planId })
  await runtime.close()
  const { lockExistingExecution } = await import('../src/existing-execution.js')
  const unlock = lockExistingExecution(plan); unlock()
  f.runtime = new Runtime(f.state, f.driver); resources.find(r => r.dir === f.dir)!.runtime = f.runtime
  expect(await f.runtime.workspaceView(ticket.id)).toMatchObject({ executionMode: 'existing', executionDirectory: f.root })
  const restored = f.runtime.settings(); f.runtime.saveSettings({ ...restored.config, paused: false }, restored.revision)
  f.messages.length = 0
  for (let i = 0; i < 60 && !f.messages.some(m => m.target.role === 'worker'); i++) { await f.runtime.tick(); await new Promise(resolve => setTimeout(resolve, 25)) }
  expect(f.messages.find(m => m.target.role === 'worker')?.target.cwd).toBe(f.root)
  expect(() => lockExistingExecution(plan)).toThrow(/busy/)
})
it('waits for an in-flight execution change on shutdown without committing it or leaking repository locks', { timeout: 60000 }, async () => {
  const f = await fixture(), ticket = await accept(f), runtime = f.runtime as any
  const settings = runtime.settings(); runtime.saveSettings({ ...settings.config, paused: true }, settings.revision)
  const plan = await runtime.executionPlan(ticket.id)
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  f.driver.stop = async () => { reached(); await gate }
  const operation = runtime.useExistingExecution(ticket.id, { confirmed: true, planId: plan.planId })
  const rejected = expect(operation).rejects.toThrow(/stopping/)
  await entered
  let closed = false
  const closing = runtime.close().then(() => { closed = true })
  await new Promise(resolve => setTimeout(resolve, 10)); expect(closed).toBe(false)
  release(); await rejected; await closing
  const { lockExistingExecution } = await import('../src/existing-execution.js')
  lockExistingExecution(plan)()
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
