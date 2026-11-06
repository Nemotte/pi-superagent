// Real Pi SDK + local scripted model: one ticket edits and verifies two cooperating repositories.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { initialize, startService } from '../packages/server/dist/index.js'
import { Client } from '../packages/extension/dist/client.js'
const dir = mkdtempSync(join(tmpdir(), 'sa multi sdk ')), root = join(dir, 'app'), state = join(dir, 'state')
const environment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: environment, stdio: 'pipe', encoding: 'utf8' }).trim()
const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')
const issued = new Map(); let service, calls = 0, sawInstructions = false, sawVerification = false, modelError
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions'); calls++
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString()), tools = body.tools.map(t => t.function.name)
    const router = tools.includes('superagent_route'), last = body.messages.at(-1), previous = issued.get(last.tool_call_id)
    assert(!tools.some(name => name.startsWith('superagent_github_')))
    const payloads = body.messages.filter(m => m.role === 'user').flatMap(m => { try { return [JSON.parse(JSON.parse(textOf(m)).payload)] } catch { return [] } })
    const payload = payloads.at(-1)
    let name, args
    if (router && last.role !== 'tool') {
      if (payload?.kind === 'candidate') { name = 'superagent_route'; args = { kind: 'accept', triggerId: payload.triggers[0].id, title: 'Unified exam API', scope: 'Update frontend and exam API files and verify that they match', reason: 'Explicit fixture request' } }
    } else if (!router) {
      const system = body.messages.filter(m => m.role === 'system').map(textOf).join('\n')
      for (const sentinel of ['SHARED_WORKSPACE_INSTRUCTION', 'FRONTEND_INSTRUCTION', 'EXAM_CLAUDE_INSTRUCTION']) assert(system.includes(sentinel))
      sawInstructions = true
      if (last.role !== 'tool' && payload?.kind === 'job_result') { name = 'job_status'; args = { id: payload.job.id } }
      else if (last.role !== 'tool') { name = 'superagent_read'; args = { kind: 'workspace' } }
      else if (previous?.name === 'superagent_read') {
        assert.equal(JSON.parse(textOf(last)).total, 3)
        name = 'write'; args = { path: 'frontends/portal/API.txt', content: 'GET /exam\n' }
      } else if (previous?.name === 'write' && previous.args.path.startsWith('frontends/')) {
        name = 'write'; args = { path: 'backend/exam/API.txt', content: 'GET /exam\n' }
      } else if (previous?.name === 'write') {
        name = 'job_start'; args = { executable: process.execPath, args: ['-e', "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('frontends/portal/API.txt','utf8'),fs.readFileSync('backend/exam/API.txt','utf8'));console.log('API contracts match')"] }
      } else if (previous?.name === 'job_status') {
        const job = JSON.parse(textOf(last))
        if (job.state === 'running') { await sleep(100); name = 'job_status'; args = { id: job.id } }
        else {
          assert.equal(job.exitCode, 0, JSON.stringify(job)); assert(job.output.includes('API contracts match')); sawVerification = true
          name = 'superagent_report'; args = { state: 'ready', summary: 'Frontend and exam API contracts match.', repositories: ['portal', 'exam'].map(id => ({ id, summary: 'Added matching GET /exam contract', checks: ['Node assertion compared frontend and exam contract files successfully'] })) }
        }
      }
    }
    if (name) issued.set(`call-${calls}`, { name, args })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `mock-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    chunk({ role: 'assistant', ...(name ? { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'Done.' }) })
    chunk({}, name ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n')
  } catch (error) { modelError = error; res.writeHead(500); res.end(String(error)) }
})
try {
  const front = join(root, 'frontends/portal'), backend = join(root, 'backend'), exam = join(backend, 'exam')
  for (const path of [front, backend, exam]) {
    mkdirSync(path, { recursive: true }); git(path, 'init'); writeFileSync(join(path, 'README.md'), 'fixture\n'); git(path, 'add', '.'); git(path, 'commit', '-m', 'initial')
  }
  writeFileSync(join(root, 'AGENTS.md'), 'SHARED_WORKSPACE_INSTRUCTION: coordinate changes across repository boundaries.')
  writeFileSync(join(front, 'AGENTS.md'), 'FRONTEND_INSTRUCTION: verify compatibility.'); git(front, 'add', '.'); git(front, 'commit', '-m', 'instructions')
  const recorded = git(exam, 'rev-parse', 'HEAD')
  git(backend, 'update-index', '--add', '--cacheinfo', `160000,${recorded},exam`); git(backend, 'commit', '-m', 'record gitlink without modules mapping')
  writeFileSync(join(exam, 'CLAUDE.md'), 'EXAM_CLAUDE_INSTRUCTION: preserve independent Git history.'); git(exam, 'add', '.'); git(exam, 'commit', '-m', 'advance nested checkout')
  const before = [front, backend, exam].map(path => [git(path, 'rev-parse', 'HEAD'), git(path, 'status', '--porcelain')])
  initialize(state, { repository: root, maxWorkers: 1, workspace: { repositories: [{ id: 'portal', path: 'frontends/portal' }, { id: 'backend', path: 'backend' }, { id: 'exam', path: 'backend/exam' }] } })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(state, 'agent/models.json'), JSON.stringify({ providers: { 'offline-fixture': { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-dummy', models: [{ id: 'mock', contextWindow: 32000, maxTokens: 1024 }] } } }))
  service = await startService(state, { port: 0 })
  assert(!existsSync(join(state, 'admin.token')))
  let client = new Client(service.url)
  const settings = await client.request('config'); settings.config.routerModel = settings.config.workerModel = { provider: 'offline-fixture', id: 'mock' }; await client.request('config', 'PUT', settings)
  await client.request('tickets', 'POST', { id: 'cross-repo', text: 'Add matching GET /exam API contracts to frontend and exam, then verify them together.' })
  let ticket
  for (let i = 0; i < 300; i++) { if (modelError) throw modelError; ticket = (await client.request('tickets'))[0]; if (ticket?.ended && !(await client.request('status')).busyWorkers) break; await sleep(100) }
  assert.equal(ticket?.ended?.outcome, 'completed', JSON.stringify(await client.request('status')))
  assert(sawInstructions && sawVerification); assert.equal(ticket.assignments.length, 1)
  const view = await client.request(`tickets/${ticket.id}/workspace`)
  assert.deepEqual(view.repositories.filter(r => r.changed).map(r => r.id).sort(), ['exam', 'portal'])
  assert.equal(view.repositories.find(r => r.id === 'backend').mounts[0].recorded, recorded)
  assert.equal(view.report.repositories.length, 2)
  assert.deepEqual([front, backend, exam].map(path => [git(path, 'rev-parse', 'HEAD'), git(path, 'status', '--porcelain')]), before)
  await service.close(); service = await startService(state, { port: 0 })
  client = new Client(service.url)
  assert.equal((await client.request('tickets')).length, 1)
  assert.deepEqual((await client.request(`tickets/${ticket.id}/workspace`)).report, view.report)
  if (process.argv.includes('--web')) {
    const { chromium, expect } = await import('@playwright/test')
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message))
      await page.goto(service.url)
      await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#login')).toBeHidden()
      await expect(page.locator('#logout')).toBeHidden()
      page.once('dialog', dialog => dialog.accept()); await page.locator('#pause').click(); await expect(page.locator('#pause')).toHaveText('恢复派单')
      await expect(page.locator('#connection')).toContainText('本地模式')
      await page.reload(); await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#logout')).toBeHidden()
      assert.deepEqual(await page.context().cookies(), [])
      await page.goto(service.url + '/#login=obsolete-token-mode-link')
      await expect(page.locator('#workspace')).toBeVisible(); await expect(page.locator('#login')).toBeHidden()
      assert.equal(new URL(page.url()).hash, '')
      await page.getByRole('button', { name: '工作区', exact: true }).click(); await expect(page.locator('#repository-members')).toContainText('3 个仓库')
      await expect(page.locator('#repository-members')).toContainText('backend/exam')
      await page.getByRole('button', { name: '执行', exact: true }).click(); await page.locator('#tickets').getByRole('button').click()
      await page.getByRole('button', { name: '仓库变更与验证', exact: true }).click()
      await expect(page.locator('#ticket-workspace')).toContainText('Frontend and exam API contracts match.')
      await expect(page.locator('#ticket-workspace')).toContainText('原有 gitlink 差异')
      await expect(page.locator('#ticket-workspace')).toContainText('Node assertion compared frontend and exam')
      await page.getByRole('button', { name: '来源', exact: true }).click(); await expect(page.locator('#github-enabled')).toBeDisabled()
      await expect(page.locator('#workspace-source-notice')).toBeVisible(); assert.deepEqual(errors, [])
    } finally { await browser.close() }
  }
  console.log(`Workspace smoke passed${process.argv.includes('--web') ? ' (including Chromium workspace/results UI)' : ''}: one real SDK Worker, frontend+nested-backend edits, cross-repository Node verification, scoped instructions, baseline gitlink differences, original checkout preservation and restart; ${calls} local model requests.`)
} finally { await service?.close(); await new Promise(resolve => { model.close(resolve); model.closeAllConnections() }); rmSync(dir, { recursive: true, force: true }) }
