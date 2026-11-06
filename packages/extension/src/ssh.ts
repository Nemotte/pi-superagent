import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createServer } from 'node:net'
import type { LoginUI } from './setup-rpc.js'
export interface SshTarget { host: string; node: string; cliPath: string }
export interface SshOptions { signal?: AbortSignal; launch?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams; timeoutMs?: number }
export interface SshTunnel { value: any; active(): boolean; close(): Promise<void> }
const transports = new Set<() => Promise<void>>()
export async function closeSshTransports(): Promise<void> { await Promise.allSettled([...transports].map(close => close())) }
export function remotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw Error('请输入远端绝对路径。')
  return value
}
export function validateSsh(target: SshTarget): SshTarget {
  if (!target || typeof target.host !== 'string' || target.host.length > 250 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target.host)) throw Error('请输入 SSH 配置别名或 user@hostname；端口和跳板机请配置在 ~/.ssh/config。')
  if (target.node !== 'node') remotePath(target.node)
  if (posix.basename(remotePath(target.cliPath)) !== 'cli.js') throw Error('请选择远端服务包 dist/cli.js 的绝对路径。')
  return { host: target.host, node: target.node, cliPath: target.cliPath }
}
export function sshEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID'])
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())))
}
export function quoteRemote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }
export function sshArguments(input: SshTarget, port?: number): string[] {
  const target = validateSsh(input)
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw Error('Invalid tunnel port')
  const policy = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'PermitLocalCommand=no', 'ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ExitOnForwardFailure=yes', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=2', 'LogLevel=ERROR', 'RemoteCommand=none']
  const command = `${quoteRemote(target.node)} ${quoteRemote(posix.join(posix.dirname(target.cliPath), 'remote-child.js'))}`
  return ['-T', ...policy.flatMap(p => ['-o', p]), ...(port === undefined ? ['-o', 'ClearAllForwardings=yes'] : ['-L', `127.0.0.1:${port}:127.0.0.1:${port}`]), '--', target.host, command]
}
function exchange(target: SshTarget, request: unknown, ui: LoginUI | undefined, options: SshOptions, port?: number): Promise<any> {
  const args = sshArguments(target, port)
  if (options.signal?.aborted) return Promise.reject(Error('SSH 操作未完成（CANCELLED）。'))
  return new Promise((resolve, reject) => {
    const child = (options.launch || ((exe, argv) => spawn(exe, argv, { stdio: 'pipe', windowsHide: true, env: sshEnvironment() })) )('ssh', args)
    const decoder = new StringDecoder('utf8'), prompts = new Map<number, AbortController>()
    let buffer = '', size = 0, stderr = 0, settled = false, active = true, closed: Promise<void> | undefined
    const timer = setTimeout(() => fail('TIMEOUT'), options.timeoutMs ?? 45000)
    const abort = () => fail('CANCELLED')
    const release = () => { abort(); return close() }
    transports.add(release)
    options.signal?.addEventListener('abort', abort, { once: true })
    const closedEvent = new Promise<void>(r => { child.once('close', () => { active = false; r() }); child.once('error', () => { active = false; r() }) })
    function cleanUI() { for (const c of prompts.values()) c.abort(); prompts.clear(); try { ui?.dispose?.() } catch { /* no secrets in cleanup errors */ } }
    function close(): Promise<void> {
      if (closed) return closed
      active = false; clearTimeout(timer); transports.delete(release); options.signal?.removeEventListener('abort', abort); cleanUI(); child.stdin.end(); child.kill()
      closed = (async () => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref()
        await closedEvent; clearTimeout(force)
      })()
      return closed
    }
    function fail(code: string) {
      void close()
      if (settled) return; settled = true
      reject(Error(`SSH 操作未完成（${code}）。请检查 SSH 信任/密钥、远端服务包及实例；未自动重试。`))
    }
    function send(message: unknown) {
      const line = JSON.stringify(message) + '\n'
      if (Buffer.byteLength(line) > 256 * 1024) { fail('INPUT_LIMIT'); return }
      if (active) child.stdin.write(line, error => { if (error) fail('DISCONNECTED') })
    }
    child.once('error', () => fail('SPAWN')); child.once('close', () => fail('DISCONNECTED'))
    child.stdin.on('error', () => fail('DISCONNECTED')); child.stdout.on('error', () => fail('DISCONNECTED'))
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > 65536) fail('OUTPUT_LIMIT') })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) { fail('OUTPUT_LIMIT'); return }
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail('OUTPUT_LIMIT'); return }
      while (active && buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let m: any
        try { m = JSON.parse(line) } catch { fail('PROTOCOL'); return }
        if (!m || typeof m !== 'object' || settled) { fail('PROTOCOL'); return }
        if (m.type === 'error') { fail(typeof m.code === 'string' && /^[A-Z_]{1,40}$/.test(m.code) ? m.code : 'REMOTE_FAILED'); return }
        if (m.type === 'ready' && port !== undefined) {
          settled = true; clearTimeout(timer); cleanUI()
          resolve({ value: m.value, active: () => active && child.exitCode === null && child.signalCode === null, close } satisfies SshTunnel); return
        }
        if (m.type === 'result' && port === undefined) { settled = true; void close(); resolve(m.value); return }
        if (m.type === 'notify') { try { ui?.notify(m.event) } catch { fail('UI_FAILED') }; continue }
        if (m.type === 'cancel-prompt') { prompts.get(m.id)?.abort(); prompts.delete(m.id); continue }
        if (m.type === 'prompt' && ui && Number.isSafeInteger(m.id) && m.id > 0 && m.prompt && !prompts.has(m.id)) {
          const controller = new AbortController(); prompts.set(m.id, controller)
          void Promise.resolve().then(() => controller.signal.aborted ? undefined : ui.prompt(m.prompt, controller.signal)).then(value => {
            prompts.delete(m.id)
            if (!active || controller.signal.aborted) return
            if (value === undefined) { fail('CANCELLED'); return }
            send({ type: 'answer', id: m.id, value })
          }).catch(() => { if (active && !controller.signal.aborted) fail('UI_FAILED') })
          continue
        }
        fail('PROTOCOL'); return
      }
    })
    send({ type: 'init', request })
  })
}
export function sshRequest(target: SshTarget, request: unknown, ui?: LoginUI, options: SshOptions = {}): Promise<any> { return exchange(target, request, ui, options) }
export async function openSshTunnel(target: SshTarget, port: number, request: unknown, options: SshOptions = {}): Promise<SshTunnel> {
  sshArguments(target, port) // Validate before allocating any resources.
  const probe = createServer()
  await new Promise<void>((resolve, reject) => { probe.once('error', () => reject(Error(`本机端口 ${port} 已占用或不可绑定；SSH 转发需要与远端服务使用相同端口。`))); probe.listen(port, '127.0.0.1', resolve) })
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return exchange(target, request, undefined, options, port)
}
