import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const load = () => import(pathToFileURL(resolve('scripts/stale-lock-grace.mjs')).href)
it('waits for the observed wall-clock lock age after a rollback, before one restart', async () => {
  const { waitForLockGrace } = await load()
  let mono = 0, wall = 0
  const timing = await waitForLockGrace({ monoNow: () => mono, wallNow: () => wall, lockMtime: () => 500, wait: async (ms: number) => { mono += ms; wall += ms; if (mono === 35000) wall -= 6000 } })
  expect(timing.elapsedMs).toBeGreaterThan(35000)
  expect(timing.lockAgeMs).toBeGreaterThanOrEqual(35000)
  expect(timing.elapsedMs).toBeLessThanOrEqual(90000)
})
it('bounds an unhealthy wall clock using a monotonic deadline', async () => {
  const { waitForLockGrace } = await load()
  let mono = 0
  await expect(waitForLockGrace({ monoNow: () => mono, wallNow: () => 0, lockMtime: () => 500, wait: async (ms: number) => { mono += ms } })).rejects.toThrow('LOCK_GRACE_TIMEOUT')
  expect(mono).toBeLessThanOrEqual(90000)
})
