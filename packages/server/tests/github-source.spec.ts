import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { GitHubError } from '../src/sources/github-client.js'
const source = await import('../src/sources/github-source.js').catch(() => ({} as any))
const resources: Array<{ dir: string; runtime: Runtime }> = []
afterEach(async () => { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } })
async function harness() {
  expect(source.GitHubSource, 'Durable GitHub source is required').toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-github-')); initialize(dir, { repository: dir })
  let time = Date.now(); const lists = new Map<string, unknown[]>(), objects = new Map<string, unknown>(), failures = new Map<string, Error>(), posts: any[] = []
  objects.set('', { default_branch: 'main', full_name: 'owner/project' }); objects.set('commits/main', { sha: 'abc123' })
  const api = {
    verify: async () => {},
    get: async (path: string) => { if (failures.has(path)) throw failures.get(path); if (!objects.has(path)) throw Error('Missing fixture ' + path); return objects.get(path) },
    pages: async (path: string) => { const route = path.split('?')[0]; if (failures.has(route)) throw failures.get(route); return lists.get(route) || [] },
    post: async (path: string, body: any) => { posts.push({ path, body }); return { id: 101 } },
  }
  const options = { prepare: async () => {}, githubClient: () => api, now: () => time }
  const runtime = new Runtime(dir, { send: async () => {}, stop: async () => {}, close: async () => {} }, options as any)
  resources.push({ dir, runtime }); const settings = runtime.settings()
  runtime.saveSettings({ ...settings.config, github: { enabled: true, repository: 'owner/project', botLogin: 'worker-bot', allowedActors: ['alice'], observe: { issues: true, pulls: true, comments: true, ci: true } } }, settings.revision)
  const github = (runtime as any).github
  await github.poll()
  const created = new Date(time + 1000).toISOString(); time += 60000
  const issue = { id: 17, number: 3, title: 'Label', body: '@worker-bot fix it', user: { login: 'alice', type: 'User' }, state: 'open', created_at: created, updated_at: created, html_url: 'https://github.com/owner/project/issues/3' }
  return { runtime, github, dir, api, options, lists, objects, failures, posts, issue, advance: () => { time += 60000 } }
}
it('polls from activation, persists per-stream cursors and deduplicates overlapping reads', async () => {
  const h = await harness(); h.lists.set('issues', [h.issue]); await h.github.poll()
  const first = h.runtime.store.records('trigger'); expect(first).toHaveLength(1)
  const cursor = h.github.status().cursors.issues; expect(cursor).toBeTruthy()
  h.advance(); await h.github.poll(); expect(h.runtime.store.records('trigger')).toHaveLength(1)
  const old = { ...h.issue, id: 1, number: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }
  h.lists.set('issues', [old]); await h.github.poll(); expect(h.runtime.store.records('trigger')).toHaveLength(1)
})
it('escalates persistent source failures to the attention queue, not a single network error', async () => {
  const h = await harness(); h.api.verify = async () => { throw new GitHubError(403, 0, '/user') }
  await h.github.poll(); expect(h.runtime.attention().problems).toEqual([])
  await h.github.poll(); await h.github.poll()
  expect(h.runtime.attention().problems).toContainEqual(expect.objectContaining({ kind: 'github', attempts: 3 }))
  h.api.verify = async () => {}; await h.github.poll(); expect(h.runtime.attention().problems).toEqual([])
})
it('retains a failed stream cursor, exposes its error, and resumes after restart', async () => {
  const h = await harness(); const before = h.github.status().cursors.comments
  h.failures.set('issues/comments', Error('temporary failure')); await h.github.poll()
  expect(h.github.status().state).toBe('error'); expect(h.github.status().cursors.comments).toBe(before)
  await h.runtime.close()
  const reopened = new Runtime(h.dir, { send: async () => {}, stop: async () => {}, close: async () => {} }, h.options as any)
  resources.find(r => r.dir === h.dir)!.runtime = reopened
  h.failures.clear(); h.lists.set('issues/comments', [{ ...h.issue, issue_url: 'https://api.github.com/repos/owner/project/issues/3' }]); h.advance()
  await (reopened as any).github.poll()
  expect(reopened.store.records('trigger')).toHaveLength(1)
  expect((reopened as any).github.status().state).toBe('ready')
})
it('keeps receiving while dispatch is paused and protects configured repository identity', async () => {
  const h = await harness(); const settings = h.runtime.settings()
  h.runtime.saveSettings({ ...settings.config, paused: true }, settings.revision)
  h.lists.set('issues', [h.issue]); await h.github.poll(); expect(h.runtime.store.records('trigger')).toHaveLength(1)
  expect(() => h.runtime.saveSettings({ ...h.runtime.settings().config, github: { ...settings.config.github, repository: 'other/project' } }, h.runtime.settings().revision)).toThrow(/identity|repository/i)
})
it('routes authorized mentions, sends a durable acknowledgement and publishes a ready result', async () => {
  const h = await harness(); h.lists.set('issues', [h.issue]); h.objects.set('issues/3', { ...h.issue, locked: false }); await h.github.poll(); await h.runtime.tick()
  const trigger = h.runtime.store.records('trigger')[0] as any
  expect(h.runtime.engine.candidate(trigger.id)?.strength).toBe('explicit')
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { triggerId: trigger.id, kind: 'accept', title: 'Fix label', scope: 'Label only', reason: 'Allowed mention', acknowledgement: 'I will fix this label.' }) as any
  await h.runtime.tick(); expect(h.posts).toHaveLength(1); expect(h.posts[0].path).toBe('issues/3/comments')
  const ticket = h.runtime.store.tickets.get(decision.ticketId)!
  await h.runtime.tool({ role: 'worker', key: `worker-${ticket.id}`, ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id }, 'report', { state: 'ready', summary: 'Label verified' })
  await h.runtime.tool({ role: 'router', key: 'router' }, 'reply', { purpose: 'result', ticketId: ticket.id, text: 'Label verified' })
  await h.runtime.tick(); expect(h.posts).toHaveLength(2); expect(h.posts[1].body.body).toContain('Label verified')
})
it('recognizes already-posted markers only from the configured account, and uses review replies', async () => {
  const h = await harness(); const message = { id: 'outbound-one', text: 'Answer', kind: 'reply', channel: { source: 'github', thread: 'github:3', address: { repository: 'owner/project', number: '3', rootId: '12' } } }
  h.objects.set('pulls/comments/12', { id: 12 }); h.objects.set('issues/3', h.issue)
  await h.github.send(message); expect(h.posts[0].path).toBe('pulls/3/comments/12/replies')
  h.lists.set('pulls/3/comments', [{ id: 101, in_reply_to_id: 12, user: { login: 'worker-bot' }, body: h.posts[0].body.body }])
  await h.github.send(message); expect(h.posts).toHaveLength(1)
  h.lists.set('pulls/3/comments', [{ id: 102, in_reply_to_id: 12, user: { login: 'attacker' }, body: h.posts[0].body.body }])
  await h.github.send(message); expect(h.posts).toHaveLength(2)
})
it('recovers a lost POST response without publishing a duplicate comment', async () => {
  const h = await harness(); h.objects.set('issues/3', h.issue)
  const message = { id: 'lost-response', text: 'Answer', kind: 'reply', channel: { source: 'github', thread: 'github:3', address: { repository: 'owner/project', number: '3' } } }
  h.api.post = async (path: string, body: any) => { h.posts.push({ path, body }); h.lists.set(path, [{ id: 100, user: { login: 'worker-bot' }, body: body.body }]); throw Error('connection lost after commit') }
  await expect(h.github.send(message)).rejects.toThrow('connection lost')
  await expect(h.github.send(message)).resolves.toBe('sent'); expect(h.posts).toHaveLength(1)
})
it('falls back from a deleted review root, but preserves permission failures for retry', async () => {
  const h = await harness(); h.objects.set('issues/3', h.issue)
  const message = { id: 'deleted-root', text: 'Answer', kind: 'reply', channel: { source: 'github', thread: 'github:3', address: { repository: 'owner/project', number: '3', rootId: '12' } } }
  h.failures.set('pulls/comments/12', new GitHubError(404, 0, 'review'))
  await h.github.send(message); expect(h.posts[0].path).toBe('issues/3/comments')
  h.failures.set('pulls/comments/12', new GitHubError(403, 0, 'review'))
  await expect(h.github.send(message)).rejects.toThrow(/403/); expect(h.posts).toHaveLength(1)
})
it('rechecks pause and withdrawals immediately before an external write', async () => {
  const h = await harness(); h.objects.set('issues/3', h.issue)
  const message = { id: 'paused-reply', text: 'Answer', kind: 'reply', channel: { source: 'github', thread: 'github:3', address: { repository: 'owner/project', number: '3' } } }
  h.api.pages = async () => { const s = h.runtime.settings(); h.runtime.saveSettings({ ...s.config, paused: true }, s.revision); return [] }
  await expect(h.github.send(message)).rejects.toThrow(/paused/i); expect(h.posts).toEqual([])
})
it('does not advance cursors or retry early when GitHub rate-limits the identity check', async () => {
  const h = await harness(); const before = h.github.status().cursors
  let count = 0; h.api.verify = async () => { count++; throw new GitHubError(429, Date.now() + 300000, '/user') }
  await h.github.poll(); await h.github.poll()
  expect(count).toBe(1); expect(h.github.status().cursors).toEqual(before); expect(h.github.status().nextPollAt).toBeGreaterThan(Date.now())
})
it('binds only the origin PR or an owned exact ticket branch and observes merged lifecycle', async () => {
  const h = await harness(); const trigger = h.runtime.submit({ text: 'Prepare a PR', id: 'manual-pr' }); await h.runtime.tick()
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { kind: 'accept', triggerId: trigger.id, title: 'PR', scope: 'Prepare change', reason: 'Request' }) as any
  const ticket = h.runtime.store.tickets.get(decision.ticketId)!
  const pull = { ...h.issue, number: 9, html_url: 'https://github.com/owner/project/pull/9', user: { login: 'worker-bot', type: 'User' }, head: { sha: 'def456', ref: `pi-superagent/${ticket.id}`, repo: { full_name: 'owner/project' } } }
  h.objects.set('pulls/9', pull)
  await h.github.bind(ticket.id, 9); expect(h.runtime.store.tickets.get(ticket.id)!.follows?.[0].own).toBe(true)
  h.objects.set('pulls/10', { ...pull, number: 10, head: { ...pull.head, ref: 'unrelated-branch' } })
  await expect(h.github.bind(ticket.id, 10)).rejects.toThrow(/belong/i)
  await h.runtime.tick(); h.runtime.engine.report(ticket.id, { state: 'ready', summary: 'PR is ready' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  h.objects.set('pulls/9', { ...pull, state: 'closed', merged: true, merged_at: new Date(Date.now() + 1000).toISOString() }); await h.github.poll()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended?.outcome).toBe('merged')
})
it('creates an idempotent ticket PR using only its own branch and binds it before ready', async () => {
  const h = await harness(); const trigger = h.runtime.submit({ id: 'create-pr', text: 'Create PR' }); h.runtime.engine.evaluateDue()
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { triggerId: trigger.id, kind: 'accept', title: 'PR', scope: 'Create PR', reason: 'Administrator request' }) as any
  const ticket = h.runtime.store.tickets.get(decision.ticketId)!
  const pull = { ...h.issue, number: 11, user: { login: 'worker-bot', type: 'User' }, head: { sha: 'def456', ref: `pi-superagent/${ticket.id}`, repo: { full_name: 'owner/project' } } }
  h.api.post = async (path: string, body: any) => { h.posts.push({ path, body }); h.lists.set('pulls', [{ ...pull, body: body.body }]); return { ...pull, body: body.body } }
  const target = { role: 'worker' as const, key: `worker-${ticket.id}`, ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id }
  await h.runtime.tool(target, 'github_create_pull', { title: 'Fix label', body: 'Verified' })
  await h.runtime.tool(target, 'github_create_pull', { title: 'Fix label', body: 'Verified' })
  expect(h.posts).toHaveLength(1); expect(h.posts[0].body.head).toBe(`pi-superagent/${ticket.id}`)
  expect(h.runtime.store.tickets.get(ticket.id)!.follows?.[0].thread).toBe('github:11')
})
it('does not report CI recovery when checks temporarily disappear or are still running', async () => {
  const h = await harness(); h.lists.set('commits/abc123/check-runs', [{ name: 'tests', status: 'completed', conclusion: 'failure' }]); await h.github.poll()
  h.advance(); h.lists.set('commits/abc123/check-runs', []); await h.github.poll()
  h.advance(); h.lists.set('commits/abc123/check-runs', [{ name: 'tests', status: 'in_progress', conclusion: null }]); await h.github.poll()
  expect((h.runtime.store.records('trigger') as any[]).filter(e => e.meta.ci)).toHaveLength(1)
})
it('preserves CI event identity across source disable and re-enable', async () => {
  const h = await harness(); h.lists.set('commits/abc123/check-runs', [{ name: 'tests', status: 'completed', conclusion: 'failure' }]); await h.github.poll()
  let s = h.runtime.settings(); h.runtime.saveSettings({ ...s.config, github: { ...s.config.github, enabled: false } }, s.revision)
  h.advance(); s = h.runtime.settings(); h.runtime.saveSettings({ ...s.config, github: { ...s.config.github, enabled: true } }, s.revision)
  await h.github.poll(); h.advance(); h.lists.set('commits/abc123/check-runs', [{ name: 'tests', status: 'completed', conclusion: 'success' }]); await h.github.poll()
  const events = (h.runtime.store.records('trigger') as any[]).filter(e => e.meta.ci)
  expect(events).toHaveLength(2); expect(new Set(events.map(e => e.id)).size).toBe(2)
})
it('records review decisions and default-branch CI transitions but not an initial CI baseline', async () => {
  const h = await harness()
  h.lists.set('pulls', [{ ...h.issue, number: 9, head: { sha: 'def456', ref: 'feature', repo: { full_name: 'owner/project' } } }])
  h.lists.set('pulls/9/reviews', [{ ...h.issue, id: 90, body: 'Please revise', state: 'CHANGES_REQUESTED', submitted_at: h.issue.created_at }])
  h.lists.set('commits/abc123/check-runs', [{ id: 1, name: 'tests', status: 'completed', conclusion: 'failure' }])
  await h.github.poll()
  const events = h.runtime.store.records('trigger') as any[]
  expect(events.some(e => e.meta.kind === 'review')).toBe(true)
  expect(events.some(e => e.meta.ci === true && e.meta.branch === 'main')).toBe(true)
})
