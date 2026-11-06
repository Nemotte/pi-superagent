// Opt-in Linux Docker/OpenSSH integration. All keys, repositories and containers are disposable.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'
import { sshRequest, openSshTunnel } from '../packages/extension/dist/ssh.js'
import { connectRemote, disconnectRemote, closeRemoteConnections } from '../packages/extension/dist/remote-connections.js'
import { saveBinding } from '../packages/extension/dist/instances.js'
if (process.platform !== 'linux') throw Error('This opt-in Docker/OpenSSH fixture currently requires a Linux test host.')
const exec = promisify(execFile), root = mkdtempSync(join(tmpdir(), 'sa-ssh-container-')), name = `pi-superagent-ssh-${process.pid}`
let created = false, browser
const docker = (args, options = {}) => exec('docker', args, { maxBuffer: 4 * 1024 * 1024, timeout: 180000, ...options })
try {
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'key')])
  writeFileSync(join(root, 'sshd_config'), 'Port 22\nListenAddress 0.0.0.0\nHostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nAuthorizedKeysFile .ssh/authorized_keys\nAllowTcpForwarding local\nAllowAgentForwarding no\nX11Forwarding no\nUsePAM no\n', { mode: 0o600 })
  await docker(['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::22', '-v', `${resolve('.') }:/product:ro`, '-v', `${dirname(dirname(process.execPath))}:/node:ro`, '-v', `${root}:/fixture:ro`, 'ubuntu:24.04', 'bash', '-c', 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq openssh-server git ca-certificates > /tmp/packages.log 2>&1 && mkdir -p /run/sshd /root/.ssh && cp /fixture/key.pub /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys && touch /tmp/ssh-ready && exec /usr/sbin/sshd -D -e -f /fixture/sshd_config'])
  created = true
  const deadline = Date.now() + 180000
  while (true) {
    if (await docker(['exec', name, 'test', '-f', '/tmp/ssh-ready']).then(() => true, () => false)) break
    if (Date.now() > deadline) throw Error('Temporary sshd setup timed out')
    await sleep(1000)
  }
  const address = (await docker(['port', name, '22'])).stdout.trim(), sshPort = address.split(':').at(-1)
  const publicKey = (await docker(['exec', name, 'ssh-keygen', '-y', '-f', '/etc/ssh/ssh_host_ed25519_key'])).stdout.trim()
  const known = join(root, 'known_hosts'), config = join(root, 'config')
  writeFileSync(known, `[127.0.0.1]:${sshPort} ${publicKey}\n`, { mode: 0o600 })
  writeFileSync(config, `Host sa-fixture\n HostName 127.0.0.1\n Port ${sshPort}\n User root\n IdentityFile ${join(root, 'key')}\n UserKnownHostsFile ${known}\n IdentitiesOnly yes\n`, { mode: 0o600 })
  const launch = (exe, args) => spawn(exe, ['-F', config, ...args], { stdio: 'pipe' })
  const options = { launch }, target = { host: 'sa-fixture', node: '/node/bin/node', cliPath: '/product/packages/server/dist/cli.js' }
  const request = (r, ui) => sshRequest(target, r, ui, options)
  assert.equal((await request({ operation: 'environment' })).protocol, 1)
  // Wrong pinned host key must fail; never TOFU or silently update known_hosts.
  writeFileSync(known, `[127.0.0.1]:${sshPort} ${readFileSync(join(root, 'key.pub'), 'utf8').trim()}\n`)
  await assert.rejects(request({ operation: 'environment' }), /DISCONNECTED/)
  writeFileSync(known, `[127.0.0.1]:${sshPort} ${publicKey}\n`)
  const repository = "/tmp/app ' 雲", stateDir = '/tmp/agent-state'
  await docker(['exec', name, 'mkdir', '-p', repository])
  for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com'], ['commit', '--allow-empty', '-m', 'initial']]) await docker(['exec', name, 'git', '-C', repository, ...args])
  const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r))
  const info = await request({ operation: 'init', repository, stateDir, port })
  const expected = { instanceId: info.instanceId, repository, port }, binding = { project: root, repository, stateDir, instanceId: info.instanceId, ssh: { ...target, port } }
  assert.equal((await request({ operation: 'service', action: 'status', stateDir, expected })).service.kind, 'detached')
  const unitPlan = (await request({ operation: 'service', action: 'plan', stateDir, expected })).service
  assert(unitPlan.unit.includes('supervised-child.js')); assert(unitPlan.unit.includes('RestartSec=35s'))
  await assert.rejects(request({ operation: 'service', action: 'install', stateDir, expected }), /SERVICE_CONFIRM_REQUIRED/)
  await request({ operation: 'start', stateDir, expected })
  const io = { tunnel: (t, p, r, o) => openSshTunnel(t, p, r, { ...o, launch }) }
  let client = await connectRemote(binding, io)
  assert.equal((await client.request('status')).management, 'token')
  const catalog = await request({ operation: 'model', stateDir, expected, request: { operation: 'catalog' } })
  assert.ok(catalog.providers.some(p => p.id === 'openai' && p.methods.includes('api_key')))
  assert.equal((await request({ operation: 'model', stateDir, expected, request: { operation: 'login', provider: 'openai', method: 'api_key' } }, { prompt: async () => 'offline-ssh-test-key', notify() {} })).ready, true)
  assert.equal((await request({ operation: 'model', stateDir, expected, request: { operation: 'check', provider: 'openai' } })).ready, true)
  const receipt = await client.request('tickets', 'POST', { id: 'over-real-ssh', text: 'Persist this local request in the cloud fixture' })
  saveBinding(join(root, 'connections'), binding)
  const token = (await request({ operation: 'connect', stateDir, expected })).token
  assert.equal(readFileSync(saveBinding(join(root, 'connections'), binding), 'utf8').includes(token), false)
  // Browser authenticates over the actual tunnel, preserving exact Host and Origin checks.
  const grant = await client.request('login-grants', 'POST', {})
  const executablePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.goto(`${client.endpoint}/#login=${grant.code}`)
  await page.waitForFunction(() => !location.hash && !document.querySelector('#workspace')?.hidden)
  const status = await page.evaluate(async () => (await fetch('/api/v1/status')).json())
  assert.equal(status.instanceId, binding.instanceId); assert.equal(status.paused, true)
  await browser.close(); browser = undefined
  await disconnectRemote(binding)
  await assert.rejects(client.request('status'), /connect/)
  const detached = await request({ operation: 'inspect', stateDir }); assert.equal(detached.online, true)
  await request({ operation: 'restart', stateDir, expected })
  client = await connectRemote(binding, io)
  assert.equal((await client.request('requests')).some(r => r.id === receipt.id), true)
  assert.equal((await client.request('status')).paused, true)
  // Drop the server-side SSH connections; clients must go offline without killing service.
  await docker(['exec', name, 'pkill', '-TERM', '-f', 'remote-child.js'])
  for (let i = 0; i < 100; i++) { if (!await client.request('status').then(() => true, () => false)) break; await sleep(50) }
  await assert.rejects(client.request('status'))
  await disconnectRemote(binding)
  assert.equal((await request({ operation: 'inspect', stateDir })).online, true)
  client = await connectRemote(binding, io)
  assert.equal((await client.request('requests')).length, 1)
  await disconnectRemote(binding)
  assert.equal((await request({ operation: 'shutdown', stateDir, expected })).online, false)
  console.log('Real OpenSSH container smoke passed: strict host-key rejection, remote init/start, pinned identity, token-only tunnel API/Web, durable request, disconnect and reconnect, restart preservation and explicit shutdown; no GitHub or paid model calls.')
} finally {
  await browser?.close().catch(() => {})
  await closeRemoteConnections()
  if (created) await docker(['rm', '-f', name]).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
