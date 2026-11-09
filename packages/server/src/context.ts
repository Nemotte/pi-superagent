import { closeSync, fstatSync, openSync, readSync, realpathSync, readdirSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep, join } from 'node:path'
import { z } from 'zod'
import { threadKey, type Candidate, type Ticket, type TicketInput } from './core/index.js'
import type { Config } from './config.js'
import type { Store } from './store.js'
import { clip, ticketCard, triggerCard } from './notices.js'
export const ReadKinds = ['tickets', 'ticket', 'trigger', 'thread', 'inputs', 'input', 'assignments', 'assignment', 'report', 'settings', 'instructions', 'rule', 'candidate', 'file', 'directory', 'workspace', 'github', 'github-message'] as const
export const ReadSchema = z.object({ kind: z.enum(ReadKinds).default('ticket'), id: z.string().max(300).optional(), offset: z.number().int().min(0).max(10000000).default(0), limit: z.number().int().min(1).max(50).default(20), path: z.string().max(1000).optional(), section: z.enum(['issue', 'comments', 'reviews', 'inline']).optional() }).strict()
export type ReadRequest = z.infer<typeof ReadSchema>
export function textPage(text: string, offset = 0) { return { text: text.slice(offset, offset + 4000), offset, chars: text.length, ...(offset + 4000 < text.length ? { next_offset: offset + 4000 } : {}) } }
const listPage = <T>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit), total: items.length, ...(offset + limit < items.length ? { next_offset: offset + limit } : {}) })
/** Explicit repository reads never follow paths outside the chosen worktree/repository. */
export function repositoryPath(repository: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.git' || p === '.pi')) throw Error('Invalid repository-relative path')
  const root = realpathSync(repository), file = realpathSync(resolve(root, path)), rel = relative(root, file)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw Error('Path escapes repository')
  return file
}
export function repositoryFile(repository: string, path: string): string {
  const fd = openSync(repositoryPath(repository, path), 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('Repository text file exceeds read budget or is not a regular file')
    const data = Buffer.alloc(2 * 1024 * 1024 + 1); let size = 0, n
    while (size < data.length && (n = readSync(fd, data, size, data.length - size, null)) > 0) size += n
    if (size === data.length) throw Error('Repository text file exceeds read budget')
    const text = data.subarray(0, size); if (text.includes(0)) throw Error('Repository file is binary')
    return text.toString('utf8')
  } finally { closeSync(fd) }
}
export function instructionContext(config: Config, revision: number, ticket?: Ticket) {
  return { revision, team: config.team, ...(config.workspace ? { workspace: { repositories: config.workspace.repositories, read: { kind: 'workspace', ...(ticket ? { id: ticket.id } : {}) }, execution: 'One ticket workspace preserves repository paths; each repository has its own Git branch. Availability does not expand the mandate.' } } : {}), ...(ticket ? { mandate: ticket.mandate, matchedRules: (ticket.mandate.basis.rules || []).map(id => {
    const rule = config.rules.find(r => r.id === id); return rule || { id, enabled: false, instruction: 'This matched rule was removed; do not expand work.' }
  }) } : { mode: config.mode, rules: config.rules.filter(r => r.enabled) }) }
}
export function inputCard(input: TicketInput, ticketId: string, store: Store) {
  const trigger = input.kind === 'trigger' && store.triggers.get(input.triggerId)
  return { id: input.id, kind: input.kind, at: input.at, ...(trigger ? { trigger: triggerCard(trigger) } : { summary: clip(JSON.stringify(input)) }), read: { kind: 'input', id: `${ticketId}/${input.id}` } }
}
export function candidateCard(candidate: Candidate, config: Config, store: Store) {
  return { kind: 'candidate', evalId: candidate.evalId, policyVersion: candidate.policyVersion, strength: candidate.strength,
    triggers: candidate.triggers.slice(0, 8).map(triggerCard), triggers_total: candidate.triggers.length,
    thread: { key: candidate.thread.key, read: { kind: 'thread', id: candidate.thread.key } },
    tickets: candidate.tickets.slice(0, 8).map(ticketCard), tickets_total: candidate.tickets.length,
    mode: config.mode, rules: config.rules.filter(r => r.enabled).map(r => ({ id: r.id, ...clip(r.instruction, 400), read: { kind: 'rule', id: r.id } })),
    handbacks: candidate.triggers.slice(0, 8).flatMap(t => (store.triggers.disposition(t.id)?.handbacks || []).slice(0, 8).map(h => ({ ticketId: h.ticketId, ...clip(h.reason, 300) }))),
    read: { kind: 'candidate', id: candidate.triggers[0].id } }
}
export function workspaceReadPath(config: Config, path: string): string {
  const file = repositoryPath(config.repository, path)
  if (!config.workspace) return file
  const root = realpathSync(config.repository), rel = relative(root, file).split(sep).join('/')
  const members = config.workspace.repositories.map(r => r.path)
  const owner = members.filter(p => p === '.' || rel === p || rel.startsWith(p + '/')).sort((a, b) => b.length - a.length)[0]
  const parts = rel.split('/').filter(Boolean)
  if (owner) for (let i = owner === '.' ? 0 : owner.split('/').length; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/') || '.'
    if (existsSync(join(root, p, '.git')) && !members.includes(p)) throw Error('Path belongs to an unregistered nested repository')
  }
  const inside = !!owner
  const connection = statSync(file).isDirectory() && members.some(p => !rel || p.startsWith(rel + '/'))
  if (!inside && !connection && !['AGENTS.md', 'README.md'].includes(rel)) throw Error('Path is outside selected workspace repositories')
  return file
}
export interface ContextHost { workspace?(ticketId?: string): Promise<{ repositories: unknown[]; [key: string]: unknown }>; store: Store; settings(): { config: Config; revision: number }; candidate(id: string): Candidate | undefined; github(request: ReadRequest): Promise<unknown> }
/** Read surface, not a second domain writer. Workers see only their Ticket and related Threads. */
export class ContextReader {
  constructor(private host: ContextHost) {}
  async read(input: unknown, own?: Ticket): Promise<unknown> {
    const r = ReadSchema.parse(input), store = this.host.store, { config, revision } = this.host.settings()
    const requireTicket = () => {
      const id = r.id || own?.id; if (own && id !== own.id) throw Error('Worker may read only its own ticket')
      const t = id && store.tickets.get(id); if (!t) throw Error('Unknown ticket'); return t
    }
    const threadAllowed = (key: string) => !own || store.threads.get(key)?.subscriptions.includes(own.id) || store.triggers.get(own.origin.triggerId)?.threads.some(ref => threadKey(ref) === key)
    if (r.kind === 'workspace') {
      if (own && r.id && r.id !== own.id) throw Error('Workspace outside own ticket')
      if (!this.host.workspace) throw Error('Workspace context unavailable')
      const { repositories, ...metadata } = await this.host.workspace(own?.id || r.id)
      const { report, ...card } = metadata
      return { ...card, ...(report ? { report: clip(JSON.stringify(report), 600) } : {}), ...listPage(repositories.map(item => {
        const row = item as Record<string, unknown>
        return { ...row, ...(Array.isArray(row.files) ? { files: row.files.slice(0, 8).map(p => String(p).slice(0, 120)) } : {}) }
      }), r.offset, r.limit) }
    }
    if (r.kind === 'instructions') {
      if (own && r.id && r.id !== own.id) throw Error('Instructions outside own ticket')
      const t = own || (r.id ? store.tickets.get(r.id) : undefined)
      if (r.id && !t) throw Error('Unknown ticket')
      return instructionContext(config, revision, t)
    }
    if (r.kind === 'rule') {
      if (own && !own.mandate.basis.rules?.includes(r.id!)) throw Error('Rule outside ticket scope')
      const rule = config.rules.find(rule => rule.id === r.id); if (!rule) throw Error('Unknown rule')
      return { id: rule.id, enabled: rule.enabled, ...textPage(rule.instruction, r.offset) }
    }
    if (r.kind === 'settings' || r.kind === 'tickets' || r.kind === 'candidate' || r.kind === 'file' || r.kind === 'directory') {
      if (own) throw Error('Read access is restricted to own ticket resources')
      if (r.kind === 'settings') return { revision, config }
      if (r.kind === 'tickets') return listPage(store.tickets.list().reverse().map(ticketCard), r.offset, r.limit)
      if (r.kind === 'candidate') {
        const c = r.id && this.host.candidate(r.id); if (!c) throw Error('Evaluation is no longer active')
        return { ...candidateCard(c, config, store), batch: listPage(c.triggers.map(triggerCard), r.offset, r.limit) }
      }
      if (!r.path) throw Error('Repository path is required')
      const path = workspaceReadPath(config, r.path)
      if (r.kind === 'file') return { path: r.path, ...textPage(repositoryFile(config.repository, r.path), r.offset) }
      const entries = readdirSync(path).filter(name => { try { workspaceReadPath(config, join(r.path!, name)); return true } catch { return false } }).sort()
      return listPage(entries, r.offset, r.limit)
    }
    if (r.kind === 'ticket') {
      const t = requireTicket()
      return { ...ticketCard(t), mandate: t.mandate, origin: { triggerId: t.origin.triggerId, triggerIds: t.origin.triggerIds.slice(0, 20), total: t.origin.triggerIds.length }, attention: t.attention, attentionResponse: t.attention && store.get(`attention-response:${t.attention.id}`), follows: t.follows,
        threads: store.threads.list().filter(thread => thread.subscriptions.includes(t.id)).slice(0, 20).map(thread => ({ key: thread.key, context: !!thread.context?.includes(t.id), read: { kind: 'thread', id: thread.key } })),
        ...(config.workspace ? { workspace: { kind: 'workspace', id: t.id } } : {}),
        inputs: { total: t.inputs.length, read: { kind: 'inputs', id: t.id } }, assignments: { total: t.assignments.length, read: { kind: 'assignments', id: t.id } } }
    }
    if (r.kind === 'inputs') { const t = requireTicket(); return listPage(t.inputs.map(i => inputCard(i, t.id, store)), r.offset, r.limit) }
    if (r.kind === 'assignments') { const t = requireTicket(); return listPage(t.assignments.map(a => ({ ...a, report: a.report && { ...a.report, summary: clip(a.report.summary) }, read: { kind: 'assignment', id: `${t.id}/${a.id}` } })), r.offset, r.limit) }
    if (r.kind === 'input' || r.kind === 'assignment') {
      const [ticketId, id] = (r.id || '').split('/'); if (own && ticketId !== own.id) throw Error('Input outside own ticket')
      const t = store.tickets.get(ticketId)
      const i = r.kind === 'input' ? t?.inputs.find(i => i.id === id) : t?.assignments.find(a => a.id === id)
      if (!i) throw Error('Unknown input or assignment')
      return { id, ...textPage(JSON.stringify(i), r.offset) }
    }
    if (r.kind === 'trigger') {
      const t = r.id && store.triggers.get(r.id); if (!t) throw Error('Unknown trigger')
      if (own && !own.origin.triggerIds.includes(t.id) && !own.inputs.some(i => i.kind === 'trigger' && i.triggerId === t.id) && !t.threads.some(ref => threadAllowed(threadKey(ref)))) throw Error('Trigger outside own ticket scope')
      return { ...triggerCard(t), ...textPage(t.text, r.offset) }
    }
    if (r.kind === 'thread') {
      if (!r.id || !threadAllowed(r.id)) throw Error('Thread outside own ticket scope')
      const t = store.threads.get(r.id); if (!t) throw Error('Unknown thread')
      const items = store.threadTriggers(r.id, r.offset, r.limit + 1)
      return { key: t.key, ref: t.ref, items: items.slice(0, r.limit).map(triggerCard), ...(items.length > r.limit ? { next_offset: r.offset + r.limit } : {}),
        ...(!own ? { subscriptions: t.subscriptions, correlated: t.correlated.slice(0, 20) } : {}),
        ...(t.ref.source === 'github' && /^\d+$/.test(t.ref.id) ? { original: { kind: 'github', id: t.ref.id, section: 'issue' } } : {}) }
    }
    if (r.kind === 'report') {
      const saved = store.get<{ ticketId: string; report: { summary: string } }>(`report:${r.id}`)
      if (!saved || (own && saved.ticketId !== own.id)) throw Error('Report outside own ticket scope or missing')
      return { ticketId: saved.ticketId, ...textPage(JSON.stringify(saved.report), r.offset) }
    }
    if (r.kind === 'github' || r.kind === 'github-message') {
      const id = (r.id || '').split('/')[0]
      if (!/^\d+$/.test(id) || !threadAllowed(`github:${id}`)) throw Error('GitHub conversation outside own ticket scope')
      return this.host.github(r)
    }
    throw Error('Unsupported read')
  }
}
