import { z } from 'zod'
import { key, type OutboundMessage } from '../core/index.js'
import { GitHubError, type GitHubApi } from './github-client.js'
import { sameLogin, type GitHubConfig } from './github-config.js'
const number = z.coerce.number().int().positive().safe()
const Posted = z.looseObject({ id: z.number(), body: z.string().nullish(), user: z.object({ login: z.string() }).nullable(), in_reply_to_id: z.number().optional() })
export async function sendGitHub(api: GitHubApi, config: GitHubConfig, instance: string, message: OutboundMessage, guard: () => void): Promise<'sent' | 'dropped'> {
  if (!sameLogin(message.channel.address.repository || '', config.repository)) throw Error('Reply belongs to another GitHub repository')
  const target = number.parse(message.channel.address.number)
  let root = message.channel.address.rootId ? number.parse(message.channel.address.rootId) : undefined
  if (root) {
    try { const comment = z.object({ id: z.number(), in_reply_to_id: z.number().optional() }).parse(await api.get(`pulls/comments/${root}`)); root = comment.in_reply_to_id || comment.id }
    catch (error) { if (error instanceof GitHubError && [404, 410].includes(error.status)) root = undefined; else throw error }
  }
  const path = root ? `pulls/${target}/comments` : `issues/${target}/comments`
  const marker = `<!-- pi-superagent:${instance}:${key('reply', message.id)} -->`
  const comments = (await api.pages(path)).map(c => Posted.parse(c))
  if (comments.some(c => sameLogin(c.user?.login || '', config.botLogin) && (!root || c.in_reply_to_id === root) && c.body?.includes(marker))) return 'sent'
  const issue = z.object({ locked: z.boolean().optional() }).parse(await api.get(`issues/${target}`))
  if (issue.locked) return 'dropped'
  guard()
  try { await api.post(root ? `${path}/${root}/replies` : path, { body: `${message.text}\n\n${marker}` }); return 'sent' }
  catch (error) { if (error instanceof GitHubError && error.status === 410) return 'dropped'; throw error }
}
