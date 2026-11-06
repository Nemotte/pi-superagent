import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const sdk = '@earendil-works/pi-coding-agent', tui = '@earendil-works/pi-tui'

it('coordinates public alpha package names, metadata and workspace links', () => {
  const lock = json('../../../package-lock.json')
  for (const [directory, name] of [['server', '@nemotte/pi-superagent'], ['extension', '@nemotte/pi-superagent-extension']]) {
    const pkg = json(`../../${directory}/package.json`)
    expect(pkg.name).toBe(name)
    expect(pkg.version).toBe('0.1.0-alpha.1')
    expect(pkg.publishConfig).toEqual({ access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org' })
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/Nemotte/pi-superagent.git', directory: `packages/${directory}` })
    expect(pkg.homepage).toBe('https://github.com/Nemotte/pi-superagent#readme')
    expect(pkg.bugs.url).toBe('https://github.com/Nemotte/pi-superagent/issues')
    expect(lock.packages[`packages/${directory}`].name).toBe(name)
    expect(lock.packages[`node_modules/${name}`]).toEqual({ resolved: `packages/${directory}`, link: true })
  }
  expect(JSON.stringify(lock)).not.toContain('@pi-superagent/')
})

it('pins the repaired SDK and coordinates the plugin host minimum without bundling another SDK', () => {
  const server = json('../package.json'), extension = json('../../extension/package.json')
  expect(server.dependencies[sdk]).toBe('1.5.0')
  expect(server.engines.node).toBe('>=24')
  expect(extension.engines?.node).toBe('>=24')
  for (const name of [sdk, tui]) {
    expect(extension.devDependencies[name]).toBe('1.5.0')
    expect(extension.peerDependencies[name]).toBe('^1.5.0')
    expect(extension.peerDependenciesMeta[name]).toEqual({ optional: true })
    expect(extension.dependencies?.[name]).toBeUndefined()
    expect(extension.optionalDependencies?.[name]).toBeUndefined()
  }
})

it('locks the upstream repaired production dependencies without workspace overrides', () => {
  const root = json('../../../package.json'), lock = json('../../../package-lock.json')
  expect(root.overrides).toBeUndefined()
  const installed = (name: string) => Object.entries<any>(lock.packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`)).map(([, pkg]) => pkg)
  for (const [name, version] of [[sdk, '1.5.0'], [tui, '1.5.0'], ['minimatch', '11.0.3'], ['undici', '8.12.3']]) {
    const packages = installed(name)
    expect(packages.length, name).toBeGreaterThan(0)
    expect(packages.map(p => p.version), name).toEqual(packages.map(() => version))
    for (const pkg of packages) expect(pkg.integrity, name).toMatch(/^sha512-/)
  }
  expect(lock.packages['packages/server'].dependencies[sdk]).toBe('1.5.0')
  expect(lock.packages['packages/extension'].devDependencies[sdk]).toBe('1.5.0')
})
