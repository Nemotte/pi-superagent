import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize, readConfig } from '../../server/src/config.js'
import { startService } from '../../server/src/service.js'
import { availablePort } from '../src/instances.js'
import { discoverWorkspace, workspaceConfig } from '../../server/src/repositories.js'
import { repository } from '../../server/tests/fixtures/workspace.js'
const mod = await import('../src/setup.js').catch(() => ({} as any))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanups.reverse().splice(0)) await f() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa wizard ')); cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'); mkdirSync(repo); const state = join(dir, 'state')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); writeFileSync(join(repo, 'README.md'), 'hello'); git('add', '.'); git('commit', '-m', 'initial')
  const calls: string[] = []; const model = { provider: 'openai', id: 'gpt-6.1-sol', name: 'Sol' }
  const ctx = { cwd: repo, mode: 'tui', hasUI: true, model, ui: { select: vi.fn(async (_title: string, options: string[]) => options[0]), input: vi.fn(async () => state), confirm: vi.fn(async () => true), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } }
  const services = {
    connections: join(dir, 'connections'),
    cli: async (home: string, args: string[]) => {
      calls.push(args[0])
      if (args[0] === 'init') {
        expect(args).toContain('--paused'); expect(args).toContain('--max-workers')
        initialize(home, { repository: repo, port: Number(args[args.indexOf('--port') + 1]), paused: true, maxWorkers: 1 })
      }
      if (args[0] === 'start') { const s = await startService(home); cleanups.push(() => s.close()) }
    },
    model: vi.fn(async (home: string, request: any) => {
      calls.push(request.operation)
      expect(readConfig(home)).toMatchObject({ paused: true, maxWorkers: 1, github: null })
      if (request.operation === 'catalog') return { providers: [{ id: 'openai', name: 'OpenAI', methods: ['oauth', 'api_key'] }], models: [model] }
      if (request.operation === 'check') return { ready: false }
      if (request.operation === 'login') return { ready: true }
      return { verified: true }
    }),
  }
  return { dir, repo, state, ctx, services, calls }
}
it('creates a local paused single-worker instance, configures it, and remembers it after confirmation', async () => {
  expect(mod.setup).toBeTypeOf('function'); const f = await fixture()
  const binding = await mod.setup(f.ctx, f.services)
  expect(binding).toMatchObject({ project: f.repo, repository: f.repo, stateDir: f.state })
  expect(f.calls).toEqual(['init', 'start', 'catalog', 'check', 'login', 'probe'])
  const { instanceClient, loadBinding } = await import('../src/instances.js'); const c = instanceClient(f.state)
  expect(await c.request('config')).toMatchObject({ config: { github: null, maxWorkers: 1, paused: false, routerModel: { provider: 'openai', id: 'gpt-6.1-sol' }, workerModel: { provider: 'openai', id: 'gpt-6.1-sol' } } })
  expect(loadBinding(f.services.connections, f.repo)).toEqual(binding)
  expect(existsSync(join(f.repo, '.pi'))).toBe(false)
  expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toMatch(/管理员令牌|打开并登录/)
})
it('guides a non-Git application root into one workspace instance and reconnects from a member directory', async () => {
  const f = await fixture(); const root = join(f.dir, 'app'); mkdirSync(root); renameSync(f.repo, join(root, 'frontend'))
  repository(join(root, 'backend')); f.ctx.cwd = root
  const normalCli = f.services.cli
  const services = { ...f.services, discover: discoverWorkspace, cli: async (home: string, args: string[]) => {
    if (args[0] === 'init') {
      expect(args).toContain('--workspace'); expect(args.filter(a => a === '--member')).toHaveLength(2)
      initialize(home, { repository: root, workspace: workspaceConfig((await discoverWorkspace(root)).repositories), port: Number(args[args.indexOf('--port') + 1]), paused: true, maxWorkers: 1 })
    } else await normalCli(home, args)
  } }
  const binding = await mod.setup(f.ctx, services)
  expect(binding).toMatchObject({ project: root, repository: root, stateDir: f.state })
  expect(readConfig(f.state).workspace?.repositories).toHaveLength(2)
  const { connectionForProject } = await import('../src/instances.js')
  expect((await connectionForProject(join(root, 'frontend'), services.connections))?.binding).toEqual(binding)
  expect(f.ctx.ui.confirm.mock.calls.some((call: any[]) => call[1].includes('2 个仓库'))).toBe(true)
  f.ctx.cwd = join(root, 'frontend'); f.ctx.ui.input.mockClear()
  await mod.configureModels(f.ctx, services)
  expect(f.ctx.ui.input).not.toHaveBeenCalled()
})
it('preserves manual repository path selection from a non-Git directory', async () => {
  const f = await fixture(); f.ctx.cwd = f.dir
  f.ctx.ui.select.mockImplementation(async (title, options) => title === '选择应用工作区或单个仓库' ? '输入其他目录' : options[0])
  f.ctx.ui.input.mockResolvedValueOnce(f.repo)
  const binding = await mod.setup(f.ctx, { ...f.services, discover: discoverWorkspace })
  expect(binding.repository).toBe(f.repo); expect(readConfig(f.state).workspace).toBeNull()
})
it('does nothing if confirmation is cancelled', async () => {
  expect(mod.setup).toBeTypeOf('function'); const f = await fixture(); f.ctx.ui.confirm.mockResolvedValue(false)
  expect(await mod.setup(f.ctx, f.services)).toBeUndefined()
  expect(f.calls).toEqual([]); expect(existsSync(f.state)).toBe(false)
})
it('does not create instance secrets inside a Git working tree', async () => {
  const f = await fixture(); const unsafe = join(f.repo, '.superagent'); f.ctx.ui.input.mockResolvedValue(unsafe)
  await expect(mod.setup(f.ctx, f.services)).rejects.toThrow(/仓库外/)
  expect(f.calls).toEqual([]); expect(existsSync(unsafe)).toBe(false)
})
it('keeps dispatch paused after a failed model probe and does not retry the paid request', async () => {
  expect(mod.setup).toBeTypeOf('function'); const f = await fixture(); const normal = f.services.model.getMockImplementation()!
  f.services.model.mockImplementation(async (home, request) => { if (request.operation === 'probe') throw Error('probe failed'); return normal(home, request) })
  await expect(mod.setup(f.ctx, f.services)).rejects.toThrow('probe failed')
  const { instanceClient } = await import('../src/instances.js')
  expect(await instanceClient(f.state).request('status')).toMatchObject({ paused: true })
  expect(f.services.model.mock.calls.filter(([, r]) => r.operation === 'probe')).toHaveLength(1)
})
it('keeps the Web address visible when authentication is cancelled before model configuration completes', async () => {
  const f = await fixture(), original = f.services.model.getMockImplementation()!
  f.services.model.mockImplementation(async (home, request) => {
    if (request.operation === 'login') {
      const url = `http://127.0.0.1:${readConfig(home).port}`
      expect(f.ctx.ui.setWidget.mock.calls.some(call => call[0] === 'superagent-connection' && JSON.stringify(call[1]).includes(url))).toBe(true)
      throw Error('已取消登录；实例保留，可以稍后继续。')
    }
    return original(home, request)
  })
  await expect(mod.setup(f.ctx, f.services)).rejects.toThrow('已取消登录')
  const { instanceClient } = await import('../src/instances.js')
  expect(await instanceClient(f.state).request('status')).toMatchObject({ paused: true })
  expect(f.ctx.ui.setWidget.mock.calls.filter(call => call[0] === 'superagent-connection').at(-1)?.[1]).toContain(`Web：http://127.0.0.1:${readConfig(f.state).port}`)
})
it('configures only the selected role on a bound instance without repository discovery or initialization', async () => {
  expect(mod.configureModels).toBeTypeOf('function')
  const f = await fixture()
  initialize(f.state, { repository: f.repo, port: await availablePort(), paused: true, maxWorkers: 1 })
  const server = await startService(f.state); cleanups.push(() => server.close())
  const { saveBinding } = await import('../src/instances.js')
  const s = server.runtime.settings(); server.runtime.saveSettings({ ...s.config, workerModel: { provider: 'other', id: 'keep-worker' } }, s.revision)
  saveBinding(f.services.connections, { project: f.repo, repository: f.repo, stateDir: f.state, instanceId: s.config.instanceId })
  f.ctx.ui.select.mockImplementation(async (title, options) => title === '配置哪些执行角色？' ? '仅 Router' : options[0])
  f.ctx.ui.confirm.mockImplementation(async title => !['验证模型连接', '开始接收任务'].includes(title))
  await mod.configureModels(f.ctx, f.services)
  expect(f.ctx.ui.input).not.toHaveBeenCalled()
  expect(f.calls).toEqual(['catalog', 'check', 'login'])
  expect(server.runtime.settings().config).toMatchObject({ paused: true, routerModel: { provider: 'openai', id: 'gpt-6.1-sol' }, workerModel: { provider: 'other', id: 'keep-worker' } })
})
it('connects to an existing instance without changing its settings or authentication', async () => {
  expect(mod.setup).toBeTypeOf('function'); const f = await fixture()
  initialize(f.state, { repository: f.repo, port: await availablePort(), paused: true, maxWorkers: 2 })
  const server = await startService(f.state); cleanups.push(() => server.close())
  const before = readFileSync(join(f.state, 'config.json'), 'utf8')
  f.ctx.ui.select.mockImplementationOnce(async (_title, options) => options[1])
  expect(await mod.setup(f.ctx, f.services)).toMatchObject({ stateDir: f.state })
  expect(f.calls).toEqual([]); expect(readFileSync(join(f.state, 'config.json'), 'utf8')).toBe(before)
  expect(server.runtime.settings().revision).toBe(1)
})
