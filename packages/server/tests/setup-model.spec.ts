import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
const mod = await import('../src/setup-model.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() })
async function runtime() {
  const dir = mkdtempSync(join(tmpdir(), 'sa model setup ')); dirs.push(dir)
  const authPath = join(dir, 'auth.json')
  return { authPath, runtime: await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false }) }
}
it('returns only catalog metadata and supported login methods', async () => {
  expect(mod.setupModel).toBeTypeOf('function'); const f = await runtime()
  const result = await mod.setupModel(f.runtime, { operation: 'catalog' })
  expect(result.providers.find((p: any) => p.id === 'openai').methods).toEqual(expect.arrayContaining(['oauth', 'api_key']))
  expect(result.models.find((m: any) => m.provider === 'openai')).toEqual({ provider: 'openai', id: expect.any(String), name: expect.any(String) })
})
it('reports an unconfigured provider as not ready so a fresh instance can reach the login dialog', async () => {
  const f = await runtime(); vi.stubEnv('OPENAI_API_KEY', '')
  expect(await mod.setupModel(f.runtime, { operation: 'check', provider: 'openai' })).toEqual({ ready: false })
})
it('allows re-login when stored authentication can no longer be resolved', async () => {
  const f = await runtime(); vi.spyOn(f.runtime, 'getAuth').mockRejectedValue(Error('expired authentication'))
  expect(await mod.setupModel(f.runtime, { operation: 'check', provider: 'openai' })).toEqual({ ready: false })
})
it('stores a newly entered API key in the instance store, never returning it to the plugin', async () => {
  expect(mod.setupModel).toBeTypeOf('function'); const f = await runtime(); const secret = 'test-api-key-unique-private'
  const result = await mod.setupModel(f.runtime, { operation: 'login', provider: 'openai', method: 'api_key' }, { prompt: async () => secret, notify: () => {} })
  expect(result).toEqual({ ready: true })
  expect(JSON.parse(readFileSync(f.authPath, 'utf8')).openai).toMatchObject({ type: 'api_key', key: secret })
  expect(JSON.stringify(result)).not.toContain(secret)
})
it('passes the stable instance identity required by OpenAI subscription registration', async () => {
  const f = await runtime(), deviceId = 'dc1648ec-4932-4c70-bf65-a7a3c2ce5a08'
  const login = vi.spyOn(f.runtime, 'login').mockResolvedValue({ type: 'oauth', access: 'test', refresh: 'test', expires: Date.now() + 60000 } as any)
  vi.spyOn(f.runtime, 'getAuth').mockResolvedValue({ auth: { apiKey: 'test' } })
  await mod.setupModel(f.runtime, { operation: 'login', provider: 'openai', method: 'oauth' }, { prompt: async () => '', notify: () => {} }, deviceId)
  const options = login.mock.calls[0][3]
  expect(options?.getDeviceId).toBeTypeOf('function'); expect(options?.getDeviceId?.()).toBe(deviceId)
  expect(options?.agentName).toBe('Pi Super-agent')
})
it('validates a selected model before an opt-in inference probe and reports failed inference', async () => {
  expect(mod.setupModel).toBeTypeOf('function'); const f = await runtime()
  await expect(mod.setupModel(f.runtime, { operation: 'probe', provider: 'openai', model: 'not-a-real-model' })).rejects.toThrow(/model/i)
  const complete = vi.spyOn(f.runtime, 'completeSimple').mockResolvedValue({ stopReason: 'error', errorMessage: 'secret reflected from provider' } as any)
  const model = f.runtime.getModels('openai')[0]
  await expect(mod.setupModel(f.runtime, { operation: 'probe', provider: 'openai', model: model.id })).rejects.toThrow(/未通过/)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(complete.mock.calls[0][2]).toMatchObject({ maxRetries: 0 })
})
