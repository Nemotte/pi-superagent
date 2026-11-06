import { z } from 'zod'
import { sameLogin } from './github-config.js'
export class GitHubError extends Error {
  constructor(readonly status: number, readonly retryAt: number, path: string) { super(`GitHub HTTP ${status} at ${path}`) }
}
export interface GitHubApi {
  get(path: string): Promise<unknown>
  pages(path: string, field?: string): Promise<unknown[]>
  post(path: string, body: unknown): Promise<unknown>
  verify(login: string): Promise<void>
}
export class GitHubClient implements GitHubApi {
  private readonly base: URL
  private readonly prefix: string
  constructor(repository: string, private token: string, private options: { baseUrl?: string; signal?: AbortSignal } = {}) {
    this.base = new URL(options.baseUrl || 'https://api.github.com')
    this.prefix = `/repos/${repository}`
    if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || repository.endsWith('/..') || repository.endsWith('/.')) throw Error('Invalid repository')
    if (this.base.origin !== 'https://api.github.com' && !(this.base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(this.base.hostname))) throw Error('Unsupported GitHub API endpoint')
  }
  private endpoint(path: string): URL {
    const url = new URL(path === '/user' ? path : `${this.prefix}${path ? '/' + path : ''}`, this.base)
    this.validate(url, path === '/user'); return url
  }
  private validate(url: URL, user = false): void {
    if (url.origin !== this.base.origin || url.username || url.password || url.hash || !(url.pathname === this.prefix || url.pathname.startsWith(this.prefix + '/') || (user && url.pathname === '/user'))) throw Error('GitHub pagination escaped the configured repository')
  }
  private async request(url: URL, method = 'GET', body?: unknown): Promise<{ data: unknown; next?: string; bytes: number }> {
    const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(this.options.signal ? [this.options.signal] : [])])
    let response: Response
    try { response = await fetch(url, { method, signal, redirect: 'error', headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'pi-superagent/0.1.0-alpha.1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }
    catch { throw Error(`GitHub transport failed at ${url.pathname}`) }
    if (!response.ok) {
      const retry = response.headers.get('retry-after'), reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const delay = retry ? (/^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : 0
      const limited = response.status === 429 || (response.status === 403 && (!!retry || response.headers.get('x-ratelimit-remaining') === '0'))
      await response.body?.cancel()
      throw new GitHubError(response.status, limited ? Math.max(Date.now() + 60000, Number.isFinite(delay) ? delay : 0, Number.isFinite(reset) ? reset : 0) : 0, url.pathname)
    }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
    if (reader) { try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 8 * 1024 * 1024) throw Error('GitHub response exceeded size limit'); chunks.push(value) } } finally { await reader.cancel().catch(() => {}); reader.releaseLock() } }
    let data: unknown
    try { data = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { throw Error('Invalid GitHub JSON response') }
    const next = response.headers.get('link')?.split(',').map(v => v.trim()).find(v => /;\s*rel="next"/.test(v))?.match(/^<([^>]+)>/)?.[1]
    return { data, next, bytes }
  }
  async get(path: string): Promise<unknown> { return (await this.request(this.endpoint(path))).data }
  async post(path: string, body: unknown): Promise<unknown> { return (await this.request(this.endpoint(path), 'POST', body)).data }
  async pages(path: string, field?: string): Promise<unknown[]> {
    let url: URL | undefined = this.endpoint(path); url.searchParams.set('per_page', '100')
    const visited = new Set<string>(), result: unknown[] = []; let bytes = 0
    while (url) {
      this.validate(url)
      if (visited.has(url.href) || visited.size >= 100) throw Error('GitHub pagination limit or cycle; cursor retained')
      visited.add(url.href)
      const page = await this.request(url); const items = field ? z.record(z.string(), z.unknown()).parse(page.data)[field] : page.data
      result.push(...z.array(z.unknown()).parse(items)); bytes += page.bytes
      if (bytes > 32 * 1024 * 1024) throw Error('GitHub stream exceeded size limit; cursor retained')
      url = page.next ? new URL(page.next, this.base) : undefined
    }
    return result
  }
  async verify(login: string): Promise<void> {
    const user = z.object({ login: z.string() }).parse(await this.get('/user'))
    if (!sameLogin(user.login, login)) throw Error('GitHub credential identity does not match botLogin')
  }
}
