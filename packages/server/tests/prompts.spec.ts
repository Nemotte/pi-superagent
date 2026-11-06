import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mod = await import('../src/prompts.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
it('states quiet delivery, Router stop ownership and matched-rule precedence explicitly', () => {
  expect(mod.rolePrompt).toBeTypeOf('function')
  const router = mod.rolePrompt({ role: 'router', key: 'router', instructions: 'Team communication' })
  expect(router).toContain('follow_up'); expect(router).toContain('superagent_reply'); expect(router).toContain('dropped'); expect(router).toContain('Team communication')
  const worker = mod.rolePrompt({ role: 'worker', key: 'w', ticketId: 't', instructions: 'Matched rule text' })
  expect(worker).toContain('Matched rule text'); expect(worker).toContain('superagent_follow'); expect(worker).toContain('superagent_unrelated'); expect(worker).toContain('superagent_ack')
})
it('requires channel replies through Router, forbids personal credentials and avoids login shells', () => {
  const worker = mod.rolePrompt({ role: 'worker', key: 'w', ticketId: 't' })
  expect(worker).toContain('Never use gh, curl, shell scripts or direct HTTP to post comments')
  expect(worker).toContain('superagent_report'); expect(worker).toContain('personal credentials')
  expect(worker).not.toContain('/bin/sh with -lc')
})
it('keeps local work independent of GitHub while retaining optional publication instructions', () => {
  for (const role of ['router', 'worker']) {
    expect(mod.rolePrompt({ role, key: role, ticketId: 't' })).not.toMatch(/github|pull request|issue|\bPR\b/i)
  }
  expect(mod.rolePrompt({ role: 'worker', key: 'w', ticketId: 't', github: true })).toContain('superagent_github_create_pull')
})
it('loads scoped workspace and member instructions with a shared total budget', () => {
  expect(mod.agentInstructions).toBeTypeOf('function')
  const root = mkdtempSync(join(tmpdir(), 'sa-workspace-prompts-')); dirs.push(root)
  mkdirSync(join(root, 'front')); mkdirSync(join(root, 'back'))
  writeFileSync(join(root, 'front/AGENTS.md'), 'Front instructions'); writeFileSync(join(root, 'front/CLAUDE.md'), 'Do not also load this')
  writeFileSync(join(root, 'back/CLAUDE.md'), 'Back instructions')
  const target = { role: 'worker', cwd: root, workspace: { instructions: 'Shared instructions', repositories: [{ id: 'front', path: 'front' }, { id: 'back', path: 'back' }] } }
  const files = mod.agentInstructions(target)
  expect(files).toHaveLength(3); expect(files.map((f: any) => f.content).join('\n')).toContain('Back instructions')
  expect(files.map((f: any) => f.content).join('\n')).not.toContain('Do not also load this')
  expect(mod.rolePrompt({ ...target, key: 'worker', ticketId: 'task' })).toContain('repositories')
  expect(mod.rolePrompt({ ...target, key: 'worker', ticketId: 'task' })).not.toContain('use superagent_github_create_pull')
  writeFileSync(join(root, 'back/CLAUDE.md'), 'x'.repeat(32000))
  expect(() => mod.agentInstructions(target)).toThrow(/budget/)
})
it('loads only the selected project AGENTS.md, with a bounded size and no symlink escape', () => {
  expect(mod.projectInstructions).toBeTypeOf('function')
  const root = mkdtempSync(join(tmpdir(), 'sa-prompts-')); dirs.push(root); const repo = join(root, 'repo'); mkdirSync(repo)
  writeFileSync(join(root, 'AGENTS.md'), 'Personal parent instructions')
  expect(mod.projectInstructions(repo)).toEqual([])
  writeFileSync(join(repo, 'AGENTS.md'), 'Project instructions')
  expect(mod.projectInstructions(repo)[0].content).toBe('Project instructions')
  writeFileSync(join(repo, 'AGENTS.md'), 'x'.repeat(32001)); expect(() => mod.projectInstructions(repo)).toThrow(/budget/)
  rmSync(join(repo, 'AGENTS.md'))
  symlinkSync(root, join(repo, 'escape'), 'junction')
  expect(() => mod.projectInstructions(join(repo, 'escape'), repo)).toThrow(/repository|path/)
})
