import { expect, it, vi } from 'vitest'
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui'
const mod = await import('../src/setup-ui.js').catch(() => ({} as any))
function terminal() {
  let component: any
  const widgets = new Map<string, unknown>()
  const ctx = { mode: 'tui', ui: {
    notify: vi.fn(), setWidget: vi.fn((key: string, value: unknown) => widgets.set(key, value)),
    custom: (factory: any) => new Promise(resolve => { component = factory({ requestRender: vi.fn() }, {}, getKeybindings(), (value: unknown) => { resolve(value); component?.dispose?.() }) }),
  } }
  return { ctx, widgets, component: () => component }
}
it('opens each login URL once and retains a manual fallback until the login UI is disposed', async () => {
  const f = terminal(), openBrowser = vi.fn(async () => false), ui = mod.loginUI(f.ctx, { openBrowser })
  const event = { type: 'auth_url', url: 'https://auth.example.com/login?state=test', instructions: 'Complete login' }
  ui.notify(event); ui.notify(event)
  await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1))
  expect(JSON.stringify([...f.widgets.values()])).toContain(event.url)
  await vi.waitFor(() => expect(JSON.stringify([...f.widgets.values()])).toContain('手动'))
  ui.dispose(); expect(f.widgets.get('superagent-login')).toBeUndefined()
})
it('does not launch a queued opener after the login interaction is disposed', async () => {
  const f = terminal(), openBrowser = vi.fn(async () => true), ui = mod.loginUI(f.ctx, { openBrowser })
  ui.notify({ type: 'auth_url', url: 'https://auth.example.com/login' }); ui.dispose()
  await new Promise(resolve => setImmediate(resolve))
  expect(openBrowser).not.toHaveBeenCalled(); expect(f.widgets.get('superagent-login')).toBeUndefined()
})
it('does not turn an empty manual-code Enter or a single Escape into cancellation', async () => {
  const f = terminal(), controller = new AbortController(), ui = mod.loginUI(f.ctx)
  let finished = false
  const pending = ui.prompt({ type: 'manual_code', message: 'Browser callback' }, controller.signal).then((v: unknown) => { finished = true; return v })
  f.component().handleInput('\r'); await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false)
  f.component().handleInput('\x1b'); await new Promise(resolve => setImmediate(resolve)); expect(finished).toBe(false)
  expect(f.component().render(60).join('\n')).toContain('确认取消')
  f.component().handleInput('\x1b') // return to waiting
  const callback = 'http://localhost:1455/auth/callback?code=private-code&state=private-state'
  f.component().handleInput('\x1b[200~' + callback + '\x1b[201~')
  expect(f.component().render(32).join('\n')).not.toContain('private-code')
  expect(f.component().render(32).every((line: string) => visibleWidth(line) <= 32)).toBe(true)
  f.component().handleInput('\r'); expect(await pending).toBe(callback)
})
it('preserves provider-specific manual login instructions', async () => {
  const f = terminal(), controller = new AbortController(), ui = mod.loginUI(f.ctx)
  const pending = ui.prompt({ type: 'manual_code', message: 'Paste the authorization code from the provider' }, controller.signal)
  expect(f.component().render(80).join('\n')).toContain('Paste the authorization code from the provider')
  controller.abort(); await pending
})
it('confirms manual cancellation and closes an obsolete prompt when the SDK aborts it', async () => {
  const f = terminal(), ui = mod.loginUI(f.ctx), controller = new AbortController()
  const cancelled = ui.prompt({ type: 'manual_code', message: 'Callback' }, controller.signal)
  f.component().handleInput('\x1b'); f.component().handleInput('\r'); expect(await cancelled).toBeUndefined()
  const automatic = new AbortController()
  const pending = ui.prompt({ type: 'manual_code', message: 'Callback' }, automatic.signal)
  automatic.abort(); expect(await pending).toBeUndefined()
  expect(f.ctx.ui.notify).not.toHaveBeenCalled()
})
it('propagates focus and masks API keys without changing their Escape cancellation behavior', async () => {
  const f = terminal(), controller = new AbortController()
  const pending = mod.secretInput(f.ctx, 'API key', controller.signal)
  expect('focused' in f.component()).toBe(true)
  f.component().focused = true; f.component().handleInput('private-api-key')
  expect(f.component().render(40).join('\n')).not.toContain('private-api-key')
  f.component().handleInput('\x1b'); expect(await pending).toBeUndefined()
})
