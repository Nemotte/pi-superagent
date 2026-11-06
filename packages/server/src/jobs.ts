import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { jobEnvironment } from './environment.js'
import { killTree } from './pi-driver.js'
export interface Job { id: string; executable: string; args: string[]; state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; output: string; exitCode: number | null; startedAt: string; endedAt?: string }
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
      if (record.state === 'running') { record.state = 'interrupted'; record.endedAt = new Date().toISOString(); this.persist(record) }
      this.records.set(record.id, record)
    }
  }
  get running(): number { return this.children.size }
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
    this.records.set(job.id, job); this.persist(job)
    const child = spawn(executable, args, { cwd: this.cwd, env: this.environment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let resolve!: () => void
    const exited = new Promise<void>(r => { resolve = r }); this.children.set(job.id, { child, exited })
    const append = (chunk: Buffer | string) => { job.output = (job.output + String(chunk)).slice(-32768) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.once('error', error => append(error.message))
    const timer = setTimeout(() => { void this.cancel(job.id) }, timeoutMs)
    child.once('close', code => {
      clearTimeout(timer); this.children.delete(job.id); job.exitCode = code; job.endedAt = new Date().toISOString()
      if (job.state === 'running') job.state = code === 0 ? 'succeeded' : 'failed'
      this.persist(job); resolve(); if (!this.closed) this.completed?.({ ...job })
    })
    return { ...job }
  }
  status(id: string): Job { const job = this.records.get(id); if (!job) throw Error('Unknown job'); return { ...job } }
  list(): Job[] { return [...this.records.values()].map(j => ({ ...j })) }
  async cancel(id: string): Promise<void> {
    const job = this.records.get(id); if (!job) throw Error('Unknown job')
    const running = this.children.get(id); if (!running) return
    job.state = 'cancelled'; await killTree(running.child); await running.exited
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.children.keys()].map(id => this.cancel(id))) }
}
