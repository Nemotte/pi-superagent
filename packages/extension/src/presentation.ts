type Row = Record<string, any>
const clean = (value: unknown, limit = 800) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit)
export function taskLabel(row: Row): string {
  const value = row.ended?.outcome || row.stage?.action || row.stage?.stage || row.assignments?.at(-1)?.report?.state || 'queued'
  return ({ completed: '已完成', stopped: '已停止', merged: '已合并', closed: '已关闭', dropped: '已结束', responded: '补充已接收，待处理', answer: '需要回答', review: '等待审阅', delivery: '投递失败', blocked: '需要解除阻塞', failed: '执行失败', working: '执行中', progress: '执行中', waiting: '等待输入', idle: '等待输入', ready: '等待审阅', queued: '等待执行' } as Record<string, string>)[value] || clean(value)
}
export function present(action: string, value: unknown): string {
  const row = (value || {}) as Row
  if (row.cancelled) return '已取消，未执行操作。'
  if (['request', 'followup'].includes(action) && typeof row.id !== 'string') return '提交结果未确认：服务未返回请求编号。请先在 Web 输入记录中核对。'
  if (action === 'web') return `Web：${clean(row.webUrl)}`
  if (action === 'status') {
    const setup = row.modelsConfigured === false || row.readiness?.state === 'setup'
    return `${setup ? '模型未配置完整 · /superagent models' : row.paused ? '派单已暂停' : '派单已开启'}\n工单 ${row.tickets ?? 0} · 执行中 ${row.busyWorkers ?? 0} · 待你处理 ${row.needsAttention ?? 0}\n${row.supervision?.kind === 'systemd-user' ? 'systemd 用户托管 · /superagent service status' : '独立后台进程（无自动恢复）'}\nWeb：${clean(row.webUrl)}`
  }
  if (action === 'request' || action === 'followup') return `${action === 'request' ? '请求已接收，等待 Router 评估。' : '补充已接收。'}\n编号：${clean(row.id)}\n/superagent web 查看输入、工单和回复。`
  if (['show', 'stop', 'retry'].includes(action)) return `${clean(row.title || row.id, 160)} · ${taskLabel(row)}\n${clean((row.attentionResponse ? '补充已接收，等待 Worker 处理。' : row.attention?.question) || row.latestReport?.summary || row.assignments?.at(-1)?.report?.summary || row.mandate?.scope)}\n工单：${clean(row.id)}`
  if (action === 'tickets') {
    const rows = Array.isArray(value) ? value : []
    return rows.length ? rows.slice(0, 20).map(t => `${taskLabel(t)} · ${clean(t.title, 100).replace(/\n/g, ' ')}\n  ${clean(t.id, 64)}`).join('\n') + '\n/superagent web 查看全部工单和沟通记录。' : '还没有工单。已提交的输入可在 Web“输入”页查看，接单后出现在这里。'
  }
  if (action === 'workspace') return `工作区：${clean(row.root)}\n${(row.repositories || []).slice(0, 32).map((r: Row) => `· ${clean(r.path, 200)}${r.changed ? '（有任务变更）' : ''}`).join('\n')}`
  if (action === 'sources') return (Array.isArray(value) ? value : []).map(s => `${s.id === 'manual' ? '本地需求' : clean(s.id)}：${({ ready: '接收就绪', disabled: '未启用', deferred: '暂未接入', error: '需要检查' } as Record<string, string>)[s.state] || clean(s.state)}`).join('\n')
  return clean(JSON.stringify(value, null, 2), 4000)
}
