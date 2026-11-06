import { setTimeout as sleep } from 'node:timers/promises'
// Test-only grace for one scripted restart; never changes a lock or retries a service.
export async function waitForLockGrace({ lockMtime, monoNow = () => performance.now(), wallNow = () => Date.now(), wait = sleep }) {
  const start = monoNow(), wallStart = wallNow()
  await wait(35000)
  // proper-lockfile uses wall time; retain 5s headroom beyond its 30s stale threshold.
  while (wallNow() - lockMtime() < 35000) {
    const remaining = 90000 - (monoNow() - start)
    if (remaining <= 0) throw Error('LOCK_GRACE_TIMEOUT')
    await wait(Math.min(100, remaining))
  }
  return { elapsedMs: monoNow() - start, wallElapsedMs: wallNow() - wallStart, lockAgeMs: wallNow() - lockMtime() }
}
