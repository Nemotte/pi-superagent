import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { copyText } from './clipboard.js'
/** A transient command-only view, not a message, widget, editor buffer or tool result. */
export async function secretPanel(ctx: ExtensionContext, title: string, value: string, options: { visible?: boolean; copy?: (value: string) => Promise<boolean> } = {}): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== 'tui') throw Error('请在 Pi 终端界面中查看私密连接信息。')
  await ctx.ui.custom<void>((tui, _theme, keys, done) => {
    let visible = options.visible || false, closed = false, copying = false, status = '此面板将在 60 秒后关闭；复制后请妥善保管剪贴板内容。'
    const finish = () => { if (!closed) { clear(); done() } }
    const timer = setTimeout(finish, 60000); timer.unref?.()
    const clear = () => { closed = true; visible = false; value = ''; clearTimeout(timer) }
    return {
      handleInput(data: string) {
        if (closed) return
        if (keys.matches(data, 'tui.select.cancel')) { finish(); return }
        if (matchesKey(data, 'v')) visible = !visible
        if (matchesKey(data, 'c') && !copying) {
          copying = true; status = '正在复制…'
          void Promise.resolve().then(() => closed ? false : (options.copy || copyText)(value)).catch(() => false).then(ok => {
            if (closed) return
            copying = false; status = ok ? '已复制。请粘贴到目标登录框，使用后可自行清空剪贴板。' : '复制失败；可按 V 显示后手动选择复制。Linux 桌面可安装 xclip / wl-clipboard。'
            tui.requestRender()
          })
        }
        tui.requestRender()
      },
      render(width: number) {
        if (width < 1 || closed) return []
        return [title, ...(visible ? wrapTextWithAnsi(value, width) : ['••••••••••••']), ...wrapTextWithAnsi(status, width), 'V 显示/隐藏 · C 复制 · Esc 关闭'].map(line => truncateToWidth(line, width))
      },
      invalidate() {}, dispose: clear,
    }
  })
}
