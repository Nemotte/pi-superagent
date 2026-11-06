import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
const moduleURL = new URL('../../../distribution/install.mjs', import.meta.url)
async function load() { expect(existsSync(moduleURL), 'portable installer').toBe(true); return import(moduleURL.href) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sa install 中文 ')); dirs.push(root)
  const bundle = join(root, 'bundle'); mkdirSync(bundle)
  const files: Record<string, string> = {}
  for (const name of ['server', 'extension']) { mkdirSync(join(bundle, 'packages'), { recursive: true }); writeFileSync(join(bundle, 'packages', name + '.tgz'), name) }
  for (const [dir, name] of [['runtime', 'server'], ['client', 'extension']]) {
    mkdirSync(join(bundle, dir))
    const packageName = name === 'server' ? '@nemotte/pi-superagent' : '@nemotte/pi-superagent-extension'
    const dependencies = { [packageName]: `file:../packages/${name}.tgz` }
    writeFileSync(join(bundle, dir, 'package.json'), JSON.stringify({ private: true, dependencies }))
    writeFileSync(join(bundle, dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, [`node_modules/${packageName}`]: { version: '0.1.0-alpha.1' }, ...(dir === 'runtime' ? { 'node_modules/@earendil-works/pi-coding-agent': { version: '1.5.0' } } : {}) } }))
  }
  writeFileSync(join(bundle, 'install.mjs'), readFileSync(moduleURL))
  for (const path of ['install.mjs', 'packages/server.tgz', 'packages/extension.tgz', 'runtime/package.json', 'runtime/package-lock.json', 'client/package.json', 'client/package-lock.json']) files[path] = createHash('sha256').update(readFileSync(join(bundle, path))).digest('hex')
  const manifest = { format: 1, version: '0.1.0-alpha.1', sdk: '1.5.0', files }
  writeFileSync(join(bundle, 'bundle.json'), JSON.stringify(manifest))
  return { root, bundle, manifest, destination: join(root, 'application with spaces 中文') }
}
it('checks native platform, architecture and Node before writing files', async () => {
  const m = await load()
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) expect(() => m.assertRuntime({ platform, arch, node: '24.14.1' })).not.toThrow()
  for (const value of [{ platform: 'linux', arch: 'ia32', node: '24.14.1' }, { platform: 'linux', arch: 'x64', node: '22.19.0' }, { platform: 'freebsd', arch: 'x64', node: '24.14.1' }]) expect(() => m.assertRuntime(value)).toThrow(/INSTALL_RUNTIME/)
})
it('verifies the exact portable payload and rejects modified, extra or linked manifest entries', async () => {
  const m = await load(), f = fixture()
  expect((await m.validateBundle(f.bundle)).version).toBe('0.1.0-alpha.1')
  writeFileSync(join(f.bundle, 'packages/server.tgz'), 'changed')
  await expect(m.validateBundle(f.bundle)).rejects.toThrow(/INTEGRITY/)
  f.manifest.files['../outside'] = '0'.repeat(64); writeFileSync(join(f.bundle, 'bundle.json'), JSON.stringify(f.manifest))
  await expect(m.validateBundle(f.bundle)).rejects.toThrow(/FORMAT/)
})
it('previews without writing and refuses an existing destination rather than repairing it', async () => {
  const m = await load(), f = fixture()
  const result = await m.install(f.bundle, f.destination)
  expect(result.installed).toBe(false); expect(existsSync(f.destination)).toBe(false)
  mkdirSync(f.destination); writeFileSync(join(f.destination, 'keep'), 'existing-data')
  await expect(m.install(f.bundle, f.destination, { confirmed: true })).rejects.toThrow(/EXISTS/)
  expect(readFileSync(join(f.destination, 'keep'), 'utf8')).toBe('existing-data')
  await expect(m.install(f.bundle, join(f.bundle, 'nested'), { confirmed: true })).rejects.toThrow(/PATH/)
})
it('constructs native npm candidates without executing npm.cmd or interpolating a shell command', async () => {
  const m = await load()
  expect(m.npmCandidates('C:\\Program Files\\nodejs\\node.exe', {}, 'win32')).toContain('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js')
  expect(m.npmCandidates('/opt/node/bin/node', {}, 'linux')).toContain('/opt/node/lib/node_modules/npm/bin/npm-cli.js')
  expect(m.npmCandidates('/opt/node/bin/node', {}, 'darwin')).toContain('/opt/node/bin/npm')
})
it('keeps only system/proxy/CA values for installation, excluding credentials and startup injection', async () => {
  const m = await load(), f = fixture()
  const env = m.installEnvironment(f.destination, { Path: 'tools', SystemRoot: 'system', HTTPS_PROXY: 'proxy', NODE_EXTRA_CA_CERTS: 'ca', NODE_OPTIONS: '--import=poison', OPENAI_API_KEY: 'secret', SSH_AUTH_SOCK: 'secret', npm_config_registry: 'https://wrong', PI_CODING_AGENT_DIR: 'personal' })
  expect(env.Path).toBe('tools'); expect(env.HTTPS_PROXY).toBe('proxy'); expect(env.NODE_EXTRA_CA_CERTS).toBe('ca')
  expect(JSON.stringify(env)).not.toMatch(/secret|poison|personal|wrong/)
  expect(env.HOME).toBe(f.destination); expect(env.NPM_CONFIG_USERCONFIG).toBe(join(f.destination, 'user.npmrc'))
})
it('cleans only its new target after npm failure and never reflects arbitrary stderr', async () => {
  const m = await load(), f = fixture(), npm = join(f.root, 'npm fixture', 'bin')
  mkdirSync(npm, { recursive: true }); writeFileSync(join(npm, '../package.json'), JSON.stringify({ name: 'npm', version: '11.0.0' }))
  const cli = join(npm, 'npm-cli.js'), seen = join(f.root, 'seen.json')
  writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify(process.argv.slice(2))); console.error('private-value-must-not-leak'); process.exit(2)`)
  await expect(m.install(f.bundle, f.destination, { confirmed: true, npmCli: cli })).rejects.toThrow(/^INSTALL_NPM_RUNTIME$/)
  expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual(['ci', '--prefix', join(realpathSync(f.root), basename(f.destination), 'runtime'), '--workspaces=false', '--ignore-scripts', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'])
  expect(existsSync(f.destination)).toBe(false); expect(existsSync(f.bundle)).toBe(true)
})
it('does not publish an installation whose SDK cannot load the plugin, even when version probes pass', async () => {
  const m = await load(), f = fixture(), npm = join(f.root, 'broken runtime npm/bin')
  mkdirSync(npm, { recursive: true }); writeFileSync(join(npm, '../package.json'), JSON.stringify({ name: 'npm', version: '11.0.0' }))
  const cli = join(npm, 'npm-cli.js')
  writeFileSync(cli, `const fs=require('node:fs'),p=require('node:path');
const put=(name,text)=>{const file=p.join(process.cwd(),name);fs.mkdirSync(p.dirname(file),{recursive:true});fs.writeFileSync(file,text)};
if(p.basename(process.cwd())==='runtime'){
put('node_modules/@earendil-works/pi-coding-agent/package.json',JSON.stringify({type:'module',version:'1.5.0'}));
put('node_modules/@earendil-works/pi-coding-agent/dist/cli.js',"console.log(process.argv[2]==='--version'?'1.5.0':'registered')");
put('node_modules/@earendil-works/pi-coding-agent/dist/index.js',"export class DefaultResourceLoader {async reload(){throw Error('private-loader-error')}}");
put('node_modules/@nemotte/pi-superagent/dist/cli.js',"console.log('0.1.0-alpha.1')");
}else put('node_modules/@nemotte/pi-superagent-extension/package.json',JSON.stringify({name:'@nemotte/pi-superagent-extension',version:'0.1.0-alpha.1'}));`)
  await expect(m.install(f.bundle, f.destination, { confirmed: true, npmCli: cli })).rejects.toThrow(/^INSTALL_PLUGIN$/)
  expect(existsSync(f.destination)).toBe(false)
})
it('native launchers preserve argv, bind the private profile/server and reject incomplete installs', async () => {
  const m = await load(), f = fixture(), sdk = join(f.destination, 'runtime/node_modules/@earendil-works/pi-coding-agent')
  mkdirSync(join(sdk, 'dist'), { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ version: '1.5.0' }))
  writeFileSync(join(sdk, 'dist/cli.js'), `console.log(JSON.stringify({args:process.argv.slice(2),profile:process.env.PI_CODING_AGENT_DIR,sessionDir:process.env.PI_CODING_AGENT_SESSION_DIR,server:process.env.PI_SUPERAGENT_SERVER}))`)
  writeFileSync(join(f.destination, 'installation.json'), JSON.stringify({ format: 1, sdk: '1.5.0', root: realpathSync(f.destination), platform: process.platform, arch: process.arch }))
  const launcher = join(f.destination, 'pi.mjs'); writeFileSync(launcher, m.launcherSource('pi'))
  const args = ['literal ; $ % & " 中文', '--flag']
  const output = JSON.parse((await exec(process.execPath, [launcher, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: 'personal-profile', PI_CODING_AGENT_SESSION_DIR: 'personal-sessions', PI_SUPERAGENT_SERVER: 'wrong-server' } })).stdout)
  expect(output.args).toEqual(args); expect(output.sessionDir).toBeUndefined(); expect(output.profile).toBe(join(realpathSync(f.destination), 'profile'))
  expect(output.server).toBe(join(realpathSync(f.destination), 'runtime/node_modules/@nemotte/pi-superagent/dist/cli.js'))
  writeFileSync(join(f.destination, '.installing'), '1')
  await expect(exec(process.execPath, [launcher])).rejects.toThrow(/INSTALL_INCOMPLETE/)
})
it('does not follow a bundle directory symlink', async () => {
  const m = await load(), f = fixture(), alias = join(f.root, 'alias')
  symlinkSync(f.bundle, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(m.validateBundle(alias)).rejects.toThrow(/PATH/)
})
