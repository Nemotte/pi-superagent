import { Type, type TSchema } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentTarget } from './agent-protocol.js'
import { ReadKinds } from './context.js'
export const hasGitHub = (target: AgentTarget): boolean => target.github === true && !target.workspace
/** Pure loadout assembly; the parent still checks current authorization on every call. */
export function hostTools(target: AgentTarget, invoke: (name: string, args: unknown) => Promise<unknown>): ToolDefinition[] {
  const github = hasGitHub(target)
  const readParameters = Type.Object({ kind: Type.Optional(Type.Union(ReadKinds.filter(v => github || !v.startsWith('github')).map(v => Type.Literal(v)))), id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), path: Type.Optional(Type.String()), ...(github ? { section: Type.Optional(Type.Union(['issue', 'comments', 'reviews', 'inline'].map(v => Type.Literal(v)))) } : {}) })
  const tool = (name: string, description: string, parameters: TSchema): ToolDefinition => ({ name: `superagent_${name}`, label: name, description, parameters,
    execute: async (_id, args) => { const result = await invoke(name, args); return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: {} } } })
  if (target.role === 'router') return [
    tool('read', 'Read bounded host resources or repository-relative files/directories; follow next_offset and read pointers. Instructions may name a ticket id.', readParameters),
    tool('note', 'Send a short fact to an open ticket; this grants no wider authority.', Type.Object({ ticketId: Type.String(), text: Type.String({ maxLength: 1000 }) })),
    tool('status', 'Ask a waiting worker for status when a person needs it; never poll.', Type.Object({ ticketId: Type.String() })),
    tool('reply', 'Send a purposeful reply. Match attention text exactly; dropped defaults to silence. Honor matched rules.', Type.Object({ purpose: Type.Union(['acknowledgement', 'answer', 'result', 'attention'].map(v => Type.Literal(v))), ticketId: Type.Optional(Type.String()), triggerId: Type.Optional(Type.String()), question: Type.Optional(Type.String()), text: Type.String({ maxLength: 4000 }) })),
    tool('assess', 'Assess an inferred candidate against every enabled rule. Observe mode records would_accept without executing.', Type.Object({
      triggerId: Type.String(), evalId: Type.String(), decision: Type.Union(['accept', 'ignore', 'unavailable'].map(v => Type.Literal(v))), title: Type.String(), scope: Type.String(), reason: Type.String(), intentEvidence: Type.String(), acknowledgement: Type.Optional(Type.String({ maxLength: 1000 })),
      direction: Type.Object({ implementationRequested: Type.Boolean(), targetBasis: Type.Union(['specified', 'existing-standard', 'undetermined'].map(v => Type.Literal(v))), requiresDesignDecision: Type.Boolean(), evidence: Type.String() }), ruleAssessments: Type.Array(Type.Object({ ruleId: Type.String(), matched: Type.Boolean(), reason: Type.String() })),
    })),
    tool('route', 'Resolve a candidate with a host-authorized decision.', Type.Object({ kind: Type.Union(['accept', 'ignore', 'unavailable', 'attach', 'stop'].map(v => Type.Literal(v))), triggerId: Type.String(), ticketId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), acknowledgement: Type.Optional(Type.String({ maxLength: 1000 })) })),
  ]
  return [
    tool('read', 'Read own ticket, instructions, matched rules and related threads/triggers. Follow read pointers and next_offset.', readParameters),
    tool('ack', 'Confirm an in-scope human request once, unless a matched rule asks for silence.', Type.Object({ triggerId: Type.String(), text: Type.String({ maxLength: 1000 }) })),
    tool('follow', 'Follow a related thread for context only, not authority.' + (github ? ' GitHub id is its issue/PR number.' : ''), Type.Object({ source: github ? Type.Union([Type.Literal('github'), Type.Literal('manual')]) : Type.Literal('manual'), id: Type.String(), reason: Type.String() })),
    tool('unrelated', 'Leave an unrelated context thread and hand back owned follow-ups. Cannot leave the origin or bound delivery thread.', Type.Object({ thread: Type.String(), reason: Type.String() })),
    tool('report', 'Report verified state; ready completes the ticket or waits for its configured delivery channel.', Type.Object({ state: Type.Union(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'].map(v => Type.Literal(v))), summary: Type.String(), question: Type.Optional(Type.Union([Type.String(), Type.Null()])), askedBy: Type.Optional(Type.String()), answers: Type.Optional(Type.String()), repositories: Type.Optional(Type.Array(Type.Object({ id: Type.String(), summary: Type.String(), checks: Type.Array(Type.String()) }), { maxItems: 32 })) })),
    ...(github ? [
      tool('github_bind_pull', 'Bind the origin PR or the agent-owned exact ticket branch PR before reporting ready.', Type.Object({ number: Type.Number({ minimum: 1 }) })),
      tool('github_create_pull', 'Create or reuse a draft PR for this ticket branch, after pushing that branch. Requires mandate authorization for publication. Never merges.', Type.Object({ title: Type.String(), body: Type.String() })),
    ] : []),
    tool('handback', 'Return an out-of-scope input to the Router.', Type.Object({ triggerId: Type.String(), reason: Type.String() })),
  ]
}
