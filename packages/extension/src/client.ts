import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loopbackRequest } from './loopback-http.js'
export function readManagement(stateDir: string): 'local' | 'token' {
  let value: any
  try { value = JSON.parse(readFileSync(join(stateDir, 'management.json'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'token'; throw error }
  if (!value || value.schema !== 1 || !['local', 'token'].includes(value.mode) || Object.keys(value).some(key => !['schema', 'mode'].includes(key))) throw Error('Invalid management mode')
  return value.mode
}
export function optionalToken(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() || undefined }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export class Client {
  private checked?: Promise<void>
  private readonly base: string
  constructor(url: string, private readonly token?: string, private readonly instanceId?: string, private readonly guard?: () => void) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Error('Use a loopback HTTP endpoint, or an SSH tunnel to one')
    this.base = parsed.origin
  }
  get endpoint(): string { return this.base }
  /** For explicit, private user UI only; never return a credential to a model tool. */
  async withCredential(show: (token: string) => Promise<unknown>): Promise<void> {
    this.guard?.()
    if (!this.token) throw Error('本地模式无需管理员令牌。')
    await show(this.token)
  }
  private async fetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    this.guard?.()
    const response = await loopbackRequest(`${this.base}/api/v1/${path}`, method,
      { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), 'x-superagent-local': '1', 'content-type': 'application/json' }, body)
    const value = response.value as { error?: string }
    if (response.status < 200 || response.status >= 300) throw new ApiError(response.status, value?.error || `Super-agent API ${response.status}`)
    return value
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    this.checked ??= this.fetch('status').then(value => {
      const status = value as { protocol: number; instanceId: string }
      if (status.protocol !== 1) throw Error('Incompatible Super-agent API protocol')
      if (this.instanceId && status.instanceId !== this.instanceId) throw Error('Super-agent instance identity mismatch')
    }).catch(error => { this.checked = undefined; throw error })
    await this.checked; return this.fetch(path, method, body)
  }
}
export function fromEnvironment(): Client {
  const dir = process.env.PI_SUPERAGENT_HOME || join(homedir(), '.pi-superagent', 'default')
  const url = process.env.PI_SUPERAGENT_URL || `http://127.0.0.1:${JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).port}`
  const token = process.env.PI_SUPERAGENT_TOKEN || (process.env.PI_SUPERAGENT_TOKEN_FILE ? optionalToken(process.env.PI_SUPERAGENT_TOKEN_FILE) : readManagement(dir) === 'local' ? undefined : optionalToken(join(dir, 'admin.token')))
  return new Client(url, token)
}
