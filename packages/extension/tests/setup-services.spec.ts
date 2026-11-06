import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareLocalStart } from '../src/setup-services.js'
const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function backend(fail = false, supervised = false) {
  const dir = mkdtempSync(join(tmpdir(), 'sa preflight 中文 ')); dirs.push(dir)
  const cli = join(dir, 'cli.js'), seen = join(dir, 'args.json'), started = join(dir, 'started')
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dir, 'bootstrap.js'), `export const protocol=1, supervisionProtocol=${supervised ? 1 : 0}, cliPath=${JSON.stringify(cli)}; export const setupEnvironment=()=>({});`)
  writeFileSync(cli, `import {writeFileSync} from 'node:fs'; const args=process.argv.slice(2);writeFileSync(${JSON.stringify(seen)},JSON.stringify(args));if(args[0]==='--version'){process.exit(${fail ? 1 : 0})}writeFileSync(${JSON.stringify(started)},'started');`)
  vi.stubEnv('PI_SUPERAGENT_SERVER', cli)
  return { dir, seen, started }
}
it('preflights the actual CLI before returning a deferred start, preserving literal state paths', async () => {
  const f = backend(), state = join(f.dir, 'state with spaces 中文')
  const start = await prepareLocalStart(state)
  expect(JSON.parse(readFileSync(f.seen, 'utf8'))).toEqual(['--version', '--state-dir', state])
  expect(existsSync(f.started)).toBe(false)
  await start()
  expect(JSON.parse(readFileSync(f.seen, 'utf8'))).toEqual(['start', '--state-dir', state])
  expect(existsSync(f.started)).toBe(true)
})
it('binds both managed stop and deferred start to the expected instance identity', async () => {
  const f = backend(false, true), start = await prepareLocalStart(f.dir, undefined, 'expected-instance')
  expect(start.stop).toBeTypeOf('function')
  await start.stop!()
  expect(JSON.parse(readFileSync(f.seen, 'utf8'))).toEqual(['shutdown', '--expected-instance-id', 'expected-instance', '--state-dir', f.dir])
  await start()
  expect(JSON.parse(readFileSync(f.seen, 'utf8'))).toEqual(['start', '--expected-instance-id', 'expected-instance', '--state-dir', f.dir])
})
it('rejects local migration on an old CLI before stopping or starting anything', async () => {
  const f = backend()
  await expect(prepareLocalStart(f.dir, { mode: 'local', instanceId: 'expected' })).rejects.toThrow(/本地模式|management/)
})
it('shows only a bounded known supervision error code, not arbitrary CLI stderr', async () => {
  const f = backend()
  writeFileSync(join(f.dir, 'cli.js'), "console.error('SERVICE_OWNERSHIP'); process.exit(1)")
  await expect(prepareLocalStart(f.dir)).rejects.toThrow(/SERVICE_OWNERSHIP/)
  writeFileSync(join(f.dir, 'cli.js'), "console.error('SERVICE_OWNERSHIP private-secret'); process.exit(1)")
  await expect(prepareLocalStart(f.dir)).rejects.not.toThrow(/private-secret/)
})
it('rejects an unusable CLI before any start action', async () => {
  const f = backend(true)
  await expect(prepareLocalStart(f.dir)).rejects.toThrow(/服务操作/)
  expect(existsSync(f.started)).toBe(false)
})
