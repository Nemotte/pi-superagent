import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Runtime } from './runtime.js'
import { configHistory, conversation, requestView, requests, search, threadView, ticketView } from './panel.js'
import { ticketDiagnostics } from './diagnostics.js'
import { readManagement } from './management.js'
import { readModelCatalog, ModelCatalogSchema, type ModelCatalog } from './model-catalog.js'
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
function equal(a: string, b: string): boolean { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()) }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json')
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw new HttpError(413, 'Request too large'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Invalid JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
export async function serveApi(runtime: Runtime, token: string | undefined, port = runtime.settings().config.port, options: { shutdown?: () => void; catalog?: typeof readModelCatalog } = {}) {
  const management = readManagement(runtime.stateDir), local = management === 'local'
  if (!local && !token) throw Error('Administrator token is required in token mode')
  const sessions = new Map<string, { csrf: string; expires: number }>()
  const grants = new Map<string, { expires: number; origin: string }>()
  const cookieName = `pi_superagent_${runtime.settings().config.instanceId.replaceAll('-', '')}`
  let attempts = 0, since = Date.now()
  const closing = new AbortController()
  let catalog: Promise<ModelCatalog> | undefined, catalogExpires = 0
  let hosts = new Set<string>()
  const server = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    void handle(req, res).catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : /revision conflict|Idempotency/.test(message) ? 409 : 400
      if (!res.headersSent) json(res, status, { error: error instanceof z.ZodError ? 'Invalid request: ' + error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : message })
      else res.end()
    })
  })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxRequestsPerSocket = 100
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(req.headers.host || '')) throw new HttpError(403, 'Host is not allowed')
    const origin = `http://${req.headers.host}`
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Origin is not allowed')
    const url = new URL(req.url || '/', origin); const path = url.pathname; const method = req.method || 'GET'
    if (local && path.startsWith('/api/v1/') && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site access is not allowed')
    if (local && !['GET', 'HEAD'].includes(method) && (req.headers['x-superagent-local'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) throw new HttpError(403, 'Local writes require a JSON client with X-Superagent-Local: 1')
    if (local && ['/api/v1/login', '/api/v1/login-grants'].includes(path)) throw new HttpError(409, 'Local mode does not require login')
    if (path === '/health' && method === 'GET') { json(res, 200, { status: 'ok', protocol: 1 }); return }
    if (['/', '/app.js', '/ticket-panel.js', '/settings-panel.js', '/records-panel.js', '/style.css'].includes(path) && method === 'GET') {
      const file = path === '/' ? 'index.html' : path.slice(1)
      const content = await readFile(new URL(`../web/${file}`, import.meta.url))
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript' : 'text/css' }); res.end(content); return
    }
    if (path === '/api/v1/login' && method === 'POST') {
      if (Date.now() - since > 60000) { since = Date.now(); attempts = 0 }
      if (++attempts > 20) throw new HttpError(429, 'Too many login attempts; retry in one minute')
      const input = z.union([z.object({ token: z.string().max(200) }).strict(), z.object({ code: z.string().max(200) }).strict()]).parse(await body(req))
      if ('code' in input) {
        if (req.headers.origin !== origin) throw new HttpError(403, 'Origin is required for browser login')
        const key = createHash('sha256').update(input.code).digest('hex'), grant = grants.get(key)
        if (!grant || grant.expires <= Date.now() || grant.origin !== origin) {
          if (grant && grant.expires <= Date.now()) grants.delete(key)
          throw new HttpError(401, '登录链接已失效，请重新运行 /superagent web。')
        }
        grants.delete(key) // Consume synchronously before issuing a session; concurrent redemption cannot win twice.
      } else if (!equal(input.token, token!)) throw new HttpError(401, 'Invalid token')
      for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id)
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!)
      const id = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url')
      sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 })
      res.setHeader('set-cookie', `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`)
      json(res, 200, { csrf }); return
    }
    if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'Not found')
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    const session = cookie && sessions.get(cookie)
    const bearer = token && req.headers.authorization?.startsWith('Bearer ') && equal(req.headers.authorization.slice(7), token)
    if (!local && !bearer && (!session || session.expires < Date.now())) throw new HttpError(401, 'Authentication required')
    if (!local && !bearer && !['GET', 'HEAD'].includes(method) && (!session || !equal(String(req.headers['x-csrf-token'] || ''), session.csrf))) throw new HttpError(403, 'CSRF token required')
    if (path === '/api/v1/login-grants' && method === 'POST') {
      if (!bearer) throw new HttpError(403, 'A bearer-authenticated client is required')
      for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key)
      if (grants.size >= 32) grants.delete(grants.keys().next().value!)
      const code = randomBytes(32).toString('base64url')
      grants.set(createHash('sha256').update(code).digest('hex'), { expires: Date.now() + 60000, origin })
      json(res, 201, { code, expiresIn: 60 }); return
    }
    if (path === '/api/v1/session' && method === 'GET') { json(res, 200, { management, csrf: local ? null : session ? session.csrf : null }); return }
    if (path === '/api/v1/logout' && method === 'POST') {
      if (cookie) sessions.delete(cookie); res.setHeader('set-cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); json(res, 200, { ok: true }); return
    }
    if (path === '/api/v1/shutdown' && method === 'POST' && options.shutdown) {
      res.once('finish', () => options.shutdown!()); json(res, 200, { stopping: true }); return
    }
    if (path === '/api/v1/attention' && method === 'GET') { json(res, 200, runtime.attention()); return }
    const recovery = path.match(/^\/api\/v1\/(decisions|triggers)\/([^/]+)\/(dismiss|reevaluate)$/)
    if (recovery && method === 'POST') {
      const id = decodeURIComponent(recovery[2])
      if (recovery[1] === 'decisions' && recovery[3] === 'dismiss') { json(res, 200, runtime.engine.dismiss(id)); return }
      if (recovery[1] === 'triggers' && recovery[3] === 'reevaluate') { json(res, 202, { queued: runtime.engine.reevaluate(id) }); return }
    }
    if (path === '/api/v1/status' && method === 'GET') { json(res, 200, { ...runtime.overview(), management }); return }
    if (path === '/api/v1/workspace' && method === 'GET') { json(res, 200, await runtime.workspaceView()); return }
    if (path === '/api/v1/sources' && method === 'GET') { json(res, 200, runtime.overview().sources); return }
    if (path === '/api/v1/sources/github/poll' && method === 'POST') { await runtime.github.poll(); json(res, 200, runtime.github.status()); return }
    const page = () => ({ offset: z.coerce.number().int().min(0).parse(url.searchParams.get('offset') ?? 0), limit: z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit') ?? 50) })
    const requestMatch = path.match(/^\/api\/v1\/requests\/([^/]+)$/)
    if (requestMatch && method === 'GET') {
      const trigger = runtime.store.triggers.get(decodeURIComponent(requestMatch[1]))
      if (!trigger) throw new HttpError(404, 'Unknown request')
      json(res, 200, requestView(runtime.store, trigger)); return
    }
    if (path === '/api/v1/requests' && method === 'GET') { const { offset, limit } = page(); json(res, 200, requests(runtime.store, offset, limit)); return }
    if (path === '/api/v1/config/history' && method === 'GET') { const { offset, limit } = page(); json(res, 200, configHistory(runtime.store, offset, limit)); return }
    if (path === '/api/v1/search' && method === 'GET') {
      const { offset, limit } = page(), query = z.string().max(200).parse(url.searchParams.get('q') || '')
      json(res, 200, search(runtime.store, query, offset, limit)); return
    }
    const threadMatch = path.match(/^\/api\/v1\/threads\/([^/]+)$/)
    if (threadMatch && method === 'GET') {
      const { offset, limit } = page(), result = threadView(runtime.store, decodeURIComponent(threadMatch[1]), offset, limit)
      if (!result) throw new HttpError(404, 'Unknown thread')
      json(res, 200, result); return
    }
    if (path === '/api/v1/models' && method === 'GET') {
      if (Date.now() >= catalogExpires) catalog = undefined
      if (!catalog) {
        catalogExpires = Date.now() + 60000
        catalog = (options.catalog || readModelCatalog)(runtime.stateDir, closing.signal).then(value => ModelCatalogSchema.parse(value)).catch(error => { catalog = undefined; throw error })
      }
      json(res, 200, await catalog); return
    }
    if (path === '/api/v1/config' && method === 'GET') { json(res, 200, runtime.settings()); return }
    if (path === '/api/v1/config' && method === 'PUT') {
      const input = z.object({ config: z.unknown(), revision: z.number().int().min(1) }).strict().parse(await body(req))
      json(res, 200, runtime.saveSettings(input.config, input.revision)); return
    }
    if (path === '/api/v1/events' && method === 'GET') {
      const after = z.coerce.number().int().min(0).parse(url.searchParams.get('after') ?? 0)
      json(res, 200, runtime.store.events(after)); return
    }
    if (path === '/api/v1/tickets' && method === 'POST') { json(res, 202, runtime.submit(await body(req))); return }
    if (['tickets', 'triggers', 'decisions', 'threads'].some(kind => path === `/api/v1/${kind}`) && method === 'GET') {
      const offset = z.coerce.number().int().min(0).parse(url.searchParams.get('offset') ?? 0)
      const limit = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get('limit') ?? 50)
      const kind = path.split('/').at(-1)!.slice(0, -1) as 'ticket' | 'trigger' | 'decision' | 'thread'
      if (kind === 'ticket') {
        const query = z.string().max(200).parse(url.searchParams.get('q') || '')
        const state = z.enum(['all', 'open', 'ended']).parse(url.searchParams.get('state') || 'all')
        json(res, 200, runtime.store.searchTickets(query, state, offset, limit)); return
      }
      json(res, 200, runtime.store.records(kind, offset, limit)); return
    }
    if (path === '/api/v1/decisions' && method === 'POST') { json(res, 200, await runtime.tool({ role: 'router', key: 'router' }, 'route', await body(req))); return }
    const subscription = path.match(/^\/api\/v1\/threads\/([^/]+)\/subscriptions$/)
    if (subscription && method === 'DELETE') {
      const key = decodeURIComponent(subscription[1]); if (!runtime.store.threads.get(key)) throw new HttpError(404, 'Unknown thread')
      json(res, 200, runtime.engine.unsubscribe(key)); return
    }
    const match = path.match(/^\/api\/v1\/tickets\/([^/]+)(?:\/(followup|stop|retry|subscriptions|diagnostics|workspace|conversation))?$/)
    if (match) {
      const id = decodeURIComponent(match[1]); const action = match[2]; const ticket = runtime.store.tickets.get(id)
      if (!ticket) throw new HttpError(404, 'Unknown ticket')
      if (action === 'workspace' && method === 'GET') { json(res, 200, await runtime.workspaceView(id)); return }
      if (action === 'diagnostics' && method === 'GET') { json(res, 200, ticketDiagnostics(runtime.stateDir, id)); return }
      if (action === 'conversation' && method === 'GET') { const { offset, limit } = page(); json(res, 200, conversation(runtime.store, ticket, offset, limit)); return }
      if (!action && method === 'GET') { json(res, 200, ticketView(ticket)); return }
      if (method === 'POST') {
        if (action === 'followup') { json(res, 202, runtime.followup(id, await body(req))); return }
        if (action === 'stop') { json(res, 200, runtime.engine.stopTicket(id)); return }
        if (action === 'retry') { json(res, 200, runtime.engine.retryTicket(id)); return }
      }
      if (method === 'DELETE' && action === 'subscriptions') throw new HttpError(400, 'Subscriptions belong to threads; use DELETE /api/v1/threads/:key/subscriptions')
    }
    throw new HttpError(404, 'Not found')
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()) })
  const actual = (server.address() as { port: number }).port
  hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`])
  return { url: `http://127.0.0.1:${actual}`, server, close: () => new Promise<void>((resolve, reject) => { closing.abort(); server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}
