// Repeat targeted suites without retrying failures; preserve each attempt for CI diagnosis.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const runs = Number(process.argv[2] ?? 20)
assert(Number.isInteger(runs) && runs >= 1 && runs <= 100, 'Expected 1..100 stability runs')
assert(process.env.npm_execpath, 'Run npm run test:stability')
const directory = resolve('.artifacts', `stability-${Date.now()}-${process.pid}`)
mkdirSync(directory, { recursive: true })
for (let run = 1; run <= runs; run++) {
  const log = join(directory, `${String(run).padStart(3, '0')}.log`), fd = openSync(log, 'w', 0o600)
  let result
  try {
    result = spawnSync(process.execPath, [process.env.npm_execpath, 'test', '--', 'packages/server/tests/coordination.spec.ts', 'packages/server/tests/driver.spec.ts', 'packages/server/tests/remote-control.spec.ts', 'packages/server/tests/supervision.spec.ts', 'packages/server/tests/backup.spec.ts', 'packages/server/tests/install.spec.ts', 'packages/server/tests/stale-lock-grace.spec.ts', '--reporter=verbose'], { stdio: ['ignore', fd, fd], timeout: 180000, env: process.env })
  } finally { closeSync(fd) }
  if (result.error || result.status !== 0) {
    console.error(readFileSync(log, 'utf8').slice(-16000))
    console.error(`Stability run ${run}/${runs} failed (${result.error?.code || result.signal || result.status}); no retry. Log: ${log}`)
    process.exit(1)
  }
  console.log(`Stability run ${run}/${runs} passed: ${log}`)
}
