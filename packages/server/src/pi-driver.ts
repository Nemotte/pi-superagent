import { fork, execFile, type ChildProcess } from 'node:child_process'
import type { AgentDriver, AgentTarget, Delivery, AgentEventHandler, AgentToolHandler } from './agent-protocol.js'
import { join } from 'node:path'
import { agentEnvironment } from './environment.js'
interface Pending { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Child { process: ChildProcess; target: AgentTarget; ready: Promise<void>; pending: Map<string, Pending>; stopped: boolean; exited: Promise<void>; stopping?: Promise<void> }
export async function killTree(process: ChildProcess): Promise<void> {
  if (!process.pid) return
  if (globalThis.process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], () => resolve()))
  else { try { globalThis.process.kill(-process.pid, 'SIGKILL') } catch { try { process.kill('SIGKILL') } catch {} } }
}
/** Stop is graceful first, then forceful: a child that ignores `stop` must not block the next assignment. */
const STOP_GRACE_MS = 3000
export class PiDriver implements AgentDriver {
  private children = new Map<string, Child>()
  private closed = false
  constructor(private options: { tool: AgentToolHandler; event: AgentEventHandler; entry?: URL }) {}
  get size(): number { return this.children.size }
  private ensure(target: AgentTarget): Child {
    if (this.closed) throw Error('Driver closed')
    const existing = this.children.get(target.key)
    if (existing) {
      if (existing.stopped || existing.target.assignmentId !== target.assignmentId) throw Error('Previous assignment is still stopping')
      return existing
    }
    if (!target.agentDir) throw Error('Agent directory is required for process isolation')
    const env = { ...agentEnvironment(join(target.agentDir, 'home')), PI_CODING_AGENT_DIR: target.agentDir }
    const process = fork(this.options.entry ?? new URL('./pi-child.js', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: globalThis.process.platform !== 'win32', execArgv: [], env,
    })
    let readyResolve!: () => void, readyReject!: (error: Error) => void, exitResolve!: () => void
    const child: Child = { process, target, pending: new Map(), stopped: false,
      ready: new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject }),
      exited: new Promise(resolve => { exitResolve = resolve }) }
    this.children.set(target.key, child)
    // A child can fail before send() reaches its first await.
    void child.ready.catch(() => {})
    let stderr = ''
    process.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    const timer = setTimeout(() => { readyReject(Error('Pi child startup timed out')); void this.stop(target.key) }, 30000)
    process.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const message = raw as { type: string; id?: string; name?: string; args?: unknown; event?: Parameters<AgentEventHandler>[1]; error?: string }
      if (message.type === 'ready') { clearTimeout(timer); readyResolve() }
      if (message.type === 'fatal') { readyReject(Error(message.error || 'Pi initialization failed')); void this.stop(target.key) }
      if ((message.type === 'ack' || message.type === 'nack') && message.id) {
        const p = child.pending.get(message.id)
        if (p) { clearTimeout(p.timer); child.pending.delete(message.id); if (message.type === 'nack') p.reject(Error(message.error || 'Delivery rejected')); else p.resolve() }
      }
      if (message.type === 'event' && message.event) this.options.event(target, message.event)
      if (message.type === 'tool' && message.id && message.name) {
        const respond = (result: unknown, error?: string) => { if (process.connected) process.send({ type: 'tool_result', id: message.id, result, error }, () => {}) }
        void this.options.tool(target, message.name, message.args).then(result => respond(result), error => respond(undefined, String(error)))
      }
    })
    process.once('error', error => readyReject(error))
    process.once('exit', (code, signal) => {
      clearTimeout(timer)
      const error = Error(`Pi child exited (${signal ?? code}): ${stderr}`)
      readyReject(error)
      for (const p of child.pending.values()) { clearTimeout(p.timer); p.reject(error) }
      child.pending.clear(); if (this.children.get(target.key) === child) this.children.delete(target.key); exitResolve()
      if (!child.stopped) this.options.event(target, { type: 'error', error: error.message })
      if (globalThis.process.platform !== 'win32') void killTree(process)
    })
    process.send({ type: 'init', target }, error => { if (error) readyReject(error) })
    return child
  }
  /** Deliver one message; a previous assignment's child is stopped first so a retry never races its own stop effect. */
  async send(target: AgentTarget, delivery: Delivery): Promise<void> {
    const existing = this.children.get(target.key)
    if (existing && !existing.stopped && existing.target.assignmentId !== target.assignmentId) await this.stop(target.key)
    const child = this.ensure(target); await child.ready
    if (child.stopped || !child.process.connected) throw Error('Pi child disconnected')
    if (child.pending.has(delivery.id)) throw Error('Delivery already in flight')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.pending.delete(delivery.id); reject(Error('Delivery persistence acknowledgement timed out')) }, 300000)
      child.pending.set(delivery.id, { resolve, reject, timer })
      child.process.send({ type: 'deliver', delivery }, error => { if (error) { clearTimeout(timer); child.pending.delete(delivery.id); reject(error) } })
    })
  }
  /** Idempotent: concurrent and repeated stops of one key share a single termination. */
  async stop(key: string): Promise<void> {
    const child = this.children.get(key); if (!child) return
    if (child.stopping) return child.stopping
    child.stopped = true
    child.stopping = (async () => {
      if (child.process.connected) child.process.send({ type: 'stop' }, () => {})
      let timer: ReturnType<typeof setTimeout> | undefined, gone = false
      const exited = child.exited.then(() => { gone = true })
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { void killTree(child.process).then(resolve, resolve) }, STOP_GRACE_MS) })])
      if (timer) clearTimeout(timer)
      if (!gone) await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, STOP_GRACE_MS))])
      // A child that outlived its forced kill must not keep its slot: forget it so the next assignment can start.
      if (!gone && this.children.get(key) === child) this.children.delete(key)
    })()
    return child.stopping
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.children.keys()].map(key => this.stop(key))) }
}
