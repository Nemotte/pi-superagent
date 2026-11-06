import { expect, it } from 'vitest'
const mod = await import('../web/settings-panel.js').catch(() => ({} as any))
it('merges unrelated concurrent fields, including separate team sections', () => {
  expect(mod.mergeDraft).toBeTypeOf('function')
  const base = { maxWorkers: 1, team: { communication: 'old', scope: 'old' } }
  expect(mod.mergeDraft(base, { ...base, team: { ...base.team, communication: 'mine' } }, { ...base, maxWorkers: 4, team: { ...base.team, scope: 'theirs' } }))
    .toEqual({ value: { maxWorkers: 4, team: { communication: 'mine', scope: 'theirs' } }, conflicts: [] })
})
it('keeps conflicting local drafts without silently choosing a winner', () => {
  expect(mod.mergeDraft).toBeTypeOf('function')
  expect(mod.mergeDraft({ rules: [] }, { rules: [{ id: 'mine' }] }, { rules: [{ id: 'theirs' }] })).toEqual({ value: { rules: [{ id: 'mine' }] }, conflicts: ['rules'] })
  expect(mod.mergeDraft({ mode: 'observe' }, { mode: 'auto' }, { mode: 'auto' })).toEqual({ value: { mode: 'auto' }, conflicts: [] })
})
