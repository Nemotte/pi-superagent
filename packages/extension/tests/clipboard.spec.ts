import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
const mod = await import('../src/clipboard.js').catch(() => ({} as any))
it('uses native clipboard commands without a shell or secret arguments', () => {
  expect(mod.clipboardCommand).toBeTypeOf('function')
  expect(mod.clipboardCommand('darwin', {})).toEqual({ file: 'pbcopy', args: [] })
  expect(mod.clipboardCommand('win32', {})).toEqual({ file: 'clip.exe', args: [] })
  expect(mod.clipboardCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ file: 'wl-copy', args: [] })
  expect(mod.clipboardCommand('linux', { DISPLAY: ':0' })).toEqual({ file: 'xclip', args: ['-selection', 'clipboard'] })
  expect(mod.clipboardCommand('linux', {})).toBeUndefined()
})
it('writes only to stdin, and keeps command failures private', async () => {
  expect(mod.copyText).toBeTypeOf('function')
  const value = 'fixture-private-token', hash = createHash('sha256').update(value).digest('hex')
  const args = ['-e', `const c=require('node:crypto').createHash('sha256');process.stdin.on('data',v=>c.update(v));process.stdin.on('end',()=>process.exit(c.digest('hex')==='${hash}'?0:1));`]
  expect(args.join(' ')).not.toContain(value)
  expect(await mod.copyText(value, { file: process.execPath, args })).toBe(true)
  expect(await mod.copyText(value, { file: process.execPath, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(1))'] })).toBe(false)
  expect(await mod.copyText(value, { file: 'pi-superagent-missing-clipboard-command', args: [] })).toBe(false)
})
