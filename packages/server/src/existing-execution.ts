import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { captureWorkspace, type WorkspaceSnapshot } from './multi-workspace.js'
import { repositoryGit } from './repositories.js'
import type { Config } from './config.js'

export interface ExistingExecution {
  mode: 'existing'
  planId: string
  snapshot: WorkspaceSnapshot
  branches: Record<string, string>
  status: Record<string, string>
}
export async function existingExecutionPlan(config: Config, ticketId: string): Promise<ExistingExecution> {
  if (config.github?.enabled) throw Error('Existing execution supports manual/local tasks; disable the GitHub source first')
  const snapshot = await captureWorkspace(config.repository, config.workspace || { repositories: [{ id: 'repository', path: '.' }] })
  const branches: Record<string, string> = {}, status: Record<string, string> = {}
  for (const repo of snapshot.repositories) {
    const branch = await repositoryGit(repo.source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
    if (!branch) throw Error('Existing execution requires a named branch in every repository')
    branches[repo.id] = branch
    status[repo.id] = await repositoryGit(repo.source, 'status', '--porcelain=v1', '-z', '--untracked-files=normal')
  }
  const planId = createHash('sha256').update(JSON.stringify([config.instanceId, ticketId, snapshot, branches, status])).digest('hex')
  return { mode: 'existing', planId, snapshot, branches, status }
}
/** Shared Git common-dir locks serialize original-checkout execution across service instances. */
export function lockExistingExecution(plan: ExistingExecution): () => void {
  const releases: Array<() => void> = []
  try {
    for (const directory of [...new Set(plan.snapshot.repositories.map(r => r.commonDir))].sort()) {
      releases.push(lockSync(directory, { lockfilePath: join(directory, 'pi-superagent-existing.lock'), stale: 30000 }))
    }
  } catch {
    for (const release of releases.reverse()) release()
    throw Error('Existing workspace is busy; another task or service owns its execution lock')
  }
  return () => { for (const release of releases.reverse()) release() }
}
