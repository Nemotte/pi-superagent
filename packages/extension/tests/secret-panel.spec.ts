import { expect, it, vi } from 'vitest'
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui'
const mod = await import('../src/secret-panel.js').catch(() => ({} as any))
function terminal() {
  let component: any
  const ctx = { hasUI: true, mode: 'tui', ui: { notify: vi.fn(), custom: (factory: any) => new Promise<void>(resolve => {
    component = factory({ requestRender: vi.fn() }, {}, getKeybindings(), () => { component?.dispose(); resolve() })
  }) } }
  return { ctx, component: () => component }
}
it('reveals and copies only in an explicit private panel, then clears its display', async () => {
  expect(mod.secretPanel).toBeTypeOf('function')
  const f = terminal(), value = 'private-token-for-panel', copy = vi.fn(async () => true)
  const pending = mod.secretPanel(f.ctx, '管理员令牌', value, { copy })
  expect(f.component().render(80).join('\n')).not.toContain(value)
  f.component().handleInput('v'); expect(f.component().render(80).join('\n')).toContain(value)
  expect(f.component().render(12).every((line: string) => visibleWidth(line) <= 12)).toBe(true)
  f.component().handleInput('v'); expect(f.component().render(80).join('\n')).not.toContain(value)
  f.component().handleInput('c'); await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(value))
  expect(f.ctx.ui.notify).not.toHaveBeenCalled()
  f.component().handleInput('\x1b'); expect(await pending).toBeUndefined()
  expect(f.component().render(80).join('\n')).not.toContain(value)
  f.component().handleInput('v'); f.component().handleInput('c'); expect(copy).toHaveBeenCalledTimes(1)
})
it('sanitizes clipboard failures and refuses RPC or non-interactive secret display', async () => {
  expect(mod.secretPanel).toBeTypeOf('function')
  const f = terminal(), pending = mod.secretPanel(f.ctx, '管理员令牌', 'fixture-secret', { copy: async () => { throw Error('private stderr fixture-secret') } })
  f.component().handleInput('c'); await vi.waitFor(() => expect(f.component().render(80).join('\n')).toContain('复制失败'))
  expect(f.component().render(80).join('\n')).not.toContain('fixture-secret')
  f.component().handleInput('\x1b'); await pending
  await expect(mod.secretPanel({ ...f.ctx, mode: 'rpc' }, 'secret', 'fixture-secret')).rejects.toThrow(/终端/)
})
it('closes transient secrets automatically and disposes the timer', async () => {
  expect(mod.secretPanel).toBeTypeOf('function'); vi.useFakeTimers()
  try {
    const f = terminal(), pending = mod.secretPanel(f.ctx, 'Login link', 'one-use-code', { visible: true })
    expect(f.component().render(80).join('\n')).toContain('one-use-code')
    await vi.advanceTimersByTimeAsync(60000); await pending
    expect(f.component().render(80).join('\n')).not.toContain('one-use-code'); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
