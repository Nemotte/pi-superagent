import { expect, it } from 'vitest'
const mod = await import('../src/cli-options.js').catch(() => ({} as any))
it('parses paths with spaces and Unicode without shell interpolation', () => {
  expect(mod.parseArgs).toBeTypeOf('function')
  expect(mod.parseArgs(['init', '--state-dir', '/tmp/state 一', '--repo', '/tmp/repo space', '--port', '4321'])).toMatchObject({ command: 'init', stateDir: '/tmp/state 一', repository: '/tmp/repo space', port: 4321 })
})
it('supports a paused single-worker bootstrap without changing normal init defaults', () => {
  expect(mod.parseArgs(['init', '--paused', '--max-workers', '1'])).toMatchObject({ paused: true, maxWorkers: 1 })
  expect(mod.parseArgs(['init']).paused).toBeUndefined()
  expect(() => mod.parseArgs(['init', '--max-workers', '0'])).toThrow()
})
it('parses workspace discovery and explicit member paths without shell splitting', () => {
  expect(mod.parseArgs(['init', '--workspace', '--repo', '/tmp/app', '--member', 'front one', '--member', 'backend/exam'])).toMatchObject({ workspace: true, members: ['front one', 'backend/exam'] })
  expect(mod.parseArgs(['discover', '--repo', '/tmp/app']).command).toBe('discover')
  expect(() => mod.parseArgs(['init', '--member', 'front'])).toThrow(/workspace/)
})
it('accepts local or token management and an expected identity for offline changes', () => {
  expect(mod.parseArgs(['init', '--management', 'token']).management).toBe('token')
  expect(mod.parseArgs(['management', 'local', '--expected-instance-id', 'expected'])).toMatchObject({ command: 'management', args: ['local'], expectedInstanceId: 'expected' })
  expect(() => mod.parseArgs(['init', '--management', 'none'])).toThrow()
})
it('parses explicit supervision confirmation and the unit-only foreground flag', () => {
  expect(mod.parseArgs(['service', 'install', '--yes', '--expected-instance-id', 'expected'])).toMatchObject({ command: 'service', args: ['install'], confirmed: true, expectedInstanceId: 'expected' })
  expect(mod.parseArgs(['serve', '--supervised']).supervised).toBe(true)
  expect(mod.parseArgs(['service', 'plan']).confirmed).toBeUndefined()
})
it('requires a bounded explicit retention count and keeps deletion confirmation separate', () => {
  expect(mod.parseArgs(['backup-prune', '/private/backups', '--keep', '3'])).toMatchObject({ keep: 3, confirmed: undefined })
  for (const n of ['0', '-1', '1.5', '1001', 'bad']) expect(() => mod.parseArgs(['backup-prune', '/private/backups', '--keep', n])).toThrow()
})
it('rejects unknown options and malformed ports', () => {
  expect(mod.parseArgs).toBeTypeOf('function')
  expect(() => mod.parseArgs(['init', '--magic'])).toThrow()
  expect(() => mod.parseArgs(['init', '--port', 'abc'])).toThrow()
})
