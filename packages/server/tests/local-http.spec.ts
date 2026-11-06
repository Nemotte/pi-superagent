import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../src/config.js'
import { startService } from '../src/service.js'
import { InstanceClient } from '../src/client.js'
const cleanups: Array<() => unknown> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-local-http-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  initialize(dir, { repository: dir, paused: true })
  const service = await startService(dir, { port: 0 }); cleanups.push(() => service.close())
  return { ...service, dir }
}
const headers = { 'content-type': 'application/json', 'x-superagent-local': '1' }
it('allows token-free local management while blocking cross-origin and simple browser writes', async () => {
  const f = await fixture(), base = f.url + '/api/v1/'
  expect((await fetch(base + 'status')).status).toBe(200)
  expect(await fetch(base + 'session').then(r => r.json())).toEqual({ management: 'local', csrf: null })
  const payload = JSON.stringify({ id: 'local', text: 'Paused local request' })
  expect((await fetch(base + 'tickets', { method: 'POST', headers, body: payload })).status).toBe(202)
  for (const badHeaders of [{ 'content-type': 'application/json' }, { ...headers, origin: 'https://other.example' }, { ...headers, origin: 'http://127.0.0.1:9999' }, { ...headers, 'content-type': 'text/plain' }, { ...headers, 'sec-fetch-site': 'cross-site' }]) {
    expect((await fetch(base + 'tickets', { method: 'POST', headers: badHeaders, body: payload })).status).toBe(403)
  }
  expect((await fetch(base + 'status', { headers: { origin: 'https://other.example' } })).status).toBe(403)
  expect((await fetch(base + 'login-grants', { method: 'POST', headers })).status).toBe(409)
})
it('allows opening the static local UI from an external link but rejects cross-site API requests', async () => {
  const f = await fixture(), headers = { 'sec-fetch-site': 'cross-site' }
  expect((await fetch(f.url, { headers })).status).toBe(200)
  expect((await fetch(f.url + '/api/v1/status', { headers })).status).toBe(403)
})
it('starts the real local service and CLI client with no token file and accepts local shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-local-client-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const { availablePort } = await import('../../extension/src/instances.js')
  const config = initialize(dir, { repository: dir, port: await availablePort(), paused: true })
  rmSync(join(dir, 'admin.token'), { force: true })
  const f = await startService(dir, { onShutdown: () => { void f.close() } }); cleanups.push(() => f.close())
  const client = new InstanceClient(dir)
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Model proxy fetch must not handle local CLI requests'))
  expect(await client.request('status')).toMatchObject({ instanceId: config.instanceId, management: 'local' })
  expect(await client.request('shutdown', 'POST')).toEqual({ stopping: true })
})
