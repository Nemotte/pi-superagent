import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
const mod = await import('../src/jobs.js').catch(() => ({} as any))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); vi.unstubAllEnvs() })
async function jobs() {
  expect(mod.Jobs).toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-jobs-')); const manager = new mod.Jobs(dir, dir)
  cleanups.push(async () => { await manager.close(); rmSync(dir, { recursive: true, force: true }) }); return manager
}
async function settled(j: any, id: string) { for (let i = 0; i < 100; i++) { const s = j.status(id); if (s.state !== 'running') return s; await sleep(20) } throw Error('Job did not settle') }
it('starts without blocking, caps output and records exit state', async () => {
  const j = await jobs(); const job = j.start(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000)); process.exitCode=3'])
  expect(job.state).toBe('running'); const result = await settled(j, job.id)
  expect(result.state).toBe('failed'); expect(result.exitCode).toBe(3); expect(result.output.length).toBeLessThanOrEqual(32768)
})
it('does not pass personal homes or credential environment to actual job processes', async () => {
  vi.stubEnv('GH_TOKEN', 'dummy-personal'); vi.stubEnv('OPENAI_API_KEY', 'dummy-provider')
  const j = await jobs(), result = await settled(j, j.start(process.execPath, ['-e', 'console.log(JSON.stringify({ home: require("node:os").homedir(), gh: process.env.GH_CONFIG_DIR, leaked: !!(process.env.GH_TOKEN || process.env.OPENAI_API_KEY) }))']).id)
  expect(result.state).toBe('succeeded')
  const data = JSON.parse(result.output); expect(data.leaked).toBe(false); expect(data.home).not.toBe(process.env.HOME || process.env.USERPROFILE); expect(data.gh).toBe(join(data.home, '.config', 'gh'))
})
it('rejects direct GitHub CLI invocation before creating a job', async () => {
  const j = await jobs()
  for (const executable of ['gh', '/usr/bin/gh', 'C:\\tools\\gh.exe']) expect(() => j.start(executable, ['--version'])).toThrow(/host|Router|GitHub/)
  expect(j.list()).toHaveLength(0)
})
it('cancels a long-running process and rejects unknown jobs', async () => {
  const j = await jobs(); const job = j.start(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  await j.cancel(job.id); expect(j.status(job.id).state).toBe('cancelled')
  expect(() => j.status('missing')).toThrow(/Unknown/)
})
