import { afterEach, expect, it } from 'vitest'
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const mod = await import('../src/instances.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa setup 中文 '))); dirs.push(dir)
  const repo = join(dir, 'repo'); mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com')
  writeFileSync(join(repo, 'README.md'), 'fixture'); git('add', '.'); git('commit', '-m', 'initial')
  return { dir, repo, git }
}
it('finds the Git root from a subdirectory and reports uncommitted changes without committing', async () => {
  expect(mod.inspectRepository).toBeTypeOf('function')
  const f = fixture(); const sub = join(f.repo, 'src'); mkdirSync(sub); writeFileSync(join(f.repo, 'README.md'), 'dirty')
  const head = f.git('rev-parse', 'HEAD').trim(); const info = await mod.inspectRepository(sub)
  expect(info).toMatchObject({ repository: f.repo, head, dirty: true })
  expect(f.git('rev-parse', 'HEAD').trim()).toBe(head)
})
it('rejects non-repositories and repositories with no HEAD', async () => {
  expect(mod.inspectRepository).toBeTypeOf('function'); const f = fixture()
  await expect(mod.inspectRepository(f.dir)).rejects.toThrow(/Git/)
  const empty = join(f.dir, 'empty'); mkdirSync(empty); execFileSync('git', ['init', empty], { stdio: 'pipe' })
  await expect(mod.inspectRepository(empty)).rejects.toThrow(/提交|HEAD/)
})
it('remembers per-project instances privately without touching the repository or leaking tokens', async () => {
  expect(mod.saveBinding).toBeTypeOf('function'); const f = fixture(); const root = join(f.dir, 'private'); const state = join(f.dir, 'state'); mkdirSync(state)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ schema: 1, instanceId: 'instance-one', repository: f.repo, port: 4321 }))
  writeFileSync(join(state, 'admin.token'), 'secret-must-not-be-copied')
  const binding = { project: f.repo, repository: f.repo, stateDir: state, instanceId: 'instance-one' }
  const path = mod.saveBinding(root, binding)
  expect(mod.loadBinding(root, f.repo)).toEqual(binding)
  expect(mod.loadBinding(root, f.dir)).toBeUndefined()
  expect(readFileSync(path, 'utf8')).not.toContain('secret-must-not-be-copied')
  expect(existsSync(join(f.repo, '.pi'))).toBe(false)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ schema: 1, instanceId: 'replacement', repository: f.repo, port: 4321 }))
  expect(() => mod.loadBinding(root, f.repo)).toThrow(/identity|身份/)
})
it('prefers a saved project binding to a stale global endpoint and does not bind another directory', async () => {
  expect(mod.connectionForProject).toBeTypeOf('function'); const f = fixture(); const root = join(f.dir, 'connections'); const state = join(f.dir, 'state'); mkdirSync(state)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ schema: 1, instanceId: 'test-id', repository: f.repo, port: 4321 }))
  writeFileSync(join(state, 'admin.token'), 'secret')
  mod.saveBinding(root, { project: f.repo, repository: f.repo, stateDir: state, instanceId: 'test-id' })
  const connection = await mod.connectionForProject(f.repo, root)
  expect(connection.binding.stateDir).toBe(state)
  expect(connection.project).toBe(f.repo)
})
it('inherits a workspace connection only from its registered members, not unregistered sibling or nested repositories', async () => {
  const f = fixture(), connections = join(f.dir, 'connections'), state = join(f.dir, 'state'); mkdirSync(state)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ schema: 1, instanceId: 'workspace', repository: f.dir, port: 4321, workspace: { repositories: [{ id: 'repo', path: 'repo' }] } }))
  writeFileSync(join(state, 'admin.token'), 'secret')
  const binding = { project: f.dir, repository: f.dir, stateDir: state, instanceId: 'workspace' }; mod.saveBinding(connections, binding)
  expect((await mod.connectionForProject(f.repo, connections))?.binding).toEqual(binding)
  for (const folder of [join(f.dir, 'other'), join(f.repo, 'nested')]) {
    mkdirSync(folder); execFileSync('git', ['init', folder], { stdio: 'pipe' })
    expect((await mod.connectionForProject(folder, connections))?.binding).toBeUndefined()
  }
})
it('selects an unused loopback port', async () => {
  expect(mod.availablePort).toBeTypeOf('function')
  const { createServer } = await import('node:net'); const port = await mod.availablePort(); const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  await new Promise<void>(resolve => server.close(() => resolve()))
})
