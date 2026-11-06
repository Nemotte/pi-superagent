import { expect, it } from 'vitest'
const mod = await import('../src/agent-tools.js').catch(() => ({} as any))
it('exposes only local channel tools and read/follow kinds without GitHub capability', () => {
  expect(mod.hostTools).toBeTypeOf('function')
  for (const role of ['router', 'worker']) {
    const tools = mod.hostTools({ role, key: role }, async () => ({}))
    expect(JSON.stringify(tools)).not.toMatch(/github/i)
    expect(tools.map((t: any) => t.name)).toContain('superagent_read')
  }
})
it('enables optional GitHub tools only for a configured single-repository worker', () => {
  expect(mod.hostTools).toBeTypeOf('function')
  const target = { role: 'worker', key: 'w', github: true }
  expect(mod.hostTools(target, async () => ({})).map((t: any) => t.name)).toContain('superagent_github_create_pull')
  const workspace = { repositories: [{ id: 'repo', path: '.' }] }
  expect(JSON.stringify(mod.hostTools({ ...target, workspace }, async () => ({})))).not.toMatch(/github/i)
})
