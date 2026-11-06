import { canRetry, latestReport, ticketStage, threadKey, type Ticket, type Trigger } from './core/index.js'
import type { Config } from './config.js'
import type { Store } from './store.js'

/** Read-only projections for human clients. Domain decisions remain in the unchanged core. */
export function readiness(config: Config, needsAttention: number) {
  const missingModels = (['router', 'worker'] as const).filter(role => !config[`${role}Model`])
  return { state: missingModels.length ? 'setup' : config.paused ? 'paused' : needsAttention ? 'attention' : 'ready', missingModels }
}
export function ticketView(ticket: Ticket) {
  return { ...ticket, stage: ticketStage(ticket), latestReport: latestReport(ticket),
    actions: { stop: !ticket.ended, retry: canRetry(ticket), followup: ticket.ended?.by !== 'human' } }
}
export function requestView(store: Store, trigger: Trigger) {
  const disposition = store.triggers.disposition(trigger.id)
  const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : undefined
  const ticketIds = [...new Set([...(decision?.ticketId ? [decision.ticketId] : []), ...(disposition?.fanout || [])])]
  return { ...trigger, disposition, decision, ticketIds, threadKeys: trigger.threads.map(threadKey).filter(key => store.threads.get(key)),
    state: ticketIds.length ? 'accepted' : disposition?.filtered ? 'filtered' : decision?.kind === 'ignore' ? 'ignored' : decision?.kind === 'unavailable' ? 'unavailable' : 'pending' }
}
export function requests(store: Store, offset: number, limit: number) {
  return (store.records('trigger', offset, limit) as Trigger[]).map(t => requestView(store, t))
}
export function threadView(store: Store, key: string, offset: number, limit: number) {
  const thread = store.threads.get(key)
  if (!thread) return
  const where = `EXISTS (SELECT 1 FROM json_each(t.value, '$.threads') ref WHERE json_extract(ref.value, '$.source') || ':' || json_extract(ref.value, '$.id') = ?)`
  const triggers = store.db.prepare(`SELECT t.value FROM trigger t WHERE ${where} ORDER BY json_extract(t.value, '$.at') DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(key, limit, offset).map(r => requestView(store, JSON.parse(String(r.value))))
  const decisions = store.db.prepare("SELECT value FROM decision WHERE json_extract(value, '$.threadKey')=? ORDER BY rowid DESC LIMIT ? OFFSET ?")
    .all(key, limit, offset).map(r => JSON.parse(String(r.value)))
  const total = Number(store.db.prepare(`SELECT count(*) AS n FROM trigger t WHERE ${where}`).get(key)!.n)
  return { thread, triggers, decisions, total, offset }
}
export function conversation(store: Store, ticket: Ticket, offset: number, limit: number) {
  const ids = JSON.stringify([...new Set([...ticket.origin.triggerIds, ticket.origin.triggerId,
    ...ticket.inputs.flatMap(i => i.kind === 'trigger' && !i.context ? [i.triggerId] : [])])])
  // Read receipts, not private Agent sessions. Legacy receipt timestamps come from their durable audit entry.
  const query = `SELECT 'input:' || id AS id, json_extract(value, '$.at') AS at, 'human' AS role,
      json_extract(value, '$.text') AS text, 'received' AS status, json_extract(value, '$.source') AS source
    FROM trigger WHERE id IN (SELECT value FROM json_each(?))
    UNION ALL
    SELECT 'reply:' || json_extract(r.value, '$.id') AS id,
      coalesce(json_extract(r.value, '$.createdAt'), (SELECT min(a.at) FROM audit a WHERE json_extract(a.value, '$.message.id') = json_extract(r.value, '$.id') AND json_extract(a.value, '$.type') IN ('reply.sent','reply.dropped')), ?) AS at,
      'router' AS role, json_extract(r.value, '$.text') AS text, json_extract(r.value, '$.status') AS status,
      json_extract(r.value, '$.channel.source') AS source
    FROM kv r WHERE r.key GLOB 'reply:*' AND json_extract(r.value, '$.ticketId') = ?`
  const params = [ids, ticket.createdAt, ticket.id]
  const total = Number(store.db.prepare(`SELECT count(*) AS n FROM (${query})`).get(...params)!.n)
  const items = store.db.prepare(`SELECT * FROM (${query}) ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).reverse()
  return { total, offset, items }
}
export function configHistory(store: Store, offset: number, limit: number) {
  return store.db.prepare("SELECT value FROM kv WHERE key GLOB 'settings:[0-9]*' ORDER BY cast(substr(key,10) AS INTEGER) DESC LIMIT ? OFFSET ?")
    .all(limit, offset).map(r => JSON.parse(String(r.value)))
}
export function search(store: Store, query: string, offset: number, limit: number) {
  if (!query.trim()) return []
  const matchedTriggers = `SELECT id FROM trigger WHERE instr(lower(id || ' ' || json_extract(value, '$.text') || ' ' || coalesce(json_extract(value, '$.url'),'')),lower(?)) > 0`
  return store.db.prepare(`SELECT * FROM (
    SELECT 'ticket' AS kind, id, json_extract(value, '$.title') AS title FROM ticket WHERE
      instr(lower(id || ' ' || json_extract(value, '$.title')),lower(?)) > 0 OR json_extract(value, '$.origin.triggerId') IN (${matchedTriggers})
    UNION ALL SELECT 'trigger', id, substr(json_extract(value, '$.text'),1,300) FROM trigger WHERE id IN (${matchedTriggers})
    UNION ALL SELECT 'thread', id, coalesce(json_extract(value,'$.meta.label'),id) FROM thread WHERE instr(lower(id),lower(?)) > 0
      OR EXISTS (SELECT 1 FROM trigger t, json_each(t.value,'$.threads') ref WHERE t.id IN (${matchedTriggers}) AND json_extract(ref.value,'$.source') || ':' || json_extract(ref.value,'$.id') = thread.id)
    ) ORDER BY kind, id LIMIT ? OFFSET ?`).all(query, query, query, query, query, limit, offset)
}
