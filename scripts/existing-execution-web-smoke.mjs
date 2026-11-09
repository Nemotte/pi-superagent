import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initialize } from '../packages/server/dist/config.js'
import { Runtime } from '../packages/server/dist/runtime.js'
import { serveApi } from '../packages/server/dist/http.js'
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa existing web '))), root = join(dir, 'app')
mkdirSync(root)
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } }).trim()
const repositories = ['frontend', 'backend', 'kt'].map(id => ({ id, path: id }))
for (const member of repositories) {
  const path = join(root, member.path); mkdirSync(path); git(path, 'init', '-b', 'fix/existing')
  writeFileSync(join(path, 'README.md'), 'Preserve unrelated deletion\n'); git(path, 'add', '.'); git(path, 'commit', '-m', 'fixture')
  rmSync(join(path, 'README.md'))
}
const before = repositories.map(r => git(join(root, r.path), 'status', '--porcelain'))
const state = join(dir, 'state'); initialize(state, { repository: root, workspace: { repositories }, paused: true })
const messages = [], runtime = new Runtime(state, { send: async (...args) => { messages.push(args) }, stop: async () => {}, close: async () => {} })
let api, browser
try {
  const request = runtime.submit({ id: 'existing', text: 'Use all three original repositories and preserve current branches.' })
  runtime.engine.evaluateDue()
  const { ticketId } = runtime.engine.decide(request.id, { kind: 'accept', title: 'Existing checkout task', scope: 'Read only fixture', reason: 'Explicit fixture request' })
  runtime.engine.report(ticketId, { state: 'blocked', summary: 'Execution configuration required', question: null })
  api = await serveApi(runtime, undefined, 0)
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(api.url); await page.locator('[data-tab="tickets"]').click()
  await page.locator('#tickets').getByRole('button', { name: /Existing checkout task/ }).click()
  const cancelled = page.waitForEvent('dialog').then(async dialog => { assert(dialog.message().includes('fix/existing')); await dialog.dismiss() })
  await page.getByRole('button', { name: '切换到原工作区执行' }).click(); await cancelled
  assert.notEqual(runtime.store.tickets.get(ticketId).execution.directory, root)
  const confirmed = page.waitForEvent('dialog').then(async dialog => { assert(dialog.message().includes(root)); await dialog.accept() })
  await page.getByRole('button', { name: '切换到原工作区执行' }).click(); await confirmed
  await expect(page.locator('#ticket-summary')).toContainText('原工作区 / 保留现有分支')
  assert.equal(runtime.store.tickets.get(ticketId).execution.directory, root)
  assert.equal(runtime.settings().config.paused, true); assert.equal(messages.length, 0)
  for (const [i, member] of repositories.entries()) {
    assert.equal(git(join(root, member.path), 'branch', '--show-current'), 'fix/existing')
    assert.equal(git(join(root, member.path), 'status', '--porcelain'), before[i])
  }
  assert.deepEqual(errors, [])
  console.log('Existing execution Web smoke passed: three original repositories, explicit preview/cancel/confirm, branch/deletion preservation, no model dispatch and separate resume.')
} finally { await browser?.close(); await api?.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }) }
