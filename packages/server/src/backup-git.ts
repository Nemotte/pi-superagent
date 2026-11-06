import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Config } from './config.js'
import { repositoryGit as git } from './repositories.js'
import { BackupError, canonical, entrySchema, equal, relativeName, scan, stat, type Entry } from './backup-files.js'
const absolute = z.string().min(1).max(4096)
const repositorySchema = z.object({ source: absolute, commonDir: absolute }).strict()
const worktreeSchema = z.object({ path: relativeName, source: absolute, gitDir: absolute, branch: z.string().regex(/^refs\/heads\/pi-superagent\/[a-zA-Z0-9_-]{1,100}$/), head: z.string().regex(/^[0-9a-f]{40,64}$/), entries: z.array(entrySchema).max(100000) }).strict()
export const gitSchema = z.object({ repositories: z.array(repositorySchema).min(1).max(32), worktrees: z.array(worktreeSchema).max(10000) }).strict()
export type GitSnapshot = z.infer<typeof gitSchema>
async function repositories(config: Config) {
  const sources = config.workspace ? config.workspace.repositories.map(m => join(config.repository, m.path)) : [config.repository]
  const result = []
  for (const path of sources) {
    const source = await canonical(path)
    if (await canonical(await git(source, 'rev-parse', '--show-toplevel')) !== source) throw new BackupError('BACKUP_GIT_CHANGED')
    result.push({ source, commonDir: await canonical(await git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir')) })
  }
  return result
}
async function administration(gitDir: string): Promise<Entry[]> {
  const entries = await scan(gitDir)
  if (entries.some(e => e.kind === 'symlink' || e.path.endsWith('.lock'))) throw new BackupError('BACKUP_GIT_CHANGED')
  return entries
}
export async function captureGit(state: string, config: Config, entries: Entry[]): Promise<GitSnapshot> {
  try {
    const repos = await repositories(config), worktrees: GitSnapshot['worktrees'] = []
    for (const file of entries.filter(e => e.path.startsWith('work/') && e.path.endsWith('/.git'))) {
      if (file.kind === 'directory') continue // Standalone nested repositories are contained in the snapshot.
      if (file.kind !== 'file' || file.size > 8192) throw new BackupError('BACKUP_GIT_CHANGED')
      const work = file.path.slice(0, -5), ticketId = work.split('/')[1]
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ticketId)) throw new BackupError('BACKUP_GIT_CHANGED')
      const pointer = (await readFile(join(state, file.path), 'utf8')).trim()
      if (!pointer.startsWith('gitdir: ')) throw new BackupError('BACKUP_GIT_CHANGED')
      const gitDir = await canonical(resolve(state, work, pointer.slice(8)))
      const repo = repos.find(r => gitDir === join(r.commonDir, 'worktrees', basename(gitDir)))
      if (!repo || await canonical((await readFile(join(gitDir, 'gitdir'), 'utf8')).trim()) !== join(state, file.path)) throw new BackupError('BACKUP_GIT_CHANGED')
      const branch = await git(repo.source, `--git-dir=${gitDir}`, 'symbolic-ref', 'HEAD'), head = await git(repo.source, `--git-dir=${gitDir}`, 'rev-parse', '--verify', 'HEAD')
      if (branch !== `refs/heads/pi-superagent/${ticketId}` || worktrees.some(w => w.gitDir === gitDir)) throw new BackupError('BACKUP_GIT_CHANGED')
      worktrees.push({ path: work, source: repo.source, gitDir, branch, head, entries: await administration(gitDir) })
    }
    return gitSchema.parse({ repositories: repos, worktrees })
  } catch { throw new BackupError('BACKUP_GIT_CHANGED') }
}
export async function verifyGit(snapshot: GitSnapshot, config: Config, origin: string): Promise<void> {
  try {
    if (!equal(await repositories(config), snapshot.repositories)) throw new BackupError('BACKUP_GIT_CHANGED')
    for (const w of snapshot.worktrees) {
      const repo = snapshot.repositories.find(r => r.source === w.source)
      if (!repo || w.gitDir !== join(repo.commonDir, 'worktrees', basename(w.gitDir)) || await canonical(w.gitDir) !== w.gitDir || !(await stat(w.gitDir))?.isDirectory()) throw new BackupError('BACKUP_GIT_CHANGED')
      if (await canonical((await readFile(join(w.gitDir, 'gitdir'), 'utf8')).trim()) !== join(origin, w.path, '.git')) throw new BackupError('BACKUP_GIT_CHANGED')
      if (!equal(await administration(w.gitDir), w.entries) || await git(w.source, `--git-dir=${w.gitDir}`, 'symbolic-ref', 'HEAD') !== w.branch || await git(w.source, `--git-dir=${w.gitDir}`, 'rev-parse', '--verify', 'HEAD') !== w.head) throw new BackupError('BACKUP_GIT_CHANGED')
      await git(w.source, 'cat-file', '-e', `${w.head}^{commit}`)
    }
  } catch { throw new BackupError('BACKUP_GIT_CHANGED') }
}
