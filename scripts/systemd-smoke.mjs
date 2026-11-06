// No host registration: validate the unit, then run its launcher in a disposable instance.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitForLockGrace } from './stale-lock-grace.mjs'
import { initialize } from '../packages/server/dist/config.js'
import { InstanceClient } from '../packages/server/dist/client.js'
import { planService, renderUnit } from '../packages/server/dist/supervision-config.js'
if (process.platform !== 'linux') { console.log('Systemd launcher smoke skipped: Linux execution host only'); process.exit(0) }
const exec = promisify(execFile), root = mkdtempSync(join(tmpdir(), 'sa systemd %$ 雲 ')), state = join(root, 'state'), home = join(root, 'home'), cliPath = resolve('packages/server/dist/cli.js'), launcher = join(dirname(cliPath), 'supervised-child.js')
let child, servicePid, output = ''
try {
  assert(existsSync(launcher), 'Supervised launcher must be packaged')
  mkdirSync(home)
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r))
  const config = initialize(state, { repository: root, port, paused: true, maxWorkers: 1, management: 'token' })
  const record = planService(state, { platform: 'linux', uid: process.getuid(), home, node: process.execPath, cliPath, run: async () => { throw Error('No host manager calls permitted in this smoke') } })
  mkdirSync(dirname(record.unitFile), { recursive: true })
  writeFileSync(record.unitFile, renderUnit(record), { mode: 0o600 }); writeFileSync(join(state, 'supervision.json'), JSON.stringify(record), { mode: 0o600 })
  writeFileSync(join(state, 'service.env.json'), JSON.stringify({ HTTPS_PROXY: 'http://fixture-user:fixture-secret@127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' }), { mode: 0o600 })
  assert(!renderUnit(record).includes('fixture-secret'))
  if (existsSync('/usr/bin/systemd-analyze')) await exec('/usr/bin/systemd-analyze', ['verify', '--man=no', record.unitFile], { timeout: 15000, maxBuffer: 65536 })
  else console.log('systemd-analyze unavailable; static unit validation skipped')
  const marker = join(root, 'ambient-preload-ran'), preload = join(root, 'poison.mjs')
  writeFileSync(preload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');`)
  const launch = () => {
    child = spawn('/usr/bin/env', ['-i', `HOME=${home}`, `PATH=${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, 'LANG=C.UTF-8', process.execPath, launcher, 'serve', '--supervised', '--expected-instance-id', config.instanceId, '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: `--import=${JSON.stringify(preload)}`, OPENAI_API_KEY: 'ambient-must-not-reach-service' } })
    child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  }
  const ready = async () => {
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      const value = await new InstanceClient(state).request('status').catch(() => undefined)
      if (value) return value
      if (child.exitCode !== null) throw Error('Launcher exited before service was ready: ' + output)
      await sleep(100)
    }
    throw Error('Supervised service ready timeout: ' + output)
  }
  let exited = launch()
  assert.equal((await ready()).supervision.kind, 'systemd-user'); assert.equal(existsSync(marker), false)
  servicePid = Number((await exec('ps', ['-o', 'pid=', '--ppid', String(child.pid)])).stdout.trim())
  assert(Number.isSafeInteger(servicePid) && servicePid > 0)
  const env = readFileSync(`/proc/${servicePid}/environ`, 'utf8')
  assert(env.includes('HTTPS_PROXY=http://fixture-user:fixture-secret@127.0.0.1:1'))
  assert(!env.includes('ambient-must-not-reach-service')); assert(!env.includes('NODE_OPTIONS='))
  const client = new InstanceClient(state)
  const request = await client.request('tickets', 'POST', { id: 'before-crash', text: 'Keep this paused request through a real process crash' })
  const settings = await client.request('config')
  process.kill(servicePid, 'SIGKILL'); servicePid = undefined
  assert.notEqual((await exited).code, 0); child = undefined
  assert(existsSync(state + '.lock'), 'Unclean exit retains the stale lock')
  // Minimum unit grace plus observed wall-clock lock age: a clock rollback can
  // outlast a fixed monotonic sleep. No deletion/mtime-forging or launch retries.
  const beforeWait = { wall: Date.now(), monotonic: performance.now(), mtime: statSync(state + '.lock').mtimeMs }, clockChanges = []
  let previous = { wall: beforeWait.wall, monotonic: beforeWait.monotonic }
  const monitor = setInterval(() => {
    const next = { wall: Date.now(), monotonic: performance.now() }, drift = next.wall - previous.wall - (next.monotonic - previous.monotonic)
    if (Math.abs(drift) > 100 && clockChanges.length < 32) clockChanges.push({ ...next, drift })
    previous = next
  }, 100)
  let grace
  try { grace = await waitForLockGrace({ lockMtime: () => statSync(state + '.lock').mtimeMs }) }
  finally {
    clearInterval(monitor)
    console.log('Supervision lock timing:', JSON.stringify({ beforeWait, afterWait: { wall: Date.now(), monotonic: performance.now(), mtime: statSync(state + '.lock').mtimeMs }, grace, clockChanges }))
  }
  exited = launch(); assert.equal((await ready()).paused, true)
  const restored = new InstanceClient(state)
  assert.deepEqual(await restored.request('config'), settings)
  assert.equal((await restored.request('requests')).filter(r => r.id === request.id).length, 1)
  await assert.rejects(exec(process.execPath, [cliPath, 'serve', '--state-dir', state]), /systemd-managed/)
  child.kill('SIGTERM'); assert.equal((await exited).code, 0); child = undefined
  assert.equal(existsSync(state + '.lock'), false)
  assert(!output.includes('fixture-secret'))
  console.log('Supervision smoke passed: unit syntax, env-i/private child environment, managed-serve guard, real SIGKILL/nonzero launcher exit, minimum 35s/observed wall-clock stale-lock grace, durable paused request/settings recovery, and graceful process-tree shutdown. No real user unit registered; restart was driven by this test.')
} finally {
  if (servicePid) { try { process.kill(servicePid, 'SIGTERM') } catch {} }
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
