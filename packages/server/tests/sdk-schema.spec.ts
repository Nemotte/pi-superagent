import { expect, it } from 'vitest'
import { validateToolArguments } from '@earendil-works/pi-ai'
import { hostTools } from '../src/agent-tools.js'
const tools = hostTools({ role: 'worker', key: 'worker' }, async () => ({}))
const validate = (name: string, args: Record<string, unknown>) => {
  const tool = tools.find(t => t.name === `superagent_${name}`)!
  return validateToolArguments(tool, { type: 'toolCall', id: 'fixture', name: tool.name, arguments: args })
}

it('keeps local tool enums, required fields and bounds under the SDK JSON Schema validator', () => {
  expect(validate('follow', { source: 'manual', id: 'thread', reason: 'Reference' }).source).toBe('manual')
  expect(() => validate('follow', { source: 'github', id: '1', reason: 'No capability' })).toThrow()
  expect(() => validate('report', { state: 'ready' })).toThrow()
  expect(() => validate('read', { kind: 'github_issue' })).toThrow()
  expect(() => validate('read', { limit: '51' })).toThrow()
  expect(() => validate('read', { offset: -1 })).toThrow()
})

it('accepts standard TypeBox unions and nested reports, coercing on a copy of the model arguments', () => {
  const args = { state: 'ready', summary: 'Checked', question: null, repositories: [{ id: 'frontend', summary: 'Changed', checks: ['node --test'] }] }
  expect(validate('report', args)).toEqual(args)
  const read = { kind: 'tickets', offset: '0', limit: '20' }
  expect(validate('read', read)).toEqual({ kind: 'tickets', offset: 0, limit: 20 })
  expect(read).toEqual({ kind: 'tickets', offset: '0', limit: '20' })
})
