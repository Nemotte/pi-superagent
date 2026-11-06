const states = { pending: '已接收，等待 Router', accepted: '已关联工单', filtered: '来源范围已过滤', ignored: '未接单', unavailable: '评估未完成', accept: '接单', ignore: '忽略', reopen: '继续执行', stop: '停止' }
const reason = rows => (rows || []).map(r => r.values?.text || r.message || r.code).join('；')
export function createRecordsPanel({ $, api, text, button, safe, showView, openTicket }) {
  let offset = 0, sequence = 0, snapshot, thread, threadOffset = 0, threadSequence = 0
  function card(record, kind) {
    const root = text('article', ''); root.className = 'card'
    const title = kind === 'triggers' ? record.text.slice(0, 160) : kind === 'decisions' ? (states[record.kind] || record.kind) : (typeof record.meta?.label === 'string' ? record.meta.label : record.key)
    root.append(text('h3', title), text('small', `${record.at || record.lastAt || record.createdAt || ''} · ${states[record.state] || ''}`))
    if (record.reason || record.decision?.reason || record.disposition?.filtered) root.append(text('p', reason(record.reason || record.decision?.reason || [record.disposition.filtered])))
    for (const id of new Set(record.ticketIds || (record.ticketId ? [record.ticketId] : record.subscriptions || []))) root.append(button('查看工单', () => openTicket(id)))
    const keys = record.threadKeys || (record.threadKey ? [record.threadKey] : record.key ? [record.key] : [])
    for (const key of keys) root.append(button('查看会话', () => openThread(key)))
    if (record.url) {
      try { const url = new URL(record.url); if (['http:', 'https:'].includes(url.protocol)) { const a = text('a', '打开原讨论'); a.href = url.href; a.rel = 'noreferrer noopener'; a.target = '_blank'; root.append(a) } } catch { /* a stored invalid URL is not a navigation target */ }
    }
    if (record.state === 'unavailable') root.append(button('重新评估', async () => { await api(`triggers/${encodeURIComponent(record.id)}/reevaluate`, 'POST'); await load() }))
    return root
  }
  async function load() {
    const request = ++sequence, kind = $('record-kind').value
    const data = await api(`${kind === 'triggers' ? 'requests' : kind}?offset=${offset}&limit=50`)
    if (request !== sequence || kind !== $('record-kind').value) return
    const next = JSON.stringify([kind, offset, data])
    if (snapshot !== next) {
      snapshot = next; $('records').textContent = JSON.stringify(data, null, 2)
      $('record-cards').replaceChildren(...data.map(r => card(r, kind)))
      if (!data.length) $('record-cards').append(text('p', '没有匹配记录。'))
      $('record-page').textContent = String(offset / 50 + 1); $('record-previous').disabled = !offset; $('record-next').disabled = data.length < 50
    }
    if (thread) await loadThread()
  }
  async function loadThread() {
    const key = thread, request = ++threadSequence
    const data = await api(`threads/${encodeURIComponent(key)}?offset=${threadOffset}&limit=20`)
    if (thread !== key || request !== threadSequence) return
    const root = $('thread-detail'); root.replaceChildren(text('h2', '会话历史'), text('small', key))
    root.append(button('收起会话', () => { thread = undefined; threadSequence++; root.replaceChildren() }))
    if (data.thread.subscriptions.length) {
      root.append(text('h3', '订阅工单'))
      for (const id of data.thread.subscriptions) root.append(button('查看工单', () => openTicket(id)))
      root.append(button('停止此会话的全部订阅', async () => { if (!confirm('停止这些工单接收此会话的后续输入？已获得的授权不会因此扩大。')) return; await api(`threads/${encodeURIComponent(key)}/subscriptions`, 'DELETE'); await loadThread() }))
    }
    root.append(text('h3', '输入与评估（最新在前）'))
    const timeline = [...data.triggers.map(value => ({ value, kind: 'triggers' })), ...data.decisions.map(value => ({ value, kind: 'decisions' }))]
    timeline.sort((a, b) => b.value.at.localeCompare(a.value.at) || b.value.id.localeCompare(a.value.id))
    for (const { value, kind } of timeline) root.append(card(value, kind))
    root.append(text('small', `会话共 ${data.total} 条输入`))
    if (threadOffset) root.append(button('较新记录', async () => { threadOffset = Math.max(0, threadOffset - 20); await loadThread() }))
    if (threadOffset + 20 < data.total || data.decisions.length === 20) root.append(button('更早记录', async () => { threadOffset += 20; await loadThread() }))
  }
  async function openThread(key) { thread = key; threadOffset = 0; showView('records'); await loadThread(); $('thread-detail').scrollIntoView({ block: 'start' }) }
  $('record-kind').onchange = safe(async () => { offset = 0; await load() })
  $('record-previous').onclick = safe(async () => { offset = Math.max(0, offset - 50); await load() })
  $('record-next').onclick = safe(async () => { offset += 50; await load() })
  let searchSequence = 0
  $('global-search').onsubmit = event => { event.preventDefault(); safe(async () => {
    const request = ++searchSequence, rows = await api('search?q=' + encodeURIComponent($('global-query').value))
    if (request !== searchSequence) return
    $('search-results').replaceChildren(text('h2', '搜索结果'), button('关闭搜索结果', () => { searchSequence++; $('search-results').replaceChildren() }), ...rows.map(r => button(`${{ ticket: '工单', trigger: '输入', thread: '会话' }[r.kind]} · ${r.title}`, async () => {
      if (r.kind === 'ticket') await openTicket(r.id)
      else if (r.kind === 'thread') await openThread(r.id)
      else {
        const request = await api('requests/' + encodeURIComponent(r.id))
        if (request.threadKeys.length) await openThread(request.threadKeys[0])
        else { thread = undefined; threadSequence++; showView('records'); $('thread-detail').replaceChildren(text('h2', '输入详情'), card(request, 'triggers'), text('p', '此输入未加入会话。')) }
      }
    })))
    if (!rows.length) $('search-results').append(text('p', '没有匹配记录。'))
    if (rows.length === 50) $('search-results').append(text('p', '显示前 50 项，请缩小搜索范围。'))
  })() }
  return { load, openThread, reset() { offset = 0; snapshot = undefined }, clear() { offset = 0; thread = snapshot = undefined; sequence++; threadSequence++; searchSequence++; $('search-results').replaceChildren(); $('thread-detail').replaceChildren(); $('record-cards').replaceChildren(); $('records').textContent = '' } }
}
