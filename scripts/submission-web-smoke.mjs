// Real paused local API: verify acceptance feedback without dispatching any model work.
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../packages/server/dist/config.js'
import { Runtime } from '../packages/server/dist/runtime.js'
import { serveApi } from '../packages/server/dist/http.js'
const dir = mkdtempSync(join(tmpdir(), 'sa-submit-web-'))
initialize(dir, { repository: dir, paused: true })
const runtime = new Runtime(dir, { send: async () => { throw Error('This test must not dispatch model work') }, stop: async () => {}, close: async () => {} })
let api, browser
try {
  api = await serveApi(runtime, undefined, 0)
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(), errors = [], posts = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST' && request.url() === api.url + '/api/v1/tickets') posts.push(request.postDataJSON()) })
  await page.goto(api.url); await page.getByRole('button', { name: '执行', exact: true }).click()
  const input = page.locator('#request'), submit = page.locator('#submit-form button[type="submit"]'), feedback = page.locator('#request-feedback'), readiness = page.locator('#request-readiness')
  await input.fill('Paused request must be visibly acknowledged')
  await page.getByRole('button', { name: '提交给 Router', exact: true }).click()
  await expect.poll(() => runtime.store.records('trigger').length).toBe(1)
  const first = runtime.store.records('trigger')[0]
  await expect(feedback).toContainText('请求已接收')
  await expect(feedback).toContainText(first.id)
  await expect(readiness).toContainText('暂停派单'); await expect(readiness).toContainText('模型未配置')
  await expect(readiness).toContainText('/superagent setup'); await expect(input).toHaveValue('')
  assert.equal(runtime.store.records('ticket').length, 0)
  await page.reload(); await page.getByRole('button', { name: '执行', exact: true }).click()
  await page.getByRole('button', { name: '查看已提交请求', exact: true }).click()
  await expect(page.locator('#record-kind')).toHaveValue('triggers'); await expect(page.locator('#record-cards')).toContainText(first.text)
  await page.getByRole('button', { name: '执行', exact: true }).click()

  let release
  const gate = new Promise(resolve => { release = resolve })
  await page.route('**/api/v1/tickets', async route => { if (route.request().method() === 'POST') await gate; await route.continue() })
  await input.fill('Only one request while a response is pending'); await submit.click()
  try {
    await expect(submit).toBeDisabled(); await expect(input).toBeDisabled(); await expect(feedback).toContainText('正在提交')
    await page.evaluate(() => { for (let i = 0; i < 2; i++) document.getElementById('submit-form').dispatchEvent(new Event('submit', { cancelable: true })) })
    assert.equal(posts.length, 2)
  } finally { release() }
  await expect(feedback).toContainText('请求已接收'); await expect(submit).toBeEnabled(); await expect(input).toBeEnabled()
  await page.unroute('**/api/v1/tickets')
  assert.equal(runtime.store.records('trigger').length, 2)

  // Server accepts the POST, but the browser loses the response. Retry must not create another Trigger.
  await page.route('**/api/v1/tickets', async route => {
    if (route.request().method() === 'POST') { const result = await route.fetch(); assert.equal(result.status(), 202); await route.abort('failed') }
    else await route.continue()
  })
  await input.fill('Retry this request with the original idempotency key'); await submit.click()
  await expect(feedback).toContainText('结果未确认'); await expect(input).toHaveValue('Retry this request with the original idempotency key')
  await expect(submit).toBeEnabled(); assert.equal(runtime.store.records('trigger').length, 3)
  const failed = posts.at(-1)
  await page.unroute('**/api/v1/tickets'); await submit.click()
  await expect(feedback).toContainText('请求已接收'); assert.deepEqual(posts.at(-1), failed)
  assert.equal(runtime.store.records('trigger').length, 3)

  // A failed follow-up read must not turn an acknowledged submission into a retry prompt.
  await page.route('**/api/v1/status', route => route.abort('failed'))
  await input.fill('Keep the accepted receipt when refresh fails'); await submit.click()
  await expect(feedback).toContainText('请求已接收'); await expect(input).toHaveValue(''); await expect(submit).toBeEnabled()
  assert.equal(runtime.store.records('trigger').length, 4)
  await page.unroute('**/api/v1/status')
  let settings = runtime.settings()
  settings = runtime.saveSettings({ ...settings.config, routerModel: { provider: 'fixture', id: 'fixture' }, workerModel: { provider: 'fixture', id: 'fixture' } }, settings.revision)
  await expect(readiness).not.toContainText('模型未配置'); await expect(readiness).toContainText('暂停派单')
  runtime.saveSettings({ ...settings.config, paused: false }, settings.revision)
  await expect(readiness).toContainText('派单已开启')
  await input.fill('   '); const count = posts.length; await submit.click()
  await expect(feedback).toContainText('请输入任务目标'); assert.equal(posts.length, count)
  // A stalled transport must release the form after the submission deadline, preserving its retry key.
  let releaseStalled
  const stalledGate = new Promise(resolve => { releaseStalled = resolve })
  await page.route('**/api/v1/tickets', async route => {
    if (route.request().method() === 'POST') { await stalledGate; await route.abort('failed').catch(() => {}) }
    else await route.continue()
  })
  await input.fill('Retry after the ten-second deadline'); await submit.click()
  try {
    await expect(feedback).toContainText('结果未确认', { timeout: 15000 })
    await expect(submit).toBeEnabled(); await expect(input).toHaveValue('Retry after the ten-second deadline')
    assert.equal(runtime.store.records('trigger').length, 4)
  } finally { releaseStalled() }
  const stalled = posts.at(-1)
  await page.unroute('**/api/v1/tickets'); await submit.click()
  await expect(feedback).toContainText('请求已接收'); assert.deepEqual(posts.at(-1), stalled)
  assert.equal(runtime.store.records('trigger').length, 5)
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0)
  assert.deepEqual(errors, [])
  console.log('Submission browser smoke passed: paused/unconfigured local instance, accepted request ID, durable records, guarded submission, lost-response idempotent retry, read-failure isolation and live readiness hints; no model dispatch.')
} finally { await browser?.close(); await api?.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
