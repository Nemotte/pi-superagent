import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { repositoryGit as git } from './repositories.js'
export async function prepareWorktree(repository: string, directory: string, ticketId: string, options: { ref?: string; allowEmpty?: boolean } = {}): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(ticketId)) throw Error('Invalid ticket ID')
  const branch = `pi-superagent/${ticketId}`
  const common = await realpath(await git(repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw Error('Worktree directory must not be a symlink')
  if (existsSync(directory) && !(options.allowEmpty && readdirSync(directory).length === 0)) {
    const existing = await realpath(await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    if (existing !== common || await git(directory, 'branch', '--show-current') !== branch) throw Error('Worktree belongs to a different repository or ticket')
    return
  }
  await mkdir(dirname(directory), { recursive: true })
  const exists = await git(repository, 'show-ref', '--verify', `refs/heads/${branch}`).then(() => true, () => false)
  await git(repository, 'worktree', 'add', ...(exists ? [directory, branch] : ['-b', branch, directory, options.ref || 'HEAD']))
}
