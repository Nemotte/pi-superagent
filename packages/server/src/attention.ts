import { canRetry, latestReport, ticketStage, type Decision } from './core/index.js'
import type { Store } from './store.js'
import { clip } from './notices.js'
export function attention(store: Store) {
  const priorities = { answer: 0, delivery: 1, failed: 2, blocked: 3, review: 4 }
  const tickets = store.tickets.open().flatMap(t => {
    const stage = ticketStage(t)
    return stage.stage === 'person' ? [{ id: t.id, title: t.title, action: stage.action, question: t.attention?.question,
      summary: clip(latestReport(t)?.summary || t.mandate.scope), canRetry: canRetry(t), updatedAt: t.updatedAt }] : []
  }).sort((a, b) => priorities[a.action] - priorities[b.action] || a.updatedAt.localeCompare(b.updatedAt))
  const evaluations = store.db.prepare(`SELECT d.value FROM decision d WHERE json_extract(d.value, '$.kind') = 'unavailable'
    AND json_extract(d.value, '$.dismissed') IS NULL AND NOT EXISTS (SELECT 1 FROM decision newer WHERE newer.rowid > d.rowid AND json_extract(newer.value, '$.threadKey') = json_extract(d.value, '$.threadKey')) ORDER BY d.rowid DESC`)
    .all().map(r => JSON.parse(String(r.value)) as Decision).filter(d => {
      const thread = store.threads.get(d.threadKey); return thread && !thread.evaluating && !thread.pending.length
    }).map(d => ({ id: d.id, triggerId: d.triggerIds[0], reason: d.reason, at: d.at }))
  const problems = store.pendingEffects().filter(e => e.attempts >= 3).map(e => ({ kind: e.kind, key: e.key, error: e.error, attempts: e.attempts }))
  return { total: tickets.length + evaluations.length + problems.length, tickets: tickets.slice(0, 50), evaluations: evaluations.slice(0, 50), problems: problems.slice(0, 50) }
}
