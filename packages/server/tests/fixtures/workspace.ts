import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'Workspace Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Workspace Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
}
export function repository(path: string, files: Record<string, string> = { 'README.md': 'initial\n' }): string {
  mkdirSync(path, { recursive: true }); git(path, 'init')
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(path, name, '..'), { recursive: true }); writeFileSync(join(path, name), text) }
  git(path, 'add', '.'); git(path, 'commit', '-m', 'initial'); return git(path, 'rev-parse', 'HEAD')
}
export function nestedWorkspace(root: string) {
  const front = join(root, 'frontends', 'portal'), back = join(root, 'backend'), child = join(back, 'exam')
  repository(front, { 'README.md': 'frontend\n', 'AGENTS.md': 'Frontend: preserve API compatibility.' })
  repository(back, { 'pom.xml': '<project/>\n', 'AGENTS.md': 'Backend: validate contracts.' })
  const recorded = repository(child, { 'README.md': 'exam\n', 'CLAUDE.md': 'Exam: validate responses.' })
  git(back, 'update-index', '--add', '--cacheinfo', `160000,${recorded},exam`)
  git(back, 'update-index', '--add', '--cacheinfo', `160000,${recorded},missing-service`)
  git(back, 'commit', '-m', 'gitlinks without gitmodules')
  writeFileSync(join(child, 'README.md'), 'new exam head\n'); git(child, 'add', '.'); git(child, 'commit', '-m', 'child advances independently')
  writeFileSync(join(root, 'AGENTS.md'), 'Workspace: coordinate frontend and backend.')
  return { front, back, child, recorded, members: [{ id: 'portal', path: 'frontends/portal' }, { id: 'backend', path: 'backend' }, { id: 'exam', path: 'backend/exam' }] }
}
