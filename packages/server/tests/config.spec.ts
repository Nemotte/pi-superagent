import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('../src/config.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
it('initializes a private instance without overwriting its credentials', () => {
  expect(mod.initialize, 'Instance initialization is required').toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-config-')); dirs.push(dir)
  const config = mod.initialize(dir, { repository: dir, port: 4200, management: 'token' })
  expect(config.instanceId).toBeTruthy(); expect(config.mode).toBe('observe'); expect(config.maxWorkers).toBe(3)
  const token = readFileSync(join(dir, 'admin.token'), 'utf8').trim(); expect(token.length).toBeGreaterThanOrEqual(43)
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain(token)
  expect(() => mod.initialize(dir, { repository: '/different' })).toThrow(/already/i)
  expect(readFileSync(join(dir, 'admin.token'), 'utf8').trim()).toBe(token)
})
it('defaults GitHub off and rejects unsafe repositories and token values in configuration', () => {
  const base = { repository: '/repo' }
  expect(mod.ConfigSchema.parse(base).github).toBeNull()
  const github = { enabled: true, repository: 'owner/project', botLogin: 'agent', allowedActors: ['alice'] }
  expect(mod.ConfigSchema.parse({ ...base, github }).github.pollSeconds).toBe(60)
  expect(() => mod.ConfigSchema.parse({ ...base, github: { ...github, repository: '../secret' } })).toThrow()
  expect(() => mod.ConfigSchema.parse({ ...base, github: { ...github, token: 'secret' } })).toThrow()
})
it('accepts an optional workspace and validates its member identities and portable paths', () => {
  const base = { repository: '/repo' }, repositories = [{ id: 'front', path: 'apps/front' }, { id: 'back', path: 'services/back' }]
  expect(mod.ConfigSchema.parse(base).workspace).toBeNull()
  expect(mod.ConfigSchema.parse({ ...base, workspace: { repositories } }).workspace.repositories).toEqual(repositories)
  for (const path of ['../secret', '/absolute', 'C:\\secret', '.git', 'a/../b', 'a//b', 'a/.pi', 'a/']) expect(() => mod.ConfigSchema.parse({ ...base, workspace: { repositories: [{ id: 'bad', path }] } })).toThrow()
  expect(() => mod.ConfigSchema.parse({ ...base, workspace: { repositories: [repositories[0], repositories[0]] } })).toThrow()
  expect(() => mod.ConfigSchema.parse({ ...base, workspace: { repositories }, github: { enabled: true, repository: 'owner/repo', botLogin: 'bot' } })).toThrow(/workspace|Workspace/)
})
it('keeps workspace instance secrets outside the workspace, including symlinked state parents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-private-workspace-')); dirs.push(dir)
  const root = join(dir, 'app'); mkdirSync(root)
  const input = { repository: root, workspace: { repositories: [{ id: 'front', path: 'front' }] } }
  expect(() => mod.initialize(join(root, 'state'), input)).toThrow(/outside.*workspace/i)
  expect(existsSync(join(root, 'state'))).toBe(false)
  symlinkSync(root, join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => mod.initialize(join(dir, 'alias/state'), input)).toThrow(/outside.*workspace/i)
})
it('validates limits and rejects unknown fields', () => {
  expect(mod.ConfigSchema).toBeDefined()
  expect(() => mod.ConfigSchema.parse({ repository: '/repo', maxWorkers: 0 })).toThrow()
  expect(() => mod.ConfigSchema.parse({ repository: '/repo', token: 'oops' })).toThrow()
})
