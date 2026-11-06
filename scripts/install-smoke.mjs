import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
const exec = promisify(execFile), root = process.cwd(), temp = mkdtempSync(join(tmpdir(), 'sa portable 安装 '))
let rpc, state, server, env, rpcExited, started = false
const run = async (file, args, cwd = temp, environment = env || process.env) => (await exec(file, args, { cwd, env: environment, timeout: 240000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout.trim()
try {
  const supplied = process.argv.indexOf('--bundle'), bundle = supplied >= 0 ? resolve(process.argv[supplied + 1]) : join(temp, 'artifacts', 'release')
  if (supplied < 0) {
    assert(existsSync(join(root, 'scripts/release-bundle.mjs')), 'portable release builder exists')
    await run(process.execPath, [join(root, 'scripts/release-bundle.mjs'), '--destination', bundle], root)
  }
  const { installEnvironment } = await import(pathToFileURL(join(bundle, 'install.mjs')).href)
  const home = join(temp, 'empty home'), destination = join(home, 'application with spaces 中文'); mkdirSync(home)
  const parentPackage = JSON.stringify({ name: 'unrelated-parent-workspace', private: true, workspaces: ['application with spaces 中文/*'] })
  writeFileSync(join(home, 'package.json'), parentPackage)
  env = { ...installEnvironment(home), NPM_CONFIG_REGISTRY: 'https://invalid.invalid', PI_CODING_AGENT_DIR: join(home, 'personal-pi'), PI_OFFLINE: '1', GIT_AUTHOR_NAME: 'Portable', GIT_AUTHOR_EMAIL: 'portable@example.com', GIT_COMMITTER_NAME: 'Portable', GIT_COMMITTER_EMAIL: 'portable@example.com' }
  const args = [join(bundle, 'install.mjs'), '--destination', destination]
  const preview = JSON.parse(await run(process.execPath, args)); assert.equal(preview.installed, false); assert(!existsSync(destination))
  const installed = JSON.parse(await run(process.execPath, [...args, '--yes'])); assert.equal(installed.installed, true); assert.equal(installed.started, false)
  assert.equal(installed.serverCli, join(installed.destination, 'runtime/node_modules/@nemotte/pi-superagent/dist/cli.js'))
  assert.equal(installed.node, process.execPath)
  assert(!existsSync(join(destination, 'installer-home')), 'temporary npm configuration/cache must not remain in the installation')
  assert.equal(readFileSync(join(home, 'package.json'), 'utf8'), parentPackage)
  assert(!existsSync(join(home, 'node_modules'))); assert(!existsSync(join(home, 'package-lock.json')))
  assert(!existsSync(env.PI_CODING_AGENT_DIR)); assert(!existsSync(join(destination, '.installing')))
  const clientLock = JSON.parse(readFileSync(join(destination, 'client/package-lock.json')))
  assert.deepEqual(Object.keys(clientLock.packages).sort(), ['', 'node_modules/@nemotte/pi-superagent-extension'])
  const pi = join(destination, 'pi.mjs'); server = join(destination, 'superagent.mjs')
  assert.equal(await run(process.execPath, [pi, '--version']), '1.5.0')
  assert.equal(await run(process.execPath, [server, '--version']), '0.1.0-alpha.1')
  const repo = join(temp, 'repository'); mkdirSync(repo)
  await run('git', ['init'], repo); writeFileSync(join(repo, 'README.md'), 'Portable fixture\n'); await run('git', ['add', '.'], repo); await run('git', ['commit', '-m', 'fixture'], repo)
  // The actual bundled Pi loads the separately installed ESM plugin, with no physical SDK in its tree.
  rpc = spawn(process.execPath, [pi, '--mode', 'rpc', '--no-session', '--offline', '--no-approve', '--no-context-files', '--no-skills'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  rpcExited = new Promise(resolve => rpc.once('exit', resolve))
  const commands = await new Promise((resolve, reject) => {
    let buffer = '', error = ''
    const timer = setTimeout(() => reject(Error('Installed Pi RPC timed out: ' + error.slice(-1000))), 30000)
    rpc.stderr.on('data', chunk => { error = (error + chunk).slice(-4096) })
    rpc.on('error', e => { clearTimeout(timer); reject(e) })
    rpc.on('exit', () => { clearTimeout(timer); reject(Error('Installed Pi exited: ' + error)) })
    rpc.stdout.on('data', chunk => {
      buffer += chunk; if (buffer.length > 1024 * 1024) { clearTimeout(timer); reject(Error('RPC output limit')); return }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try { const message = JSON.parse(line); if (message.id === 'commands') { clearTimeout(timer); resolve(message) } } catch {}
      }
    })
    rpc.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n')
  })
  assert.equal(commands.success, true); assert(commands.data.commands.some(c => c.name === 'superagent'))
  rpc.kill('SIGTERM'); await rpcExited; rpc = undefined
  // Drive the SDK-loaded command through its lazy setup import and real masked Input,
  // not a native import that could accidentally borrow the workspace's peer packages.
  const wizard = join(temp, 'wizard.mjs'), wizardState = join(home, 'wizard state')
  writeFileSync(wizard, `import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs'; import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
const sdk=await import(${JSON.stringify(pathToFileURL(join(destination, 'runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)});
const loader=new sdk.DefaultResourceLoader({cwd:${JSON.stringify(repo)},agentDir:${JSON.stringify(join(destination, 'profile'))},noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true});
await loader.reload(); const loaded=loader.getExtensions(); assert.deepEqual(loaded.errors,[]);
const command=loaded.extensions.flatMap(e=>[...e.commands.values()]).find(c=>c.name==='superagent'); assert(command);
const notices=[], key='portable-fixture-key', state=${JSON.stringify(wizardState)};
const ctx={cwd:${JSON.stringify(repo)},mode:'tui',hasUI:true,model:{provider:'openai',id:'gpt-6.1-sol'},ui:{
select:async(title,options)=>title.startsWith('为此实例单独认证')?options.find(o=>o.includes('API key')):options[0],input:async()=>state,
confirm:async(title)=>!['验证模型连接','开始接收任务'].includes(title),notify:(text,type)=>notices.push({text,type}),setStatus(){},setWidget(){},
custom:factory=>new Promise(resolve=>{const c=factory({requestRender(){}},{},{},value=>{c.dispose?.();resolve(value)});c.handleInput(key);assert(!c.render(80).join('').includes(key));c.handleInput('\\r')})}};
try {await command.handler('setup',ctx);assert(!notices.some(n=>n.type==='error'),JSON.stringify(notices));assert(existsSync(state+'/agent/auth.json'));assert.equal(JSON.parse(readFileSync(state+'/agent/auth.json')).openai.key,key);assert(!JSON.stringify(notices).includes(key));}
finally {if(existsSync(state+'/config.json')) await promisify(execFile)(process.execPath,[${JSON.stringify(server)},'shutdown','--state-dir',state]).catch(()=>{});}
`)
  await run(process.execPath, [wizard], repo, { ...env, PI_SUPERAGENT_SERVER: join(destination, 'runtime/node_modules/@nemotte/pi-superagent/dist/cli.js'), PI_CODING_AGENT_DIR: join(destination, 'profile') })
  for (let i = 0; i < 100 && existsSync(wizardState + '.lock'); i++) await sleep(50)
  assert(!existsSync(wizardState + '.lock'))
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r))
  state = join(home, 'instance 中文')
  const cli = (...args) => run(process.execPath, [server, ...args, '--state-dir', state], repo)
  await cli('init', '--repo', repo, '--port', String(port), '--paused', '--max-workers', '1')
  const status = JSON.parse(await cli('start')); started = true; assert.equal(status.status.paused, true)
  const url = `http://127.0.0.1:${port}`; assert((await fetch(url).then(r => r.text())).includes('Pi Super-agent'))
  const input = JSON.parse(await cli('request', 'Portable installation test', '--id', 'portable-once'))
  assert.equal(JSON.parse(await cli('request', 'Portable installation test', '--id', 'portable-once')).id, input.id)
  const installedServer = join(destination, 'runtime/node_modules/@nemotte/pi-superagent/dist')
  const { Jobs } = await import(pathToFileURL(join(installedServer, 'jobs.js')).href)
  const jobs = new Jobs(join(state, 'fixture-jobs'), repo)
  try {
    const job = jobs.start(process.execPath, ['-e', 'process.stdout.write("native-job-ok")'])
    for (let i = 0; i < 100 && jobs.status(job.id).state === 'running'; i++) await sleep(50)
    assert.equal(jobs.status(job.id).state, 'succeeded'); assert.equal(jobs.status(job.id).output, 'native-job-ok')
  } finally { await jobs.close() }
  await cli('shutdown'); started = false
  for (let i = 0; i < 100 && existsSync(state + '.lock'); i++) await sleep(50)
  assert(!existsSync(state + '.lock'))
  if (process.argv.includes('--audit')) {
    assert(process.env.npm_execpath, 'Run via npm')
    for (const dir of ['runtime', 'client']) {
      const report = JSON.parse(await run(process.execPath, [process.env.npm_execpath, 'audit', '--prefix', join(destination, dir), '--workspaces=false', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'], join(destination, dir), installEnvironment(home)))
      assert.equal(report.metadata.vulnerabilities.total, 0); console.log(`Portable ${dir} audit: 0 vulnerabilities`)
    }
  }
  console.log(`Portable install smoke passed (${process.platform}/${process.arch}): same bundle, empty home, native npm/SQLite, isolated plugin tree, real Pi RPC command registration and SDK-loaded setup/masked test-key login, CLI/Web/pending input, native Node Job and clean shutdown; no model calls or business instances used.`)
} finally {
  if (rpc) { rpc.kill('SIGTERM'); await rpcExited }
  if (started && server) await run(process.execPath, [server, 'shutdown', '--state-dir', state]).catch(() => {})
  rmSync(temp, { recursive: true, force: true })
}
