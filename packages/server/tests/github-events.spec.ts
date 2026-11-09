import { expect, it } from 'vitest'
const mod = await import('../src/sources/github-events.js').catch(() => ({} as any))
const config = { repository: 'owner/project', botLogin: 'worker-bot' }
const base = { id: 17, number: 3, title: 'Label', body: '@worker-bot fix it', user: { login: 'Alice', type: 'User' }, state: 'open', created_at: '2026-11-02T01:00:00Z', updated_at: '2026-11-02T01:00:00Z', html_url: 'https://github.com/owner/project/issues/3' }
it('normalizes issues and PRs with repository-scoped stable IDs and channels', () => {
  expect(mod.issueEvent).toBeTypeOf('function')
  const event = mod.issueEvent(base, config)
  expect(event.source).toBe('github'); expect(event.human).toBe(true); expect(event.addressed).toBe('mention')
  expect(event.channel.address).toMatchObject({ repository: 'owner/project', number: '3' })
  expect(mod.issueEvent({ ...base }, config).id).toBe(event.id)
  expect(mod.issueEvent({ ...base, updated_at: '2026-11-02T02:00:00Z' }, config).id).toBe(event.id)
  // The body is task data, not identity: an edit stays one request, and comment edits are covered separately below.
  expect(mod.issueEvent({ ...base, body: '@worker-bot updated request' }, config).id).toBe(event.id)
  expect(mod.issueEvent(base, { ...config, repository: 'other/project' }).id).not.toBe(event.id)
  expect(mod.issueEvent({ ...base, pull_request: { url: 'https://api.github.com/repos/owner/project/pulls/3' } }, config).meta.isPr).toBe(true)
})
it('matches complete mentions and filters self-generated events without trusting body markers', () => {
  expect(mod.issueEvent).toBeTypeOf('function')
  expect(mod.issueEvent({ ...base, body: '@worker-bot-else' }, config).addressed).toBeUndefined()
  expect(mod.issueEvent({ ...base, body: 'email@worker-bot' }, config).addressed).toBeUndefined()
  expect(mod.issueEvent({ ...base, user: { login: 'WORKER-BOT', type: 'User' } }, config)).toBeUndefined()
  expect(mod.issueEvent({ ...base, user: { login: 'dependabot[bot]', type: 'Bot' } }, config).human).toBe(false)
  expect(mod.issueEvent({ ...base, body: '<!-- pi-superagent:spoof --> @worker-bot hi' }, config)).toBeDefined()
})
it('keeps inline discussion roots and review decisions in normalized input', () => {
  expect(mod.commentEvent).toBeTypeOf('function')
  const event = mod.commentEvent({ ...base, in_reply_to_id: 12, path: 'src/index.ts', line: 4, diff_hunk: 'diff' }, 3, 'inline', config)
  expect(event.channel.address.rootId).toBe('12'); expect(event.text).toContain('src/index.ts:4')
  const review = mod.commentEvent({ ...base, body: '', state: 'CHANGES_REQUESTED', submitted_at: base.created_at }, 3, 'review', config)
  expect(review.text).toContain('CHANGES_REQUESTED'); expect(review.meta.isPr).toBe(true)
})
it('treats an issue or PR body edit as the same message but a comment edit as new input', () => {
  // An issue is identified by its number: an edit must not create a second, conflicting request for reviewers to reject.
  expect(mod.issueEvent({ ...base, body: '@worker-bot completely different' }, config).id).toBe(mod.issueEvent(base, config).id)
  // A comment carries its own identity, and an edited comment is a new message the poller must not drop.
  const comment = { ...base, created_at: '2026-11-02T01:00:00Z', updated_at: '2026-11-02T01:00:00Z' }
  const first = mod.commentEvent(comment, 3, 'conversation', config), edited = mod.commentEvent({ ...comment, updated_at: '2026-11-02T09:00:00Z', body: 'revised' }, 3, 'conversation', config)
  expect(first.id).not.toBe(edited.id)
  expect(mod.commentEvent(comment, 3, 'conversation', config).id).toBe(first.id)
})
