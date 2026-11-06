import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('../src/delivery.js').catch(() => ({} as any))
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))
it('recognizes persisted host background notices but not arbitrary custom entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-notice-')); dirs.push(dir); const path = join(dir, 'session.jsonl')
  const content = mod.encodeDelivery({ id: 'notice:1:0', text: 'Ticket ended' })
  writeFileSync(path, JSON.stringify({ type: 'custom', customType: 'superagent-notice', data: content }) + '\n' + JSON.stringify({ type: 'custom_message', customType: 'other', content }) + '\n')
  expect([...mod.persistedDeliveryIds(path)]).toEqual([])
  appendFileSync(path, JSON.stringify({ type: 'custom_message', customType: 'superagent-notice', content }) + '\n')
  expect([...mod.persistedDeliveryIds(path)]).toEqual(['notice:1:0'])
})
it('recognizes only stable IDs persisted in user messages, not queued messages or assistant quotations', () => {
  expect(mod.persistedDeliveryIds).toBeTypeOf('function')
  const dir = mkdtempSync(join(tmpdir(), 'pi-sa-delivery-')); dirs.push(dir); const path = join(dir, 'session.jsonl')
  expect([...mod.persistedDeliveryIds(path)]).toEqual([])
  const content = [{ type: 'text', text: mod.encodeDelivery({ id: 'input-1', text: 'request' }) }]
  writeFileSync(path, JSON.stringify({ type: 'message', message: { role: 'assistant', content } }) + '\n')
  expect([...mod.persistedDeliveryIds(path)]).toEqual([])
  appendFileSync(path, JSON.stringify({ type: 'message', message: { role: 'user', content } }) + '\n')
  expect([...mod.persistedDeliveryIds(path)]).toEqual(['input-1'])
  appendFileSync(path, '{"type":')
  expect([...mod.persistedDeliveryIds(path)]).toEqual(['input-1'])
})
