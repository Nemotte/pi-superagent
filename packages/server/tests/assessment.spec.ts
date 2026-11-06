import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Runtime } from '../src/runtime.js'
import { initialize } from '../src/config.js'
import { issueEvent } from '../src/sources/github-events.js'
const resources: Array<{ dir: string; runtime: Runtime }> = []
afterEach(async () => { for (const r of resources.splice(0)) { await r.runtime.close(); rmSync(r.dir, { recursive: true, force: true }) } })
function harness(mode = 'observe', ci = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-assess-')); initialize(dir, { repository: dir })
  const runtime = new Runtime(dir, { send: async () => {}, stop: async () => {}, close: async () => {} }); resources.push({ dir, runtime })
  const s = runtime.settings(); runtime.saveSettings({ ...s.config, mode, github: { enabled: true, repository: 'owner/project', botLogin: 'worker-bot', allowedActors: ['alice'], observe: { issues: true, ci: true }, admission: { ci: { unlistedUnaddressed: 'inferred' } } }, rules: [{ id: 'copy', instruction: 'Only precise copy fixes', enabled: true }] }, s.revision)
  const trigger = ci ? { id: 'ci-failure', source: 'github', actor: { source: 'github', id: '' }, human: false, threads: [{ source: 'github', id: 'ci:main' }], at: new Date().toISOString(), text: 'CI failed', meta: { repository: 'owner/project', ci: true, branch: 'main' } }
    : issueEvent({ id: 1, number: 1, title: 'Fix typo', body: 'Change Helo to Hello', user: { login: 'alice', type: 'User' }, state: 'open', created_at: new Date().toISOString() }, s.config.github || { repository: 'owner/project', botLogin: 'worker-bot' })!
  runtime.engine.receive(trigger); runtime.engine.evaluateDue()
  const candidate = runtime.engine.candidate(trigger.id)
  const assessment = { triggerId: trigger.id, evalId: candidate?.evalId, decision: 'accept', title: 'Fix typo', scope: 'One spelling correction', reason: 'Specified target', intentEvidence: 'Change Helo to Hello', direction: { implementationRequested: true, targetBasis: 'specified', requiresDesignDecision: false, evidence: 'Exact replacement supplied' }, ruleAssessments: [{ ruleId: 'copy', matched: true, reason: 'Spelling only' }] }
  return { runtime, trigger, assessment, candidate }
}
it('records would_accept in observe mode without creating a ticket', async () => {
  const h = harness(); expect(h.candidate?.strength).toBe('inferred')
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', h.assessment) as any
  expect(decision.kind).toBe('ignore'); expect(decision.audit.would_accept).toBe(true); expect(h.runtime.store.tickets.list()).toEqual([])
})
it('allows a fully evidenced inference only in auto mode', async () => {
  const h = harness('auto'); const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', h.assessment) as any
  expect(decision.kind).toBe('accept'); expect(h.runtime.store.tickets.get(decision.ticketId)?.mandate.strength).toBe('inferred')
})
it('rejects missing rules, missing evidence and stale evaluations', async () => {
  const h = harness('auto'); const target = { role: 'router' as const, key: 'router' }
  await expect(h.runtime.tool(target, 'assess', { ...h.assessment, ruleAssessments: [] })).rejects.toThrow(/rule/i)
  await expect(h.runtime.tool(target, 'assess', { ...h.assessment, intentEvidence: '' })).rejects.toThrow()
  await expect(h.runtime.tool(target, 'assess', { ...h.assessment, evalId: 'stale' })).rejects.toThrow(/eval/i)
  expect(h.runtime.store.tickets.list()).toEqual([])
})
it('cannot bypass observe mode by attaching an inferred candidate to a completed ticket', async () => {
  const h = harness(); const manual = h.runtime.submit({ id: 'prior-ticket', text: 'Authorized old scope' }); h.runtime.engine.evaluateDue()
  const prior = await h.runtime.tool({ role: 'router', key: 'router' }, 'route', { triggerId: manual.id, kind: 'accept', title: 'Previous', scope: 'Old scope', reason: 'Administrator' }) as any
  h.runtime.engine.report(prior.ticketId, { state: 'ready', summary: 'Done' })
  await expect(h.runtime.tool({ role: 'router', key: 'router' }, 'route', { triggerId: h.trigger.id, kind: 'attach', ticketId: prior.ticketId })).rejects.toThrow(/inferred|explicit/i)
  expect(h.runtime.store.tickets.get(prior.ticketId)?.assignments).toHaveLength(1)
})
it('does not accept an unsettled design direction', async () => {
  const h = harness('auto')
  const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', { ...h.assessment, direction: { ...h.assessment.direction, requiresDesignDecision: true } }) as any
  expect(decision.kind).toBe('ignore'); expect(h.runtime.store.tickets.list()).toEqual([])
})
it('can complete a senderless CI ticket without trying to reply to a nonexistent channel', async () => {
  const h = harness('auto', true); const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', h.assessment) as any
  const ticket = h.runtime.store.tickets.get(decision.ticketId)!
  await h.runtime.tool({ role: 'worker', key: `worker-${ticket.id}`, ticketId: ticket.id, assignmentId: ticket.assignments.at(-1)!.id }, 'report', { state: 'ready', summary: 'Verified' })
  expect(h.runtime.store.tickets.get(ticket.id)?.ended?.outcome).toBe('completed')
})
it('notifies existing tickets when their matched rule or proactive authorization changes', async () => {
  const h = harness('auto'); const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', h.assessment) as any
  const s = h.runtime.settings(); h.runtime.saveSettings({ ...s.config, mode: 'observe', rules: s.config.rules.map(rule => ({ ...rule, enabled: false })) }, s.revision)
  const inputs = h.runtime.store.tickets.get(decision.ticketId)!.inputs as any[]
  expect(inputs.some(input => input.kind === 'policy-changed' && input.effect.rules.some((r: any) => r.change === 'disabled'))).toBe(true)
})
it('attaches an administrator UI followup to a GitHub-origin ticket, not another Router evaluation', async () => {
  const h = harness('auto'); const decision = await h.runtime.tool({ role: 'router', key: 'router' }, 'assess', h.assessment) as any
  const trigger = h.runtime.followup(decision.ticketId, { id: 'admin-followup', text: 'Use this spelling' })
  expect(h.runtime.store.triggers.disposition(trigger.id)?.fanout).toContain(decision.ticketId)
})
