import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialize } from '../packages/server/dist/config.js'
import { Runtime } from '../packages/server/dist/runtime.js'
import { serveApi } from '../packages/server/dist/http.js'
const dir = mkdtempSync(join(tmpdir(), 'sa-panel-web-')); initialize(dir, { repository: dir, paused: true })
const runtime = new Runtime(dir, { send: async () => { throw Error('No model dispatch in panel tests') }, stop: async () => {}, close: async () => {} })
let api, browser
const failures = [], errors = []
async function scenario(name, run) {
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message))
  try { await page.goto(api.url); await expect(page.locator('#workspace')).toBeVisible(); await run(page); console.log('PASS:', name) }
  catch (e) { failures.push(name + ': ' + e.message); console.error('FAIL:', name, e.message) }
  finally { await page.close() }
}
try {
  api = await serveApi(runtime, undefined, 0)
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true, args: ['--no-sandbox'] })
  await scenario('overview exposes actionable setup and GitLab-independent local workflow', async page => {
    await expect(page.locator('#readiness')).toContainText('模型未配置')
    await page.locator('#readiness').getByRole('button', { name: '配置模型' }).click()
    await expect(page.locator('#router-provider')).toBeVisible()
    await page.getByRole('button', { name: '加载型号目录', exact: true }).click()
    await expect(page.locator('#model-catalog-notice')).toContainText('目录已载入', { timeout: 15000 })
    await page.locator('#router-provider').fill('openai')
    assert(await page.locator('#router-model-options option').count() > 0)
    await page.locator('[data-tab="sources"]').click()
    await expect(page.locator('#sources-view')).toContainText('GitLab')
    await expect(page.locator('#sources-view')).toContainText('无需 GitHub')
  })
  await scenario('old service asset routes show restart guidance instead of a blank workspace', async page => {
    await page.route('**/ticket-panel.js', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }))
    await page.reload()
    await expect(page.locator('#error')).toContainText('/superagent restart')
  })
  const input = runtime.submit({ id: 'panel', text: '检查 GitLab 本地代码 <img src=x onerror="window.injected=true">' }); runtime.engine.evaluateDue()
  const decision = runtime.engine.decide(input.id, { kind: 'accept', title: '本地审阅', scope: 'Read only', reason: 'Explicit request' })
  const id = decision.ticketId
  await scenario('conversation, live result, valid actions and drafts survive polling', async page => {
    await page.locator('[data-tab="tickets"]').click(); await page.locator('#tickets').getByRole('button').click()
    await expect(page.locator('#conversation')).toContainText('检查 GitLab 本地代码')
    await expect(page.locator('#detail').getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
    const draft = page.locator('#followup-text'); await draft.fill('保留我尚未发送的草稿'); await draft.focus()
    runtime.store.set('reply:panel', { id: 'panel', ticketId: id, kind: 'reply', channel: input.channel, text: '这是持久的 Router 回复', status: 'sent', createdAt: new Date().toISOString() })
    runtime.engine.report(id, { state: 'blocked', summary: '需要明确验收范围', question: '只检查接口吗？' })
    await expect(page.locator('#conversation')).toContainText('这是持久的 Router 回复', { timeout: 10000 })
    await expect(page.locator('#ticket-summary')).toContainText('只检查接口吗？')
    await expect(draft).toHaveValue('保留我尚未发送的草稿'); await expect(draft).toBeFocused()
    await expect(page.locator('#detail').getByRole('button', { name: '重试', exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.injected), undefined)
    runtime.engine.stopTicket(id)
    await expect(page.locator('#ticket-summary')).toContainText('已停止', { timeout: 10000 })
    await expect(page.locator('#followup-form')).toBeHidden()
    await expect(page.locator('#detail').getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    await page.reload(); await page.locator('[data-tab="tickets"]').click(); await page.locator('#tickets').getByRole('button').click()
    await expect(page.locator('#conversation')).toContainText('这是持久的 Router 回复')
  })
  await scenario('request navigation, thread history and literal global search', async page => {
    await page.locator('[data-tab="records"][data-kind="triggers"]').click()
    await page.locator('#record-cards').getByRole('button', { name: '查看会话', exact: true }).click()
    await expect(page.locator('#thread-detail')).toContainText('检查 GitLab 本地代码')
    await page.locator('#thread-detail').getByRole('button', { name: '查看工单', exact: true }).first().click()
    await expect(page.locator('#detail')).toContainText('本地审阅')
    await page.locator('#global-query').fill('检查 GitLab'); await page.locator('#global-search').getByRole('button').click()
    await expect(page.locator('#search-results')).toContainText('本地审阅')
  })
  await scenario('settings merge concurrent unrelated edits, keep conflicts and expose history', async page => {
    await page.locator('[data-tab="config"]').click()
    await page.locator('#router-provider').fill('fixture'); await page.locator('#router-model').fill('router')
    await page.locator('#worker-provider').fill('fixture'); await page.locator('#worker-model').fill('worker')
    let s = runtime.settings(); runtime.saveSettings({ ...s.config, maxWorkers: 4 }, s.revision)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.locator('#settings-notice')).toContainText('已保存')
    assert.equal(runtime.settings().config.maxWorkers, 4); assert.equal(runtime.settings().config.workerModel.id, 'worker'); assert.equal(runtime.settings().config.paused, true)
    await page.locator('#team-communication').fill('本地正在编辑')
    s = runtime.settings(); runtime.saveSettings({ ...s.config, team: { ...s.config.team, communication: '另一个客户端修改' } }, s.revision)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.locator('#settings-notice')).toContainText('冲突')
    await expect(page.locator('#team-communication')).toHaveValue('本地正在编辑')
    assert.equal(runtime.settings().config.team.communication, '另一个客户端修改')
    await page.locator('[data-tab="attention"]').click(); await page.locator('[data-tab="config"]').click()
    await expect(page.locator('#team-communication')).toHaveValue('本地正在编辑')
    await page.getByRole('button', { name: '查看保存历史', exact: true }).click()
    await expect(page.locator('#config-history')).toContainText('版本')
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0)
  })
  const makeTicket = key => {
    const t = runtime.submit({ id: key, text: key }); runtime.engine.evaluateDue()
    return runtime.engine.decide(t.id, { kind: 'accept', title: key, scope: 'Read only', reason: 'Test request' }).ticketId
  }
  const a = makeTicket('first-detail'), b = makeTicket('second-detail')
  await scenario('new questions are visible outside the attention tab and replies show received rather than asking again', async page => {
    await page.locator('[data-tab="config"]').click()
    runtime.engine.report(a, { state: 'blocked', summary: 'Need confirmation', question: '保留现有分支吗？' })
    await expect(page.locator('#attention-alert')).toContainText('需要你确认 / 回答', { timeout: 10000 })
    await expect(page.locator('#attention-alert')).toContainText('保留现有分支吗？')
    await page.locator('#attention-alert').getByRole('button', { name: '查看并回答' }).click()
    await expect(page.locator('#ticket-summary')).toContainText('first-detail')
    await page.locator('#followup-text').fill('保留现有分支，已经确认。')
    await page.getByRole('button', { name: '发送跟进', exact: true }).click()
    await expect(page.locator('#ticket-summary')).toContainText('补充已接收，待处理')
    await expect(page.locator('#ticket-summary')).not.toContainText('需要你回答：')
    await expect(page.locator('#attention-alert')).toBeHidden({ timeout: 10000 })
    assert(runtime.store.tickets.get(a).attention, 'receipt alone does not claim the decision or execution change is applied')
    runtime.engine.report(a, { state: 'blocked', summary: 'Execution configuration pending', question: null })
  })
  await scenario('late detail responses cannot replace a newer selection; drafts follow their ticket', async page => {
    await page.locator('[data-tab="tickets"]').click()
    let release, reached
    const gate = new Promise(resolve => { release = resolve }), requested = new Promise(resolve => { reached = resolve })
    await page.route(`**/api/v1/tickets/${a}`, async route => { reached(); await gate; await route.continue() })
    try {
      await page.locator('#tickets').getByRole('button', { name: /first-detail/ }).click(); await requested
      await page.locator('#followup-text').fill('first ticket draft')
      await page.locator('#tickets').getByRole('button', { name: /second-detail/ }).click()
      await expect(page.locator('#ticket-summary')).toContainText('second-detail')
    } finally { release() }
    await page.unrouteAll({ behavior: 'wait' })
    await expect(page.locator('#ticket-summary')).toContainText('second-detail')
    await page.locator('#tickets').getByRole('button', { name: /first-detail/ }).click()
    await expect(page.locator('#followup-text')).toHaveValue('first ticket draft')
  })
  await scenario('a lost followup response retains the same id for manual retry', async page => {
    await page.locator('[data-tab="tickets"]').click(); await page.locator('#tickets').getByRole('button', { name: /second-detail/ }).click()
    const posts = []; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith(`/tickets/${b}/followup`)) posts.push(r.postDataJSON()) })
    await page.route(`**/api/v1/tickets/${b}/followup`, async route => { await route.fetch(); await route.abort() })
    await page.locator('#followup-text').fill('idempotent followup'); await page.getByRole('button', { name: '发送跟进', exact: true }).click()
    await expect(page.locator('#followup-form')).toContainText('发送结果未确认')
    await page.unroute(`**/api/v1/tickets/${b}/followup`)
    await page.getByRole('button', { name: '发送跟进', exact: true }).click()
    await expect(page.locator('#followup-form')).toContainText('补充已接收')
    assert.equal(posts.length, 2); assert.equal(posts[0].id, posts[1].id)
    assert.equal(runtime.store.records('trigger', 0, 100).filter(t => t.text === 'idempotent followup').length, 1)
  })
  await scenario('the receipt entry returns to newest inputs after browsing older pages', async page => {
    for (let i = 0; i < 55; i++) runtime.submit({ id: `older-${i}`, text: `Older request ${i}` })
    await page.locator('[data-tab="records"][data-kind="triggers"]').click(); await page.locator('#record-next').click()
    await expect(page.locator('#record-page')).toHaveText('2')
    await page.locator('[data-tab="tickets"]').click(); await page.locator('#request').fill('Newest receipt after paging')
    await page.getByRole('button', { name: '提交给 Router', exact: true }).click(); await expect(page.locator('#request-feedback')).toContainText('请求已接收')
    await page.getByRole('button', { name: '查看已提交请求', exact: true }).click()
    await expect(page.locator('#record-cards')).toContainText('Newest receipt after paging')
  })
  assert.deepEqual(errors, []); assert.deepEqual(failures, [])
  console.log('Panel browser smoke passed: readiness, local/GitLab guidance, live conversation/results/actions, stable drafts, record navigation/search and safe settings merge/history.')
} finally { await browser?.close(); await api?.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
