import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { realpathSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { git, nestedWorkspace } from './fixtures/workspace.js'
const mod = await import('../src/repositories.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() { const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa discover 中文 '))); dirs.push(root); return { root, ...nestedWorkspace(root) } }
it('does not lazily fetch missing objects from a partial clone during host Git checks', async () => {
  const f = fixture(), partial = join(f.root, 'partial')
  git(f.front, 'config', 'uploadpack.allowFilter', 'true')
  const clone = spawnSync('git', ['-C', f.root, '-c', 'protocol.file.allow=always', 'clone', '--upload-pack=git -c uploadpack.allowFilter=true upload-pack', '--filter=blob:none', '--no-checkout', pathToFileURL(f.front).href, partial], { encoding: 'utf8' })
  expect(clone.status, clone.stderr).toBe(0)
  const blob = git(f.front, 'rev-parse', 'HEAD:README.md'), packs = join(partial, '.git', 'objects', 'pack')
  expect(await mod.repositoryGit(partial, 'rev-list', '--objects', '--missing=print', 'HEAD'), `${git(f.root, '--version')}\n${clone.stderr}`).toContain('?' + blob)
  const before = readdirSync(packs).sort()
  await expect(mod.repositoryGit(partial, 'cat-file', '-e', blob)).rejects.toThrow()
  expect(readdirSync(packs).sort()).toEqual(before)
})
it('discovers nested repositories and missing gitlinks without using submodule update or gitmodules', async () => {
  expect(mod.discoverWorkspace).toBeTypeOf('function'); const f = fixture()
  const before = git(f.back, 'status', '--porcelain')
  const result = await mod.discoverWorkspace(f.root)
  expect(result.repositories.map((r: any) => r.path)).toEqual(['backend', 'backend/exam', 'frontends/portal'])
  expect(result.unavailable).toContainEqual(expect.objectContaining({ path: 'backend/missing-service', reason: 'missing-checkout' }))
  expect(result.repositories.find((r: any) => r.path === 'backend').gitlinks).toContainEqual({ path: 'exam', commit: f.recorded })
  expect(git(f.back, 'status', '--porcelain')).toBe(before)
})
it('reports no-HEAD repositories precisely, skips dependency trees and does not follow symlinks', async () => {
  expect(mod.discoverWorkspace).toBeTypeOf('function'); const f = fixture()
  const empty = join(f.root, 'empty'); mkdirSync(empty); git(empty, 'init')
  mkdirSync(join(f.root, 'node_modules', 'fake', '.git'), { recursive: true })
  symlinkSync(f.front, join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await mod.discoverWorkspace(f.root)
  expect(result.repositories).toHaveLength(3)
  expect(result.unavailable).toContainEqual(expect.objectContaining({ path: 'empty', reason: 'missing-head' }))
})
it('fails explicitly when discovery exceeds its directory budget', async () => {
  expect(mod.discoverWorkspace).toBeTypeOf('function'); const f = fixture()
  await expect(mod.discoverWorkspace(f.root, { maxDirectories: 1 })).rejects.toThrow(/budget/i)
})
it('validates selected members and refuses parent-owned tracked directory overlap', async () => {
  expect(mod.validateWorkspace).toBeTypeOf('function'); const f = fixture()
  await expect(mod.validateWorkspace(f.root, { repositories: f.members })).resolves.toBeDefined()
  await expect(mod.validateWorkspace(f.root, { repositories: [{ id: 'outside', path: '../outside' }] })).rejects.toThrow()
  writeFileSync(join(f.front, 'inside.txt'), 'parent-owned'); git(f.front, 'add', '.'); git(f.front, 'commit', '-m', 'tracked')
  const nested = join(f.front, 'tracked'); mkdirSync(nested); writeFileSync(join(nested, 'file'), 'parent'); git(f.front, 'add', '.'); git(f.front, 'commit', '-m', 'tracked dir')
  git(nested, 'init'); git(nested, 'add', '.'); git(nested, 'commit', '-m', 'nested')
  await expect(mod.validateWorkspace(f.root, { repositories: [...f.members, { id: 'overlap', path: 'frontends/portal/tracked' }] })).rejects.toThrow(/tracked|overlap/i)
})
