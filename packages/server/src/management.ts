import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { readConfig, readToken } from './config.js'
export const ManagementMode = z.enum(['local', 'token'])
export type ManagementMode = z.infer<typeof ManagementMode>
const schema = z.object({ schema: z.literal(1), mode: ManagementMode }).strict()
export function readManagement(stateDir: string): ManagementMode {
  try { return schema.parse(JSON.parse(readFileSync(join(stateDir, 'management.json'), 'utf8'))).mode }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'token'; throw error }
}
/** Offline, filesystem-authorized operation; never depends on a browser session or model credentials. */
export function configureManagement(stateDir: string, mode: ManagementMode, expectedId?: string): void {
  ManagementMode.parse(mode)
  const unlock = lockSync(stateDir, { stale: 30000 })
  const temp = join(stateDir, `management.${randomUUID()}.tmp`)
  try {
    const config = readConfig(stateDir)
    if (expectedId && config.instanceId !== expectedId) throw Error('Instance identity mismatch')
    if (mode === 'token') {
      if (!existsSync(join(stateDir, 'admin.token'))) writeFileSync(join(stateDir, 'admin.token'), randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' })
      readToken(stateDir)
    }
    writeFileSync(temp, JSON.stringify({ schema: 1, mode }) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, join(stateDir, 'management.json'))
  } finally { rmSync(temp, { force: true }); unlock() }
}
