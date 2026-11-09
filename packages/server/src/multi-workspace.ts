import { mkdirSync, realpathSync as fsRealpathSync, lstatSync } from 'node:fs'
const realpathSync = fsRealpathSync.native
import { relative, sep, dirname } from 'node:path'
import type { WorkspaceConfig } from './config.js'
import { memberPath, repositoryGit, validateWorkspace, type RepositoryInfo } from './repositories.js'
import { prepareWorktree } from './workspace.js'
import { repositoryFile } from './context.js'
export interface WorkspaceSnapshot { schema: 1; root: string; repositories: RepositoryInfo[]; instructions?: string }
export async function captureWorkspace(root: string, workspace: WorkspaceConfig): Promise<WorkspaceSnapshot> {
  root = realpathSync(root)
  const repositories = await validateWorkspace(root, workspace)
  let instructions: string | undefined
  if (!repositories.some(r => r.path === '.')) {
    try { instructions = repositoryFile(root, 'AGENTS.md') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (instructions && instructions.length > 32000) throw Error('Workspace AGENTS.md exceeds instruction budget')
  }
  return { schema: 1, root, repositories, ...(instructions ? { instructions } : {}) }
}
async function verifyWorktree(repo: RepositoryInfo, directory: string, ticketId: string, branches?: Record<string, string>): Promise<void> {
  const common = realpathSync(await repositoryGit(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  if (common !== repo.commonDir || await repositoryGit(directory, 'branch', '--show-current') !== (branches?.[repo.id] ?? `pi-superagent/${ticketId}`) || realpathSync(await repositoryGit(directory, 'rev-parse', '--show-toplevel')) !== realpathSync(directory)) throw Error('Worktree repository identity or branch changed')
}
export async function prepareWorkspace(snapshot: WorkspaceSnapshot, directory: string, ticketId: string): Promise<void> {
  if (lstatSync(dirname(directory), { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('Execution parent must not be a symlink')
  memberPath(directory, '.', true)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const repo of snapshot.repositories) {
    const target = memberPath(directory, repo.path, true)
    if (realpathSync(await repositoryGit(repo.source, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== repo.commonDir) throw Error('Workspace source repository identity changed')
    await repositoryGit(repo.source, 'cat-file', '-e', `${repo.head}^{commit}`)
    await prepareWorktree(repo.source, target, ticketId, { ref: repo.head, allowEmpty: true })
    await verifyWorktree(repo, target, ticketId)
  }
}
export async function workspaceStatus(snapshot: WorkspaceSnapshot, directory: string, ticketId: string, branches?: Record<string, string>) {
  return Promise.all(snapshot.repositories.map(async repo => {
    const target = memberPath(directory, repo.path)
    await verifyWorktree(repo, target, ticketId, branches)
    const [head, diff, untracked, index] = await Promise.all([
      repositoryGit(target, 'rev-parse', 'HEAD'),
      repositoryGit(target, 'diff', '--name-only', '-z', '--ignore-submodules=all', repo.head, '--'),
      repositoryGit(target, 'ls-files', '--others', '--exclude-standard', '-z'),
      repositoryGit(target, 'ls-files', '--stage', '-z'),
    ])
    const children = snapshot.repositories.filter(r => r !== repo && (repo.path === '.' || r.path.startsWith(repo.path + '/')))
    const childPaths = children.map(r => relative(repo.source, r.source).split(sep).join('/'))
    const ownFiles = [...diff.split('\0'), ...untracked.split('\0')].filter(p => p && !childPaths.some(c => p === c || p.startsWith(c + '/')))
    const links = new Map(index.split('\0').filter(e => e.startsWith('160000 ')).map(e => [e.slice(e.indexOf('\t') + 1), e.split(' ')[1]]))
    const originalLinks = new Map(repo.gitlinks.map(l => [l.path, l.commit]))
    const changedLinks = [...new Set([...originalLinks.keys(), ...links.keys()])].filter(path => links.get(path) !== originalLinks.get(path))
    const files = [...new Set([...ownFiles, ...changedLinks])].sort()
    const mounts = repo.gitlinks.flatMap(link => {
      const child = children.find(c => c.path === (repo.path === '.' ? link.path : `${repo.path}/${link.path}`))
      return child && child.head !== link.commit ? [{ path: link.path, recorded: link.commit, mounted: child.head }] : []
    })
    return { id: repo.id, path: repo.path, baseHead: repo.head, head, sourceDirty: repo.dirty, changed: head !== repo.head || files.length > 0, files: files.slice(0, 50).map(p => p.slice(0, 500)), files_total: files.length, mounts }
  }))
}
