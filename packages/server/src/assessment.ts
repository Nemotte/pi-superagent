import { z } from 'zod'
import type { Config } from './config.js'
import type { AssessmentOutcome } from './core/index.js'
export const AssessmentSchema = z.object({
  triggerId: z.string().min(1), evalId: z.string().min(1), decision: z.enum(['accept', 'ignore', 'unavailable']),
  title: z.string().max(160), scope: z.string().max(2000), reason: z.string().min(1).max(1000),
  intentEvidence: z.string().max(1000), acknowledgement: z.string().trim().min(1).max(1000).optional(),
  direction: z.object({ implementationRequested: z.boolean(), targetBasis: z.enum(['specified', 'existing-standard', 'undetermined']), requiresDesignDecision: z.boolean(), evidence: z.string().min(1).max(1000) }).strict(),
  ruleAssessments: z.array(z.object({ ruleId: z.string(), matched: z.boolean(), reason: z.string().min(1).max(1000) }).strict()).max(30),
}).strict()
export function assessmentOutcome(input: z.infer<typeof AssessmentSchema>, config: Config): AssessmentOutcome {
  const rules = config.rules.filter(r => r.enabled), ids = new Set(input.ruleAssessments.map(r => r.ruleId))
  if (ids.size !== input.ruleAssessments.length || ids.size !== rules.length || rules.some(r => !ids.has(r.id))) throw Error('Exactly one assessment per enabled rule is required')
  const matches = input.ruleAssessments.filter(r => r.matched).map(r => r.ruleId)
  const audit = { rule_assessments: input.ruleAssessments, direction: input.direction, intent_evidence: input.intentEvidence }
  if (input.decision !== 'accept') return { kind: input.decision, reason: input.reason, audit }
  if (!input.intentEvidence.trim() || !input.title.trim() || !input.scope.trim()) throw Error('Acceptance requires intent evidence, title and scope')
  const d = input.direction
  if (!d.implementationRequested || d.requiresDesignDecision || d.targetBasis === 'undetermined' || !matches.length) return { kind: 'ignore', reason: 'Unsettled direction or no matching rule', audit }
  if (config.mode !== 'auto') return { kind: 'ignore', reason: input.reason, audit: { ...audit, would_accept: true, proposal: { title: input.title, scope: input.scope } } }
  return { kind: 'accept', title: input.title, scope: input.scope, reason: input.reason, rules: matches, audit, ...(input.acknowledgement ? { acknowledgement: input.acknowledgement } : {}) }
}
