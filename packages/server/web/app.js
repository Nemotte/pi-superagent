const modules = await Promise.all([import('./ticket-panel.js'), import('./settings-panel.js'), import('./records-panel.js')]).catch(() => {
  if (new URLSearchParams(location.hash.slice(1)).has('login')) history.replaceState(null, '', location.pathname + location.search)
  document.getElementById('connection').textContent = '面板资源未载入'
  document.getElementById('error').textContent = '面板资源未载入。刚更新代码时，请在 Pi 中先 /reload，再运行 /superagent restart 确认重启，然后刷新此页。'
  return null
})
if (modules) {
const [{ createTicketPanel, stageLabel }, { createSettingsPanel }, { createRecordsPanel }] = modules
const $ = id => document.getElementById(id)
let csrf, settings, sourceSettings, loading = false, authenticated = false
let offset = 0, ticketRequest = 0, eventCursor = 0, eventRows = [], pendingSubmission, submitting = false
let attentionSnapshot, readinessSnapshot, ticketSnapshot
const answerDrafts = new Map()
const actions = { answer: '需要回答', delivery: '需要恢复投递', failed: '执行失败', blocked: '需要解除阻塞', review: '等待审阅', queued: '等待执行' }
const views = ['attention', 'tickets', 'events', 'records', 'repos', 'sources', 'config']
const ticketPanel = createTicketPanel({ $, api, text, button, safe, renderWorkspace, refresh, openThread: key => recordsPanel.openThread(key) })
const settingsPanel = createSettingsPanel({ $, api, text, button, safe, refresh })
const recordsPanel = createRecordsPanel({ $, api, text, button, safe, showView, openTicket })
async function api(path, method = 'GET', data, signal) {
  const response = await fetch('/api/v1/' + path, { method, signal, headers: { 'content-type': 'application/json', 'x-superagent-local': '1', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
  const result = await response.json()
  if (response.status === 401) showLogin()
  if (!response.ok) throw Error(response.status === 404 && /^(requests|search|config\/history|threads\/|tickets\/.+\/conversation)/.test(path) ? '当前服务尚未加载新版面板 API。请在 Pi 中运行 /superagent restart 并确认重启。' : result.error || response.statusText)
  return result
}
function showLogin() { authenticated = false; $('login').hidden = false; $('workspace').hidden = true; $('connection').textContent = '未登录' }
function error(e) { $('error').textContent = e.message }
function safe(fn) { return (...args) => { $('error').textContent = ''; Promise.resolve().then(() => fn(...args)).catch(error) } }
function text(tag, content) { const el = document.createElement(tag); el.textContent = content; return el }
async function loadTickets() {
  const request = ++ticketRequest
  const query = new URLSearchParams({ q: $('ticket-query').value, state: $('ticket-state').value, offset: String(offset), limit: '50' })
  const tickets = await api('tickets?' + query)
  if (request !== ticketRequest) return
  const snapshot = JSON.stringify([offset, tickets])
  if (snapshot === ticketSnapshot) return
  ticketSnapshot = snapshot
  $('tickets').replaceChildren(...tickets.map(t => {
    const el = text('button', t.title); el.className = 'ticket'
    el.append(text('small', stageLabel(t)))
    el.onclick = safe(() => detail(t.id)); return el
  }))
  if (!tickets.length) $('tickets').append(text('p', '没有匹配的工单。新请求需要 Router 接单后才会出现在这里。'))
  $('previous').disabled = offset === 0; $('next').disabled = tickets.length < 50; $('page-number').textContent = String(offset / 50 + 1)
}
function button(label, run) { const b = text('button', label); b.type = 'button'; b.className = 'secondary'; b.onclick = safe(async () => { if (b.disabled) return; b.disabled = true; try { await run() } finally { b.disabled = false } }); return b }
function showView(name) {
  for (const view of views) $(view + '-view').hidden = view !== name
  for (const tab of document.querySelectorAll('nav [data-tab]')) tab.setAttribute('aria-current', tab.dataset.tab === name && (!tab.dataset.kind || tab.dataset.kind === $('record-kind').value) ? 'page' : 'false')
}
async function openTicket(id) { showView('tickets'); await loadTickets(); await detail(id) }
async function loadAttention() {
  const data = await api('attention'), snapshot = JSON.stringify(data)
  if (snapshot === attentionSnapshot) return
  attentionSnapshot = snapshot
  const focused = document.activeElement?.dataset.answer
  const items = data.tickets.map(t => {
    const card = text('article', ''); card.className = 'card attention-card'
    card.append(text('small', actions[t.action]), text('h3', t.title), text('p', t.question || t.summary.text))
    if (t.action === 'answer') {
      const form = document.createElement('form'), input = document.createElement('textarea'), submit = text('button', '回答')
      input.dataset.answer = t.id; input.setAttribute('aria-label', t.question); input.required = true; input.maxLength = 20000
      input.value = answerDrafts.get(t.id)?.text || ''
      input.oninput = () => answerDrafts.set(t.id, { id: crypto.randomUUID(), text: input.value })
      form.append(input, submit)
      form.onsubmit = event => { event.preventDefault(); safe(async () => {
        const pending = answerDrafts.get(t.id); if (!pending?.text.trim()) return
        submit.disabled = input.disabled = true
        try {
          await api(`tickets/${encodeURIComponent(t.id)}/followup`, 'POST', pending)
          if (answerDrafts.get(t.id)?.id === pending.id) { answerDrafts.delete(t.id); input.value = '' }
          card.append(text('p', '回答已送达，等待 Worker 继续。'))
        } finally { submit.disabled = input.disabled = false }
      })() }; card.append(form)
    }
    if (t.canRetry) card.append(button('重试', async () => { await api(`tickets/${encodeURIComponent(t.id)}/retry`, 'POST'); await loadAttention() }))
    card.append(button('查看工单', () => openTicket(t.id)))
    return card
  })
  for (const e of data.evaluations) {
    const card = text('article', ''); card.className = 'card attention-card'
    card.append(text('h3', '请求尚未完成评估'), text('p', (e.reason || []).map(r => r.values?.text || r.message || r.code).join('；')),
      button('重新评估', async () => { await api(`triggers/${encodeURIComponent(e.triggerId)}/reevaluate`, 'POST'); await loadAttention() }),
      button('忽略此提醒', async () => { await api(`decisions/${encodeURIComponent(e.id)}/dismiss`, 'POST'); await loadAttention() }))
    items.push(card)
  }
  for (const p of data.problems) { const card = text('article', ''); card.className = 'card attention-card'; card.append(text('h3', `${p.kind} 连续失败 ${p.attempts} 次`), text('p', p.error), button('检查配置', async () => { showView('config'); await loadConfig() })); items.push(card) }
  $('attention').replaceChildren(...items)
  if (!items.length) $('attention').append(text('p', '暂无需要你处理的事项。'))
  if (data.total > items.length) $('attention').append(text('p', `共有 ${data.total} 项；每类最多显示 50 项，处理后显示后续事项。`))
  if (focused) [...$('attention').querySelectorAll('textarea')].find(el => el.dataset.answer === focused)?.focus()
}
async function loadConfig() { await settingsPanel.load() }
function renderReadiness(status) {
  const state = status.readiness?.state || (status.modelsConfigured === false ? 'setup' : status.paused ? 'paused' : status.needsAttention ? 'attention' : 'ready')
  const snapshot = JSON.stringify([state, status.paused])
  if (snapshot === readinessSnapshot) return
  readinessSnapshot = snapshot
  const panel = $('readiness')
  panel.replaceChildren(text('h2', { setup: '模型未配置完整', paused: '派单已暂停', attention: '有事项需要你处理', ready: '派单已开启' }[state]))
  if (state === 'setup') panel.append(text('p', '先完成 Router / Worker 设置。已经提交的请求会保留，无需重交。'), button('配置模型', async () => { showView('config'); await loadConfig() }))
  else if (state === 'paused') panel.append(text('p', '请求继续保存。确认恢复后，已有请求也可能开始执行。'), button('恢复派单', () => togglePause()))
  else panel.append(text('p', state === 'ready' ? '明确需求由 Router 评估，接单后由 Worker 执行。' : '请处理下面的问题、失败或待审阅结果。'))
}
function renderSources(sources) {
  $('source-health').textContent = JSON.stringify(sources, null, 2)
  $('source-status').replaceChildren(...sources.filter(s => s.state !== 'deferred').map(s => {
    const card = text('article', ''); card.className = 'card'; card.append(text('strong', `${s.id === 'manual' ? '本地需求' : s.id} · ${{ ready: '接收就绪', disabled: '未启用', error: '需要检查', starting: '连接中', paused: '已暂停' }[s.state] || s.state}`))
    if (s.error) card.append(text('p', s.error)); return card
  }))
}
async function refresh() {
  if (!authenticated || loading) return
  loading = true
  try {
    const status = await api('status')
    $('connection').textContent = (status.management === 'local' ? '本地模式 · ' : '') + (status.modelsConfigured === false ? '待配置模型' : status.paused ? '已暂停新派单' : '服务在线')
    renderReadiness(status)
    $('pause').disabled = status.paused && status.modelsConfigured === false
    $('instance').textContent = `实例 ${status.instanceId} · API v${status.protocol}`
    $('pause').textContent = status.paused ? '恢复派单' : '暂停派单'
    const reasons = []
    if (status.paused) reasons.push('当前暂停派单：请求会保存，恢复派单后才交给 Router。')
    if (status.modelsConfigured === false) reasons.push('模型未配置完整：请在 Pi 中运行 /superagent setup，完成 Router / Worker 设置后再恢复派单。')
    const readiness = reasons.join(' ') || '派单已开启：请求由 Router 评估，接单后生成工单。'
    if ($('request-readiness').textContent !== readiness) $('request-readiness').textContent = readiness
    $('stats').replaceChildren(...[['工单总数', status.tickets], ['执行中的 Worker', status.busyWorkers], ['需要关注', status.needsAttention], ['待处理 Effects', status.pendingEffects]].map(([label, value]) => { const el = text('div', label); el.className = 'card'; el.append(text('strong', value)); return el }))
    if (!$('attention-view').hidden) await loadAttention()
    if (!$('tickets-view').hidden) { await loadTickets(); await ticketPanel.update() }
    if (!$('events-view').hidden) {
      const events = await api('events?after=' + eventCursor)
      if (events.length) eventCursor = events.at(-1).id
      eventRows = [...eventRows, ...events].slice(-500); $('events').textContent = JSON.stringify(eventRows, null, 2)
    }
    if (!$('records-view').hidden) await loadRecords()
    if (!$('sources-view').hidden) renderSources(status.sources)
  } finally { loading = false }
}
async function detail(id) { await ticketPanel.open(id) }
function renderWorkspace(container, view) {
  container.replaceChildren(text('h3', `${view.repositories.length} 个仓库`), text('p', view.root))
  if (view.error) container.append(text('p', view.error))
  if (view.report) container.append(text('p', view.report.summary))
  for (const repo of view.repositories) {
    const card = text('article', ''); card.className = 'card'
    card.append(text('strong', repo.path), text('small', `仓库 ID：${repo.id}`))
    if (repo.baseHead) card.append(text('p', `基线 ${repo.baseHead.slice(0, 12)} → ${repo.head?.slice(0, 12) || '不可用'} · ${repo.changed ? '有任务变更' : '无任务变更'}`))
    if (repo.sourceDirty) card.append(text('p', '原目录有未提交状态；未带入任务工作区。'))
    for (const mount of repo.mounts || []) card.append(text('p', `原有 gitlink 差异：${mount.path} ${mount.recorded.slice(0, 12)} → ${mount.mounted.slice(0, 12)}`))
    if (repo.files?.length) card.append(text('pre', repo.files.join('\n')), text('small', `显示 ${repo.files.length} / ${repo.files_total} 个变更路径`))
    const result = view.report?.repositories?.find(r => r.id === repo.id)
    if (result) card.append(text('p', result.summary), text('pre', result.checks.join('\n')))
    container.append(card)
  }
}
async function loadRecords() { await recordsPanel.load() }
async function loadSource() {
  sourceSettings = await api('config')
  const workspace = !!sourceSettings.config.workspace
  $('workspace-source-notice').hidden = !workspace
  $('github-settings').hidden = workspace
  $('github-settings').open = !workspace && !!sourceSettings.config.github?.enabled
  for (const control of $('github-form').querySelectorAll('input,button')) control.disabled = workspace
  $('github-poll').disabled = workspace
  const config = sourceSettings.config.github || { enabled: false, repository: '', botLogin: '', allowedActors: [], allowedBots: [], pollSeconds: 60, observe: {} }
  $('github-enabled').checked = config.enabled; $('github-repository').value = config.repository; $('github-bot').value = config.botLogin
  $('github-repository').readOnly = $('github-bot').readOnly = !!sourceSettings.config.github
  $('github-allowed').value = config.allowedActors.join(', '); $('github-bots').value = config.allowedBots.join(', '); $('github-interval').value = config.pollSeconds
  for (const kind of ['issues', 'pulls', 'comments', 'ci']) $('observe-' + kind).checked = !!config.observe[kind]
  renderSources(await api('sources'))
}
async function enter() {
  const session = await api('session'); csrf = session.csrf; $('logout').hidden = session.management === 'local'; authenticated = true; $('login').hidden = true; $('workspace').hidden = false
  settings = await api('config'); $('config').value = JSON.stringify(settings.config, null, 2); await refresh()
}
$('login-form').onsubmit = event => { event.preventDefault(); safe(async () => { const result = await api('login', 'POST', { token: $('token').value }); $('token').value = ''; csrf = result.csrf; await enter() })() }
$('submit-form').onsubmit = event => { event.preventDefault(); safe(async () => {
  if (submitting) return
  const input = $('request'), submit = $('submit-form').querySelector('button[type="submit"]'), feedback = $('request-feedback')
  if (!input.value.trim()) { feedback.textContent = '请输入任务目标、约束和验收条件。'; return }
  submitting = true; submit.disabled = input.disabled = true; submit.textContent = '正在提交…'; feedback.textContent = '正在提交请求…'
  try {
    pendingSubmission = pendingSubmission?.text === input.value ? pendingSubmission : { id: crypto.randomUUID(), text: input.value }
    const received = await api('tickets', 'POST', pendingSubmission, AbortSignal.timeout(10000))
    if (!received || typeof received.id !== 'string') throw Error('服务未返回请求编号')
    pendingSubmission = undefined; input.value = ''
    feedback.textContent = `请求已接收（${received.id}）。Router 接单后会出现在工单列表；可在“查看已提交请求”中查到本次输入。`
    // Acceptance is durable already; a failed status read must not turn it into a failed submission.
    void refresh().catch(error)
  } catch (e) {
    feedback.textContent = `提交结果未确认：${e.message}。内容已保留；再次提交相同内容会复用请求编号。`
  } finally { submitting = false; submit.disabled = input.disabled = false; submit.textContent = '提交给 Router' }
})() }
$('request-records').onclick = safe(async () => { $('record-kind').value = 'triggers'; recordsPanel.reset(); showView('records'); await loadRecords() })
$('ticket-filter').onsubmit = event => { event.preventDefault(); offset = 0; safe(loadTickets)() }
$('previous').onclick = safe(async () => { offset = Math.max(0, offset - 50); await loadTickets() })
$('next').onclick = safe(async () => { offset += 50; await loadTickets() })
$('github-form').onsubmit = event => { event.preventDefault(); safe(async () => {
  const list = id => $(id).value.split(',').map(x => x.trim()).filter(Boolean)
  const github = { ...sourceSettings.config.github, enabled: $('github-enabled').checked, repository: $('github-repository').value.trim(), botLogin: $('github-bot').value.trim(), allowedActors: list('github-allowed'), allowedBots: list('github-bots'), pollSeconds: Number($('github-interval').value), observe: Object.fromEntries(['issues', 'pulls', 'comments', 'ci'].map(kind => [kind, $('observe-' + kind).checked])) }
  sourceSettings = await api('config', 'PUT', { config: { ...sourceSettings.config, github }, revision: sourceSettings.revision })
  $('source-notice').textContent = 'GitHub 配置已保存。凭证就绪后可以立即轮询。启用状态变化后，请显式重启服务以更新已运行 Agent 的工具和指令。'; await loadSource()
})() }
$('github-poll').onclick = safe(async () => { $('source-health').textContent = JSON.stringify(await api('sources/github/poll', 'POST'), null, 2) })
async function togglePause() {
  const current = await api('config')
  if (current.config.paused && (!current.config.routerModel || !current.config.workerModel)) throw Error('请先配置 Router / Worker 型号，再恢复派单。')
  if (!confirm(current.config.paused ? '恢复派单？已有待处理请求也可能开始执行。' : '暂停派单和后续回复？入站请求仍会保存。')) return
  await api('config', 'PUT', { config: { ...current.config, paused: !current.config.paused }, revision: current.revision }); await refresh()
}
$('pause').onclick = safe(togglePause)
$('local-request').onclick = safe(async () => { showView('tickets'); await refresh(); $('request').focus() })
$('logout').onclick = safe(async () => { await api('logout', 'POST'); csrf = undefined; eventCursor = 0; eventRows = []; answerDrafts.clear(); attentionSnapshot = readinessSnapshot = ticketSnapshot = undefined; ticketPanel.clear(); recordsPanel.clear(); settingsPanel.clear(); pendingSubmission = undefined; $('request').value = ''; showLogin() })
for (const tab of document.querySelectorAll('[data-tab]')) tab.onclick = safe(async () => {
  if (tab.dataset.kind) { $('record-kind').value = tab.dataset.kind; recordsPanel.reset() }
  showView(tab.dataset.tab)
  if (tab.dataset.tab === 'config') await loadConfig()
  if (tab.dataset.tab === 'sources') await loadSource()
  if (tab.dataset.tab === 'repos') renderWorkspace($('repository-members'), await api('workspace'))
  await refresh()
})
setInterval(() => { refresh().catch(error) }, 3000)
async function loginFromLink() {
  let code = new URLSearchParams(location.hash.slice(1)).get('login')
  if (code !== null) {
    history.replaceState(null, '', location.pathname + location.search)
    try { await api('login', 'POST', { code }) }
    catch (error) {
      // An old token-mode link must not send a converted local instance back to a login form.
      const session = await api('session').catch(() => undefined)
      if (session?.management !== 'local') throw error
    } finally { code = null }
  }
  await enter()
}
const connect = () => { $('error').textContent = ''; loginFromLink().catch(e => { showLogin(); if (!e.message.includes('Authentication')) error(e) }) }
window.addEventListener('hashchange', connect)
connect()
}
