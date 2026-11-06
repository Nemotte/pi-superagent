// Remote bridge integration; all instances/repos are temporary. No model provider requests.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { Client } from '../packages/extension/dist/client.js'
if (process.platform !== 'linux') { console.log('Remote bridge smoke skipped: the first SSH execution host is Linux.'); process.exit(0) }
const root = mkdtempSync(join(tmpdir(), 'sa remote smoke ')), stateDir = join(root, 'state'), repo = join(root, "repo ' 雲")
mkdirSync(repo)
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); writeFileSync(join(repo, 'README.md'), 'remote\n'); git('add', '.'); git('commit', '-m', 'initial')
const helper = resolve('packages/server/dist/remote-child.js')
function rpc(request, answer) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'ignore'] }); let output = '', done = false
    const timeout = setTimeout(() => finish(Error('bridge timeout')), 45000)
    function finish(error, result) { if (done) return; done = true; clearTimeout(timeout); p.stdin.end(); p.kill(); error ? reject(error) : resolve(result) }
    p.on('error', () => finish(Error('bridge spawn failed'))); p.on('exit', () => finish(Error('bridge exited')))
    p.stdout.setEncoding('utf8'); p.stdout.on('data', data => {
      output += data
      while (output.includes('\n')) {
        const i = output.indexOf('\n'), line = output.slice(0, i); output = output.slice(i + 1)
        let m; try { m = JSON.parse(line) } catch { finish(Error('invalid bridge JSON')); return }
        if (m.type === 'result') finish(undefined, m.value)
        if (m.type === 'error') finish(Error(m.code))
        if (m.type === 'prompt') p.stdin.write(JSON.stringify({ type: 'answer', id: m.id, value: answer || 'offline-test-key' }) + '\n')
      }
    })
    p.stdin.on('error', () => finish(Error('bridge stdin closed')))
    p.stdin.write(JSON.stringify({ type: 'init', request }) + '\n')
  })
}
let expected, client
try {
  const environment = await rpc({ operation: 'environment' }); assert.equal(environment.protocol, 1)
  const net = createServer(); await new Promise(r => net.listen(0, '127.0.0.1', r)); const port = net.address().port; await new Promise(r => net.close(r))
  const created = await rpc({ operation: 'init', repository: repo, stateDir, port })
  assert.equal(created.management, 'token'); assert.equal(created.online, false); assert.equal(created.token, undefined)
  expected = { instanceId: created.instanceId, repository: repo, port }
  const call = (operation, extra = {}) => rpc({ operation, stateDir, expected, ...extra })
  const started = await call('start'); assert.equal(started.online, true); assert.equal(started.status.paused, true)
  const credentials = await call('connect'); client = new Client(`http://127.0.0.1:${port}`, credentials.token, expected.instanceId)
  await assert.rejects(call('restart', { expected: { ...expected, port: port + 1 } }), /IDENTITY/)
  assert.equal((await client.request('status')).paused, true)
  const request = await client.request('tickets', 'POST', { id: 'remote-idempotent', text: 'Keep this request while disconnected' })
  const restarted = await call('restart'); assert.equal(restarted.online, true); assert.equal(restarted.status.paused, true)
  assert.equal((await client.request('requests')).some(row => row.id === request.id), true)
  const catalog = await call('model', { request: { operation: 'catalog' } }); assert.ok(catalog.providers.length); assert.ok(catalog.models.length)
  const provider = catalog.providers.find(p => p.id === 'openai' && p.methods.includes('api_key')); assert.ok(provider)
  const auth = await call('model', { request: { operation: 'login', provider: provider.id, method: 'api_key' } }); assert.equal(auth.ready, true)
  assert.equal((await call('model', { request: { operation: 'check', provider: provider.id } })).ready, true)
  assert.ok(readFileSync(join(stateDir, 'agent', 'auth.json'), 'utf8').includes('offline-test-key'))
  const inspect = await rpc({ operation: 'inspect', stateDir }); assert.equal(inspect.token, undefined)
  // Each bridge exited; the detached service and its durable input remained available.
  assert.equal((await client.request('requests')).length, 1)
  assert.equal(git('status', '--porcelain').toString().trim(), '')
  assert.equal((await call('shutdown')).online, false)
  console.log('Remote bridge smoke passed: token init/start, identity rejection, preserved paused settings/input on restart, isolated SDK catalog/test-key login, and service survival after control connections close.')
} finally {
  if (expected) await rpc({ operation: 'shutdown', stateDir, expected }).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
