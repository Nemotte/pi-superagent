import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { InstanceClient } from '../packages/server/dist/client.js'
import { prepareWorktree } from '../packages/server/dist/workspace.js'
const exec = promisify(execFile), root = mkdtempSync(join(tmpdir(), 'sa restore 中文 ')), repo = join(root, 'repo'), state = join(root, 'state'), backup = join(root, 'snapshot'), cli = resolve('packages/server/dist/cli.js')
const env = { ...process.env, GIT_AUTHOR_NAME: 'Backup Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Backup Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const run = async (...args) => (await exec(process.execPath, [cli, ...args, '--state-dir', state], { env, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout
let child, output = ''
const start = async () => {
  child = spawn(process.execPath, [cli, 'serve', '--state-dir', state], { stdio: ['ignore', 'pipe', 'pipe'], env })
  child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  const client = new InstanceClient(state), deadline = performance.now() + 10000
  while (performance.now() < deadline) { if (await client.request('status').then(() => true, () => false)) return client; await sleep(50) }
  throw Error('Temporary service ready timeout: ' + output)
}
const stop = async client => { const exited = new Promise(r => child.once('exit', r)); await client.request('shutdown', 'POST'); await exited; child = undefined }
try {
  mkdirSync(repo); await exec('git', ['-C', repo, 'init'], { env })
  writeFileSync(join(repo, 'README.md'), 'original\n'); await exec('git', ['-C', repo, 'add', '.'], { env }); await exec('git', ['-C', repo, 'commit', '-m', 'fixture'], { env })
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r))
  const identity = JSON.parse(await run('init', '--repo', repo, '--port', String(port), '--paused', '--management', 'token'))
  const client = await start(), request = await client.request('tickets', 'POST', { id: 'keep-one', text: 'A durable request across disk restore' }), config = await client.request('config')
  await stop(client)
  await prepareWorktree(repo, join(state, 'work', 'fixture-ticket'), 'fixture-ticket')
  writeFileSync(join(state, 'work', 'fixture-ticket', 'README.md'), 'uncommitted task edit\n')
  mkdirSync(join(state, 'sessions', 'router'), { recursive: true }); writeFileSync(join(state, 'sessions', 'router', 'fixture.jsonl'), '{"type":"session","version":3}\n')
  writeFileSync(join(state, 'agent', 'auth.json'), '{"fixture":{"key":"private-test-key"}}', { mode: 0o600 })
  const receipt = JSON.parse(await run('backup', backup))
  assert.equal(receipt.verified, true, 'CLI backup must produce a verified manifest')
  assert.equal(JSON.parse(await run('backup-check', backup)).instanceId, identity.instanceId)
  renameSync(state, state + '.saved')
  assert.equal(JSON.parse(await run('restore', backup, '--expected-instance-id', identity.instanceId)).restored, false); assert(!existsSync(state))
  await run('restore', backup, '--expected-instance-id', identity.instanceId, '--yes')
  assert.equal(readFileSync(join(state, 'sessions', 'router', 'fixture.jsonl'), 'utf8'), '{"type":"session","version":3}\n')
  assert.equal(readFileSync(join(state, 'work', 'fixture-ticket', 'README.md'), 'utf8'), 'uncommitted task edit\n')
  const restored = await start()
  assert.deepEqual(await restored.request('config'), config)
  assert.equal((await restored.request('requests')).filter(r => r.id === request.id).length, 1)
  assert.equal((await restored.request('tickets', 'POST', { id: 'keep-one', text: 'A durable request across disk restore' })).id, request.id)
  await stop(restored)
  const failed = await exec(process.execPath, [cli, 'serve', '--state-dir', backup], { env }).then(() => false, e => String(e.stderr).includes('BACKUP_SNAPSHOT_NOT_INSTANCE'))
  assert(failed); assert(!output.includes('private-test-key'))
  console.log('Backup CLI smoke passed: verified offline snapshot, checksum/schema/Git checks, preview and original-path restore, private credentials/session/dirty worktree persistence, pending-request idempotency, snapshot startup rejection; no real business data or model calls.')
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
