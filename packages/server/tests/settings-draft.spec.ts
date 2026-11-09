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
  // Both sides added a different rule: the draft keeps both and names the list as the conflict a person resolves.
  expect(mod.mergeDraft({ rules: [] }, { rules: [{ id: 'mine' }] }, { rules: [{ id: 'theirs' }] })).toEqual({ value: { rules: [{ id: 'mine' }] }, conflicts: ['rules'] })
  expect(mod.mergeDraft({ mode: 'observe' }, { mode: 'auto' }, { mode: 'auto' })).toEqual({ value: { mode: 'auto' }, conflicts: [] })
})
it('merges rule lists by id so edits to different rules do not conflict', () => {
  const base = { rules: [{ id: 'a', instruction: 'keep a', enabled: true }, { id: 'b', instruction: 'keep b', enabled: true }] }
  const local = { rules: [{ id: 'a', instruction: 'mine a', enabled: true }, { id: 'b', instruction: 'keep b', enabled: true }] }
  const remote = { rules: [{ id: 'a', instruction: 'keep a', enabled: true }, { id: 'b', instruction: 'theirs b', enabled: false }] }
  expect(mod.mergeDraft(base, local, remote)).toEqual({ value: { rules: [{ id: 'a', instruction: 'mine a', enabled: true }, { id: 'b', instruction: 'theirs b', enabled: false }] }, conflicts: [] })
})
it('reports a conflict only for the same rule and respects additions and removals', () => {
  const base = { rules: [{ id: 'a', instruction: 'keep', enabled: true }] }
  expect(mod.mergeDraft(base, { rules: [{ id: 'a', instruction: 'mine', enabled: true }] }, { rules: [{ id: 'a', instruction: 'theirs', enabled: true }] }))
    .toEqual({ value: { rules: [{ id: 'a', instruction: 'mine', enabled: true }] }, conflicts: ['rules[a].instruction'] })
  expect(mod.mergeDraft(base, { rules: [...base.rules, { id: 'b', instruction: 'new', enabled: true }] }, base))
    .toEqual({ value: { rules: [...base.rules, { id: 'b', instruction: 'new', enabled: true }] }, conflicts: [] })
  // A rule the other side deleted, that this side only kept as-is, is deleted; an edit on one side wins over a deletion.
  expect(mod.mergeDraft(base, base, { rules: [] }).value).toEqual({ rules: [] })
  const localEdited = { rules: [{ id: 'a', instruction: 'mine', enabled: true }] }
  expect(mod.mergeDraft(base, localEdited, { rules: [] }).value).toEqual(localEdited)
})
