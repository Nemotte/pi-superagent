import { expect, it, vi } from 'vitest'

it('notifies each open question once, permits a genuinely new question, and never connects a transport', async () => {
  const { attentionNotifier } = await import('../src/attention-notifications.js')
  const notify = vi.fn(), poll = attentionNotifier(notify)
  const row = { id: 'ticket', title: 'Workspace task', action: 'answer', attentionId: 'question-1', question: 'Confirm?' }
  await poll(async () => ({ tickets: [row] }))
  await poll(async () => ({ tickets: [row] }))
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls[0][0]).toContain('需要你确认')
  expect(notify.mock.calls[0][0]).toContain('/superagent show ticket')
  await poll(async () => ({ tickets: [] }))
  await poll(async () => ({ tickets: [{ ...row, attentionId: 'question-2', question: 'Which option?' }] }))
  expect(notify).toHaveBeenCalledTimes(2)
  await poll(async () => { throw Error('SSH disconnected') })
  expect(notify).toHaveBeenCalledTimes(2)
})
it('suppresses overlapping polls and notifications after session disposal', async () => {
  const { attentionNotifier } = await import('../src/attention-notifications.js')
  let active = true, finish!: (value: unknown) => void
  const notify = vi.fn(), poll = attentionNotifier(notify, () => active)
  const read = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const pending = poll(read); await poll(read); expect(read).toHaveBeenCalledTimes(1)
  active = false; finish({ tickets: [{ id: 't', title: 'Task', action: 'answer', question: 'Confirm?' }] })
  await pending; expect(notify).not.toHaveBeenCalled()
})
