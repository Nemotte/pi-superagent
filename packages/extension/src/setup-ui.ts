import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { CURSOR_MARKER, Input, renderFakeCursor, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { openBrowser } from './browser.js'
import type { LoginUI } from './setup-rpc.js'
export function secretInput(ctx: ExtensionContext, title: string, signal: AbortSignal, manualCode = false): Promise<string | undefined> {
  if (ctx.mode !== 'tui') throw Error('私密输入需要 Pi 终端界面，请在终端运行 /superagent setup。')
  return ctx.ui.custom<string | undefined>((tui, _theme, keys, done) => {
    const input = new Input(); input.focused = true
    let confirming = false, closed = false
    const finish = (value?: string) => { if (!closed) { closed = true; done(value) } }
    const abort = () => finish()
    input.onSubmit = value => { if (!manualCode || value.trim()) finish(value) }
    input.onEscape = () => { if (manualCode) confirming = true; else finish() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) queueMicrotask(abort)
    return {
      get focused() { return input.focused }, set focused(value: boolean) { input.focused = value },
      handleInput(data: string) {
        if (closed) return
        if (confirming) {
          if (keys.matches(data, 'tui.select.cancel')) confirming = false
          else if (keys.matches(data, 'tui.input.submit') || data === '\n') finish()
        } else input.handleInput(data)
        tui.requestRender()
      },
      render(width: number) {
        if (width < 1) return []
        if (confirming) return ['确认取消登录？', 'Enter：取消登录 · Esc：返回等待'].map(line => truncateToWidth(line, width))
        const lines = manualCode ? ['等待浏览器登录完成；回调后自动继续。', '无需按 Esc。也可按下方说明粘贴授权码或回调地址。', ...wrapTextWithAnsi(title, width)] : [title]
        return [...lines.map(line => truncateToWidth(line, width)), '•'.repeat(Math.min([...input.getValue()].length, Math.max(0, width - 1))) + (input.focused ? CURSOR_MARKER + renderFakeCursor(' ') : ' '), truncateToWidth(manualCode ? 'Enter：提交已粘贴地址 · Esc：取消选项' : 'Enter 确认 · Esc 取消（不写入聊天记录）', width)]
      },
      invalidate() {},
      dispose() { closed = true; signal.removeEventListener('abort', abort); input.setValue('') },
    }
  })
}
export function loginUI(ctx: ExtensionContext, options: { openBrowser?: typeof openBrowser } = {}): LoginUI {
  const opened = new Set<string>()
  let disposed = false, links: string[] = [], progress = '', hint = '', activeUrl: string | undefined
  const show = () => { if (!disposed) ctx.ui.setWidget?.('superagent-login', [progress, ...links, hint].filter(Boolean)) }
  const open = (url: string) => {
    if (opened.has(url)) return
    opened.add(url); hint = '已请求打开浏览器；未弹出时请手动打开上方链接。'
    void Promise.resolve().then(() => disposed ? false : options.openBrowser ? options.openBrowser(url) : openBrowser(url)).catch(() => false).then(ok => {
      if (!disposed && activeUrl === url && !ok) { hint = '未能自动打开浏览器，请手动打开上方链接。'; show() }
    })
  }
  return {
    async prompt(prompt, signal) {
      if (prompt.type === 'secret' || prompt.type === 'manual_code') return secretInput(ctx, prompt.message, signal, prompt.type === 'manual_code')
      if (prompt.type === 'select') {
        const choices = prompt.options || []; const labels = choices.map(o => `${o.label} (${o.id})`)
        const answer = await ctx.ui.select(prompt.message, labels, { signal })
        return answer === undefined ? undefined : choices[labels.indexOf(answer)]?.id
      }
      return ctx.ui.input(prompt.message, prompt.placeholder, { signal })
    },
    notify(event) {
      if (disposed) return
      if (event.type === 'auth_url' && event.url) {
        activeUrl = event.url; links = [event.url, ...(event.instructions ? [event.instructions] : [])]; progress = '等待浏览器登录。远程登录未自动回调时，请在遮罩框粘贴最终回调地址。'; open(event.url)
      } else if (event.type === 'device_code' && event.verificationUri) {
        activeUrl = event.verificationUri; links = [event.verificationUri, `设备码：${event.userCode || ''}`]; progress = '在浏览器输入设备码并授权，完成后自动继续。'; open(event.verificationUri)
      } else {
        progress = [event.message, ...(event.links || []).map(l => `${l.label || ''} ${l.url}`)].filter(Boolean).join('\n')
      }
      show()
    },
    dispose() { disposed = true; opened.clear(); links = []; ctx.ui.setWidget?.('superagent-login', undefined) },
  }
}
