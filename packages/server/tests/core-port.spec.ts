import { expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
it('vendors the host-independent domain with the upstream license', () => {
  const root = resolve('packages/server/src/core')
  expect(existsSync(root), 'The domain core must be present in the published service').toBe(true)
  for (const file of readdirSync(root).filter(name => name.endsWith('.ts'))) {
    expect(readFileSync(resolve(root, file), 'utf8')).not.toContain('@deepseek-ai/')
  }
  expect(readFileSync('packages/server/THIRD_PARTY_NOTICES.md', 'utf8')).toContain('6337fc823ce20251c8de8085948165c81aaa701e')
})
