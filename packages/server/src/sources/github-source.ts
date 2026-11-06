import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Engine, type OutboundMessage, type Trigger } from '../core/index.js'
import type { Config } from '../config.js'
import type { Store } from '../store.js'
import { GitHubClient, GitHubError, type GitHubApi } from './github-client.js'
import { sameLogin, type GitHubConfig } from './github-config.js'
import { CommentSchema, IssueSchema, PullSchema, issueEvent, commentEvent, numberFromUrl, type Pull } from './github-events.js'
import { sendGitHub } from './github-channel.js'
import { textPage, type ReadRequest } from '../context.js'
import { clip } from '../notices.js'
export type GitHubClientFactory = (config: GitHubConfig, signal: AbortSignal) => GitHubApi
export class SourceDeferred extends Error {}
interface SourceState {
  started: string; cursors: Record<string, string>; pendingPulls: number[]; nextPollAt: number; failures: number
  state: 'pending' | 'ready' | 'error'; lastSuccess?: string; error?: string
}
interface Host { store: Store; engine: Engine; stateDir: string; config(): Config; client?: GitHubClientFactory; now?: () => number }
const streams = [['issues', 'issues?state=all'], ['comments', 'issues/comments?'], ['inline', 'pulls/comments?']] as const
export class GitHubSource {
  private controller = new AbortController()
  private running?: Promise<void>
  private operations = new Set<Promise<unknown>>()
  constructor(private host: Host) {}
  private now(): number { return this.host.now?.() ?? Date.now() }
  private state(): SourceState {
    const old = this.host.store.get<SourceState>('github:state')
    if (old) return old
    const started = new Date(this.now()).toISOString()
    const state: SourceState = { started, cursors: Object.fromEntries(streams.map(([id]) => [id, started])), pendingPulls: [], state: 'pending', failures: 0, nextPollAt: 0 }
    this.host.store.set('github:state', state); return state
  }
  private update(patch: Partial<SourceState>): void { this.host.store.set('github:state', { ...this.state(), ...patch }) }
  configurationChanged(before: GitHubConfig | null, after: GitHubConfig | null): void {
    if (!before?.enabled && after?.enabled) {
      const started = new Date(this.now()).toISOString()
      this.update({ started, cursors: Object.fromEntries(streams.map(([id]) => [id, started])), nextPollAt: 0, state: 'pending', error: undefined })
      const prior = this.host.store.get<{ revision: number }>('github:branch-baseline')
      this.host.store.set('github:branch-baseline', { revision: prior?.revision || 0, failures: [] })
    } else if (after?.enabled) this.update({ nextPollAt: 0 })
  }
  status() {
    if (!this.host.config().github?.enabled) return { id: 'github', state: 'disabled', configured: !!this.host.config().github }
    const state = this.state()
    return { id: 'github', ...state, nextPollAt: Math.max(state.nextPollAt, this.host.store.get<number>('github:rate-until') || 0) }
  }
  private config(): GitHubConfig { const c = this.host.config().github; if (!c?.enabled || this.controller.signal.aborted) throw new SourceDeferred('GitHub source disabled'); return c }
  private guard(config: GitHubConfig): void {
    if (JSON.stringify(this.config()) !== JSON.stringify(config)) throw new SourceDeferred('GitHub settings changed; retry with current settings')
    const until = this.host.store.get<number>('github:rate-until') || 0
    if (until > this.now()) throw new GitHubError(429, until, 'rate limit')
  }
  private client(config: GitHubConfig): GitHubApi {
    const until = this.host.store.get<number>('github:rate-until') || 0
    if (until > this.now()) throw new GitHubError(429, until, 'rate limit')
    if (this.host.client) return this.host.client(config, this.controller.signal)
    let token = process.env.PI_SUPERAGENT_GITHUB_TOKEN?.trim()
    if (!token) { try { token = readFileSync(join(this.host.stateDir, 'github.token'), 'utf8').trim() } catch { throw Error('Configure instance github.token or PI_SUPERAGENT_GITHUB_TOKEN') } }
    if (!token) throw Error('GitHub credential is empty')
    return new GitHubClient(config.repository, token, { signal: this.controller.signal })
  }
  private rate(error: unknown): void { if (error instanceof GitHubError && error.retryAt) this.host.store.set('github:rate-until', Math.max(this.host.store.get<number>('github:rate-until') || 0, error.retryAt)) }
  tick(): Promise<void> { return this.host.config().github?.enabled && this.now() >= this.state().nextPollAt ? this.poll() : Promise.resolve() }
  poll(): Promise<void> {
    if (this.running) return this.running
    if (this.controller.signal.aborted || !this.host.config().github?.enabled || this.now() < (this.host.store.get<number>('github:rate-until') || 0)) return Promise.resolve()
    return this.running = this.round().finally(() => { this.running = undefined })
  }
  private async round(): Promise<void> {
    const c = this.config(), start = new Date(this.now()).toISOString(), errors: string[] = []
    const attempt = async (name: string, fn: () => Promise<void>) => {
      try { this.guard(c); await fn() }
      catch (error) { this.rate(error); errors.push(`${name}: ${String(error).slice(0, 800)}`) }
    }
    try {
      const api = this.client(c); await api.verify(c.botLogin); this.guard(c)
      const repo = z.object({ full_name: z.string(), default_branch: z.string() }).parse(await api.get(''))
      if (!sameLogin(repo.full_name, c.repository)) throw Error('GitHub repository identity mismatch')
      for (const [id, path] of streams) await attempt(id, async () => {
        const since = this.state().cursors[id]
        const items = await api.pages(`${path}&sort=updated&direction=asc&since=${encodeURIComponent(since)}`)
        this.guard(c)
        this.host.store.atomic(() => {
          for (const item of items) {
            const raw = CommentSchema.parse(item), at = raw.updated_at || raw.created_at
            if (!at || !Number.isFinite(Date.parse(at))) throw Error('GitHub item has an invalid timestamp')
            if (Date.parse(at) < Date.parse(this.state().started) || Date.parse(at) > Date.parse(start)) continue
            if (id === 'issues') {
              const issue = IssueSchema.parse(item)
              if (issue.pull_request) this.remember(issue.number)
              // Closing a previously unknown issue must not turn its old body into a new request.
              if (issue.state !== 'closed') this.receive(issueEvent(issue, c), c)
            } else {
              const number = numberFromUrl((id === 'comments' ? raw.issue_url : raw.pull_request_url) || '', c.repository)
              this.receive(commentEvent(raw, number, id === 'comments' ? 'conversation' : 'inline', c), c)
              if (id === 'inline') this.remember(number)
            }
          }
          const cursors = { ...this.state().cursors, [id]: new Date(Math.max(Date.parse(since), Date.parse(start) - 5000)).toISOString() }
          this.update({ cursors })
        })
      })
      const pulls = new Map<number, Pull>()
      await attempt('pulls', async () => { for (const raw of await api.pages('pulls?state=open&sort=updated&direction=desc')) { const pull = PullSchema.parse(raw); this.guard(c); this.remember(pull.number); pulls.set(pull.number, pull) } })
      const tracked = new Set(this.state().pendingPulls)
      for (const ticket of this.host.store.tickets.open()) for (const follow of ticket.follows || []) if (!follow.closed && /^github:\d+$/.test(follow.thread)) tracked.add(Number(follow.thread.slice(7)))
      for (const number of tracked) if (!pulls.has(number)) await attempt(`PR #${number}`, async () => { pulls.set(number, PullSchema.parse(await api.get(`pulls/${number}`))) })
      for (const pull of pulls.values()) await attempt(`PR #${pull.number}`, () => this.pollPull(api, c, pull))
      if (c.observe.ci) await attempt('default branch CI', async () => {
        const head = z.object({ sha: z.string() }).parse(await api.get(`commits/${encodeURIComponent(repo.default_branch)}`))
        await this.ci(api, c, head.sha, undefined, repo.default_branch)
      })
      this.guard(c)
      if (errors.length) throw Error(errors.join('; '))
      this.update({ state: 'ready', lastSuccess: start, error: undefined, failures: 0, nextPollAt: this.now() + c.pollSeconds * 1000 })
    } catch (error) {
      if (this.controller.signal.aborted || error instanceof SourceDeferred) return
      this.rate(error); const failures = this.state().failures + 1
      this.update({ state: 'error', failures, error: String(error).slice(0, 2000), nextPollAt: Math.max(this.now() + Math.min(3600000, c.pollSeconds * 1000 * 2 ** Math.min(failures - 1, 6)), this.host.store.get<number>('github:rate-until') || 0) })
    }
  }
  private remember(number: number): void { const pending = this.state().pendingPulls; if (!pending.includes(number)) this.update({ pendingPulls: [...pending, number] }) }
  private receive(trigger: Trigger | undefined, c: GitHubConfig): void {
    if (!trigger) return
    const kind = trigger.meta.kind
    const observed = trigger.meta.ci ? c.observe.ci : kind === 'issue' ? c.observe.issues : kind === 'pull' ? c.observe.pulls : c.observe.comments
    if (!observed && !trigger.addressed && !this.host.store.threads.get(`github:${trigger.threads[0].id}`)?.subscriptions.length) return
    this.guard(c); this.host.engine.receive(trigger)
    const thread = this.host.store.threads.get(`github:${trigger.threads[0].id}`)
    if (thread) { thread.meta = { ...thread.meta, ...trigger.meta }; this.host.store.threads.save(thread) }
  }
  private claim(ticketId: string, pull: Pull, c: GitHubConfig): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || ticket.ended) throw Error('Ticket has ended')
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    const own = sameLogin(pull.user.login, c.botLogin) && sameLogin(pull.head.repo?.full_name || '', c.repository) && pull.head.ref === `pi-superagent/${ticket.id}`
    const from = origin?.source === 'github' && origin.meta.isPr && origin.meta.number === pull.number && sameLogin(String(origin.meta.repository), c.repository)
    if (!own && !from) throw Error('PR does not belong to this ticket')
    if (pull.base && !sameLogin(pull.base.repo.full_name, c.repository)) throw Error('PR targets another repository')
    if (pull.state !== 'open') throw Error('Cannot bind a closed PR')
    if (this.host.store.tickets.open().some(t => t.id !== ticketId && t.follows?.some(f => f.thread === `github:${pull.number}` && !f.closed))) throw Error('PR already belongs to another ticket')
    this.host.engine.bindThread(ticketId, { source: 'github', id: String(pull.number) }, own); this.remember(pull.number)
  }
  bind(ticketId: string, number: number, valid: () => void = () => {}): Promise<unknown> {
    return this.track((async () => {
      const c = this.config(), api = this.client(c); await api.verify(c.botLogin)
      const pull = PullSchema.parse(await api.get(`pulls/${z.number().int().positive().safe().parse(number)}`))
      this.guard(c); valid(); this.host.store.atomic(() => this.claim(ticketId, pull, c)); return this.host.store.tickets.get(ticketId)
    })())
  }
  createPull(ticketId: string, title: string, body: string, valid: () => void): Promise<unknown> {
    return this.track((async () => {
      const c = this.config(), api = this.client(c); await api.verify(c.botLogin)
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || ticket.ended) throw Error('Ticket has ended')
      const head = `pi-superagent/${ticketId}`
      const marker = `<!-- pi-superagent:${this.host.config().instanceId}:ticket:${ticketId} -->`
      const candidates = (await api.pages(`pulls?state=all&head=${encodeURIComponent(c.repository.split('/')[0] + ':' + head)}`)).map(p => PullSchema.parse(p))
      const old = candidates.find(p => sameLogin(p.user.login, c.botLogin) && sameLogin(p.head.repo?.full_name || '', c.repository) && p.head.ref === head)
      this.guard(c); valid()
      if (old) { if (old.state === 'open') this.host.store.atomic(() => this.claim(ticketId, old, c)); return old }
      const repo = z.object({ default_branch: z.string() }).parse(await api.get(''))
      this.guard(c); valid()
      if (this.host.config().paused) throw new SourceDeferred('Dispatch paused')
      const pull = PullSchema.parse(await api.post('pulls', { title, body: `${body}\n\n${marker}`, head, base: repo.default_branch, draft: true }))
      this.guard(c); valid(); this.host.store.atomic(() => this.claim(ticketId, pull, c)); return pull
    })())
  }
  private async pollPull(api: GitHubApi, c: GitHubConfig, pull: Pull): Promise<void> {
    this.guard(c)
    if (pull.state === 'open' && sameLogin(pull.user.login, c.botLogin) && sameLogin(pull.head.repo?.full_name || '', c.repository)) {
      const ticket = this.host.store.tickets.open().find(t => pull.head.ref === `pi-superagent/${t.id}`)
      if (ticket) this.host.store.atomic(() => this.claim(ticket.id, pull, c))
    }
    const reviews = await api.pages(`pulls/${pull.number}/reviews`); this.guard(c)
    this.host.store.atomic(() => {
      for (const raw of reviews) { const review = CommentSchema.parse(raw); if (Date.parse(review.updated_at || review.submitted_at || '') >= Date.parse(this.state().started)) this.receive(commentEvent(review, pull.number, 'review', c), c) }
    })
    const subscribed = this.host.store.tickets.open().some(t => t.follows?.some(f => f.thread === `github:${pull.number}` && !f.closed))
    if (pull.state === 'open' && subscribed) await this.ci(api, c, pull.head.sha, pull.number)
    this.guard(c)
    this.host.store.atomic(() => {
      if (pull.state === 'closed' || pull.merged) this.host.engine.threadClosed({ source: 'github', id: String(pull.number) }, pull.merged || pull.merged_at ? 'merged' : 'closed', pull.merged_at || pull.closed_at || new Date(this.now()).toISOString())
      this.update({ pendingPulls: this.state().pendingPulls.filter(n => n !== pull.number) })
    })
  }
  private async ci(api: GitHubApi, c: GitHubConfig, sha: string, number?: number, branch?: string): Promise<void> {
    const checks = z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })).parse(await api.pages(`commits/${encodeURIComponent(sha)}/check-runs`, 'check_runs'))
    const statuses = z.array(z.object({ context: z.string(), state: z.string() })).parse(await api.pages(`commits/${encodeURIComponent(sha)}/statuses`))
    const latest = new Map<string, string>(); for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
    const failures = [...checks.filter(x => x.status === 'completed' && !['success', 'neutral', 'skipped'].includes(x.conclusion || '')).map(x => `check:${x.name}:${x.conclusion}`), ...[...latest].filter(([, state]) => ['failure', 'error'].includes(state)).map(([name, state]) => `status:${name}:${state}`)].sort()
    const running = checks.some(x => x.status !== 'completed') || [...latest.values()].includes('pending')
    const name = number ? `github:ci:pr:${number}` : 'github:branch-baseline'
    const previous = this.host.store.get<{ failures: string[]; revision: number; branch?: string }>(name)
    const known = previous && (number || previous.branch === branch) ? previous : undefined
    const definitive = !running && (checks.length > 0 || latest.size > 0)
    const current = failures.length || definitive ? failures : known?.failures || []
    this.guard(c)
    this.host.store.atomic(() => {
      let revision = previous?.revision || 0
      if ((known && JSON.stringify(current) !== JSON.stringify(known.failures)) || (number && !known && current.length)) {
        revision++
        const thread = number ? String(number) : `ci:${branch}`
        this.receive({ id: key('github-ci', c.repository.toLowerCase(), thread, String(revision)), source: 'github', actor: { source: 'github', id: '' }, human: false,
          threads: [{ source: 'github', id: thread }], at: new Date(this.now()).toISOString(), text: `CI ${number ? `PR #${number}` : branch} @ ${sha}: ${current.length ? current.join(', ') : 'recovered'}`,
          meta: { repository: c.repository, ci: true, sha, ...(number ? { number, isPr: true } : { branch }) } }, c)
      }
      this.host.store.set(name, { failures: current, revision, branch })
    })
  }
  readContext(request: ReadRequest): Promise<unknown> {
    return this.track((async () => {
      const c = this.config(), api = this.client(c), [number, section, messageId] = (request.id || '').split('/')
      if (!/^\d+$/.test(number) || !Number.isSafeInteger(Number(number)) || Number(number) < 1) throw Error('Invalid GitHub conversation')
      await api.verify(c.botLogin); this.guard(c)
      const parse = (raw: unknown) => z.looseObject({ id: z.number(), body: z.string().nullable().optional(), title: z.string().optional(), user: z.object({ login: z.string() }).nullable().optional(), issue_url: z.string().optional(), pull_request_url: z.string().optional(), html_url: z.string().optional(), state: z.string().optional(), created_at: z.string().optional() }).parse(raw)
      if (request.kind === 'github-message') {
        if (!messageId || !/^\d+$/.test(messageId) || !['comments', 'inline', 'reviews'].includes(section)) throw Error('Invalid GitHub message reference')
        const path = section === 'comments' ? `issues/comments/${messageId}` : section === 'inline' ? `pulls/comments/${messageId}` : `pulls/${number}/reviews/${messageId}`
        const message = parse(await api.get(path)); this.guard(c)
        if (numberFromUrl(message.issue_url || message.pull_request_url || message.html_url || '', c.repository) !== Number(number)) throw Error('Message belongs to another conversation')
        return { id: request.id, from: message.user?.login, ...textPage(message.body || '', request.offset) }
      }
      const selected = request.section || 'issue'
      if (selected === 'issue') {
        const issue = parse(await api.get(`issues/${number}`)); this.guard(c)
        return { id: number, title: issue.title, state: issue.state, from: issue.user?.login, ...textPage(issue.body || '', request.offset), comments: { kind: 'github', id: number, section: 'comments' } }
      }
      if (request.offset % 20) throw Error('GitHub page offsets must be multiples of 20')
      const path = selected === 'comments' ? `issues/${number}/comments` : `pulls/${number}/${selected === 'inline' ? 'comments' : 'reviews'}`
      const items = z.array(z.unknown()).max(100).parse(await api.get(`${path}?per_page=20&page=${request.offset / 20 + 1}`)).map(parse); this.guard(c)
      return { items: items.slice(0, 20).map(m => ({ id: m.id, from: m.user?.login, at: m.created_at, ...clip(m.body || ''), read: { kind: 'github-message', id: `${number}/${selected}/${m.id}` } })), ...(items.length >= 20 ? { next_offset: request.offset + 20 } : {}) }
    })())
  }
  send(message: OutboundMessage, valid: () => void = () => {}): Promise<'sent' | 'dropped'> {
    return this.track((async () => {
      const c = this.config(), api = this.client(c)
      await api.verify(c.botLogin)
      const guard = () => { this.guard(c); if (this.host.config().paused) throw new SourceDeferred('Dispatch paused'); valid() }
      guard(); return sendGitHub(api, c, this.host.config().instanceId, message, guard)
    })())
  }
  private track<T>(promise: Promise<T>): Promise<T> { this.operations.add(promise); return promise.catch(error => { this.rate(error); throw error }).finally(() => this.operations.delete(promise)) }
  async close(): Promise<void> { this.controller.abort(); await Promise.allSettled([...(this.running ? [this.running] : []), ...this.operations]) }
}
