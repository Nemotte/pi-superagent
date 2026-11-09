// Offline integration: real service + real Pi SDK subprocesses + a local scripted model.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { initialize, startService } from '../packages/server/dist/index.js'
import { Client } from '../packages/extension/dist/client.js'
import { GitHubClient } from '../packages/server/dist/sources/github-client.js'
const dir = mkdtempSync(join(tmpdir(), 'pi-sa-smoke 工作 ')); const repository = join(dir, 'repository'); const state = join(dir, 'state')
let service, calls = 0, routerTools, workerTools
const proxyMode = process.argv.includes('--proxy'), proxySockets = new Set()
const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY']
const savedEnvironment = Object.fromEntries(proxyVariables.map(k => [k, process.env[k]]))
for (const key of proxyVariables) delete process.env[key]
let proxyRequests = 0
const proxy = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://model.invalid')
  if (url.hostname !== 'model.invalid') { res.writeHead(502); res.end('Unexpected proxy target'); return }
  proxyRequests++
  const upstream = httpRequest({ host: '127.0.0.1', port: model.address().port, path: url.pathname, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
  upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream)
})
proxy.on('connect', (req, socket, head) => {
  if (req.url !== 'model.invalid:80') { socket.destroy(); return }
  proxyRequests++
  const upstream = connect(model.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
  for (const s of [socket, upstream]) { proxySockets.add(s); s.on('close', () => proxySockets.delete(s)); s.on('error', () => { socket.destroy(); upstream.destroy() }) }
})
const issued = new Map(), observedKinds = new Set()
let sawProjectInstructions = false, sawMatchedRule = false
let githubUrl, githubIssue, quietIssue, githubRequests = 0, clock = Date.now(); const comments = []
const github = createServer(async (req, res) => {
  githubRequests++
  try {
    assert.equal(req.headers.authorization, 'Bearer offline-github-token')
    const path = new URL(req.url, 'http://localhost').pathname.replace('/repos/owner/project', '')
    res.setHeader('content-type', 'application/json')
    if (path === '/user') return res.end(JSON.stringify({ login: 'worker-bot' }))
    if (!path) return res.end(JSON.stringify({ full_name: 'owner/project', default_branch: 'main' }))
    if (path === '/issues') return res.end(JSON.stringify([githubIssue, quietIssue].filter(Boolean)))
    if (path === '/issues/comments') return res.end(JSON.stringify(comments))
    if (path === '/issues/3') return res.end(JSON.stringify(githubIssue))
    if (path === '/issues/4') return res.end(JSON.stringify(quietIssue))
    if (path === '/issues/3/comments') {
      if (req.method === 'POST') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const data = JSON.parse(Buffer.concat(chunks).toString())
        comments.push({ id: comments.length + 100, body: data.body, user: { login: 'worker-bot', type: 'User' }, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString(), issue_url: 'https://api.github.com/repos/owner/project/issues/3', html_url: 'https://github.com/owner/project/issues/3#issuecomment-100' })
        return res.end(JSON.stringify(comments.at(-1)))
      }
      return res.end(JSON.stringify(comments))
    }
    if (path === '/pulls' || path === '/pulls/comments') return res.end('[]')
    res.writeHead(404); res.end('{}')
  } catch (error) { console.error('Mock GitHub:', error); res.writeHead(500); res.end('{}') }
})
const options = () => ({ port: 0, now: () => clock, githubClient: (config, signal) => new GitHubClient(config.repository, 'offline-github-token', { baseUrl: githubUrl, signal }) })
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions'); calls++
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString()); const tools = body.tools.map(t => t.function.name)
    const router = tools.includes('superagent_route'); if (router) routerTools = tools; else workerTools = tools
    const last = body.messages.at(-1); let name, args
    const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')
    const payload = body.messages.filter(m => m.role === 'user').flatMap(m => { try { return [JSON.parse(JSON.parse(textOf(m)).payload)] } catch { return [] } }).findLast(p => !['settings_saved', 'ticket_ended', 'thread_unsubscribed'].includes(p.kind))
    if (payload) observedKinds.add(payload.kind)
    const previous = last.role === 'tool' && issued.get(last.tool_call_id)
    if (!router) {
      const system = body.messages.filter(m => m.role === 'system').map(textOf).join('\n')
      assert(system.includes('PROJECT_GUIDELINE_MUST_REACH_WORKER')); sawProjectInstructions = true
      if (system.includes('QUIET_MATCHED_RULE')) sawMatchedRule = true
    }
    if (last.role !== 'tool') { name = 'superagent_read'; args = { kind: 'instructions', ...(router && payload.ticket ? { id: payload.ticket.id } : {}) } }
    else if (previous?.name === 'superagent_read') {
      if (router && payload.kind === 'candidate') {
        if (payload.strength === 'inferred') {
          name = 'superagent_assess'; args = { triggerId: payload.triggers[0].id, evalId: payload.evalId, decision: 'accept', title: 'Quiet fixture', scope: 'Inspect spelling only', reason: 'Quiet copy rule', intentEvidence: 'Fix Helo', direction: { implementationRequested: true, targetBasis: 'specified', requiresDesignDecision: false, evidence: 'Exact typo' }, ruleAssessments: payload.rules.map(r => ({ ruleId: r.id, matched: true, reason: 'Spelling request' })) }
        } else {
          name = 'superagent_route'; args = { kind: 'accept', triggerId: payload.triggers[0].id, title: 'Offline smoke ticket', scope: 'Follow this offline fixture request without editing files', reason: 'Explicit test request', acknowledgement: 'I will inspect this request.' }
        }
      } else if (router && payload.kind === 'follow_up' && /stop/i.test(payload.trigger.text)) {
        name = 'superagent_route'; args = { kind: 'stop', triggerId: payload.trigger.id, ticketId: payload.delivered_to[0].id, reason: 'The person asked to stop' }
      } else if (router && ['worker_report', 'worker_attention'].includes(payload.kind) && ['ready', 'blocked'].includes(payload.state)) {
        name = 'superagent_reply'; args = payload.question ? { purpose: 'attention', ticketId: payload.ticket.id, question: payload.question, text: payload.question } : { purpose: 'result', ticketId: payload.ticket.id, text: payload.summary.text }
      } else if (!router) {
        const instructions = JSON.parse(textOf(last))
        name = 'superagent_report'; args = instructions.matchedRules?.some(r => r.instruction.includes('QUIET_MATCHED_RULE')) ? { state: 'dropped', summary: 'Already correct; no change needed.' }
          : /Wait for a human/i.test(payload.request?.text || '') ? { state: 'blocked', summary: 'Needs a human decision', question: 'Continue or stop?' }
          : { state: payload.kind === 'input' ? 'waiting' : 'ready', summary: 'Offline transport fixture completed; no code changes requested', question: null }
      }
    }
    if (name) issued.set(`tool-${calls}`, { name, args })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `mock-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    chunk({ role: 'assistant', ...(name ? { tool_calls: [{ index: 0, id: `tool-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'Done.' }) })
    chunk({}, name ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) { console.error('Mock endpoint:', error); res.writeHead(500); res.end(String(error)) }
})
try {
  mkdirSync(repository); const env = { ...process.env, GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com', GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com' }
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { env, stdio: 'pipe' })
  git('init'); writeFileSync(join(repository, 'README.md'), 'Smoke fixture\n'); writeFileSync(join(repository, 'AGENTS.md'), 'PROJECT_GUIDELINE_MUST_REACH_WORKER: do not edit fixture files.\n'); git('add', '.'); git('commit', '-m', 'fixture')
  initialize(state, { repository, management: 'token' })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  if (proxyMode) {
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    // Startup proxy initialization alone is overwritten by the SDK dependency import.
    process.env.NODE_USE_ENV_PROXY = '1'
  }
  writeFileSync(join(state, 'agent', 'models.json'), JSON.stringify({ providers: { 'offline-fixture': { baseUrl: proxyMode ? 'http://model.invalid/v1' : `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-dummy', models: [{ id: 'mock', contextWindow: 32000, maxTokens: 1024 }] } } }))
  await new Promise(resolve => github.listen(0, '127.0.0.1', resolve)); githubUrl = `http://127.0.0.1:${github.address().port}`
  service = await startService(state, options())
  const client = new Client(service.url, readFileSync(join(state, 'admin.token'), 'utf8').trim())
  const settings = await client.request('config'); settings.config.routerModel = settings.config.workerModel = { provider: 'offline-fixture', id: 'mock' }
  await client.request('config', 'PUT', settings)
  const request = { id: 'offline-smoke', text: 'Return ready without editing files. This is an offline integration test.' }
  await client.request('tickets', 'POST', request); await client.request('tickets', 'POST', request)
  let ticket
  for (let i = 0; i < 200; i++) {
    const tickets = await client.request('tickets'); ticket = tickets[0]
    if (ticket?.ended) break
    await sleep(100)
  }
  assert.equal(ticket?.ended?.outcome, 'completed', JSON.stringify(await client.request('status')))
  assert.equal((await client.request('tickets')).length, 1)
  assert(routerTools.includes('superagent_assess')); assert(routerTools.includes('superagent_route')); assert(!routerTools.includes('write')); assert(!routerTools.includes('job_start'))
  for (const name of ['superagent_note', 'superagent_status', 'superagent_reply']) assert(routerTools.includes(name))
  for (const name of ['superagent_ack', 'superagent_follow', 'superagent_unrelated']) assert(workerTools.includes(name))
  assert(sawProjectInstructions)
  assert(!workerTools.some(name => name.startsWith('superagent_github_'))); assert.equal(githubRequests, 0, 'Local work must not call GitHub')
  assert(workerTools.includes('job_start')); assert(!workerTools.includes('superagent_route'))
  assert(existsSession(join(state, 'sessions', 'router'))); assert(existsSession(join(state, 'sessions', ticket.id)))
  const ghSettings = await client.request('config'); ghSettings.config.github = { enabled: true, repository: 'owner/project', botLogin: 'worker-bot', allowedActors: ['alice'] }
  await client.request('config', 'PUT', ghSettings); await client.request('sources/github/poll', 'POST')
  const at = new Date(clock + 1000).toISOString(); clock += 60000
  githubIssue = { id: 3, number: 3, title: 'GitHub offline request', body: '@worker-bot return ready without editing files', state: 'open', user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at, html_url: 'https://github.com/owner/project/issues/3' }
  await client.request('sources/github/poll', 'POST')
  for (let i = 0; i < 200; i++) {
    const tickets = await client.request('tickets')
    if (tickets.length === 2 && tickets.every(t => t.ended) && comments.length === 2) break
    await sleep(100)
  }
  assert.equal((await client.request('tickets')).length, 2, JSON.stringify(await client.request('status')))
  assert.equal(comments.length, 2, JSON.stringify(await client.request('status')))
  assert(workerTools.includes('superagent_github_bind_pull')); assert(workerTools.includes('superagent_github_create_pull'))
  assert(comments.every(c => c.body.includes('<!-- pi-superagent:')))
  await waitFor(() => !service.runtime.store.pendingEffects().some(e => e.kind === 'relay' || e.kind === 'notice'))
  await sleep(300); const beforeNotice = calls
  service.runtime.store.enqueue('notice', 'non-waking-fixture', { kind: 'settings_saved', revision: 123 })
  await service.runtime.tick(); await sleep(300); assert.equal(calls, beforeNotice, 'Background notices must not wake Router')
  const routerLog = readdirSync(join(state, 'sessions', 'router')).filter(n => n.endsWith('.jsonl')).map(n => readFileSync(join(state, 'sessions', 'router', n), 'utf8')).join('\n')
  assert(routerLog.includes('non-waking-fixture') || routerLog.includes('123')); assert(routerLog.includes('superagent-notice'))
  await client.request('tickets', 'POST', { id: 'stop-fixture', text: 'Wait for a human decision; do not complete yet.' })
  let stopped
  await waitFor(async () => { stopped = (await client.request('tickets')).find(t => t.attention?.question === 'Continue or stop?'); return !!stopped })
  // This scenario exercises Router forwarding first; early answers now intentionally suppress stale attention relays.
  await waitFor(() => observedKinds.has('worker_attention'))
  await client.request(`tickets/${stopped.id}/followup`, 'POST', { id: 'stop-followup', text: 'Please stop this task.' })
  await waitFor(async () => (await client.request(`tickets/${stopped.id}`)).ended?.by === 'human')
  assert(observedKinds.has('follow_up')); assert(observedKinds.has('worker_attention'))
  const quietSettings = await client.request('config')
  quietSettings.config.mode = 'auto'; quietSettings.config.rules = [{ id: 'quiet-copy', enabled: true, instruction: 'QUIET_MATCHED_RULE: inspect spelling only; remain silent, no acknowledgement or dropped-result message.' }]
  quietSettings.config.github.observe.issues = true
  await client.request('config', 'PUT', quietSettings)
  const quietAt = new Date(clock + 1000).toISOString(); clock += 60000
  quietIssue = { ...githubIssue, id: 4, number: 4, title: 'Quiet fixture', body: 'Fix Helo', created_at: quietAt, updated_at: quietAt, html_url: 'https://github.com/owner/project/issues/4' }
  await client.request('sources/github/poll', 'POST')
  await waitFor(async () => (await client.request('tickets')).some(t => t.title === 'Quiet fixture' && t.ended?.outcome === 'dropped'))
  await waitFor(() => !service.runtime.store.pendingEffects().some(e => e.kind === 'relay'))
  assert(sawMatchedRule); assert.equal(comments.length, 2, 'Quiet matched rule must not manufacture channel messages')
  await service.close(); service = await startService(state, options())
  const restarted = new Client(service.url, readFileSync(join(state, 'admin.token'), 'utf8').trim())
  assert((await restarted.request('tickets')).every(t => t.ended))
  await restarted.request('sources/github/poll', 'POST'); await service.runtime.tick()
  assert.equal((await restarted.request('tickets')).length, 4); assert.equal(comments.length, 2)
  if (proxyMode) assert(proxyRequests > 0, 'Pi SDK subprocesses must use the configured proxy')
  console.log(`Offline smoke passed (${proxyMode ? 'environment proxy + NO_PROXY' : 'direct'}): real Pi SDK coordination/replies, question-to-stop follow-up, quiet matched rule, project AGENTS.md, non-waking persistent notices, GitHub ingestion/self-echo/restart, API and role allowlists; ${calls} local model requests.`)
} finally {
  await service?.close()
  for (const socket of proxySockets) socket.destroy()
  if (proxy.listening) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections() })
  await new Promise(resolve => { model.close(resolve); model.closeAllConnections() })
  await new Promise(resolve => { github.close(resolve); github.closeAllConnections() })
  for (const key of proxyVariables) { if (savedEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = savedEnvironment[key] }
  rmSync(dir, { recursive: true, force: true })
}
async function waitFor(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100) } throw Error('Timed out: ' + check.toString() + '\n' + JSON.stringify({ status: service.runtime.overview(), triggers: service.runtime.store.records('trigger'), decisions: service.runtime.store.records('decision'), recentCalls: [...issued.entries()].slice(-12) })) }
function existsSession(path) { return readdirSync(path).some(name => name.endsWith('.jsonl')) }
