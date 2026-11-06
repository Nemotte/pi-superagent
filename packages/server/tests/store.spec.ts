import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('../src/store.js').catch(() => ({} as any))
const dirs: string[] = []
const stores: any[] = []
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function open() {
  expect(mod.Store, 'SQLite repository adapter is required').toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-store-')); dirs.push(dir)
  const path = join(dir, 'state.sqlite'); const store = new mod.Store(path); stores.push(store)
  return { store, path }
}
it('rolls back both domain records and queued effects', () => {
  const { store } = open()
  expect(() => store.atomic(() => { store.set('x', 1); store.enqueue('test', 'x', {}); throw Error('rollback') })).toThrow('rollback')
  expect(store.get('x')).toBeUndefined(); expect(store.pendingEffects()).toEqual([])
})
it('preserves pending work across a database reopen', () => {
  const { store, path } = open(); store.set('value', { persisted: true }); store.enqueue('launch', 'a', { ticket: '1' })
  store.close(); stores.pop()
  const reopened = new mod.Store(path); stores.push(reopened)
  expect(reopened.get('value')).toEqual({ persisted: true }); expect(reopened.pendingEffects()).toHaveLength(1)
})
it('does not let an old attempt delete a newer generation', () => {
  const { store } = open(); store.enqueue('delivery', 'a', { n: 1 }); const old = store.pendingEffects()[0]
  store.enqueue('delivery', 'a', { n: 2 }); store.finishEffect(old)
  expect(store.pendingEffects()[0].payload).toEqual({ n: 2 })
  store.finishEffect(store.pendingEffects()[0]); expect(store.pendingEffects()).toEqual([])
})
it('backs off failures and keeps failed work durable', () => {
  const { store } = open(); store.enqueue('reply', 'a', {}); const row = store.pendingEffects()[0]
  store.failEffect(row, 'network', 1000)
  const next = store.pendingEffects()[0]
  expect(next.attempts).toBe(1); expect(next.due).toBeGreaterThanOrEqual(1000); expect(next.error).toBe('network')
})
it('runs afterCommit only after the outer transaction succeeds', () => {
  const { store } = open(); const seen: number[] = []
  expect(() => store.atomic(() => { store.atomic(() => store.afterCommit(() => seen.push(1))); throw Error('no') })).toThrow()
  expect(seen).toEqual([])
  store.atomic(() => { store.afterCommit(() => seen.push(2)); expect(seen).toEqual([]) })
  expect(seen).toEqual([2])
})
it('refuses a newer schema without changing its version', () => {
  const { store, path } = open(); store.set('schema', 999); store.close(); stores.pop()
  expect(() => new mod.Store(path)).toThrow(/schema/i)
})
