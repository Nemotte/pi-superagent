import { afterEach, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('../src/setup-rpc.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function backend() { return { setupPath: fileURLToPath(new URL('./fixtures/setup.mjs', import.meta.url)), setupEnvironment: () => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }) } }
function state() { const dir = mkdtempSync(join(tmpdir(), 'sa rpc ')); dirs.push(dir); return dir }
it('carries private input over IPC, not argv, and resolves on completion', async () => {
  expect(mod.setupRpc).toBeTypeOf('function')
  const prompts: any[] = []
  const value = await mod.setupRpc(backend(), state(), { operation: 'login' }, { prompt: async (p: any) => { prompts.push(p); return 'private-key' }, notify: () => {} }, 2000)
  expect(prompts[0].type).toBe('secret'); expect(value).toEqual({ ready: true, leaked: false, args: [] })
  expect(JSON.stringify(value)).not.toContain('private-key')
})
it('kills a stalled initialization process on timeout and rejects a crashed process', async () => {
  expect(mod.setupRpc).toBeTypeOf('function')
  await expect(mod.setupRpc(backend(), state(), { operation: 'timeout' }, undefined, 80)).rejects.toThrow(/超时|timeout/)
  await expect(mod.setupRpc(backend(), state(), { operation: 'crash' }, undefined, 2000)).rejects.toThrow(/退出|exit/)
})
it('continues login if the SDK aborts a manual prompt whose UI rejects on abort', async () => {
  const ui = { prompt: async (_prompt: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('obsolete prompt')), { once: true })), notify: () => {} }
  await expect(mod.setupRpc(backend(), state(), { operation: 'automatic-callback' }, ui, 3000)).resolves.toEqual({ ready: true })
})
it('distinguishes a UI failure from user cancellation without exposing private error text', async () => {
  const ui = { prompt: async () => { throw Error('private-callback-code') }, notify: () => {} }
  const result = await mod.setupRpc(backend(), state(), { operation: 'login' }, ui, 2000).catch((error: Error) => error.message)
  expect(result).toContain('界面'); expect(result).not.toContain('取消'); expect(result).not.toContain('private-callback-code')
})
it('cleans up notification failures instead of throwing out of the IPC handler', async () => {
  let disposed = false
  const ui = { prompt: async () => '', notify: () => { throw Error('UI unavailable') }, dispose: () => { disposed = true } }
  await expect(mod.setupRpc(backend(), state(), { operation: 'notify-failure' }, ui, 500)).rejects.toThrow(/界面/)
  expect(disposed).toBe(true)
})
it('cancels initialization when a login dialog is dismissed', async () => {
  expect(mod.setupRpc).toBeTypeOf('function')
  await expect(mod.setupRpc(backend(), state(), { operation: 'login' }, { prompt: async () => undefined, notify: () => {} }, 2000)).rejects.toThrow(/取消|cancel/)
})
