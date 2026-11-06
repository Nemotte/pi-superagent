import { expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.js'
import { policy, policyEffects } from '../src/policy.js'
import { issueEvent } from '../src/sources/github-events.js'
function fixture(type = 'User', login = 'alice', body = '@worker-bot fix typo') {
  const config = ConfigSchema.parse({ repository: '/repo', mode: 'auto', rules: [{ id: 'copy', enabled: true, instruction: 'Copy only' }], github: { enabled: true, repository: 'owner/project', botLogin: 'worker-bot', allowedActors: ['alice'], allowedBots: ['robot'], observe: { issues: true } } })
  const trigger = issueEvent({ id: 1, number: 1, title: 'Task', body, state: 'open', created_at: new Date().toISOString(), user: { login, type } }, config.github!)!
  const thread = { subscriptions: [], context: [] } as any
  return { config, trigger, thread }
}
function mandate(h: ReturnType<typeof fixture>) {
  const admitted = policy(h.config).gate(h.trigger, h.thread, []) as any
  return { actor: h.trigger.actor, strength: admitted.strength, policyVersion: '', scope: 'Copy only', basis: { ...admitted.basis, rules: ['copy'] } }
}
it('ignores unlisted requests by default, while listed people remain explicit even when proactive mode is off', () => {
  const outsider = fixture('User', 'outsider')
  expect(policy(outsider.config).gate(outsider.trigger, outsider.thread, [])).toMatchObject({ admissible: false })
  const h = fixture(); h.config.mode = 'off'
  expect(policy(h.config).gate(h.trigger, h.thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
})
it('allows an administrator to open a receiving scope to explicit requests without granting bots explicit authority', () => {
  const h = fixture('User', 'outsider'); const config = ConfigSchema.parse({ ...h.config, mode: 'off', github: { ...h.config.github, admission: { issues: { unlistedAddressed: 'explicit' } } } })
  expect(policy(config).gate(h.trigger, h.thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
  const bot = fixture('Bot', 'robot')
  expect(policy({ ...config, mode: 'auto' }).gate(bot.trigger, bot.thread, [])).toMatchObject({ admissible: true, strength: 'inferred' })
})
it('context-only subscriptions confer no follow-up authority', () => {
  const h = fixture('User', 'alice', 'Change spelling'); h.thread.subscriptions = ['context-ticket']; h.thread.context = ['context-ticket']
  expect(policy(h.config).gate(h.trigger, h.thread, [])).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'admission' } })
  h.config.github!.observe.issues = false
  expect(policy(h.config).gate(h.trigger, h.thread, [])).toMatchObject({ admissible: false })
})
it('revokes inferred bot mandates when a configured bot is removed, even without a bot suffix', () => {
  const h = fixture('Bot', 'robot'); const m = mandate(h); h.config.github!.allowedBots = []
  expect(policy(h.config).revalidate(m)).toBe(false)
})
it('keeps an inferred mandate when receive-all is turned off but its source still listens', () => {
  const h = fixture('User', 'alice', 'Fix typo'); const m = mandate(h), version = policy(h.config).version
  h.config.github!.observe.issues = false
  expect(policy(h.config).version).toBe(version); expect(policy(h.config).revalidate(m)).toBe(true)
  h.config.github!.enabled = false; expect(policy(h.config).revalidate(m)).toBe(false)
})
it('keeps an explicit follow-up mandate after sender removal, but revokes an addressed mandate', () => {
  const h = fixture('User', 'alice', 'Fix typo'); h.thread.subscriptions = ['own-ticket']; const m = mandate(h)
  expect(m.basis.via).toBe('followup'); h.config.github!.allowedActors = []
  expect(policy(h.config).revalidate(m)).toBe(true)
  expect(policy(h.config).revalidate({ ...m, basis: { ...m.basis, via: 'addressed', addressed: 'mention' } })).toBe(false)
})
it('revalidates the original admission cell when sender membership or the table changes', () => {
  const h = fixture('User', 'alice', 'Fix typo'); const m = mandate(h)
  h.config.github!.allowedActors = []; expect(policy(h.config).revalidate(m)).toBe(false)
  const other = fixture('User', 'outsider'); const c = ConfigSchema.parse({ ...other.config, github: { ...other.config.github, admission: { issues: { unlistedAddressed: 'inferred' } } } })
  const m2 = mandate({ ...other, config: c }); expect(policy(c).revalidate(m2)).toBe(true)
  const narrowed = ConfigSchema.parse({ ...c, github: { ...c.github, admission: {} } })
  expect(policy(narrowed).revalidate(m2)).toBe(false)
})
it('does not mislabel a proactive-mode or rule change as removal of requester permission', () => {
  const h = fixture('User', 'alice', 'Fix typo'); const ticket = { id: 'one', mandate: mandate(h) } as any
  const after = ConfigSchema.parse({ ...h.config, mode: 'observe', rules: [] })
  const effect = policyEffects([ticket], h.config, after).get(ticket.id)
  expect(effect?.rules?.[0].change).toBe('disabled'); expect(effect?.proactive).toBe(false); expect(effect?.requesterAllowed).toBeUndefined()
})
