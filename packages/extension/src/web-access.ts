import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { ApiError, type Client } from './client.js'
import { openBrowser } from './browser.js'
import { secretPanel } from './secret-panel.js'
export async function openWeb(ctx: ExtensionContext, client: Client, ui: { openBrowser?: (url: string) => Promise<boolean>; panel?: typeof secretPanel } = {}): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') throw Error('请在 Pi 终端运行 /superagent web；仅查看地址可用 /superagent web url。')
  let grant: { code?: string; expiresIn?: number }
  try {
    const status = await client.request('status') as { management?: string }
    if (status.management === 'local') {
      const opened = await (ui.openBrowser || openBrowser)(client.endpoint).catch(() => false)
      ctx.ui.notify(`${opened ? '已请求打开' : '请在浏览器打开'}本地 Web：${client.endpoint}`, 'info')
      return
    }
    grant = await client.request('login-grants', 'POST') as typeof grant
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw Error('当前服务尚未支持一键登录，请更新服务包后运行 /superagent restart，在插件内确认重启；暂不重启可用 /superagent token 复制令牌登录。')
    throw Error('无法为此实例建立 Web 登录，请检查服务连接、实例身份与权限；未自动启动或重启服务。')
  }
  if (!grant || typeof grant.code !== 'string' || !/^[\w-]{43}$/.test(grant.code) || grant.expiresIn !== 60) throw Error('服务返回了无效的 Web 登录授权。')
  const url = client.endpoint + '/#login=' + grant.code
  const opened = await (ui.openBrowser || openBrowser)(url).catch(() => false)
  if (!opened) await (ui.panel || secretPanel)(ctx, '请复制到浏览器打开（一次有效，授权 60 秒后到期）', url, { visible: true })
  else ctx.ui.notify(`已请求打开 Web 并自动登录：${client.endpoint}\n若未出现页面，请重新运行 /superagent web；管理令牌入口：/superagent token。`, 'info')
}
