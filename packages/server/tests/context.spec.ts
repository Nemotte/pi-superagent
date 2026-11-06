import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { GitHubError } from '../src/sources/github-client.js'
const fixtures: Array<{ dir: string; runtime: Runtime }> = []
afterEach(async () => { for (const h of fixtures.splice(0)) { await h.runtime.close(); rmSync(h.dir, { recursive: true, force: true }) } })
const router = { role: 'router' as const, key: 'router' }
async function fixture(api?: any) {
  const dir = mkdtempSync(join(tmpdir(), 'sa-context-')), repo = join(dir, 'repo'), state = join(dir, 'state'); mkdirSync(repo)
  initialize(state, { repository: repo }); const messages: any[] = []
  const runtime = new Runtime(state, { send: async (target, delivery) => { messages.push({ target, delivery }) }, stop: async () => {}, close: async () => {} }, { prepare: async () => {}, githubClient: () => api || { verify: async () => {}, get: async () => ({ full_name: 'owner/project', default_branch: 'main' }), pages: async () => [], post: async () => { throw Error('No external publication in context tests') } } }); fixtures.push({ dir, runtime })
  return { dir, repo, runtime, messages }
}
it('sends bounded candidates and assignments with expandable text pointers', async () => {
  const h = await fixture(); const trigger = h.runtime.submit({ id: 'long', text: 'x'.repeat(20000) }); await h.runtime.tick()
  const candidate = h.messages.find(m => m.target.role === 'router')
  expect(candidate.delivery.text.length).toBeLessThan(9000)
  expect(JSON.parse(candidate.delivery.text).triggers[0].read).toMatchObject({ kind: 'trigger', id: trigger.id })
  const page = await h.runtime.tool(router, 'read', { kind: 'trigger', id: trigger.id }) as any
  expect(page.text).toHaveLength(4000); expect(page.next_offset).toBe(4000)
  const next = await h.runtime.tool(router, 'read', { kind: 'trigger', id: trigger.id, offset: page.next_offset }) as any
  expect(next.offset).toBe(4000)
  await h.runtime.tool(router, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Bounded', scope: 'One task', reason: 'Test' }); await h.runtime.tick()
  expect(h.messages.find(m => m.target.role === 'worker').delivery.text.length).toBeLessThan(9000)
})
it('provides a paginated Thread history and enforces Worker read ownership', async () => {
  const h = await fixture(); const t = h.runtime.submit({ id: 'first', text: 'Do one thing' }); await h.runtime.tick()
  const d = await h.runtime.tool(router, 'route', { kind: 'accept', triggerId: t.id, title: 'First', scope: 'One task', reason: 'Test' }) as any; await h.runtime.tick()
  const worker = h.messages.find(m => m.target.role === 'worker').target
  h.runtime.followup(d.ticketId, { id: 'second', text: 'More context' })
  const thread = await h.runtime.tool(worker, 'read', { kind: 'thread', id: 'manual:first', limit: 1 }) as any
  expect(thread.items).toHaveLength(1); expect(thread.next_offset).toBe(1)
  const other = h.runtime.submit({ id: 'unrelated', text: 'Private unrelated task' })
  await expect(h.runtime.tool(worker, 'read', { kind: 'trigger', id: other.id })).rejects.toThrow(/access|own|scope/i)
  await expect(h.runtime.tool(worker, 'read', { kind: 'thread', id: 'manual:unrelated' })).rejects.toThrow(/access|own|scope/i)
  await expect(h.runtime.tool(worker, 'read', { kind: 'settings' })).rejects.toThrow(/access|own|scope/i)
})
it('keeps mutation results bounded and exposes full assignment reports on demand', async () => {
  const h = await fixture(), trigger = h.runtime.submit({ id: 'mutations', text: 'One task' }); await h.runtime.tick()
  const d = await h.runtime.tool(router, 'route', { kind: 'accept', triggerId: trigger.id, title: 'Bounded mutations', scope: 'One task', reason: 'Test' }) as any; await h.runtime.tick()
  const worker = h.messages.find(m => m.target.role === 'worker').target
  for (let i = 0; i < 20; i++) h.runtime.engine.note(d.ticketId, String(i) + 'x'.repeat(1000))
  const response = await h.runtime.tool(worker, 'report', { state: 'progress', summary: 'r'.repeat(8000) })
  expect(JSON.stringify(response).length).toBeLessThan(2000)
  const assignments = await h.runtime.tool(worker, 'read', { kind: 'assignments' }) as any
  const pointer = assignments.items[0].read; expect(pointer.kind).toBe('assignment')
  const full = await h.runtime.tool(worker, 'read', pointer) as any
  expect(full.text.length).toBe(4000); expect(full.next_offset).toBe(4000)
})
it('gives Router bounded repository reads while rejecting traversal and symlink escape', async () => {
  const h = await fixture(); writeFileSync(join(h.repo, 'README.md'), 'a'.repeat(9000)); writeFileSync(join(h.dir, 'private'), 'secret')
  const page = await h.runtime.tool(router, 'read', { kind: 'file', path: 'README.md' }) as any
  expect(page.text).toHaveLength(4000); expect(page.next_offset).toBe(4000)
  await expect(h.runtime.tool(router, 'read', { kind: 'file', path: '../private' })).rejects.toThrow(/repository|path/)
  symlinkSync(h.dir, join(h.repo, 'escape'), 'junction')
  await expect(h.runtime.tool(router, 'read', { kind: 'file', path: 'escape/private' })).rejects.toThrow(/repository|path/)
})
it('reads original GitHub discussions in bounded pages and validates expanded comment ownership', async () => {
  const api = { verify: async () => {}, get: async (path: string) => {
    if (path === 'issues/1') return { id: 1, number: 1, title: 'Original', body: 'x'.repeat(12000), user: { login: 'alice' } }
    if (path.startsWith('issues/1/comments?')) return [{ id: 9, body: 'y'.repeat(12000), user: { login: 'alice' } }]
    return { id: 9, body: 'secret', user: { login: 'alice' }, issue_url: 'https://api.github.com/repos/owner/project/issues/2' }
  }, pages: async () => [], post: async () => {} }
  const h = await fixture(api), s = h.runtime.settings()
  h.runtime.saveSettings({ ...s.config, github: { enabled: true, repository: 'owner/project', botLogin: 'bot' } }, s.revision)
  const root = await h.runtime.tool(router, 'read', { kind: 'github', id: '1', section: 'issue' }) as any
  expect(root.text).toHaveLength(4000); expect(root.next_offset).toBe(4000)
  const comments = await h.runtime.tool(router, 'read', { kind: 'github', id: '1', section: 'comments' }) as any
  expect(comments.items[0].text.length).toBeLessThanOrEqual(600); expect(comments.items[0].read.id).toBe('1/comments/9')
  await expect(h.runtime.tool(router, 'read', { kind: 'github-message', id: '1/comments/9' })).rejects.toThrow(/conversation/)
})
it('shares GitHub read rate limits with the source instead of retrying remote reads immediately', async () => {
  let calls = 0
  const h = await fixture({ verify: async () => { calls++; throw new GitHubError(429, Date.now() + 60000, 'read') } }), s = h.runtime.settings()
  h.runtime.saveSettings({ ...s.config, github: { enabled: true, repository: 'owner/project', botLogin: 'bot' } }, s.revision)
  for (let i = 0; i < 2; i++) await expect(h.runtime.tool(router, 'read', { kind: 'github', id: '1' })).rejects.toThrow(/429/)
  expect(calls).toBe(1)
})
it('supplies matched rule text and team instructions, preserves revisions and updates live work', async () => {
  const h = await fixture(), s = h.runtime.settings()
  h.runtime.saveSettings({ ...s.config, team: { communication: 'Use one concise sentence.', scope: 'Ask before redesign.', delivery: 'Include test evidence.' }, mode: 'auto', rules: [{ id: 'copy', enabled: true, instruction: 'Change spelling only; no acknowledgement.' }], github: { enabled: true, repository: 'owner/project', botLogin: 'bot', allowedActors: ['alice'], observe: { issues: true } } }, s.revision)
  const trigger = { id: 'gh', source: 'github', actor: { source: 'github', id: 'alice' }, human: true, threads: [{ source: 'github', id: '1' }], at: new Date().toISOString(), text: 'Fix Helo', meta: { repository: 'owner/project', kind: 'issue' } }
  h.runtime.engine.receive(trigger); h.runtime.engine.evaluateDue(); const candidate = h.runtime.engine.candidate('gh')!
  const d = await h.runtime.tool(router, 'assess', { triggerId: 'gh', evalId: candidate.evalId, decision: 'accept', title: 'Spelling', scope: 'Helo to Hello', reason: 'Clear', intentEvidence: 'Fix Helo', direction: { implementationRequested: true, targetBasis: 'specified', requiresDesignDecision: false, evidence: 'Exact typo' }, ruleAssessments: [{ ruleId: 'copy', matched: true, reason: 'Typo' }] }) as any
  await h.runtime.tick(); const worker = h.messages.find(m => m.target.role === 'worker')
  expect(worker.target.instructions).toContain('Change spelling only; no acknowledgement.')
  expect(worker.target.instructions).toContain('Use one concise sentence.')
  const before = await h.runtime.tool(worker.target, 'read', { kind: 'instructions' }) as any
  const s2 = h.runtime.settings(); h.runtime.saveSettings({ ...s2.config, team: { ...s2.config.team, communication: 'Answer in Chinese.' } }, s2.revision)
  const current = await h.runtime.tool(worker.target, 'read', { kind: 'instructions' }) as any
  expect(current.team.communication).toBe('Answer in Chinese.')
  expect(h.runtime.store.get<any>(`settings:${before.revision}`).config.team.communication).toBe('Use one concise sentence.')
  expect(h.runtime.store.tickets.get(d.ticketId)?.inputs.some(i => i.kind === 'note' && i.text.includes('instructions'))).toBe(true)
})
