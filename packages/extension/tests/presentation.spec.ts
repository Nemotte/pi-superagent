import { expect, it } from 'vitest'
const mod = await import('../src/presentation.js').catch(() => ({} as any))
it('summarizes setup, pause and counts without presenting protocol JSON as the user interface', () => {
  expect(mod.present).toBeTypeOf('function')
  const output = mod.present('status', { modelsConfigured: false, paused: true, tickets: 2, busyWorkers: 0, needsAttention: 0, webUrl: 'http://127.0.0.1:4317' })
  expect(output).toContain('模型未配置'); expect(output).toContain('/superagent models'); expect(output).toContain('2'); expect(output).not.toContain('"paused"')
})
it('distinguishes systemd registration from detached operation in the status summary', () => {
  expect(mod.present('status', { supervision: { kind: 'systemd-user' }, modelsConfigured: true, paused: true })).toContain('systemd 用户托管')
  expect(mod.present('status', { supervision: { kind: 'detached' } })).toContain('无自动恢复')
})
it('shows durable request receipts and bounded, terminal-safe task summaries', () => {
  expect(mod.present).toBeTypeOf('function')
  expect(mod.present('request', { id: 'manual:one' })).toContain('请求已接收')
  expect(mod.present('request', { cancelled: true })).toContain('已取消')
  expect(mod.present('request', {})).not.toContain('请求已接收')
  const output = mod.present('show', { id: 'one', title: '\u001b]52;c;payload\u0007', ended: { outcome: 'completed' }, latestReport: { summary: 'Useful result' } })
  expect(output).toContain('已完成'); expect(output).toContain('Useful result'); expect(output).not.toMatch(/[\u001b\u0007]/)
  expect(mod.present('tickets', Array.from({ length: 1000 }, (_, i) => ({ id: String(i), title: 'x'.repeat(500) })) ).length).toBeLessThan(4000)
})
