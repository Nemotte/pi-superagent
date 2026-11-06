// Run through npm so npm_execpath identifies the native npm CLI on every platform.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
const exec = promisify(execFile)
const root = process.cwd(); const dir = mkdtempSync(join(tmpdir(), 'pi package 安装 ')); const tarballs = join(dir, 'tarballs'); const clean = join(dir, 'clean')
let child, url, token, setupClient, failureLog = ''
async function command(file, args, cwd = root, extraEnv = {}) { return (await exec(file, args, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...extraEnv, GIT_AUTHOR_NAME: 'Package Smoke', GIT_AUTHOR_EMAIL: 'package@example.com', GIT_COMMITTER_NAME: 'Package Smoke', GIT_COMMITTER_EMAIL: 'package@example.com' } })).stdout.trim() }
const npm = (...args) => { if (!process.env.npm_execpath) throw Error('Run npm run test:package'); return command(process.execPath, [process.env.npm_execpath, ...args]) }
try {
  mkdirSync(tarballs); mkdirSync(clean); writeFileSync(join(clean, 'package.json'), '{"private":true,"type":"module"}\n')
  const paths = []
  for (const name of ['server', 'extension']) {
    const [packed] = JSON.parse(await npm('pack', '--workspace', `@pi-superagent/${name}`, '--pack-destination', tarballs, '--json'))
    assert(packed.files.some(f => f.path === 'dist/index.js')); assert(packed.files.some(f => f.path === 'LICENSE'))
    assert(!packed.files.some(f => /(^|\/)(upstream|node_modules|admin.token|state.sqlite)/.test(f.path)))
    if (name === 'server') { for (const file of ['web/index.html', 'dist/pi-child.js', 'dist/remote-child.js', 'dist/remote-control.js', 'dist/agent-tools.js', 'dist/supervision.js', 'dist/supervision-config.js', 'dist/supervised-child.js', 'dist/backup.js', 'dist/backup-files.js', 'dist/backup-database.js', 'dist/backup-git.js', 'dist/instance-files.js']) assert(packed.files.some(f => f.path === file)) }
    else for (const file of ['dist/ssh.js', 'dist/remote.js', 'dist/remote-connections.js', 'dist/service-ui.js']) assert(packed.files.some(f => f.path === file))
    paths.push(join(tarballs, packed.filename))
  }
  const install = (cwd, packages) => command(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', ...packages], cwd)
  const audit = async (cwd, label) => {
    const report = JSON.parse(await command(process.execPath, [process.env.npm_execpath, 'audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'], cwd))
    assert.equal(report.metadata.vulnerabilities.total, 0, `${label} production audit`)
    console.log(`${label} production audit: 0 vulnerabilities`)
  }
  // A plugin-only consumer must not acquire a second SDK through optional peers.
  const pluginOnly = join(dir, 'plugin-only'); mkdirSync(pluginOnly)
  writeFileSync(join(pluginOnly, 'package.json'), '{"private":true,"type":"module"}\n')
  await install(pluginOnly, [paths[1]])
  const pluginLock = JSON.parse(readFileSync(join(pluginOnly, 'package-lock.json'), 'utf8'))
  assert.deepEqual(Object.keys(pluginLock.packages).sort(), ['', 'node_modules/@pi-superagent/extension'])
  if (process.argv.includes('--audit')) await audit(pluginOnly, 'Plugin-only tarball')
  await install(clean, paths)
  // Inspect the consumer tree, not only workspace pins or the upstream manifest.
  const tree = JSON.parse(await command(process.execPath, [process.env.npm_execpath, 'ls', '--all', '--omit=dev', '--json'], clean))
  const versions = new Map()
  function visit(dependencies = {}) {
    for (const [name, value] of Object.entries(dependencies)) {
      if (value.version) { const found = versions.get(name) || new Set(); found.add(value.version); versions.set(name, found) }
      visit(value.dependencies)
    }
  }
  visit(tree.dependencies)
  for (const [name, version] of [['@earendil-works/pi-coding-agent', '1.5.0'], ['@earendil-works/pi-tui', '1.5.0'], ['minimatch', '11.0.3'], ['undici', '8.12.3']]) assert.deepEqual([...(versions.get(name) || [])], [version], name)
  if (process.argv.includes('--audit')) await audit(clean, 'Server + plugin tarballs')
  const cli = join(clean, 'node_modules', '@pi-superagent', 'server', 'dist', 'cli.js')
  assert.equal(await command(process.execPath, [cli, '--version'], clean), '0.1.0-alpha.1')
  if (process.platform === 'linux') {
    const bridge = spawn(process.execPath, [join(clean, 'node_modules/@pi-superagent/server/dist/remote-child.js')], { cwd: clean, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bridge.kill(); reject(Error('Installed SSH bridge timed out')) }, 10000)
      bridge.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); bridge.stdin.end(); resolve(JSON.parse(output.trim())) } })
      bridge.on('error', error => { clearTimeout(timer); reject(error) })
      bridge.on('exit', () => { clearTimeout(timer); if (!output) reject(Error('Installed SSH bridge exited')) })
    })
    bridge.stdin.write(JSON.stringify({ type: 'init', request: { operation: 'environment' } }) + '\n')
    assert.equal((await result).value.protocol, 1)
  }
  const repo = join(dir, 'repo'); mkdirSync(repo); await command('git', ['init'], repo)
  writeFileSync(join(repo, 'README.md'), 'Package fixture\n'); await command('git', ['add', '.'], repo); await command('git', ['commit', '-m', 'fixture'], repo)
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const state = join(dir, 'state'); const run = (...args) => command(process.execPath, [cli, ...args, '--state-dir', state], clean, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '', http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', no_proxy: '' })
  await run('init', '--repo', repo, '--port', String(port), '--management', 'token'); token = readFileSync(join(state, 'admin.token'), 'utf8').trim(); url = `http://127.0.0.1:${port}`
  assert.equal(JSON.parse(await run('service', 'status')).kind, 'detached')
  await assert.rejects(run('service', 'install'), /SERVICE_CONFIRM_REQUIRED/)
  assert(!existsSync(join(state, 'supervision.json')))
  if (process.platform === 'linux') {
    const plan = JSON.parse(await run('service', 'plan'))
    assert(plan.unit.includes('supervised-child.js')); assert(plan.unit.includes('Restart=on-failure'))
    assert(!existsSync(plan.unitFile)); assert(!plan.unit.includes(token))
  }
  child = spawn(process.execPath, [cli, 'serve', '--state-dir', state], { cwd: clean, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', chunk => { failureLog += String(chunk) })
  child.stdout.on('data', () => {})
  for (let i = 0; i < 100; i++) { if (await fetch(url + '/health').then(r => r.ok, () => false)) break; await sleep(100) }
  assert.equal(JSON.parse(await run('status')).protocol, 1)
  assert.equal(JSON.parse(await run('sources')).find(s => s.id === 'github').state, 'disabled')
  assert.equal(JSON.parse(await run('github', 'poll')).state, 'disabled')
  assert((await fetch(url).then(r => r.text())).includes('Pi Super-agent'))
  for (const file of ['app.js', 'ticket-panel.js', 'settings-panel.js', 'records-panel.js']) assert((await fetch(url + '/' + file)).ok)
  const catalog = await fetch(url + '/api/v1/models', { headers: { authorization: `Bearer ${token}` } }).then(r => r.json())
  assert(catalog.models.some(m => m.provider === 'openai'))
  assert(catalog.models.every(m => Object.keys(m).every(k => ['provider', 'id', 'name'].includes(k))))
  await run('pause')
  const text = 'Do not execute; test literal ; $ tokens 中文'
  const first = JSON.parse(await run('request', text, '--id', 'package-request'))
  const second = JSON.parse(await run('request', text, '--id', 'package-request')); assert.equal(first.id, second.id); assert.equal(first.text, text)
  assert.equal(JSON.parse(await run('doctor')).service.paused, true)
  const exit = new Promise(resolve => child.once('exit', resolve)); await run('shutdown'); await exit; child = undefined
  // start survives the initiating CLI; shutdown still uses authenticated API, not a saved PID.
  assert.equal(JSON.parse(await run('start')).status.paused, true); await run('shutdown')
  for (let i = 0; i < 100; i++) { if (!await fetch(url + '/health').then(r => r.ok, () => false)) break; await sleep(50) }
  const backup = join(dir, 'backup'); await run('backup', backup)
  assert.equal(readFileSync(join(backup, 'admin.token'), 'utf8').trim(), token)
  const inspectedBackup = JSON.parse(await run('backup-check', backup)); assert.equal(inspectedBackup.verified, true)
  assert(!JSON.stringify(inspectedBackup).includes(token))
  await assert.rejects(command(process.execPath, [cli, 'serve', '--state-dir', backup], clean), /BACKUP_SNAPSHOT_NOT_INSTANCE/)
  await assert.rejects(run('restore', backup, '--expected-instance-id', inspectedBackup.instanceId, '--yes'), /BACKUP_EXISTS/)
  // Run the actual installed wizard, CLI, authentication IPC and SDK API-key login offline.
  const extensionDir = join(clean, 'node_modules', '@pi-superagent', 'extension', 'dist')
  const { setup } = await import(pathToFileURL(join(extensionDir, 'setup.js')).href)
  const { localSetupServices } = await import(pathToFileURL(join(extensionDir, 'setup-services.js')).href)
  const { instanceClient, connectionForProject } = await import(pathToFileURL(join(extensionDir, 'instances.js')).href)
  const setupState = join(dir, 'wizard state 中文'), services = localSetupServices(); services.connections = join(dir, 'connections')
  const app = join(dir, 'application'); mkdirSync(app)
  for (const member of ['frontend', 'backend']) await command('git', ['clone', '--no-hardlinks', repo, join(app, member)])
  const discovered = JSON.parse(await command(process.execPath, [cli, 'discover', '--repo', app], clean))
  assert.equal(discovered.repositories.length, 2)
  const privateKey = 'offline-fixture-api-key'; const notices = [], widgets = new Map()
  const ctx = { cwd: app, mode: 'tui', hasUI: true, model: { provider: 'openai', id: 'gpt-6.1-sol' }, ui: {
    select: async (title, options) => title.startsWith('为此实例单独认证') ? options.find(o => o.includes('API key')) : options[0], input: async () => setupState,
    confirm: async title => !['验证模型连接', '开始接收任务'].includes(title),
    notify: text => notices.push(text), setStatus: () => {}, setWidget: (name, lines) => widgets.set(name, lines),
    custom: factory => new Promise(resolve => {
      const component = factory({ requestRender() {} }, {}, {}, value => { component.dispose?.(); resolve(value) })
      component.handleInput(privateKey)
      assert(!component.render(80).join('\n').includes(privateKey), 'Private input must be masked')
      component.handleInput('\r')
    }),
  } }
  try {
    const binding = await setup(ctx, services); assert.equal(binding.stateDir, setupState)
    setupClient = instanceClient(setupState)
    const cfg = (await setupClient.request('config')).config
    assert.equal(cfg.paused, true); assert.equal(cfg.maxWorkers, 1); assert.equal(cfg.github, null)
    assert.equal(cfg.repository, app); assert.equal(cfg.workspace.repositories.length, 2)
    assert.equal((await setupClient.request('workspace')).repositories.length, 2)
    assert.equal(cfg.routerModel.id, 'gpt-6.1-sol'); assert.deepEqual(cfg.workerModel, cfg.routerModel)
    assert.equal(JSON.parse(readFileSync(join(setupState, 'agent', 'auth.json'), 'utf8')).openai.key, privateKey)
    assert(!JSON.stringify(notices).includes(privateKey)); assert(!JSON.stringify(binding).includes(privateKey))
    assert(widgets.get('superagent-connection').includes(`Web：http://127.0.0.1:${cfg.port}`))
    assert.equal(widgets.get('superagent-login'), undefined)
    assert(!JSON.stringify([...widgets.values()]).includes(privateKey))
    const { openWeb } = await import(pathToFileURL(join(extensionDir, 'web-access.js')).href)
    let opened
    await openWeb(ctx, setupClient, { openBrowser: async href => { opened = new URL(href); return true } })
    assert.equal(opened.origin, setupClient.endpoint)
    assert.equal(opened.hash, '')
    assert(!existsSync(join(setupState, 'admin.token')))
    assert.equal((await fetch(opened.origin + '/api/v1/status').then(r => r.json())).instanceId, binding.instanceId)
    const reconnected = await connectionForProject(join(app, 'frontend'), services.connections)
    assert.equal((await reconnected.client.request('status')).instanceId, binding.instanceId)
    const pending = await reconnected.client.request('tickets', 'POST', { id: 'wizard-task', text: 'Paused offline task after setup' })
    const { restartService } = await import(pathToFileURL(join(extensionDir, 'service-control.js')).href)
    const beforeRestart = await setupClient.request('config')
    const hostFetch = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Host model fetch is unavailable; local lifecycle must be independent') }
    try { await restartService(ctx, reconnected) } finally { globalThis.fetch = hostFetch }
    assert.deepEqual(await setupClient.request('config'), beforeRestart)
    assert((await setupClient.request('triggers')).some(trigger => trigger.id === pending.id))
    await openWeb(ctx, setupClient, { openBrowser: async href => { opened = new URL(href); return true } })
    assert.equal(opened.hash, ''); assert.equal((await fetch(opened.origin + '/api/v1/status')).status, 200)
    // Exercise an actual legacy token instance, including its old Web session and a full offline mode change.
    rmSync(join(state, 'management.json')); await run('start')
    const legacyClient = instanceClient(state), legacyId = (await legacyClient.request('status')).instanceId
    const legacy = { project: repo, binding: { project: repo, repository: repo, stateDir: state, instanceId: legacyId }, client: legacyClient }
    let legacyOpened
    await openWeb(ctx, legacyClient, { openBrowser: async href => { legacyOpened = new URL(href); return true } })
    const code = new URLSearchParams(legacyOpened.hash.slice(1)).get('login'); assert(code)
    assert(!JSON.stringify(notices).includes(code)); assert(!JSON.stringify(notices).includes(token))
    const login = await fetch(url + '/api/v1/login', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    await restartService(ctx, legacy)
    assert.equal((await fetch(url + '/api/v1/status', { headers: { cookie } })).status, 401)
    const legacySettings = await legacyClient.request('config')
    await restartService(ctx, legacy, { management: 'local' })
    rmSync(join(state, 'admin.token'))
    const localClient = instanceClient(state)
    await restartService(ctx, { ...legacy, client: localClient })
    assert.deepEqual(await localClient.request('config'), legacySettings)
    assert((await localClient.request('triggers')).some(trigger => trigger.id === first.id))
    assert.equal((await fetch(url + '/api/v1/status').then(r => r.json())).management, 'local')
    await localClient.request('shutdown', 'POST')
    assert(notices.some(notice => notice.includes('重启完成')))
  } finally {
    setupClient ??= existsWizardClient()
    if (setupClient) { await setupClient.request('shutdown', 'POST').catch(() => {}); setupClient = undefined }
  }
  function existsWizardClient() { try { return instanceClient(setupState) } catch { return undefined } }
  console.log('Package smoke passed: both tarballs, plugin-only install without SDK, repaired consumer SDK tree, clean install, CLI/Web lifecycle/backup, installed multi-repository wizard/discovery, isolated SDK login IPC, masked input, token one-use login/cookie exchange, token-free local Web, inherited member binding, host-fetch-independent restart, legacy-to-local conversion and token-free restart with settings/ticket preservation.')
} catch (error) { console.error(failureLog); throw error }
finally {
  if (url && token) await fetch(url + '/api/v1/shutdown', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-superagent-local': '1' }, signal: AbortSignal.timeout(2000) }).catch(() => {})
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)) }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
