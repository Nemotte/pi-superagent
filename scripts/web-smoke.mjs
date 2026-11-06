import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../packages/server/dist/config.js'
import { readToken } from '../packages/server/dist/config.js'
import { Runtime } from '../packages/server/dist/runtime.js'
import { serveApi } from '../packages/server/dist/http.js'
const dir = mkdtempSync(join(tmpdir(), 'pi-sa-web-')); initialize(dir, { repository: dir, management: 'token' })
let api, browser
const runtime = new Runtime(dir, { send: async () => {}, stop: async () => {}, close: async () => {} }, {
  githubClient: () => ({ verify: async () => {}, get: async () => ({ full_name: 'owner/project', default_branch: 'main' }), pages: async () => [], post: async () => { throw Error('Browser smoke must not publish') } }),
})
try {
  api = await serveApi(runtime, readToken(dir), 0)
  const executablePath = process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message))
  const grantResponse = await fetch(api.url + '/api/v1/login-grants', { method: 'POST', headers: { authorization: `Bearer ${readToken(dir)}` } })
  assert.equal(grantResponse.status, 201)
  const { code } = await grantResponse.json(), requestUrls = []
  page.on('request', request => requestUrls.push(request.url()))
  await page.goto(api.url + '/#login=' + code)
  await expect(page.locator('#workspace')).toBeVisible()
  assert.equal(page.url(), api.url + '/')
  assert(requestUrls.every(url => !url.includes(code)))
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0)
  await page.reload(); await expect(page.locator('#workspace')).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.locator('#login')).toBeVisible()
  await page.goto(api.url + '/#login=' + code)
  await expect(page.locator('#error')).toContainText('登录链接已失效')
  assert.equal(page.url(), api.url + '/')
  await page.locator('#token').fill(readToken(dir)); await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('#workspace')).toBeVisible()
  await expect(page.locator('#attention-view')).toBeVisible()
  await expect(page.locator('#attention')).toContainText('暂无需要你处理的事项')
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  await expect(page.locator('#repository-members')).toContainText('1 个仓库')
  await page.getByRole('button', { name: '来源', exact: true }).click()
  await page.locator('#github-settings > summary').click()
  await page.locator('#github-repository').fill('owner/project'); await page.locator('#github-bot').fill('worker-bot'); await page.locator('#github-allowed').fill('alice')
  await page.locator('#github-enabled').check(); await page.getByRole('button', { name: '保存 GitHub 配置' }).click()
  await expect(page.locator('#source-notice')).toContainText('已保存')
  assert.equal(runtime.settings().config.github.repository, 'owner/project')
  await page.getByRole('button', { name: '立即轮询' }).click(); await expect(page.locator('#source-health')).toContainText('ready')
  await expect(page.locator('#sources-view')).toContainText('飞书已延期')
  await page.getByRole('button', { name: '执行', exact: true }).click()
  const injection = '<img src=x onerror="window.injected=true">'
  await page.locator('#request').fill(injection); await page.getByRole('button', { name: '提交给 Router' }).click()
  await expect.poll(() => runtime.store.records('trigger').length).toBe(1)
  const trigger = runtime.store.records('trigger')[0]; runtime.engine.evaluateDue()
  const decision = await runtime.tool({ role: 'router', key: 'router' }, 'route', { kind: 'accept', triggerId: trigger.id, title: 'UI smoke ticket', scope: 'Test only', reason: 'Offline browser fixture' })
  await expect(page.locator('#tickets')).toContainText('UI smoke ticket', { timeout: 10000 })
  await page.locator('#ticket-query').fill('nonexistent'); await page.locator('#ticket-filter').getByRole('button').click()
  await expect(page.locator('#tickets')).not.toContainText('UI smoke ticket')
  await page.locator('#ticket-query').fill('UI smoke'); await page.locator('#ticket-filter').getByRole('button').click()
  await page.locator('#tickets').getByRole('button').click(); await page.getByText('授权、分派与诊断', { exact: true }).click(); await page.getByRole('button', { name: '运行诊断' }).click()
  await expect(page.locator('#diagnostics')).toContainText('messages')
  await page.getByRole('button', { name: '仓库变更与验证', exact: true }).click()
  await expect(page.locator('#ticket-workspace')).toContainText('1 个仓库')
  runtime.engine.report(decision.ticketId, { state: 'blocked', summary: 'One decision is needed', question: '使用大写还是小写？' })
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await expect(page.locator('#attention')).toContainText('使用大写还是小写？')
  await page.locator('#attention textarea').fill('使用小写')
  await page.locator('#attention').getByRole('button', { name: '回答', exact: true }).click()
  await expect.poll(() => runtime.store.records('trigger').some(t => t.text === '使用小写')).toBe(true)
  await page.getByRole('button', { name: '执行', exact: true }).click()
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect.poll(() => runtime.store.tickets.get(decision.ticketId)?.ended?.by).toBe('human')
  await page.getByRole('button', { name: '输入', exact: true }).click(); await page.locator('#record-kind').selectOption('triggers')
  await expect(page.locator('#records')).toContainText('onerror')
  // Hold the initial configuration load: users must not edit values that the response will overwrite.
  let releaseConfig
  const configGate = new Promise(resolve => { releaseConfig = resolve })
  await page.route('**/api/v1/config', async route => { if (route.request().method() === 'GET') await configGate; await route.continue() })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  try { await expect(page.locator('#team-communication')).toBeDisabled() } finally { releaseConfig() }
  await expect(page.locator('#team-communication')).toBeEnabled()
  await page.unroute('**/api/v1/config')
  await page.locator('#team-communication').fill('只说需要人决定或可用的结果。')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect.poll(() => runtime.settings().config.team.communication).toBe('只说需要人决定或可用的结果。')
  assert.equal(await page.evaluate(() => window.injected), undefined)
  assert.deepEqual(errors, [])
  console.log('Browser smoke passed: real Chromium one-use login/fragment cleanup/refresh/logout/manual login/CSRF, GitHub configuration and health, attention queue/direct answers, team instructions, submit/filter/stop, diagnostics, records and safe text rendering.')
} finally { await browser?.close(); await api?.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
