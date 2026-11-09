import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { jobEnvironment } from './environment.js'
import { killTree } from './pi-driver.js'
export interface Job { id: string; executable: string; args: string[]; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; output: string; exitCode: number | null; startedAt: string; endedAt?: string }
/** A cancelled tree may keep a grandchild holding the pipes open; wait this long for `close`, then settle anyway. */
const CLOSE_GRACE_MS = 2000
const OUTPUT_LIMIT = 32768
/**
 * Keep the newest output up to the limit, and regex to characters that are whole code points. Decoded chunks arrive in
 * order, so a truncated leading surrogate is always the pair half to drop; a stream cut mid-sequence shows up as U+FFFD.
 */
function tail(text: string): string {
  const value = text.slice(-OUTPUT_LIMIT)
  const start = value.charCodeAt(0) >= 0xdc00 && value.charCodeAt(0) <= 0xdfff ? 1 : 0
  return value.slice(start).replace(/\ufffd/g, '')
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function text(value: unknown): string { return typeof value === 'string' ? value : String(value ?? '') }
export class Jobs {
  private records = new Map<string, Job>()
  private children = new Map<string, { child: ChildProcess; exited: Promise<void> }>()
  private closed = false
  private environment: NodeJS.ProcessEnv
  constructor(private directory: string, private cwd: string, private completed?: (job: Job) => void, home = join(directory, 'home')) {
    this.environment = jobEnvironment(home)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(directory).filter(n => n.endsWith('.job.json'))) {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Job
      if (record.state === 'running') { record.state = 'interrupted'; record.endedAt = new Date().toISOString(); this.save(record) }
      this.records.set(record.id, record)
    }
  }
  get running(): number { return this.children.size }
  /** Durable record; a vanished directory (removed test instance) must not turn a settled job into an exception. */
  private save(job: Job): void { try { this.persist(job) } catch (error) { console.error('job record:', String(error)) } }
  private persist(job: Job): void {
    const path = join(this.directory, `${job.id}.job.json`)
    writeFileSync(path + '.tmp', JSON.stringify(job), { mode: 0o600 }); renameSync(path + '.tmp', path)
  }
  start(executable: string, args: string[], timeoutMs = 3600000): Job {
    if (this.closed) throw Error('Job manager closed')
    if (/^gh(?:\.(?:exe|cmd|bat))?$/.test(basename(executable.replaceAll('\\', '/')).toLowerCase())) throw Error('Use host GitHub tools; send results through superagent_report and Router, not gh')
    if (this.children.size >= 4) throw Error('Maximum concurrent jobs reached')
    if (this.records.size >= 1000) throw Error('Job history limit reached; archive completed jobs before adding more')
    const job: Job = { id: randomUUID(), executable, args, state: 'running', output: '', exitCode: null, startedAt: new Date().toISOString() }
    this.records.set(job.id, job); this.save(job)
    const child = spawn(executable, args, { cwd: this.cwd, env: this.environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let resolve!: () => void
    const exited = new Promise<void>(r => { resolve = r }); const entry = { child, exited }; this.children.set(job.id, entry)
    const decoder = new StringDecoder('utf8')
    let closing = false
    const append = (chunk: Buffer | string) => { if (!closing) job.output = tail(job.output + text(chunk)) }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    child.stdout?.on('error', () => {}); child.stderr?.on('error', () => {})
    child.once('error', error => append(error.message))
    const timer = setTimeout(() => { void this.cancel(job.id).catch(() => {}) }, timeoutMs)
    // `exit` settles the status and frees the running slot even when a descendant still holds the output pipes;
    // `close` settles only once every stream closed. Status is decided once, on whichever arrives first.
    child.once('exit', code => {
      job.exitCode = code; if (job.state === 'running') job.state = code === 0 ? 'succeeded' : 'failed'
      closing = true; job.output = tail(job.output + decoder.end()); resolve()
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (this.children.get(job.id) !== entry) return // cancel() already settled this job.
      this.children.delete(job.id); job.endedAt ??= new Date().toISOString()
      if (job.exitCode === null) { job.exitCode = code; if (job.state === 'running') job.state = code === 0 ? 'succeeded' : 'failed' }
      closing = true; job.output = tail(job.output + decoder.end()); resolve()
      this.save(job); if (!this.closed) this.completed?.({ ...job })
    })
    return { ...job }
  }
  status(id: string): Job { const job = this.records.get(id); if (!job) throw Error('Unknown job'); return { ...job } }
  list(): Job[] { return [...this.records.values()].map(j => ({ ...j })) }
  /** Terminate a job's process tree and settle it, even when a descendant keeps the output pipes open. */
  async cancel(id: string): Promise<void> {
    const job = this.records.get(id); if (!job) throw Error('Unknown job')
    const running = this.children.get(id); if (!running) return
    if (job.state === 'running') job.state = 'cancelled'
    await killTree(running.child)
    // Destroy our ends so a surviving grandchild cannot pin the streams; `exit` is authoritative.
    running.child.stdout?.destroy(); running.child.stderr?.destroy()
    await Promise.race([running.exited, delay(CLOSE_GRACE_MS)])
    await killTree(running.child).catch(() => {})
    // Settle synchronously once the process is gone, even if `close` never arrives.
    if (this.children.get(id) === running) { this.children.delete(id); job.endedAt ??= new Date().toISOString(); this.save(job); if (!this.closed) this.completed?.({ ...job }) }
    await running.exited
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.children.keys()].map(id => this.cancel(id).catch(() => {})))
  }
}
