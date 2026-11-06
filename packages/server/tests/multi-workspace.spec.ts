import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, nestedWorkspace, repository } from './fixtures/workspace.js'
const mod = await import('../src/multi-workspace.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'sa assemble 中文 ')); dirs.push(dir); const root = join(dir, 'app'); mkdirSync(root); return { dir, root, ...nestedWorkspace(root) } }
it('assembles one ticket workspace across frontend, parent and nested gitlink repositories', async () => {
  expect(mod.captureWorkspace).toBeTypeOf('function'); const f = fixture(); const work = join(f.dir, 'work')
  writeFileSync(join(f.child, 'untracked.txt'), 'original-only')
  const snapshot = await mod.captureWorkspace(f.root, { repositories: f.members })
  await mod.prepareWorkspace(snapshot, work, 'task-one')
  expect(readFileSync(join(work, 'frontends/portal/README.md'), 'utf8')).toBe('frontend\n')
  expect(readFileSync(join(work, 'backend/exam/README.md'), 'utf8')).toBe('new exam head\n')
  expect(existsSync(join(work, 'backend/exam/untracked.txt'))).toBe(false)
  expect(snapshot.instructions).toContain('Workspace: coordinate')
  const statuses = await mod.workspaceStatus(snapshot, work, 'task-one')
  expect(statuses.every((s: any) => s.changed === false)).toBe(true)
  expect(statuses.find((s: any) => s.id === 'backend').mounts).toContainEqual(expect.objectContaining({ path: 'exam', recorded: f.recorded, mounted: git(f.child, 'rev-parse', 'HEAD') }))
  expect(git(f.front, 'branch', '--show-current')).not.toBe('pi-superagent/task-one')
})
it('recovers a partially assembled workspace using pinned heads after original repositories advance', async () => {
  expect(mod.captureWorkspace).toBeTypeOf('function'); const f = fixture(); const work = join(f.dir, 'work')
  const snapshot = await mod.captureWorkspace(f.root, { repositories: f.members })
  mkdirSync(join(work, 'frontends/portal'), { recursive: true }); writeFileSync(join(work, 'frontends/portal/blocker'), 'keep')
  await expect(mod.prepareWorkspace(snapshot, work, 'partial')).rejects.toThrow()
  expect(git(join(work, 'backend/exam'), 'branch', '--show-current')).toBe('pi-superagent/partial')
  rmSync(join(work, 'frontends/portal'), { recursive: true, force: true })
  writeFileSync(join(f.front, 'README.md'), 'new source\n'); git(f.front, 'add', '.'); git(f.front, 'commit', '-m', 'advance source')
  await mod.prepareWorkspace(snapshot, work, 'partial')
  writeFileSync(join(work, 'frontends/portal/README.md'), 'task changes\n')
  await mod.prepareWorkspace(snapshot, work, 'partial')
  expect(readFileSync(join(work, 'frontends/portal/README.md'), 'utf8')).toBe('task changes\n')
  expect(git(join(work, 'frontends/portal'), 'rev-parse', 'HEAD')).toBe(snapshot.repositories.find((r: any) => r.id === 'portal').head)
  const statuses = await mod.workspaceStatus(snapshot, work, 'partial')
  expect(statuses.find((r: any) => r.id === 'portal')).toMatchObject({ changed: true, files: ['README.md'] })
})
it('refuses symlink destinations and worktrees belonging to a different ticket', async () => {
  expect(mod.captureWorkspace).toBeTypeOf('function'); const f = fixture(); const work = join(f.dir, 'work'); mkdirSync(work)
  const snapshot = await mod.captureWorkspace(f.root, { repositories: f.members })
  symlinkSync(f.back, join(work, 'backend'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(mod.prepareWorkspace(snapshot, work, 'task-two')).rejects.toThrow(/symlink/i)
  rmSync(join(work, 'backend')); await mod.prepareWorkspace(snapshot, work, 'task-two')
  await expect(mod.prepareWorkspace(snapshot, work, 'other-ticket')).rejects.toThrow(/different|ticket/i)
})
it('refuses a redirected execution parent', async () => {
  const f = fixture(), destination = join(f.dir, 'destination'); mkdirSync(destination)
  const snapshot = await mod.captureWorkspace(f.root, { repositories: f.members })
  symlinkSync(destination, join(f.dir, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(mod.prepareWorkspace(snapshot, join(f.dir, 'redirect/task'), 'redirected')).rejects.toThrow(/symlink/i)
})
it('ignores inherited Git repository overrides when assembling the worktrees', async () => {
  const f = fixture(), snapshot = await mod.captureWorkspace(f.root, { repositories: f.members })
  const foreign = join(f.dir, 'foreign'); repository(foreign)
  vi.stubEnv('GIT_DIR', join(foreign, '.git'))
  try { await mod.prepareWorkspace(snapshot, join(f.dir, 'safe'), 'clean-env') } finally { vi.unstubAllEnvs() }
  expect(readFileSync(join(f.dir, 'safe/frontends/portal/README.md'), 'utf8')).toBe('frontend\n')
})
it('supports a workspace root that is itself a repository with nested repositories', async () => {
  expect(mod.captureWorkspace).toBeTypeOf('function'); const f = fixture(); const work = join(f.dir, 'root-work')
  const snapshot = await mod.captureWorkspace(f.back, { repositories: [{ id: 'root', path: '.' }, { id: 'exam', path: 'exam' }] })
  await mod.prepareWorkspace(snapshot, work, 'root-task')
  expect(readFileSync(join(work, 'pom.xml'), 'utf8')).toContain('project')
  expect(git(join(work, 'exam'), 'branch', '--show-current')).toBe('pi-superagent/root-task')
})
it('detects staged gitlink changes separately from pre-existing mounted child HEAD differences', async () => {
  expect(mod.captureWorkspace).toBeTypeOf('function'); const f = fixture(); const work = join(f.dir, 'work')
  const snapshot = await mod.captureWorkspace(f.root, { repositories: f.members }); await mod.prepareWorkspace(snapshot, work, 'links')
  git(join(work, 'backend'), 'add', 'exam')
  const statuses = await mod.workspaceStatus(snapshot, work, 'links')
  expect(statuses.find((r: any) => r.id === 'backend')).toMatchObject({ changed: true, files: ['exam'] })
})
