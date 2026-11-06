// Normalization follows the MIT DeepSeek prototype; see THIRD_PARTY_NOTICES.md.
import { z } from 'zod'
import { key, type Trigger } from '../core/index.js'
import { sameLogin, type GitHubConfig } from './github-config.js'
type Identity = Pick<GitHubConfig, 'repository' | 'botLogin'>
export const UserSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable().transform(v => v ?? { login: 'ghost', type: 'Unknown' })
export const CommentSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().optional(), updated_at: z.string().optional(), submitted_at: z.string().nullish(),
  state: z.string().optional(), commit_id: z.string().nullish(), path: z.string().optional(), line: z.number().nullish(),
  diff_hunk: z.string().optional(), in_reply_to_id: z.number().int().positive().optional(),
  issue_url: z.string().optional(), pull_request_url: z.string().optional(),
})
export const IssueSchema = CommentSchema.extend({ number: z.number().int().positive(), title: z.string(), state: z.enum(['open', 'closed']), created_at: z.string(), pull_request: z.unknown().optional() })
export const PullSchema = IssueSchema.extend({ merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
  head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }), base: z.object({ repo: z.object({ full_name: z.string() }) }).optional(),
})
export type Pull = z.infer<typeof PullSchema>
function message(raw: z.infer<typeof CommentSchema>, number: number, kind: string, config: Identity, text: string): Trigger | undefined {
  if (sameLogin(raw.user.login, config.botLogin)) return undefined
  const escaped = config.botLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const mention = new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escaped}(?![a-zA-Z0-9_-])`, 'i').test(raw.body || '')
  const at = raw.updated_at || raw.submitted_at || raw.created_at
  if (!at || !Number.isFinite(Date.parse(at))) throw Error('GitHub event has no valid timestamp')
  const isPr = ['pull', 'inline', 'review'].includes(kind) || /\/pull\//.test(raw.html_url || '')
  return { id: key(`github-${kind}`, config.repository.toLowerCase(), String(raw.id), ['issue', 'pull'].includes(kind) ? '' : at, text), source: 'github',
    actor: { source: 'github', id: raw.user.login }, human: raw.user.type === 'User' && !/\[bot\]$/i.test(raw.user.login),
    threads: [{ source: 'github', id: String(number) }], at, text: text.slice(0, 60000), ...(mention ? { addressed: 'mention' } : {}),
    channel: { source: 'github', thread: `github:${number}`, address: { repository: config.repository, number: String(number), ...(kind === 'inline' ? { rootId: String(raw.in_reply_to_id || raw.id) } : {}) } },
    ...(raw.html_url ? { url: raw.html_url } : {}), meta: { repository: config.repository, number, isPr, kind, commentId: raw.id } }
}
export function issueEvent(input: unknown, config: Identity): Trigger | undefined {
  const issue = IssueSchema.parse(input)
  return message(issue, issue.number, issue.pull_request ? 'pull' : 'issue', config, `${issue.title}\n\n${issue.body || ''}`)
}
export function commentEvent(input: unknown, number: number, kind: 'conversation' | 'inline' | 'review', config: Identity): Trigger | undefined {
  const comment = CommentSchema.parse(input)
  const text = [kind === 'review' && comment.state ? `${comment.state} review (${comment.commit_id || 'unknown commit'})` : '',
    kind === 'inline' && comment.path ? `${comment.path}:${comment.line ?? '?'}\n${(comment.diff_hunk || '').split('\n').slice(-8).join('\n')}` : '', comment.body || ''].filter(Boolean).join('\n\n')
  return text ? message(comment, number, kind, config, text) : undefined
}
export function numberFromUrl(input: string, repository: string): number {
  const url = new URL(input)
  if (url.origin !== 'https://api.github.com') throw Error('Unexpected GitHub comment target')
  const prefix = `/repos/${repository}/`; if (!url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) throw Error('GitHub comment belongs to another repository')
  const match = /^(?:issues|pulls)\/(\d+)$/.exec(url.pathname.slice(prefix.length))
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) throw Error('Invalid GitHub thread number')
  return Number(match[1])
}
