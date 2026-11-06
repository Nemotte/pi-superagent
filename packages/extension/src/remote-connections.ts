import { Client } from './client.js'
import { sshBinding, type Binding } from './instances.js'
import { closeSshTransports, openSshTunnel, type SshTunnel } from './ssh.js'
interface Entry { client: Client; tunnel: SshTunnel }
const connected = new Map<string, Entry>(), pending = new Map<string, { controller: AbortController; promise: Promise<Client> }>()
const keyOf = (b: Binding) => JSON.stringify(sshBinding(b))
export const remoteExpected = (b: Binding) => ({ instanceId: b.instanceId, repository: b.repository, port: sshBinding(b).ssh.port })
export const remoteEndpoint = (b: Binding) => `http://127.0.0.1:${sshBinding(b).ssh.port}`
const disconnected = () => { throw Error('SSH 连接已关闭；请运行 /superagent connect。远端服务可能仍在运行。') }
/** Passive lookup: session_start/model tools never create SSH connections. */
export function remoteClient(binding: Binding): Client {
  const entry = connected.get(keyOf(binding))
  return entry?.tunnel.active() ? entry.client : new Client(remoteEndpoint(binding), undefined, binding.instanceId, disconnected)
}
export function connectRemote(binding: Binding, io: { tunnel?: typeof openSshTunnel } = {}): Promise<Client> {
  const b = sshBinding(binding), key = keyOf(b), entry = connected.get(key)
  if (entry?.tunnel.active()) return Promise.resolve(entry.client)
  const previous = pending.get(key)
  if (previous) return previous.promise
  const controller = new AbortController()
  const promise = (async () => {
    if (entry) { connected.delete(key); await entry.tunnel.close() }
    const tunnel = await (io.tunnel || openSshTunnel)(b.ssh, b.ssh.port, { operation: 'tunnel', stateDir: b.stateDir, expected: remoteExpected(b) }, { signal: controller.signal })
    try {
      controller.signal.throwIfAborted()
      const v = tunnel.value
      if (!v || v.protocol !== 1 || v.instanceId !== b.instanceId || v.repository !== b.repository || v.stateDir !== b.stateDir || v.port !== b.ssh.port || v.management !== 'token' || typeof v.token !== 'string' || v.token.length < 32 || v.token.length > 200) throw Error('远端实例身份或协议已变化；请重新运行 /superagent ssh。')
      const client = new Client(remoteEndpoint(b), v.token, b.instanceId, () => { if (!tunnel.active()) disconnected() })
      delete v.token // Only the private Client retains the credential for this connection.
      const status = await client.request('status') as { management: string }
      if (status.management !== 'token') throw Error('SSH 实例必须使用 token 管理模式。')
      controller.signal.throwIfAborted(); connected.set(key, { client, tunnel }); return client
    } catch (error) { await tunnel.close(); throw error }
  })().finally(() => { if (pending.get(key)?.controller === controller) pending.delete(key) })
  pending.set(key, { controller, promise }); return promise
}
export async function disconnectRemote(binding: Binding): Promise<void> {
  const key = keyOf(binding), opening = pending.get(key)
  opening?.controller.abort(); if (opening) await opening.promise.catch(() => {})
  const entry = connected.get(key); connected.delete(key); await entry?.tunnel.close()
}
export async function closeRemoteConnections(): Promise<void> {
  await closeSshTransports()
  for (const p of pending.values()) p.controller.abort()
  await Promise.allSettled([...pending.values()].map(p => p.promise))
  const entries = [...connected.values()]; connected.clear()
  await Promise.allSettled(entries.map(e => e.tunnel.close()))
}
