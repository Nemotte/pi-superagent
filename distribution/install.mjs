#!/usr/bin/env node
// Standalone release installer. Only Node built-ins; do not import the development workspace.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
const exec = promisify(execFile)
export const payloadFiles = ['install.mjs', 'packages/server.tgz', 'packages/extension.tgz', 'runtime/package.json', 'runtime/package-lock.json', 'client/package.json', 'client/package-lock.json']
const fail = code => { throw new Error(code) }
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'))
async function stat(file) { try { return await fs.lstat(file) } catch (e) { if (e.code !== 'ENOENT') throw e } }
const inside = (a, b) => { const r = path.relative(a, b); return !r || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
export function assertRuntime({ platform = process.platform, arch = process.arch, node = process.versions.node } = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch) || !/^\d+\.\d+\.\d+$/.test(node) || Number(node.split('.')[0]) < 24) fail('INSTALL_RUNTIME: requires Node 24+ on Linux/macOS/Windows x64/arm64')
}
export function installEnvironment(home, source = process.env) {
  const allow = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i
  return { ...Object.fromEntries(Object.entries(source).filter(([k]) => allow.test(k))), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), NPM_CONFIG_USERCONFIG: path.join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(home, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(home, 'npm-cache'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }
}
export function npmCandidates(node, env = process.env, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix, bin = p.dirname(node)
  return [env.npm_execpath, p.join(bin, 'node_modules/npm/bin/npm-cli.js'), p.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'), ...(platform === 'win32' ? [] : [p.join(bin, 'npm'), '/usr/share/nodejs/npm/bin/npm-cli.js']), ...String(env.PATH || env.Path || '').split(p.delimiter).filter(Boolean).map(d => p.join(d, platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'))].filter(Boolean)
}
async function locateNpm(explicit) {
  for (const candidate of explicit ? [explicit] : npmCandidates(await fs.realpath(process.execPath))) {
    if (!path.isAbsolute(candidate)) continue
    try {
      const file = await fs.realpath(candidate)
      if (path.basename(file) !== 'npm-cli.js' || !(await stat(file))?.isFile()) continue
      const pkg = await json(path.resolve(path.dirname(file), '../package.json'))
      if (pkg.name === 'npm' && Number(pkg.version.split('.')[0]) >= 10) return file
    } catch {}
  }
  fail('INSTALL_NPM: install Node 24 with npm 10+ or provide --npm-cli /absolute/npm-cli.js')
}
export async function validateBundle(root) {
  if (!(await stat(root))?.isDirectory()) fail('INSTALL_PATH')
  let manifest
  try {
    const s = await stat(path.join(root, 'bundle.json'))
    if (!s?.isFile() || s.size > 16384) fail('INSTALL_FORMAT')
    manifest = await json(path.join(root, 'bundle.json'))
    if (manifest.format !== 1 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) || manifest.sdk !== '1.5.0' || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...payloadFiles].sort())) fail('INSTALL_FORMAT')
  } catch { fail('INSTALL_FORMAT') }
  for (const directory of ['packages', 'runtime', 'client']) if (!(await stat(path.join(root, directory)))?.isDirectory()) fail('INSTALL_PATH')
  for (const file of payloadFiles) {
    const s = await stat(path.join(root, file)), expected = manifest.files[file]
    if (!s?.isFile() || s.nlink > 1 || s.size > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expected)) fail('INSTALL_INTEGRITY')
    if (createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') !== expected) fail('INSTALL_INTEGRITY')
  }
  for (const [dir, name] of [['runtime', 'server'], ['client', 'extension']]) {
    const pkg = await json(path.join(root, dir, 'package.json')), lock = await json(path.join(root, dir, 'package-lock.json'))
    const packageName = name === 'server' ? '@nemotte/pi-superagent' : '@nemotte/pi-superagent-extension'
    const dependencies = { [packageName]: `file:../packages/${name}.tgz` }
    if (JSON.stringify(pkg.dependencies) !== JSON.stringify(dependencies) || lock.lockfileVersion !== 3 || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(dependencies) || lock.packages?.[`node_modules/${packageName}`]?.version !== manifest.version) fail('INSTALL_LOCK')
    if (dir === 'client' && Object.keys(lock.packages).length !== 2) fail('INSTALL_PLUGIN_DEPENDENCIES')
    if (dir === 'runtime' && lock.packages['node_modules/@earendil-works/pi-coding-agent']?.version !== manifest.sdk) fail('INSTALL_SDK')
  }
  return manifest
}
async function command(file, args, cwd, env, phase) {
  try { return (await exec(file, args, { cwd, env, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim() }
  catch { fail('INSTALL_' + phase) }
}
async function preflight(npmCli) {
  assertRuntime()
  const { DatabaseSync } = await import('node:sqlite').catch(() => fail('INSTALL_SQLITE'))
  const db = new DatabaseSync(':memory:'); try { db.prepare('SELECT 1').get() } finally { db.close() }
  const git = await command('git', ['--version'], tmpdir(), installEnvironment(tmpdir()), 'GIT')
  const version = /^git version (\d+)\.(\d+)/.exec(git)
  if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 31) fail('INSTALL_GIT: requires Git 2.31+')
  return { npm: await locateNpm(npmCli), git }
}
export function launcherSource(kind) {
  if (!['pi', 'superagent'].includes(kind)) fail('INSTALL_LAUNCHER')
  return `import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
try {
  if(existsSync(join(root,'.installing'))) throw Error('INSTALL_INCOMPLETE');
  const record=JSON.parse(readFileSync(join(root,'installation.json'),'utf8'));
  if(record.format!==1||record.root!==root||record.platform!==process.platform||record.arch!==process.arch||Number(process.versions.node.split('.')[0])<24) throw Error('INSTALL_ENVIRONMENT_CHANGED');
  const server=join(root,'runtime/node_modules/@nemotte/pi-superagent/dist/cli.js');
  const pi=join(root,'runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const sdk=JSON.parse(readFileSync(join(root,'runtime/node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8'));
  if(sdk.version!==record.sdk) throw Error('INSTALL_SDK_CHANGED');
  const env={...process.env}; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.PI_PACKAGE_DIR;
  ${kind === 'pi' ? "env.PI_SUPERAGENT_SERVER=server;env.PI_CODING_AGENT_DIR=join(root,'profile');delete env.PI_CODING_AGENT_SESSION_DIR;env.PI_SKIP_VERSION_CHECK='1';" : ''}
  const child=spawn(process.execPath,[${kind === 'pi' ? 'pi' : 'server'},...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:false});
  process.on('SIGTERM',()=>child.kill('SIGTERM'));
  process.on('SIGINT',()=>{if(!process.stdin.isTTY) child.kill('SIGINT')});
  child.on('error',()=>{console.error('INSTALL_LAUNCH_FAILED');process.exitCode=1});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)});
} catch(error) { console.error(/^INSTALL_[A-Z_]+$/.test(error.message)?error.message:'INSTALL_INVALID');process.exitCode=1 }
`
}
export async function install(bundle, destination, { confirmed = false, npmCli } = {}) {
  assertRuntime()
  if (!path.isAbsolute(destination)) fail('INSTALL_PATH')
  bundle = await fs.realpath(bundle).then(async real => { if ((await stat(bundle))?.isSymbolicLink()) fail('INSTALL_PATH'); return real })
  destination = path.resolve(destination)
  if (await stat(destination)) fail('INSTALL_EXISTS: choose an absent installation directory')
  if (inside(bundle, destination) || inside(destination, bundle)) fail('INSTALL_PATH')
  const manifest = await validateBundle(bundle), tools = await preflight(npmCli)
  if (!confirmed) return { installed: false, requiresConfirmation: true, version: manifest.version, destination, node: process.version, platform: process.platform, arch: process.arch, git: tools.git }
  let created = false
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    destination = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination))
    if (inside(bundle, destination) || inside(destination, bundle)) fail('INSTALL_PATH')
    await fs.mkdir(destination, { mode: 0o700 }); created = true
    await fs.writeFile(path.join(destination, '.installing'), '1\n', { mode: 0o600, flag: 'wx' })
    for (const dir of ['packages', 'runtime', 'client', 'profile', 'installer-home']) await fs.mkdir(path.join(destination, dir), { mode: 0o700 })
    for (const file of [...payloadFiles, 'bundle.json']) await fs.copyFile(path.join(bundle, file), path.join(destination, file), fs.constants.COPYFILE_EXCL)
    await validateBundle(destination)
    const home = path.join(destination, 'installer-home'), env = installEnvironment(home)
    for (const file of ['user.npmrc', 'global.npmrc']) await fs.writeFile(path.join(home, file), '', { mode: 0o600, flag: 'wx' })
    for (const dir of ['runtime', 'client']) await command(process.execPath, [tools.npm, 'ci', '--prefix', path.join(destination, dir), '--workspaces=false', '--ignore-scripts', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], path.join(destination, dir), env, 'NPM_' + dir.toUpperCase())
    const pi = path.join(destination, 'runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), server = path.join(destination, 'runtime/node_modules/@nemotte/pi-superagent/dist/cli.js')
    if (await command(process.execPath, [pi, '--version'], destination, env, 'PI') !== manifest.sdk || await command(process.execPath, [server, '--version'], destination, env, 'SERVER') !== manifest.version) fail('INSTALL_VERSION')
    await command(process.execPath, [pi, 'install', path.join(destination, 'client/node_modules/@nemotte/pi-superagent-extension')], destination, { ...env, PI_CODING_AGENT_DIR: path.join(destination, 'profile') }, 'REGISTER')
    const probe = `const {DefaultResourceLoader}=await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(pi), 'index.js')).href)});const loader=new DefaultResourceLoader({cwd:${JSON.stringify(destination)},agentDir:${JSON.stringify(path.join(destination, 'profile'))},noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true});await loader.reload();const loaded=loader.getExtensions();if(loaded.errors.length||!loaded.extensions.some(e=>e.commands.has('superagent')))process.exit(1)`
    await command(process.execPath, ['--input-type=module', '-e', probe], destination, env, 'PLUGIN')
    await fs.rm(home, { recursive: true })
    for (const kind of ['pi', 'superagent']) await fs.writeFile(path.join(destination, kind + '.mjs'), launcherSource(kind), { mode: 0o600, flag: 'wx' })
    await fs.writeFile(path.join(destination, 'installation.json'), JSON.stringify({ format: 1, version: manifest.version, sdk: manifest.sdk, platform: process.platform, arch: process.arch, root: destination }) + '\n', { mode: 0o600, flag: 'wx' })
    await fs.rm(path.join(destination, '.installing'))
    return { installed: true, version: manifest.version, destination, node: process.execPath, serverCli: server, pi: [process.execPath, path.join(destination, 'pi.mjs')], server: [process.execPath, path.join(destination, 'superagent.mjs')], started: false, profile: path.join(destination, 'profile') }
  } catch (error) {
    if (created) await fs.rm(destination, { recursive: true, force: true })
    if (/^INSTALL_[A-Z_]+/.test(error.message)) throw error
    fail('INSTALL_FILESYSTEM')
  }
}
async function main() {
  const { values } = parseArgs({ options: { yes: { type: 'boolean' }, destination: { type: 'string' }, 'npm-cli': { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false })
  if (values.help) { console.log('node install.mjs [--yes] [--destination ABSOLUTE_PATH] [--npm-cli ABSOLUTE_NPM_CLI]\nRequires Node 24+ with npm 10+, Git 2.31+, and registry access. Default is preview; no service starts.'); return }
  console.log(JSON.stringify(await install(path.dirname(fileURLToPath(import.meta.url)), values.destination || path.join(homedir(), '.pi-superagent', 'application'), { confirmed: values.yes, npmCli: values['npm-cli'] }), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(/^INSTALL_[A-Z_]+/.test(error.message) ? error.message : 'INSTALL_FAILED'); process.exitCode = 1 })
