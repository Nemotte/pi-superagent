// Build once, consume this same artifact on each target OS; never ship node_modules.
import * as fs from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { installEnvironment, payloadFiles, validateBundle } from '../distribution/install.mjs'
const exec = promisify(execFile), root = process.cwd()
const { values } = parseArgs({ options: { destination: { type: 'string' } } })
const destination = resolve(values.destination || '.artifacts/release')
if (!process.env.npm_execpath) throw Error('Run npm run release:bundle')
const server = JSON.parse(await fs.readFile(join(root, 'packages/server/package.json'), 'utf8'))
const extension = JSON.parse(await fs.readFile(join(root, 'packages/extension/package.json'), 'utf8'))
if (server.version !== extension.version) throw Error('RELEASE_VERSION')
const workspaceLock = JSON.parse(await fs.readFile(join(root, 'package-lock.json'), 'utf8'))
const approved = new Set(Object.entries(workspaceLock.packages).filter(([key, p]) => key.includes('node_modules/') && p.integrity).map(([key, p]) => `${key.split('node_modules/').at(-1)}@${p.version}:${p.integrity}`))
const npm = async (args, cwd, env) => (await exec(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout
let created = false
try {
  await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await fs.mkdir(destination, { mode: 0o700 }); created = true
  for (const dir of ['packages', 'runtime', 'client', 'builder-home']) await fs.mkdir(join(destination, dir), { mode: 0o700 })
  const home = join(destination, 'builder-home'), env = installEnvironment(home)
  for (const file of ['user.npmrc', 'global.npmrc']) await fs.writeFile(join(home, file), '', { mode: 0o600 })
  for (const name of ['server', 'extension']) {
    const [packed] = JSON.parse(await npm(['pack', '--workspace', `packages/${name}`, '--pack-destination', join(destination, 'packages'), '--ignore-scripts', '--json'], root, env))
    if (!packed.files.some(f => f.path === 'dist/index.js') || packed.files.some(f => /(^|\/)(node_modules|admin.token|state.sqlite|upstream)(\/|$)/.test(f.path))) throw Error('RELEASE_CONTENTS')
    await fs.rename(join(destination, 'packages', packed.filename), join(destination, 'packages', name + '.tgz'))
  }
  for (const [dir, name] of [['runtime', 'server'], ['client', 'extension']]) {
    const cwd = join(destination, dir)
    const product = name === 'server' ? server : extension
    const pkg = { name: `pi-superagent-${dir}`, private: true, version: server.version, dependencies: { [product.name]: `file:../packages/${name}.tgz` } }
    await fs.writeFile(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    // Seed from the verified workspace graph. Arborist prunes unrelated dev roots without
    // resolving compatible transitive ranges to whatever happens to be latest today.
    const graph = dir === 'runtime' ? Object.fromEntries(Object.entries(workspaceLock.packages).filter(([key, value]) => key.startsWith('node_modules/') && !value.link)) : {}
    for (const value of Object.values(graph)) {
      if (value.resolved?.startsWith('https://registry.npmmirror.com/')) value.resolved = value.resolved.replace('https://registry.npmmirror.com/', 'https://registry.npmjs.org/')
    }
    graph[`node_modules/${product.name}`] = { version: product.version, resolved: `file:../packages/${name}.tgz`, integrity: 'sha512-' + createHash('sha512').update(await fs.readFile(join(destination, 'packages', name + '.tgz'))).digest('base64'), license: product.license, ...product.dependencies ? { dependencies: product.dependencies } : {}, ...product.peerDependencies ? { peerDependencies: product.peerDependencies, peerDependenciesMeta: product.peerDependenciesMeta } : {}, ...product.bin ? { bin: product.bin } : {}, ...product.engines ? { engines: product.engines } : {} }
    await fs.writeFile(join(cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies }, ...graph } }, null, 2) + '\n')
    await npm(['install', '--prefix', cwd, '--workspaces=false', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], cwd, env)
    const lock = JSON.parse(await fs.readFile(join(cwd, 'package-lock.json'), 'utf8'))
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (!key || key === `node_modules/${product.name}`) continue
      if (!approved.has(`${key.split('node_modules/').at(-1)}@${pkg.version}:${pkg.integrity}`)) throw Error(`RELEASE_DEPENDENCY_DRIFT: ${key}`)
      if (!pkg.resolved?.startsWith('https://registry.npmjs.org/')) throw Error('RELEASE_REGISTRY')
    }
    if (await fs.stat(join(cwd, 'node_modules')).catch(() => false)) throw Error('RELEASE_NODE_MODULES')
  }
  await fs.copyFile(join(root, 'distribution/install.mjs'), join(destination, 'install.mjs'))
  const files = {}
  for (const file of payloadFiles) files[file] = createHash('sha256').update(await fs.readFile(join(destination, file))).digest('hex')
  await fs.writeFile(join(destination, 'bundle.json'), JSON.stringify({ format: 1, version: server.version, sdk: server.dependencies['@earendil-works/pi-coding-agent'], files }, null, 2) + '\n')
  await fs.writeFile(join(destination, 'INSTALL.txt'), 'Requires Node 24+ (with npm 10+), Git 2.31+, registry access.\nPreview: node install.mjs\nInstall: node install.mjs --yes\nDefault destination: HOME/.pi-superagent/application (must not exist).\nFor a custom location: node install.mjs --yes --destination ABSOLUTE_PATH\nIn your project, run: node "INSTALL/pi.mjs", then type /superagent.\nCLI: node "INSTALL/superagent.mjs" --help\nFor SSH setup use the printed node + serverCli, not the wrapper entry.\nPrivate Pi profile; no service/model/autostart is activated by installation.\nCopy this release directory, not an installed application or node_modules, to other systems.\n')
  await fs.rm(home, { recursive: true })
  await validateBundle(destination)
  console.log(JSON.stringify({ bundle: destination, version: server.version, platforms: ['linux', 'darwin', 'win32'], architectures: ['x64', 'arm64'], nodeModulesIncluded: false }))
} catch (error) {
  if (created) await fs.rm(destination, { recursive: true, force: true })
  console.error(/^RELEASE_|^INSTALL_/.test(error.message) ? error.message : 'RELEASE_FAILED'); process.exitCode = 1
}
