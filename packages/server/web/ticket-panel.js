const labels = { answer: '需要回答', delivery: '投递失败', blocked: '需要解除阻塞', failed: '执行失败', review: '等待审阅', queued: '等待执行', working: '正在执行', idle: '等待新输入', completed: '已完成', merged: '已合并', closed: '已关闭', stopped: '已停止', dropped: '已结束（无需继续）' }
export const stageLabel = ticket => labels[ticket.ended?.outcome || ticket.stage?.action || ticket.stage?.stage || ticket.assignments?.at(-1)?.report?.state] || '等待执行'

export function createTicketPanel({ $, api, text, button, safe, renderWorkspace, refresh, openThread }) {
  let selected, sequence = 0, offset = 0, snapshot, messagesSnapshot
  const drafts = new Map()
  function scaffold(id) {
    const root = $('detail'); root.replaceChildren()
    for (const name of ['ticket-summary', 'ticket-actions', 'conversation']) { const el = document.createElement('section'); el.id = name; root.append(el) }
    const form = document.createElement('form'); form.id = 'followup-form'
    const label = text('label', '补充要求或回答问题'), input = document.createElement('textarea'); input.id = 'followup-text'; input.required = true; input.maxLength = 20000
    input.value = drafts.get(id)?.text || ''; label.append(input)
    const submit = text('button', '发送跟进'), feedback = text('p', ''); feedback.setAttribute('role', 'status'); let busy = false
    input.oninput = () => drafts.set(id, { id: crypto.randomUUID(), text: input.value })
    form.append(label, submit, feedback)
    form.onsubmit = event => { event.preventDefault(); safe(async () => {
      if (busy || !input.value.trim()) return
      busy = true; input.disabled = submit.disabled = true
      const pending = drafts.get(id)?.text === input.value ? drafts.get(id) : { id: crypto.randomUUID(), text: input.value }; drafts.set(id, pending)
      feedback.textContent = '正在发送…'
      try {
        await api(`tickets/${encodeURIComponent(id)}/followup`, 'POST', pending, AbortSignal.timeout(10000))
        drafts.delete(id); input.value = ''; feedback.textContent = '补充已接收。'
        // A later status failure does not invalidate the durable acknowledgement.
        if (selected === id) void update().catch(e => { $('error').textContent = e.message })
      } catch (e) { feedback.textContent = `发送结果未确认：${e.message}。草稿已保留，再次发送会复用请求编号。` }
      finally { busy = false; input.disabled = submit.disabled = false }
    })() }
    root.append(form)
    const repositories = document.createElement('section'); repositories.id = 'ticket-workspace'
    const diagnostic = document.createElement('pre'); diagnostic.id = 'diagnostics'
    const extra = document.createElement('details'); extra.append(text('summary', '授权、分派与诊断'))
    const metadata = document.createElement('section'); metadata.id = 'ticket-metadata'
    extra.append(metadata, button('运行诊断', async () => { diagnostic.textContent = JSON.stringify(await api(`tickets/${encodeURIComponent(id)}/diagnostics`), null, 2) }), diagnostic)
    const raw = document.createElement('details'); raw.append(text('summary', '完整工单 / 审计')); const pre = text('pre', ''); pre.id = 'ticket-raw'; raw.append(pre); extra.append(raw)
    root.append(button('仓库变更与验证', async () => renderWorkspace(repositories, await api(`tickets/${encodeURIComponent(id)}/workspace`))), repositories, extra)
  }
  async function update() {
    if (!selected) return
    const id = selected, request = ++sequence, path = `tickets/${encodeURIComponent(id)}`
    const [ticket, messages] = await Promise.all([api(path), api(`${path}/conversation?offset=${offset}&limit=50`)])
    if (selected !== id || request !== sequence) return
    const next = JSON.stringify(ticket)
    if (next !== snapshot) {
      snapshot = next
      const summary = $('ticket-summary'); summary.replaceChildren(text('h2', ticket.title), text('strong', stageLabel(ticket)))
      if (ticket.attention?.question) summary.append(text('p', '需要你回答：' + ticket.attention.question))
      if (ticket.latestReport) summary.append(text('h3', '最新进展 / 结果'), text('p', ticket.latestReport.summary))
      const controls = $('ticket-actions'); controls.replaceChildren()
      for (const [label, action] of [['停止', 'stop'], ['重试', 'retry']]) if (ticket.actions?.[action]) controls.append(button(label, async () => {
        if (!confirm(`${label}“${ticket.title}”？`)) return
        await api(`${path}/${action}`, 'POST'); if (selected === id) await update(); await refresh()
      }))
      $('followup-form').hidden = ticket.actions?.followup === false
      const metadata = $('ticket-metadata'); metadata.replaceChildren(text('h3', '授权范围'), text('p', ticket.mandate.scope), text('small', `策略版本：${ticket.mandate.policyVersion}`))
      for (const a of ticket.assignments) metadata.append(text('p', `${a.createdAt} · ${a.state === 'running' ? '执行中' : a.state === 'pending' ? '等待执行' : '本次执行已结束'}${a.report ? ' · ' + a.report.summary : ''}`))
      for (const channel of ticket.channels || []) metadata.append(button('查看来源会话', () => openThread(`${channel.source}:${channel.source === 'manual' ? channel.thread : channel.thread.replace(/^github:/, '')}`)))
      $('ticket-raw').textContent = JSON.stringify(ticket, null, 2)
    }
    const messageSnapshot = JSON.stringify(messages)
    if (messageSnapshot !== messagesSnapshot) {
      messagesSnapshot = messageSnapshot
      const root = $('conversation'); root.replaceChildren(text('h3', '沟通记录'))
      if (!messages.items.length) root.append(text('p', '尚无消息。'))
      for (const message of messages.items) {
        const card = text('article', ''); card.className = 'message ' + message.role
        const state = { received: '已接收', pending: '待发送', sent: '已送达', dropped: '未送达，已停止投递' }[message.status] || message.status
        card.append(text('small', `${message.role === 'router' ? 'Router' : '收到的输入'} · ${state} · ${message.at}`), text('p', message.text)); root.append(card)
      }
      root.append(text('small', `显示 ${messages.items.length} / ${messages.total} 条消息`))
      if (offset + 50 < messages.total) root.append(button('更早消息', async () => { offset += 50; await update() }))
      if (offset) root.append(button('较新消息', async () => { offset = Math.max(0, offset - 50); await update() }))
    }
  }
  return {
    async open(id) { if (id !== selected) { selected = id; offset = 0; snapshot = messagesSnapshot = undefined; scaffold(id) } await update() },
    update,
    clear() { selected = undefined; sequence++; drafts.clear(); $('detail').replaceChildren(text('p', '选择工单查看详情。')) },
  }
}
