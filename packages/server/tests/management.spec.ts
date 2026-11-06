import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { initialize } from '../src/config.js'
const mod = await import('../src/management.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })))
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'sa-local-')); dirs.push(dir); const config = initialize(dir, { repository: dir, paused: true }); return { dir, config } }
it('defaults new instances to local without creating administrator credentials', () => {
  const { dir } = fixture()
  expect(existsSync(join(dir, 'admin.token'))).toBe(false)
  expect(mod.readManagement(dir)).toBe('local')
})
it('retains token mode for legacy instances and rejects malformed management settings', () => {
  expect(mod.readManagement).toBeTypeOf('function'); const { dir } = fixture()
  rmSync(join(dir, 'management.json'))
  expect(mod.readManagement(dir)).toBe('token')
  writeFileSync(join(dir, 'management.json'), '{"schema":1,"mode":"oops"}')
  expect(() => mod.readManagement(dir)).toThrow()
})
it('switches only offline with matching identity and preserves credentials when returning to local', () => {
  expect(mod.configureManagement).toBeTypeOf('function'); const { dir, config } = fixture()
  const unlock = lockSync(dir)
  try { expect(() => mod.configureManagement(dir, 'token', config.instanceId)).toThrow() } finally { unlock() }
  expect(() => mod.configureManagement(dir, 'token', 'wrong')).toThrow(/identity/i)
  expect(existsSync(join(dir, 'admin.token'))).toBe(false)
  mod.configureManagement(dir, 'token', config.instanceId)
  const token = readFileSync(join(dir, 'admin.token'), 'utf8')
  expect(token.trim()).toHaveLength(43); expect(mod.readManagement(dir)).toBe('token')
  mod.configureManagement(dir, 'local', config.instanceId)
  expect(mod.readManagement(dir)).toBe('local'); expect(readFileSync(join(dir, 'admin.token'), 'utf8')).toBe(token)
})
