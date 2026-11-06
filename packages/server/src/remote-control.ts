import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createConnection } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { initialize, readConfig, readToken } from './config.js'
import { readManagement } from './management.js'
import { InstanceClient } from './client.js'
import { discoverWorkspace, repositoryMember, validateWorkspace, workspaceConfig } from './repositories.js'
import { jobEnvironment } from './environment.js'
import { serviceOperation } from './supervision.js'
import { registeredService, serviceActions, ServiceError } from './supervision-config.js'
const exec = promisify(execFile)
const path = z.string().min(1).max(4096).refine(p => isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p), 'Absolute path required')
const expectedSchema = z.object({ instanceId: z.string().uuid(), repository: path, port: z.number().int().min(1024).max(65535) }).strict()
const requestSchema = z.object({ operation: z.enum(['environment', 'discover', 'inspect', 'init', 'connect', 'start', 'restart', 'shutdown', 'service']), action: z.enum(serviceActions).optional(), confirmed: z.boolean().optional(), stateDir: path.optional(), repository: path.optional(), port: z.number().int().min(1024).max(65535).optional(), members: z.array(z.string().min(1).max(500)).min(1).max(32).optional(), expected: expectedSchema.optional() }).strict()
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url))
export class RemoteError extends Error { constructor(readonly code: string) { super(code) } }
export function remoteIdentity(stateDir: string, expected: unknown) {
  const identity = expectedSchema.parse(expected), config = readConfig(stateDir)
  if (config.instanceId !== identity.instanceId || realpathSync(config.repository) !== identity.repository || config.port !== identity.port) throw new RemoteError('IDENTITY')
  if (readManagement(stateDir) !== 'token') throw new RemoteError('TOKEN_REQUIRED')
  return config
}
async function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(250, () => done(false)); socket.once('connect', () => done(false))
    socket.once('error', error => done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'))
  })
}
async function available(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new RemoteError('PORT_BUSY'))); server.listen(port, '127.0.0.1', resolve) })
  await new Promise<void>(resolve => server.close(() => resolve()))
}
async function git(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')))
  return (await exec('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], { timeout: 10000, maxBuffer: 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
}
async function privateState(stateDir: string, repository: string): Promise<string> {
  let parent = resolve(stateDir); const suffix: string[] = []
  while (!existsSync(parent)) { const next = dirname(parent); suffix.unshift(parent.slice(next.length + (next === sep ? 0 : 1))); parent = next }
  parent = realpathSync(parent)
  const target = join(parent, ...suffix), delta = relative(repository, target)
  if (!delta || delta !== '..' && !delta.startsWith('..' + sep) && !isAbsolute(delta) || await git(parent, ['rev-parse', '--is-inside-work-tree']).catch(() => '') === 'true') throw new RemoteError('PRIVATE_STATE_REQUIRED')
  return target
}
async function inspect(stateDir: string) {
  const c = readConfig(stateDir), registration = registeredService(stateDir)
  const status = await new InstanceClient(stateDir).request('status').catch(() => undefined) as { paused: boolean; busyWorkers: number } | undefined
  return { protocol: 1, instanceId: c.instanceId, repository: realpathSync(c.repository), stateDir: realpathSync(stateDir), port: c.port, management: readManagement(stateDir), supervision: registration?.kind ?? 'detached', workspace: c.workspace, online: !!status, ...(status ? { status: { paused: status.paused, busyWorkers: status.busyWorkers } } : {}) }
}
async function runCli(stateDir: string, args: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  return exec(process.execPath, [cliPath, ...args, '--state-dir', stateDir], { timeout: 60000, maxBuffer: 1024 * 1024, env: jobEnvironment(join(stateDir, 'agent', 'home')), signal })
}
/** SSH-authorized operations only. No arbitrary command execution or automatic credentials installation. */
export async function remoteOperation(input: unknown, signal?: AbortSignal): Promise<unknown> {
  const r = requestSchema.parse(input); signal?.throwIfAborted()
  if (r.operation === 'environment') {
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) throw new RemoteError('RUNTIME_UNSUPPORTED')
    await exec('git', ['--version'], { timeout: 10000, maxBuffer: 4096, signal })
    return { protocol: 1, version: '0.1.0-alpha.1', node: process.execPath, home: homedir(), cliPath }
  }
  if (r.operation === 'discover') return discoverWorkspace(path.parse(r.repository))
  const stateDir = path.parse(r.stateDir)
  if (r.operation === 'init') {
    const repository = realpathSync(path.parse(r.repository)), port = z.number().int().min(1024).max(65535).parse(r.port)
    const state = await privateState(stateDir, repository)
    const workspace = r.members ? workspaceConfig(await validateWorkspace(repository, { repositories: r.members.map(repositoryMember) })) : null
    if (!workspace) {
      if (realpathSync(await git(repository, ['rev-parse', '--show-toplevel'])) !== repository) throw new RemoteError('REPOSITORY_ROOT_REQUIRED')
      await git(repository, ['rev-parse', '--verify', 'HEAD'])
    }
    await available(port); signal?.throwIfAborted()
    initialize(state, { repository, workspace, port, paused: true, maxWorkers: 1, management: 'token' })
    return inspect(state)
  }
  if (r.operation === 'inspect') return inspect(stateDir)
  const c = remoteIdentity(stateDir, r.expected), canonicalState = realpathSync(stateDir)
  if (r.operation === 'connect') return { ...await inspect(canonicalState), token: readToken(canonicalState) }
  if (r.operation === 'service') {
    if (!r.action) throw new RemoteError('SERVICE_ACTION')
    try { return { instanceId: c.instanceId, service: await serviceOperation(canonicalState, r.action, { expectedId: c.instanceId, confirmed: r.confirmed, ...(signal ? { signal } : {}) }) } }
    catch (error) { if (error instanceof ServiceError) throw new RemoteError(error.code); throw error }
  }
  const check = () => { signal?.throwIfAborted(); remoteIdentity(canonicalState, r.expected) }
  const stopped = async () => !existsSync(canonicalState + '.lock') && await portClosed(c.port)
  check()
  if (registeredService(canonicalState)) {
    await runCli(canonicalState, ['--version'], signal); check()
    if (r.operation !== 'start') {
      await runCli(canonicalState, ['shutdown', '--expected-instance-id', c.instanceId], signal)
      const deadline = performance.now() + 30000
      while (!await stopped()) { check(); if (performance.now() >= deadline) throw new RemoteError('STOP_TIMEOUT'); await sleep(100, undefined, { signal }) }
    }
    check()
    if (r.operation !== 'shutdown') await runCli(canonicalState, ['start', '--expected-instance-id', c.instanceId], signal)
    check(); return inspect(canonicalState)
  }
  const client = new InstanceClient(canonicalState)
  const online = await client.request('status').catch(() => undefined)
  if (!online && !await stopped()) throw new RemoteError('INSTANCE_BUSY')
  if (r.operation === 'start' && online) return inspect(canonicalState)
  // Check the installed CLI before stopping anything. No model or channel network calls.
  await runCli(canonicalState, ['--version'], signal)
  if (online) { check(); await client.request('shutdown', 'POST') }
  const deadline = performance.now() + 30000
  while (!await stopped()) {
    check(); if (performance.now() >= deadline) throw new RemoteError('STOP_TIMEOUT')
    await sleep(100, undefined, { signal })
  }
  check()
  if (r.operation !== 'shutdown') {
    await available(c.port); check(); await runCli(canonicalState, ['start'], signal)
    check(); await new InstanceClient(canonicalState).request('status')
  }
  return inspect(canonicalState)
}
