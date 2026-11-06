import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
let agentDir: string
beforeEach(() => { agentDir = mkdtempSync(join(tmpdir(), 'sa-driver-env-')) })
const mod = await import('../src/pi-driver.js').catch(() => ({} as any))
const drivers: any[] = []
afterEach(async () => { await Promise.all(drivers.splice(0).map(d => d.close())); vi.unstubAllEnvs(); rmSync(agentDir, { recursive: true, force: true }) })
it('supervises a real child and correlates concurrent deliveries and role-bound calls', async () => {
  expect(mod.PiDriver).toBeTypeOf('function')
  const calls: any[] = []; const events: any[] = []
  const driver = new mod.PiDriver({ entry: new URL('./fixtures/agent.mjs', import.meta.url),
    tool: async (target: any, name: string, args: any) => { calls.push({ target, name, args }); return { ok: true } },
    event: (target: any, event: any) => events.push({ target, event }) })
  drivers.push(driver)
  const target = { role: 'worker', key: 'worker-a', ticketId: 'a', assignmentId: 'attempt-1', agentDir }
  await Promise.all([driver.send(target, { id: 'one', text: 'one' }), driver.send(target, { id: 'two', text: 'two' })])
  expect(calls).toHaveLength(2); expect(calls[0].target.assignmentId).toBe('attempt-1')
  expect(events.filter(e => e.event.type === 'read')).toHaveLength(2)
  await driver.stop(target.key)
  expect(driver.size).toBe(0)
})
it('rejects a negative delivery acknowledgement promptly', async () => {
  const driver = new mod.PiDriver({ entry: new URL('./fixtures/agent.mjs', import.meta.url), tool: async () => {}, event: () => {} }); drivers.push(driver)
  // Process startup has its own deadline; a loaded CI host may need >500ms to fork.
  // The assertion distinguishes NACK from the 300s persistence-ACK timeout.
  await expect(driver.send({ role: 'router', key: 'router', agentDir }, { id: 'bad', text: 'fail' })).rejects.toThrow('failed delivery')
})
it('sets an instance home and strips channel credentials before the child starts', async () => {
  vi.stubEnv('GH_TOKEN', 'dummy-personal'); vi.stubEnv('PI_SUPERAGENT_GITHUB_TOKEN', 'dummy-bot')
  let environment: any
  const driver = new mod.PiDriver({ entry: new URL('./fixtures/agent.mjs', import.meta.url), tool: async (_target: any, _name: string, args: any) => { environment = JSON.parse(args.summary) }, event: () => {} }); drivers.push(driver)
  await driver.send({ role: 'router', key: 'router', agentDir }, { id: 'env', text: 'environment' })
  expect(environment.home).toBe(join(agentDir, 'home')); expect(environment.gh).toBe(join(agentDir, 'home', '.config', 'gh')); expect(environment.leaked).toBe(false)
})
it('rejects startup exits instead of hanging forever', async () => {
  expect(mod.PiDriver).toBeTypeOf('function')
  const driver = new mod.PiDriver({ entry: new URL('./fixtures/crash.mjs', import.meta.url), tool: async () => {}, event: () => {} })
  drivers.push(driver)
  await expect(driver.send({ role: 'router', key: 'router', agentDir }, { id: 'x', text: 'x' })).rejects.toThrow(/exit/i)
})
