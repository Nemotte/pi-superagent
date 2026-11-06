import { afterEach, expect, it, vi } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
const mod = await import('../src/ssh.js').catch(() => ({} as any))
const target = { host: 'cloud-dev', node: '/opt/Node 24/bin/node', cliPath: "/opt/agent ' stable/dist/cli.js" }
const processes: ChildProcess[] = []
const launch = vi.fn((_exe: string, _args: string[]) => { const p = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/ssh.mjs', import.meta.url))], { stdio: 'pipe' }); processes.push(p); return p })
afterEach(() => { for (const p of processes.splice(0)) p.kill(); launch.mockClear() })
it('quotes remote executable paths without shell expansion and enforces SSH trust/forwarding policy', () => {
  expect(mod.sshArguments).toBeTypeOf('function')
  const args = mod.sshArguments(target, 4317)
  expect(args).toContain('BatchMode=yes'); expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('ForwardAgent=no')
  expect(args).toContain('ControlPath=none'); expect(args).toContain('ExitOnForwardFailure=yes')
  expect(args).toContain('127.0.0.1:4317:127.0.0.1:4317')
  if (process.platform !== 'win32') {
    const quoted = mod.quoteRemote("a'$(printf unsafe) b")
    expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' })).toBe("a'$(printf unsafe) b")
  }
})
it('passes only SSH/runtime environment, not local model or management credentials', () => {
  expect(mod.sshEnvironment).toBeTypeOf('function')
  expect(mod.sshEnvironment({ PATH: '/bin', HOME: '/home/test', SSH_AUTH_SOCK: '/tmp/agent', OPENAI_API_KEY: 'secret', PI_SUPERAGENT_TOKEN: 'secret', NODE_OPTIONS: '--require private.js', GH_TOKEN: 'secret' })).toEqual({ PATH: '/bin', HOME: '/home/test', SSH_AUTH_SOCK: '/tmp/agent' })
})
it('rejects an occupied local tunnel port before starting SSH', async () => {
  const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  try { await expect(mod.openSshTunnel(target, (s.address() as any).port, { operation: 'tunnel' }, { launch })).rejects.toThrow(/端口.*占用/); expect(launch).not.toHaveBeenCalled() }
  finally { await new Promise<void>(r => s.close(() => r())) }
})
it('rejects SSH option/command injection and relative remote paths', () => {
  expect(mod.sshArguments).toBeTypeOf('function')
  for (const host of ['-oProxyCommand=bad', 'user@host;id', 'host\nother', 'ssh://host', 'host space']) expect(() => mod.sshArguments({ ...target, host })).toThrow()
  for (const cliPath of ['relative/cli.js', '/a\n/cli.js']) expect(() => mod.sshArguments({ ...target, cliPath })).toThrow()
  expect(() => mod.sshArguments({ ...target, node: 'node --eval bad' })).toThrow()
})
it('sends requests and secret prompt answers only over stdin and cleans completed children', async () => {
  expect(mod.sshRequest).toBeTypeOf('function')
  const ui = { prompt: vi.fn(async () => 'secret-answer'), notify: vi.fn(), dispose: vi.fn() }
  expect(await mod.sshRequest(target, { operation: 'prompt', private: 'request-secret' }, ui, { launch })).toEqual({ answered: true })
  expect(JSON.stringify(launch.mock.calls)).not.toMatch(/request-secret|secret-answer/)
  expect(ui.dispose).toHaveBeenCalledOnce()
})
it('bounds malformed/oversized output and timeouts without reflecting stderr or raw content', async () => {
  expect(mod.sshRequest).toBeTypeOf('function')
  await expect(mod.sshRequest(target, { operation: 'bad' }, undefined, { launch })).rejects.toThrow(/PROTOCOL/)
  await expect(mod.sshRequest(target, { operation: 'huge' }, undefined, { launch })).rejects.toThrow(/LIMIT/)
  await expect(mod.sshRequest(target, { operation: 'hang' }, undefined, { launch, timeoutMs: 50 })).rejects.toThrow(/TIMEOUT/)
})
it('ignores a cancelled SDK prompt rejection but treats user cancellation as terminal', async () => {
  expect(mod.sshRequest).toBeTypeOf('function')
  const ui = { prompt: (_p: unknown, signal: AbortSignal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })), notify: vi.fn() }
  expect(await mod.sshRequest(target, { operation: 'aborted-prompt' }, ui, { launch })).toEqual({ ready: true })
  await expect(mod.sshRequest(target, { operation: 'prompt' }, { prompt: async () => undefined, notify() {} }, { launch })).rejects.toThrow(/CANCELLED/)
})
it('cancels opening connections on shutdown without starting or stopping a service', async () => {
  const controller = new AbortController()
  const opening = mod.sshRequest(target, { operation: 'hang' }, undefined, { launch, signal: controller.signal })
  controller.abort()
  await expect(opening).rejects.toThrow(/CANCELLED/)
})
it('releases in-flight login/control SSH processes when the Pi session closes', async () => {
  expect(mod.closeSshTransports).toBeTypeOf('function')
  const pending = mod.sshRequest(target, { operation: 'hang' }, undefined, { launch })
  const failure = expect(pending).rejects.toThrow(/CANCELLED/)
  await mod.closeSshTransports(); await failure
})
it('keeps a tunnel alive only after a private ready handshake and invalidates it on close', async () => {
  expect(mod.openSshTunnel).toBeTypeOf('function')
  const tunnel = await mod.openSshTunnel(target, 4317, { operation: 'tunnel' }, { launch })
  expect(tunnel.active()).toBe(true); expect(tunnel.value.token).toBe('private-memory-only')
  await tunnel.close(); expect(tunnel.active()).toBe(false)
  await tunnel.close()
})
