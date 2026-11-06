import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceSchema, type WorkspaceConfig } from './config.js'
const exec = promisify(execFile)
export interface Gitlink { path: string; commit: string }
export interface RepositoryInfo { id: string; path: string; source: string; commonDir: string; head: string; dirty: boolean; gitlinks: Gitlink[] }
export interface Discovery { root: string; repositories: RepositoryInfo[]; unavailable: Array<{ path: string; reason: string }> }
export async function repositoryGit(cwd: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')))
  return (await exec('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' } })).stdout.trimEnd()
}
/** Reject symlink path components, even when a link happens to point back inside the root. */
export function memberPath(root: string, path: string, allowMissing = false): string {
  WorkspaceSchema.parse({ repositories: [{ id: 'path', path }] })
  let current = resolve(root)
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('Workspace root must not be a symlink')
  for (const part of path === '.' ? [] : path.split('/')) {
    current = join(current, part)
    if (existsSync(current)) { if (lstatSync(current).isSymbolicLink()) throw Error('Workspace path must not contain symlinks') }
    else if (!allowMissing) throw Error(`Workspace member missing: ${path}`)
  }
  return current
}
export async function gitlinks(source: string, ref = 'HEAD'): Promise<Gitlink[]> {
  const entries = (await repositoryGit(source, 'ls-tree', '-rz', ref)).split('\0').filter(Boolean)
  const links = entries.filter(e => e.startsWith('160000 ')).map(e => { const tab = e.indexOf('\t'); return { path: e.slice(tab + 1), commit: e.slice(0, tab).split(' ')[2] } })
  if (links.length > 256) throw Error('Gitlink metadata budget exceeded')
  for (const link of links) WorkspaceSchema.parse({ repositories: [{ id: 'link', path: link.path }] })
  return links
}
export async function inspectMember(root: string, member: { id: string; path: string }): Promise<RepositoryInfo> {
  const source = memberPath(root, member.path)
  if (!existsSync(join(source, '.git')) || lstatSync(join(source, '.git')).isSymbolicLink()) throw Error('Not a repository root')
  if (realpathSync(await repositoryGit(source, 'rev-parse', '--show-toplevel')) !== realpathSync(source)) throw Error('Not a repository root')
  const head = await repositoryGit(source, 'rev-parse', '--verify', 'HEAD').catch(() => { throw Error('missing-head') })
  return { ...member, source: realpathSync(source), head, commonDir: realpathSync(await repositoryGit(source, 'rev-parse', '--path-format=absolute', '--git-common-dir')), dirty: Boolean(await repositoryGit(source, 'status', '--porcelain', '--untracked-files=normal')), gitlinks: await gitlinks(source, head) }
}
export async function validateWorkspace(root: string, input: unknown): Promise<RepositoryInfo[]> {
  const workspace = WorkspaceSchema.parse(input)
  root = realpathSync(root)
  const members = await Promise.all(workspace.repositories.map(m => inspectMember(root, m)))
  if (new Set(members.map(m => m.commonDir)).size !== members.length) throw Error('Duplicate repository common-dir in workspace')
  for (const child of members) {
    const parents = members.filter(p => p !== child && (p.path === '.' || child.path.startsWith(p.path + '/'))).sort((a, b) => b.path.length - a.path.length)
    const parent = parents[0]; if (!parent) continue
    const path = relative(parent.source, child.source).split(sep).join('/')
    const entry = await repositoryGit(parent.source, 'ls-tree', '-z', parent.head, '--', path)
    if (entry && !entry.startsWith('160000 ')) throw Error(`Workspace overlap with parent-tracked files: ${child.path}`)
    if (parent.gitlinks.some(l => path.startsWith(l.path + '/'))) throw Error(`Select the intermediate gitlink repository before ${child.path}`)
  }
  return members.sort((a, b) => a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path, 'en'))
}
export function repositoryMember(path: string): { id: string; path: string } {
  return { id: (basename(path === '.' ? 'root' : path).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'repo') + '-' + createHash('sha256').update(path).digest('hex').slice(0, 8), path }
}
const skipped = new Set(['node_modules', 'target', 'dist', 'build', 'vendor', '__pycache__'])
export async function discoverWorkspace(directory: string, budget: { maxDirectories?: number; maxDepth?: number } = {}): Promise<Discovery> {
  const root = realpathSync(resolve(directory)), result: Discovery = { root, repositories: [], unavailable: [] }
  let visited = 0
  const walk = async (path: string, depth: number) => {
    if (++visited > (budget.maxDirectories ?? 3000) || depth > (budget.maxDepth ?? 8)) throw Error('Workspace discovery budget exceeded; select a narrower root or explicit members')
    const full = memberPath(root, path)
    if (existsSync(join(full, '.git'))) {
      const { id } = repositoryMember(path)
      let info: RepositoryInfo
      try { info = await inspectMember(root, { id, path }) }
      catch (error) { result.unavailable.push({ path, reason: (error as Error).message === 'missing-head' ? 'missing-head' : 'unreadable-repository' }); return }
      result.repositories.push(info)
      if (result.repositories.length > 32) throw Error('Workspace repository budget exceeded (32)')
      // A repository owns its ordinary source tree. Traverse gitlinks, not every source/dependency directory.
      for (const link of info.gitlinks) {
        const nested = path === '.' ? link.path : `${path}/${link.path}`
        const destination = memberPath(root, nested, true)
        if (existsSync(join(destination, '.git'))) await walk(nested, depth + link.path.split('/').length)
        else result.unavailable.push({ path: nested, reason: 'missing-checkout' })
      }
      return
    }
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || skipped.has(entry.name)) continue
      await walk(path === '.' ? entry.name : `${path}/${entry.name}`, depth + 1)
    }
  }
  await walk('.', 0)
  return result
}
export function workspaceConfig(members: RepositoryInfo[]): WorkspaceConfig { return { repositories: members.map(({ id, path }) => ({ id, path })) } }
