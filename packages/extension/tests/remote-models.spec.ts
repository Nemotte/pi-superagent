import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../../server/src/config.js'
import { startService } from '../../server/src/service.js'
import { instanceClient, availablePort } from '../src/instances.js'
const f = vi.hoisted(() => ({ connection: undefined as any, services: undefined as any, remoteModelServices: vi.fn() }))
vi.mock('../src/instances.js', async original => ({ ...await original<object>(), connectionForProject: async () => f.connection }))
vi.mock('../src/remote.js', () => ({ remoteModelServices: f.remoteModelServices }))
const { configureModels } = await import('../src/setup.js')
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks() })
it('configures a remote role via the SSH SDK adapter without reading a remote state directory locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sa remote model ')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'state'), repo = join(root, 'repo'); mkdirSync(repo)
  const c = initialize(state, { repository: repo, port: await availablePort(), paused: true, management: 'token' })
  const server = await startService(state); cleanup.push(() => server.close())
  const binding = { project: root, repository: '/srv/app', stateDir: '/srv/private-not-on-client', instanceId: c.instanceId, ssh: { host: 'cloud', node: 'node', cliPath: '/opt/sa/dist/cli.js', port: c.port } }
  f.connection = { project: root, binding, client: instanceClient(state) }
  const model = { provider: 'provider', id: 'model' }
  const remoteModel = vi.fn(async (_dir, r) => r.operation === 'catalog' ? { providers: [{ id: 'provider', name: 'Provider', methods: ['api_key'] }], models: [model] } : { ready: true })
  f.remoteModelServices.mockReturnValue({ connections: root, model: remoteModel })
  const ctx = { cwd: root, hasUI: true, mode: 'tui', ui: { select: vi.fn(async (title, options) => title === '配置哪些执行角色？' ? '仅 Router' : options[0]), confirm: vi.fn(async () => false), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } }
  const local = { connections: root, cli: vi.fn(), model: vi.fn(async () => { throw Error('must not use local SDK') }) }
  await configureModels(ctx as any, local)
  expect(f.remoteModelServices).toHaveBeenCalledWith(binding, root)
  expect(local.model).not.toHaveBeenCalled()
  expect(remoteModel.mock.calls.map(([, r]) => r.operation)).toEqual(['catalog', 'check'])
  expect(server.runtime.settings().config).toMatchObject({ paused: true, routerModel: model, workerModel: null })
})
