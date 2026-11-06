import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
/** Non-secret connection details survive setup errors; no network request or service startup. */
export function showConnection(ctx: ExtensionContext, webUrl: string, repository?: string): void {
  if (!ctx.hasUI) return
  ctx.ui.setStatus('superagent', `SA · ${webUrl}`)
  ctx.ui.setWidget?.('superagent-connection', [repository ? `Super-agent：${repository}` : 'Super-agent', `Web：${webUrl}`, '/superagent web 打开控制台 · /superagent 查看菜单'])
}
