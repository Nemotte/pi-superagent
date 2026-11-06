import { createHash } from 'node:crypto'
import type { Config } from './config.js'
import type { Policy, SourceScope, Ticket, PolicyEffect } from './core/index.js'
import { sameLogin } from './sources/github-config.js'
const defaults = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' } as const
export function sourceScope(c: Config): SourceScope {
  return { scope: ({ source, meta }) => {
    if (source === 'manual') return { listened: true, observed: false }
    const g = c.github
    if (source !== 'github' || !g?.enabled || !sameLogin(String(meta.repository || ''), g.repository)) return { listened: false, reason: 'source_disabled_or_outside_repository' }
    const row = meta.ci ? 'ci' : meta.kind === 'issue' ? 'issues' : meta.kind === 'pull' ? 'pulls' : 'comments'
    return { listened: true, observed: g.observe[row], row }
  } }
}
/** Source reception does not confer authority. Mirrors upstream admission and resume semantics. */
export function policy(c: Config): Policy {
  const g = c.github, scope = sourceScope(c)
  const listed = (id: string) => !!g?.allowedActors.some(v => sameLogin(v, id))
  const bot = (id: string) => !!g?.allowedBots.some(v => sameLogin(v, id))
  const inferred = (rules: readonly string[]) => c.mode === 'auto' && !!rules.length && rules.every(id => c.rules.some(r => r.enabled && r.id === id))
  const admission = (row: string | undefined, cell: keyof typeof defaults) => g?.admission?.[row as 'issues' | 'pulls' | 'comments' | 'ci']?.[cell] ?? defaults[cell]
  return {
    version: createHash('sha256').update(JSON.stringify({ semantics: 'upstream-admission-v1', mode: c.mode, rules: c.rules, github: g && { enabled: g.enabled, repository: g.repository, allowedActors: g.allowedActors, allowedBots: g.allowedBots, admission: g.admission } })).digest('hex'),
    paused: c.paused, evalTimeoutMs: 120000, admitsInferred: inferred,
    gate(trigger, thread, tickets) {
      if (trigger.source === 'manual' && trigger.actor.id === 'administrator' && trigger.human) return { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', source: 'manual' } }
      const received = scope.scope(trigger)
      if (trigger.source !== 'github' || !received.listened || !g || sameLogin(trigger.actor.id, g.botLogin)) return { admissible: false, reason: 'source_disabled_or_outside_repository' }
      const basis = { source: 'github', scope: trigger.meta, row: received.row, sender: trigger.actor.id }
      const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
      if (!trigger.human) {
        if (c.mode === 'off' || (!trigger.addressed && !received.observed) || (trigger.actor.id && !bot(trigger.actor.id))) return { admissible: false, reason: 'admission_ignored' }
        if (trigger.actor.id) return { admissible: true, strength: 'inferred', basis: { ...basis, ...addressed, via: 'bot', observation: { mode: c.mode } } }
        if (admission(received.row, 'unlistedUnaddressed') !== 'inferred') return { admissible: false, reason: 'admission_ignored' }
        return { admissible: true, strength: 'inferred', basis: { ...basis, via: 'admission', cell: 'unlistedUnaddressed', observation: { mode: c.mode } } }
      }
      const allowed = listed(trigger.actor.id)
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...basis, via: 'addressed', addressed: trigger.addressed } }
      const cell = allowed ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
      const grant = trigger.addressed || received.observed ? admission(received.row, cell) : 'ignore'
      if (grant === 'explicit') return { admissible: true, strength: 'explicit', basis: { ...basis, ...addressed, via: 'admission', cell } }
      const participates = [...thread.subscriptions, ...tickets.map(t => t.id)].some(id => !thread.context?.includes(id))
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || c.mode !== 'off') && participates) return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...basis, via: 'followup' } }
      if (grant === 'inferred' && c.mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, ...addressed, via: 'admission', cell, observation: { mode: c.mode } } }
      return { admissible: false, reason: 'admission_ignored' }
    },
    revalidate(mandate) {
      if (mandate.actor.source === 'manual') return mandate.actor.id === 'administrator'
      const basis = mandate.basis, received = scope.scope({ source: mandate.actor.source, meta: basis.scope || {} })
      if (!received.listened || mandate.actor.source !== 'github') return false
      if (basis.via === 'followup') return mandate.strength === 'explicit' || inferred(basis.rules || [])
      if (basis.via === 'bot' && !bot(mandate.actor.id)) return false
      if (basis.via === 'admission') {
        const allowed = listed(mandate.actor.id)
        if (basis.cell === 'unlistedAddressed' && allowed) return true
        const cell = basis.cell === 'unlistedUnaddressed' && allowed ? 'listedUnaddressed' : basis.cell
        if (cell === 'listedUnaddressed' && !allowed) return false
        const strength = { ignore: 0, inferred: 1, explicit: 2 }
        if (strength[admission(received.row, cell)] < strength[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !listed(mandate.actor.id)) return false
      return mandate.strength === 'explicit' || inferred(basis.rules || [])
    },
  }
}
export function policyEffects(tickets: Ticket[], before: Config, after: Config): Map<string, PolicyEffect> {
  const previous = policy(before), current = policy(after), effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const effect: PolicyEffect = {}, changes: NonNullable<PolicyEffect['rules']> = []
    for (const id of ticket.mandate.basis.rules || []) {
      const old = before.rules.find(r => r.id === id), next = after.rules.find(r => r.id === id)
      if (old?.enabled && !next?.enabled) changes.push({ id, name: id, change: 'disabled' })
      else if (next?.enabled && old?.instruction !== next.instruction) changes.push({ id, name: id, change: 'changed', instruction: next.instruction })
    }
    if (changes.length) effect.rules = changes
    if (previous.revalidate(ticket.mandate) && !current.revalidate(ticket.mandate)) {
      if (!policy({ ...after, mode: before.mode, rules: before.rules }).revalidate(ticket.mandate)) { effect.requesterAllowed = false; effect.requester = ticket.mandate.actor }
      else if (ticket.mandate.strength === 'inferred' && before.mode === 'auto' && after.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
