import { expect, it, vi } from 'vitest'
const mod = await import('../src/browser.js').catch(() => ({} as any))
it('uses platform opener argument arrays without a shell and rejects unsafe URLs', () => {
  expect(mod.browserCommand).toBeTypeOf('function')
  const url = 'https://auth.example.com/login?state=test&originator=Pi%20Super-agent'
  expect(mod.browserCommand(url, 'linux')).toEqual({ file: 'xdg-open', args: [url] })
  expect(mod.browserCommand(url, 'darwin')).toEqual({ file: 'open', args: [url] })
  expect(mod.browserCommand(url, 'win32')).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] })
  for (const bad of ['file:///tmp/private', 'javascript:alert(1)', 'https://user:secret@example.com', '--flag']) expect(() => mod.browserCommand(bad, 'linux')).toThrow()
})
it('returns opener failure without exposing errors or retrying it', async () => {
  expect(mod.openBrowser).toBeTypeOf('function')
  const run = vi.fn(async () => { throw Error('private reflected argument') })
  expect(await mod.openBrowser('https://auth.example.com', run)).toBe(false); expect(run).toHaveBeenCalledTimes(1)
})
