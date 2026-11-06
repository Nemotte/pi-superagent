import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { Engine, key, latestAssignment, latestReport, liveTicket, type AssessmentOutcome, type OutboundMessage, type Policy, type Ticket, type Trigger } from './core/index.js'
import { ConfigSchema, readConfig, type Config } from './config.js'
import { Store, type Effect } from './store.js'
import { prepareWorktree } from './workspace.js'
import { captureWorkspace, prepareWorkspace, workspaceStatus, type WorkspaceSnapshot } from './multi-workspace.js'
import type { AgentDriver, AgentEvent, AgentTarget } from './agent-protocol.js'
import { policy, policyEffects, sourceScope } from './policy.js'
import { GitHubSource, SourceDeferred, type GitHubClientFactory } from './sources/github-source.js'
import { GitHubError } from './sources/github-client.js'
import { sameLogin } from './sources/github-config.js'
import { AssessmentSchema, assessmentOutcome } from './assessment.js'
import { domainNotice, followupRelay, reportRelay, triggerCard, ticketCard } from './notices.js'
import { ContextReader, candidateCard, inputCard, instructionContext } from './context.js'
import { attention } from './attention.js'
import { readiness } from './panel.js'
import { registeredService } from './supervision-config.js'

export const RequestSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default(() => randomUUID()), text: z.string().trim().min(1).max(20000) }).strict()
const RouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept'), triggerId: z.string(), title: z.string().min(1).max(160), scope: z.string().min(1).max(2000), reason: z.string().min(1).max(1000), acknowledgement: z.string().trim().min(1).max(1000).optional() }).strict(),
  z.object({ kind: z.enum(['ignore', 'unavailable']), triggerId: z.string(), reason: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('stop'), triggerId: z.string(), ticketId: z.string(), reason: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('attach'), triggerId: z.string(), ticketId: z.string() }).strict(),
])
const ReportSchema = z.object({ state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), summary: z.string().min(1).max(8000), question: z.string().min(1).max(1000).nullable().optional(), askedBy: z.string().optional(), answers: z.string().optional(), repositories: z.array(z.object({ id: z.string().max(64), summary: z.string().min(1).max(1500), checks: z.array(z.string().max(500)).max(10) }).strict()).max(32).optional() }).strict()
class Deferred extends Error {}
type Receipt = OutboundMessage & { status: 'pending' | 'sent' | 'dropped' }

