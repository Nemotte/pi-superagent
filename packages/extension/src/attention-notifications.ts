interface AttentionRow { id: string; title: string; action: string; attentionId?: string; question?: string }
/** Reads an already available connection; never establishes SSH or starts services. */
export function attentionNotifier(notify: (text: string) => void, active = () => true) {
  const seen = new Set<string>()
  let reading = false
  return async (read: () => Promise<unknown>) => {
    if (reading || !active()) return
    reading = true
    try {
      const data = await read() as { tickets?: AttentionRow[]; scope?: string }
      if (!active() || !Array.isArray(data?.tickets)) return
      const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)
      for (const row of data.tickets) {
        if (row.action !== 'answer' || typeof row.id !== 'string' || typeof row.question !== 'string') continue
        const key = JSON.stringify([data.scope || '', row.attentionId || `${row.id}:${row.question}`])
        if (seen.has(key)) continue
        notify(`需要你确认 / 回答：${clean(row.title || row.id)}\n${clean(row.question)}\n查看并处理：/superagent show ${clean(row.id)}（或 /superagent web）`)
        seen.add(key)
        if (seen.size > 1000) seen.delete(seen.values().next().value!)
      }
    } catch { /* Offline connections are reported by explicit status/connect commands. */ }
    finally { reading = false }
  }
}
