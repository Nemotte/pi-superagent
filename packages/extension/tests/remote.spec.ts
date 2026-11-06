import { afterEach, expect, it, vi } from 'vitest'
import { realpathSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { saveBinding, loadBinding, connectionForProject, pathKey } from '../src/instances.js'
const mod = await import('../src/remote-connections.js').catch(() => ({} as any))
const cleanup: Array<() => unknown> = []
afterEach(async () => { await mod.closeRemoteConnections?.(); for (const f of cleanup.splice(0).reverse()) await f() })
function fixture(port = 4317) {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa remote client '))); cleanup.push(() => rmSync(project, { recursive: true, force: true }))
  const binding = { project, repository: '/srv/cloud/repo', stateDir: '/srv/cloud/private', instanceId: randomUUID(), ssh: { host: 'cloud-test', node: 'node', cliPath: '/opt/sa/dist/cli.js', port } }
  return { project, directory: join(project, 'connections'), binding }
}
it('loads an SSH binding without trying to read remote paths on the client filesystem', () => {
  const f = fixture(); saveBinding(f.directory, f.binding)
  expect(loadBinding(f.directory, f.project)).toEqual(f.binding)
  expect(readFileSync(join(f.directory, pathKey(f.project) + '.json'), 'utf8')).not.toContain('token')
})
it('does not connect or send HTTP on session discovery without an explicit user connection', async () => {
  const f = fixture(); saveBinding(f.directory, f.binding)
  const connection = await connectionForProject(f.project, f.directory)
  expect(connection?.binding).toEqual(f.binding)
  await expect(connection!.client.request('status')).rejects.toThrow(/connect/)
})
it('verifies the remote identity and prevents old clients using a closed tunnel', async () => {
  expect(mod.connectRemote).toBeTypeOf('function')
  let hits = 0
  const f = fixture(), token = 'a'.repeat(48)
  const server = createServer((req, res) => { hits++; expect(req.headers.authorization).toBe(`Bearer ${token}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ protocol: 1, instanceId: f.binding.instanceId, management: 'token' })) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise<void>(r => server.close(() => r())))
  f.binding.ssh.port = (server.address() as any).port
  let active = true
  const tunnel = { value: { protocol: 1, ...f.binding, port: f.binding.ssh.port, management: 'token', token }, active: () => active, close: async () => { active = false } }
  const io = { tunnel: vi.fn(async () => tunnel) }
  const client = await mod.connectRemote(f.binding, io)
  await client.request('status'); expect(io.tunnel).toHaveBeenCalledOnce(); expect(hits).toBeGreaterThan(0)
  await mod.disconnectRemote(f.binding)
  const before = hits
  await expect(client.request('status')).rejects.toThrow(/connect/)
  await expect(client.withCredential(async () => {})).rejects.toThrow(/connect/)
  expect(hits).toBe(before)
})
it('closes a tunnel with unexpected identity without sending its credential to HTTP', async () => {
  expect(mod.connectRemote).toBeTypeOf('function')
  const f = fixture(), close = vi.fn(async () => {})
  const tunnel = { value: { protocol: 1, ...f.binding, port: f.binding.ssh.port, management: 'token', instanceId: randomUUID(), token: 'a'.repeat(48) }, active: () => true, close }
  await expect(mod.connectRemote(f.binding, { tunnel: async () => tunnel })).rejects.toThrow(/身份/)
  expect(close).toHaveBeenCalledOnce()
})
it('rejects malformed remote binding paths, host options and accidental secret persistence', () => {
  const f = fixture()
  expect(() => saveBinding(f.directory, { ...f.binding, ssh: { ...f.binding.ssh, host: '-oBad' } })).toThrow()
  expect(() => saveBinding(f.directory, { ...f.binding, repository: 'relative' })).toThrow()
  saveBinding(f.directory, { ...f.binding, token: 'do-not-persist' } as any)
  expect(readFileSync(join(f.directory, pathKey(f.project) + '.json'), 'utf8')).not.toContain('do-not-persist')
})