/** Owns the database, effects and domain; all model tool requests are authorized here. */
export class Runtime {
  readonly store: Store
  readonly engine: Engine
  readonly github: GitHubSource
  readonly context: ContextReader
  private readonly unlock: () => void
  private readonly running = new Map<number, Promise<void>>()
  private readonly busy = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private closing = false
  private closePromise?: Promise<void>
  constructor(readonly stateDir: string, private readonly driver: AgentDriver, private readonly options: { prepare?: typeof prepareWorktree; githubClient?: GitHubClientFactory; now?: () => number } = {}) {
    const initial = readConfig(stateDir)
    this.unlock = lockSync(stateDir, { stale: 30000 })
    let opened: Store | undefined
    try {
      this.store = opened = new Store(join(stateDir, 'state.sqlite'))
      if (!this.store.get('settings')) this.store.set('settings', { config: initial, revision: 1 })
      const snapshot = this.settings()
      if (!this.store.get(`settings:${snapshot.revision}`)) this.store.set(`settings:${snapshot.revision}`, snapshot)
      this.context = new ContextReader({ store: this.store, settings: () => this.settings(), candidate: id => this.engine.candidate(id), workspace: id => this.workspaceView(id), github: request => this.github.readContext(request) })
      this.engine = new Engine({ repo: this.store, policy: () => this.policy(),
        scope: { scope: input => sourceScope(this.settings().config).scope(input) },
        assessor: { request: candidate => this.store.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0].id }) },
        executor: {
          start: (ticket, assignment) => this.store.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
          deliver: ticket => this.store.enqueue('delivery', ticket.id, { ticketId: ticket.id }),
          stop: (ticket, assignment) => this.store.enqueue('stop', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id }),
        },
        outbox: {
          send: message => { if (!this.store.get(`reply:${message.id}`)) { this.store.set(`reply:${message.id}`, { ...message, status: 'pending', createdAt: new Date().toISOString() }); this.store.enqueue('reply', message.id, {}) } },
          status: id => this.store.get<Receipt>(`reply:${id}`)?.status,
          withdraw: id => { const r = this.store.get<Receipt>(`reply:${id}`); if (r?.status === 'pending') this.store.set(`reply:${id}`, { ...r, status: 'dropped' }) },
        },
        prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: ticket.id, directory: join(stateDir, 'work', ticket.id), assignment: outcome.scope } }),
        emit: event => domainNotice(this.store, event),
      })
      this.github = new GitHubSource({ store: this.store, engine: this.engine, stateDir, config: () => this.settings().config, client: options.githubClient, now: options.now })
      for (const ticket of this.store.tickets.open()) {
        const a = latestAssignment(ticket)
        if (a?.state === 'running') this.engine.assignmentInterrupted(ticket.id, a.id)
        else if (a?.state === 'pending') this.store.enqueue('launch', a.id, { ticketId: ticket.id, assignmentId: a.id })
      }
      for (const thread of this.store.threads.active()) if (thread.evaluating) this.store.enqueue('assessment', thread.evaluating.id, { triggerId: thread.evaluating.triggerIds[0] })
    } catch (error) { opened?.close(); this.unlock(); throw error }
  }
  settings(): { config: Config; revision: number } {
    const value = this.store.get<{ config: unknown; revision: number }>('settings')!
    return { ...value, config: ConfigSchema.parse(value.config) }
  }
  saveSettings(input: unknown, revision: number): ReturnType<Runtime['settings']> {
    const config = ConfigSchema.parse(input)
    return this.store.atomic(() => {
      const old = this.settings()
      if (old.revision !== revision) throw Error('Settings revision conflict')
      if (config.repository !== old.config.repository || config.instanceId !== old.config.instanceId || config.port !== old.config.port) throw Error('Instance identity, repository and port cannot change through runtime settings')
      if (JSON.stringify(config.workspace) !== JSON.stringify(old.config.workspace)) throw Error('Workspace membership cannot change through runtime settings; create another instance')
      if (old.config.github && (!config.github || !sameLogin(config.github.repository, old.config.github.repository) || !sameLogin(config.github.botLogin, old.config.github.botLogin))) throw Error('GitHub repository and bot identity are immutable; disable the source or create a separate instance')
      const before = this.policy().version
      const value = { config, revision: revision + 1 }; this.store.set('settings', value); this.store.set(`settings:${value.revision}`, value)
      const after = this.policy().version
      if (before !== after) this.engine.policyChanged(before, after, policyEffects(this.store.tickets.open(), old.config, config))
      if (JSON.stringify(old.config.team) !== JSON.stringify(config.team)) for (const ticket of this.store.tickets.open()) this.engine.note(ticket.id, `Team instructions changed (revision ${value.revision}); read instructions before continuing. This grants no wider mandate.`)
      this.github.configurationChanged(old.config.github, config.github)
      this.store.audit({ type: 'settings.saved', revision: value.revision })
      this.store.enqueue('notice', 'settings', { kind: 'settings_saved', revision: value.revision, read: { kind: 'settings' } })
      return value
    })
  }
  private policy(): Policy { return policy(this.settings().config) }
  submit(input: unknown): Trigger { return this.manual(RequestSchema.parse(input)) }
  followup(ticketId: string, input: unknown): Trigger {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) throw Error('Unknown ticket')
    if (ticket.ended?.by === 'human') throw Error('Ticket was stopped; create a new request')
    const origin = this.store.triggers.get(ticket.origin.triggerId)!
    if (origin.source === 'manual') return this.manual(RequestSchema.parse(input), origin.threads[0].id)
    return this.store.atomic(() => {
      const trigger = this.manual(RequestSchema.parse(input), `ticket-${ticket.id}`)
      if (!this.store.triggers.disposition(trigger.id)?.fanout.includes(ticket.id)) this.engine.attach(ticket.id, trigger.id)
      return trigger
    })
  }
  private manual(input: z.infer<typeof RequestSchema>, threadId = input.id): Trigger {
    const id = `manual:${input.id}`; const old = this.store.triggers.get(id)
    if (old) {
      if (old.text !== input.text || old.threads[0].id !== threadId) throw Error('Idempotency key reused with different request')
      return old
    }
    const trigger: Trigger = { id, source: 'manual', actor: { source: 'manual', id: 'administrator' }, human: true, addressed: 'direct',
      threads: [{ source: 'manual', id: threadId }], at: new Date().toISOString(), text: input.text,
      channel: { source: 'manual', thread: threadId, address: {} }, meta: {} }
    this.engine.receive(trigger); return trigger
  }
  attention() {
    const result = attention(this.store), source = this.github.status()
    if ('failures' in source && source.failures >= 3) {
      result.total++; result.problems.unshift({ kind: 'github', key: 'source', attempts: source.failures, error: source.error || 'GitHub source repeatedly failed' })
    }
    return result
  }
  async workspaceView(ticketId?: string): Promise<{ repositories: unknown[]; [key: string]: unknown }> {
    const config = this.settings().config
    const ticket = ticketId ? this.store.tickets.get(ticketId) : undefined
    if (ticketId && !ticket) throw Error('Unknown ticket')
    const snapshot = ticketId && this.store.get<WorkspaceSnapshot>(`workspace:${ticketId}`)
    const result = ticketId && this.store.get<{ report: unknown; read?: unknown }>(`workspace-result:${ticketId}`)
    let repositories: unknown[] = config.workspace?.repositories || [{ id: 'repository', path: '.' }]
    let error: string | undefined
    if (snapshot && ticket?.execution) {
      try { repositories = await workspaceStatus(snapshot, ticket.execution.directory, ticket.id) }
      catch (e) { error = String(e).slice(0, 500); repositories = snapshot.repositories.map(r => ({ id: r.id, path: r.path, baseHead: r.head, state: 'unavailable' })) }
    }
    return { kind: config.workspace ? 'workspace' : 'repository', root: config.repository, ...(ticketId ? { ticketId } : {}), prepared: !!snapshot && !error, repositories, ...(error ? { error } : {}), ...(result ? { report: result.report, reportRead: result.read } : {}) }
  }
  overview() {
    const tickets = this.store.tickets.list(), registration = registeredService(this.stateDir)
    return { protocol: 1, version: '0.1.0-alpha.1', instanceId: this.settings().config.instanceId,
      workspace: { root: this.settings().config.repository, repositories: this.settings().config.workspace?.repositories || [{ id: 'repository', path: '.' }], kind: this.settings().config.workspace ? 'workspace' : 'repository' },
      supervision: registration ? { kind: registration.kind, unitName: registration.unitName } : { kind: 'detached' },
      paused: this.settings().config.paused, busyWorkers: this.busy.size, tickets: tickets.length,
      needsAttention: this.attention().total,
      readiness: readiness(this.settings().config, this.attention().total),
      pendingEffects: this.store.pendingEffects().length,
      problems: this.store.pendingEffects().filter(e => e.attempts > 0).map(e => ({ kind: e.kind, key: e.key, attempts: e.attempts, error: e.error })),
      sources: [{ id: 'manual', state: 'ready' }, this.github.status(), { id: 'feishu', state: 'deferred' }],
      modelsConfigured: !!this.settings().config.routerModel && !!this.settings().config.workerModel }
  }
  start(): void { this.timer ??= setInterval(() => { void this.tick().catch(error => console.error('scheduler:', String(error))) }, 500) }
  async tick(): Promise<void> {
    if (this.closing) return
    this.engine.evaluateDue()
    const tasks: Promise<void>[] = [this.github.tick()]
    for (const row of this.store.pendingEffects().filter(e => e.due <= Date.now()).slice(0, 100)) {
      if (this.running.has(row.seq) || (this.settings().config.paused && row.kind !== 'stop')) continue
      const task = Promise.resolve().then(() => this.effect(row)).then(() => this.store.finishEffect(row)).catch(error => {
        if (this.closing) return
        if (error instanceof Deferred || error instanceof SourceDeferred) this.store.deferEffect(row)
        else { this.store.failEffect(row, String(error)); if (error instanceof GitHubError && error.retryAt) this.store.deferEffect(row, Math.max(1000, error.retryAt - Date.now())) }
      }).finally(() => this.running.delete(row.seq))
      this.running.set(row.seq, task); tasks.push(task)
    }
    await Promise.all(tasks)
  }
  private target(ticket?: Ticket): AgentTarget {
    const { config, revision } = this.settings()
    const instructions = JSON.stringify(instructionContext(config, revision, ticket))
    return { role: ticket ? 'worker' : 'router', key: ticket ? `worker-${ticket.id}` : 'router',
      cwd: ticket?.execution?.directory ?? this.stateDir, agentDir: join(this.stateDir, 'agent'),
      sessionDir: join(this.stateDir, 'sessions', ticket?.id ?? 'router'), model: ticket ? config.workerModel : config.routerModel,
      github: !!config.github?.enabled && !config.workspace,
      instructions: `${instructions}\n${ticket ? `Authorized scope: ${ticket.mandate.scope}. Ticket branch: pi-superagent/${ticket.id}.` : ''}${config.github?.enabled ? ` GitHub repository/account: ${config.github.repository} / ${config.github.botLogin}` : ''}`,
      ...(config.workspace ? { workspace: { ...config.workspace, instructions: ticket ? this.store.get<WorkspaceSnapshot>(`workspace:${ticket.id}`)?.instructions : undefined } } : {}),
      ...(ticket ? { ticketId: ticket.id, assignmentId: latestAssignment(ticket)!.id } : {}) }
  }
  private current(target: AgentTarget): Ticket {
    const ticket = target.ticketId && this.store.tickets.get(target.ticketId)
    if (!ticket || ticket.ended || latestAssignment(ticket)?.id !== target.assignmentId) throw Error('Stale or ended assignment')
    return ticket
  }
  private reserve(ticket: Ticket, human = false): void {
    if (this.busy.has(ticket.id)) return
    if (this.busy.size >= this.settings().config.maxWorkers + Number(human)) throw new Deferred('Worker slots full')
    this.busy.add(ticket.id)
  }
  private async effect(row: Effect): Promise<void> {
    const p = row.payload as { triggerId?: string; ticketId?: string; assignmentId?: string }
    if (row.kind === 'relay' || row.kind === 'notice') {
      if (this.store.pendingEffects().some(e => e.kind === row.kind && e.seq < row.seq)) throw new Deferred('Earlier Router message is pending')
      if (row.kind === 'notice' && !this.store.get('router-started')) throw new Deferred('Background notices do not start Router')
      const payload = row.payload as { kind: string; triggerId?: string }
      const message = payload.kind === 'follow_up' ? followupRelay(this.store, payload.triggerId!) : payload
      if (message) { await this.driver.send(this.target(), { id: `${row.kind}:${row.seq}:${row.generation}`, text: JSON.stringify(message), ...(row.kind === 'notice' ? { wake: false as const } : {}) }); this.store.set('router-started', true) }
      return
    }
    if (row.kind === 'assessment') {
      const candidate = this.engine.candidate(p.triggerId!)
      if (!candidate || candidate.evalId !== row.key) return
      await this.driver.send(this.target(), { id: `eval:${candidate.evalId}`, text: JSON.stringify(candidateCard(candidate, this.settings().config, this.store)) })
      this.store.set('router-started', true); this.engine.candidateDelivered(candidate.evalId); return
    }
    if (row.kind === 'stop') {
      // Stop the process before a replacement Assignment can launch.
      await this.driver.stop(`worker-${p.ticketId}`); this.busy.delete(p.ticketId!); return
    }
    if (row.kind === 'reply') {
      const receipt = this.store.get<Receipt>(`reply:${row.key}`)
      if (receipt?.status !== 'pending') return
      const earlier = this.store.pendingEffects().some(e => {
        if (e.kind !== 'reply' || e.seq >= row.seq || e.attempts >= 3) return false
        const previous = this.store.get<Receipt>(`reply:${e.key}`)
        return previous?.status === 'pending' && previous.ticketId === receipt.ticketId && previous.channel.source === receipt.channel.source && previous.channel.thread === receipt.channel.thread
      })
      if (earlier) throw new Deferred('Earlier reply to this conversation is pending')
      const status = receipt.channel.source === 'manual' ? 'sent' : receipt.channel.source === 'github' ? await this.github.send(receipt, () => {
        if (this.store.get<Receipt>(`reply:${row.key}`)?.status !== 'pending') throw new SourceDeferred('Reply withdrawn')
      }) : undefined
      if (!status) throw Error('Outbound source adapter is not installed')
      this.store.atomic(() => { this.store.set(`reply:${row.key}`, { ...receipt, status }); this.store.audit({ type: `reply.${status}`, message: receipt }) }); return
    }
    const ticket = p.ticketId && this.store.tickets.get(p.ticketId)
    if (!ticket || !liveTicket(ticket)) return
    if (this.store.pendingEffects().some(e => e.kind === 'stop' && (e.payload as { ticketId: string }).ticketId === ticket.id)) throw new Deferred('Waiting for old assignment to stop')
    let target = this.target(ticket)
    if (row.kind === 'launch') {
      if (latestAssignment(ticket)?.id !== p.assignmentId) return
      this.reserve(ticket)
      try {
        const config = this.settings().config
        if (config.workspace) {
          let snapshot = this.store.get<WorkspaceSnapshot>(`workspace:${ticket.id}`)
          if (!snapshot) { snapshot = await captureWorkspace(config.repository, config.workspace); this.store.set(`workspace:${ticket.id}`, snapshot) }
          await prepareWorkspace(snapshot, ticket.execution!.directory, ticket.id)
          target = this.target(ticket)
        } else await (this.options.prepare ?? prepareWorktree)(config.repository, ticket.execution!.directory, ticket.id)
        this.current(target)
        if (this.settings().config.paused) throw new Deferred('Paused')
        this.engine.assignmentStarted(ticket.id, p.assignmentId!)
        const card = await this.context.read({ kind: 'ticket', id: ticket.id }, ticket)
        const current = this.current(target)
        if (this.settings().config.paused) throw new Deferred('Paused')
        await this.driver.send(target, { id: `assignment:${p.assignmentId}`, text: JSON.stringify({ kind: 'assignment', ticket: card, request: triggerCard(this.store.triggers.get(ticket.origin.triggerId)!), instructions: instructionContext(this.settings().config, this.settings().revision, current) }) })
      } catch (error) { this.busy.delete(ticket.id); throw error }
    } else if (row.kind === 'delivery') {
      if (latestAssignment(ticket)?.state !== 'running' || this.store.pendingEffects().some(e => e.kind === 'launch' && (e.payload as { ticketId: string }).ticketId === ticket.id)) throw new Deferred('Waiting for assignment launch')
      this.reserve(ticket, ticket.inputs.some(i => ticket.undelivered.includes(i.id) && i.kind === 'trigger' && i.human))
      try {
        for (const id of ticket.undelivered) {
          if (this.settings().config.paused) throw new Deferred('Paused')
          const current = this.current(target); const input = current.inputs.find(i => i.id === id)
          if (!input || !current.undelivered.includes(id)) continue
          await this.driver.send(target, { id, text: JSON.stringify({ kind: 'input', input: inputCard(input, ticket.id, this.store), instructions: instructionContext(this.settings().config, this.settings().revision, current) }) })
          this.current(target); this.engine.inputsDelivered(ticket.id, target.assignmentId!, [id]); this.engine.inputsRead(ticket.id, [id])
        }
      } catch (error) { if (!(error instanceof Deferred)) this.engine.deliveryFailed(ticket.id, target.assignmentId!, String(error)); throw error }
    } else throw Error(`Unknown effect ${row.kind}`)
  }
  private decide(triggerId: string, outcome: AssessmentOutcome, evalId?: string) {
    return this.store.atomic(() => {
      const decision = this.engine.decide(triggerId, { ...outcome, ...(evalId ? { evalId } : {}) })
      if (decision.ticketId && outcome.kind === 'accept') {
        const ticket = this.store.tickets.get(decision.ticketId)!, origin = this.store.triggers.get(ticket.origin.triggerId)
        if (origin?.source === 'github' && origin.meta.isPr && !ticket.follows?.length) this.engine.bindThread(decision.ticketId, origin.threads[0], false)
      }
      return decision
    })
  }
  async tool(target: AgentTarget, name: string, args: unknown): Promise<unknown> {
    if (this.closing) throw Error('Service is stopping')
    if (target.role === 'router') {
      if (target.key !== 'router') throw Error('Invalid router identity')
      if (name === 'read') return this.context.read(args)
      if (name === 'note') {
        const v = z.object({ ticketId: z.string(), text: z.string().trim().min(1).max(1000) }).strict().parse(args)
        return ticketCard(this.engine.note(v.ticketId, v.text))
      }
      if (name === 'status') return this.engine.requestStatus(z.object({ ticketId: z.string() }).strict().parse(args).ticketId)
      if (name === 'reply') {
        const v = z.discriminatedUnion('purpose', [
          z.object({ purpose: z.literal('acknowledgement'), ticketId: z.string(), triggerId: z.string(), text: z.string().trim().min(1).max(1000) }).strict(),
          z.object({ purpose: z.enum(['answer', 'result', 'attention']), ticketId: z.string().optional(), triggerId: z.string().optional(), question: z.string().optional(), text: z.string().trim().min(1).max(4000) }).strict(),
        ]).parse(args)
        if (v.purpose === 'attention' && v.text !== v.question?.trim()) throw Error('Forward the saved question unchanged')
        return this.engine.reply(v)
      }
      if (name === 'assess') {
        const input = AssessmentSchema.parse(args), candidate = this.engine.candidate(input.triggerId)
        if (!candidate || candidate.evalId !== input.evalId || candidate.strength !== 'inferred') throw Error('Stale or non-inferred evaluation')
        return this.decide(input.triggerId, assessmentOutcome(input, this.settings().config), input.evalId)
      }
      if (name === 'route') {
        const r = RouteSchema.parse(args)
        const candidate = this.engine.candidate(r.triggerId)
        if (r.kind === 'attach') {
          if (candidate?.strength !== 'explicit') throw Error('Attach requires an explicit candidate; inferred candidates require assessment')
          return this.engine.attach(r.ticketId, r.triggerId)
        }
        if (r.kind === 'accept' && candidate?.strength !== 'explicit') throw Error('Inferred acceptance requires assessment')
        return this.decide(r.triggerId, r, candidate?.evalId)
      }
      throw Error('Tool is not allowed for this role')
    }
    const ticket = this.current(target)
    if (name === 'read') return this.context.read(args, ticket)
    if (name === 'ack') {
      const v = z.object({ triggerId: z.string(), text: z.string().trim().min(1).max(1000) }).strict().parse(args)
      return this.engine.reply({ purpose: 'acknowledgement', ticketId: ticket.id, ...v })
    }
    if (name === 'follow') {
      const v = z.object({ source: z.enum(['github', 'manual']), id: z.string().min(1).max(200), reason: z.string().min(1).max(1000) }).strict().parse(args)
      if (v.source === 'github' && (!this.settings().config.github?.enabled || !/^\d+$/.test(v.id))) throw Error('Follow requires a configured repository issue/PR number')
      return this.store.atomic(() => {
        const result = this.engine.followForContext(ticket.id, { source: v.source, id: v.id })
        if (result) this.store.enqueue('notice', `follow:${ticket.id}:${v.source}:${v.id}`, { kind: 'context_followed', ticketId: ticket.id, thread: `${v.source}:${v.id}`, reason: v.reason })
        return result
      })
    }
    if (name === 'unrelated') {
      const v = z.object({ thread: z.string(), reason: z.string().min(1).max(1000) }).strict().parse(args)
      return this.engine.markUnrelated(ticket.id, v.thread, v.reason)
    }
    if (name === 'github_bind_pull') {
      const input = z.object({ number: z.number().int().positive().safe() }).strict().parse(args)
      return this.github.bind(ticket.id, input.number, () => { this.current(target) })
    }
    if (name === 'github_create_pull') {
      const input = z.object({ title: z.string().trim().min(1).max(160), body: z.string().max(20000) }).strict().parse(args)
      return this.github.createPull(ticket.id, input.title, input.body, () => { this.current(target) })
    }
    if (name === 'report') {
      const report = ReportSchema.parse(args), config = this.settings().config
      let observed: Awaited<ReturnType<typeof workspaceStatus>> | undefined
      if (config.workspace) {
        const ids = (report.repositories || []).map(r => r.id)
        if (new Set(ids).size !== ids.length || ids.some(id => !config.workspace!.repositories.some(r => r.id === id))) throw Error('Report contains unknown or duplicate workspace repositories')
        if (report.state === 'ready') {
          if (!report.repositories) throw Error('Workspace ready report requires repositories results and checks')
          const snapshot = this.store.get<WorkspaceSnapshot>(`workspace:${ticket.id}`)
          if (!snapshot) throw Error('Workspace was not prepared')
          observed = await workspaceStatus(snapshot, ticket.execution!.directory, ticket.id)
          const missing = observed.filter(r => r.changed && !ids.includes(r.id)).map(r => r.id)
          if (missing.length) throw Error(`Report is missing changed repositories: ${missing.join(', ')}`)
          this.current(target)
        }
      }
      return this.store.atomic(() => {
        const result = this.engine.report(ticket.id, report)
        const reportId = reportRelay(this.store, result, report)
        if (config.workspace) this.store.set(`workspace-result:${ticket.id}`, { report, observed, ...(reportId ? { read: { kind: 'report', id: reportId } } : {}) })
        this.store.audit({ type: 'worker.report', ticketId: ticket.id, report }); return ticketCard(result)
      })
    }
    if (name === 'handback') {
      const v = z.object({ triggerId: z.string(), reason: z.string().min(1).max(1000) }).strict().parse(args)
      return this.engine.handback(ticket.id, v.triggerId, v.reason)
    }
    throw Error('Tool is not allowed for this role')
  }
  event(target: AgentTarget, event: AgentEvent): void {
    if (this.closing || target.role !== 'worker') return
    let ticket: Ticket
    try { ticket = this.current(target) } catch { return }
    if (event.type === 'read' && event.deliveryId) this.engine.inputsRead(ticket.id, [event.deliveryId])
    if (event.type === 'settled' || event.type === 'error') {
      this.busy.delete(ticket.id)
      if (event.type === 'error' || event.failed) this.store.atomic(() => {
        const report = { state: 'failed' as const, summary: event.error || 'Agent run failed' }
        reportRelay(this.store, this.engine.report(ticket.id, report), report)
      })
      else {
        this.engine.turnEnded(ticket.id, target.assignmentId!)
        const report = latestReport(this.store.tickets.get(ticket.id)!)
        if (!report || report.state === 'progress') this.engine.report(ticket.id, { state: 'waiting', summary: 'Waiting for further input' })
      }
    }
  }
  close(): Promise<void> { return this.closePromise ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closing = true; if (this.timer) clearInterval(this.timer)
    try { await Promise.all([this.github.close(), this.driver.close()]); await Promise.allSettled(this.running.values()) }
    finally { this.store.close(); this.unlock() }
  }
}
