import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('../src/workspace.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
it('creates and reuses a real worktree using paths with spaces and Unicode', async () => {
  expect(mod.prepareWorktree).toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi sa 工作-')); dirs.push(dir)
  const repo = join(dir, 'repo'); mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } })
  git('init'); writeFileSync(join(repo, 'README.md'), 'hello'); git('add', '.'); git('commit', '-m', 'initial')
  const target = join(dir, 'work', 'task-1')
  await mod.prepareWorktree(repo, target, 'task-1'); await mod.prepareWorktree(repo, target, 'task-1')
  expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('hello')
  expect(execFileSync('git', ['-C', target, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('pi-superagent/task-1')
  const impostor = join(dir, 'wrong'); mkdirSync(impostor)
  await expect(mod.prepareWorktree(repo, impostor, 'task-1')).rejects.toThrow()
})
