import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'
import { createServer } from 'node:net'
import { Client, fromEnvironment, readManagement, optionalToken } from './client.js'
import { remotePath, validateSsh, type SshTarget } from './ssh.js'
const exec = promisify(execFile)
export interface Binding { project: string; repository: string; stateDir: string; instanceId: string; ssh?: SshTarget & { port: number } }
export function sshBinding(binding: Binding): Binding & { ssh: SshTarget & { port: number } } {
  if (!binding.ssh || !Number.isInteger(binding.ssh.port) || binding.ssh.port < 1024 || binding.ssh.port > 65535 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(binding.instanceId)) throw Error('Invalid SSH instance binding')
  return { project: binding.project, repository: remotePath(binding.repository), stateDir: remotePath(binding.stateDir), instanceId: binding.instanceId, ssh: { ...validateSsh(binding.ssh), port: binding.ssh.port } }
}
export interface Instance { schema: number; instanceId: string; repository: string; port: number; workspace?: { repositories: Array<{ id: string; path: string }> } | null }
export const connectionsDir = () => join(homedir(), '.pi-superagent', 'connections')
export const canonical = (path: string) => realpathSync(resolve(path))
export const pathKey = (path: string) => createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 24)
export function suggestedStateDir(repository: string): string { return join(homedir(), '.pi-superagent', `${basename(repository).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 40) || 'project'}-${pathKey(repository).slice(0, 8)}`) }
async function git(path: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return (await exec('git', ['-C', path, '-c', 'core.fsmonitor=false', ...args], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim()
}
export async function projectPath(cwd: string): Promise<string> {
  return canonical(await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => cwd))
}
export async function privateStatePath(path: string): Promise<string> {
  let parent = resolve(path); const suffix: string[] = []
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) throw Error('无法访问实例目录所在的磁盘或父目录。')
    suffix.unshift(basename(parent)); parent = next
  }
  parent = canonical(parent)
  if (await git(parent, ['rev-parse', '--is-inside-work-tree']).catch(() => '') === 'true') throw Error('实例包含凭据，请选择 Git 仓库外的数据目录。')
  return join(parent, ...suffix)
}
export async function inspectRepository(path: string): Promise<{ repository: string; head: string; dirty: boolean }> {
  let repository: string
  try { repository = canonical(await git(path, ['rev-parse', '--show-toplevel'])) } catch { throw Error('请选择本地 Git 仓库目录。') }
  let head: string
  try { head = await git(repository, ['rev-parse', '--verify', 'HEAD']) } catch { throw Error('仓库需要至少一次提交（HEAD）；向导不会自动提交文件。') }
  return { repository, head, dirty: Boolean(await git(repository, ['status', '--porcelain', '--untracked-files=normal'])) }
}
export function instanceConfig(stateDir: string): Instance {
  const c = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  if (c.schema !== 1 || typeof c.instanceId !== 'string' || !c.instanceId || typeof c.repository !== 'string' || !isAbsolute(c.repository) || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error('Invalid instance configuration')
  return c
}
export function instanceClient(stateDir: string, expectedId?: string): Client {
  const c = instanceConfig(stateDir)
  if (expectedId && c.instanceId !== expectedId) throw Error('Super-agent instance identity changed; reconnect using /superagent setup')
  return new Client(`http://127.0.0.1:${c.port}`, readManagement(stateDir) === 'local' ? undefined : optionalToken(join(stateDir, 'admin.token')), expectedId || c.instanceId)
}
export function loadBinding(directory: string, project: string): Binding | undefined {
  const path = join(directory, `${pathKey(project)}.json`)
  if (!existsSync(path)) return
  const binding = JSON.parse(readFileSync(path, 'utf8')) as Binding
  if (binding.project !== project || typeof binding.stateDir !== 'string' || !isAbsolute(binding.stateDir) || typeof binding.repository !== 'string' || typeof binding.instanceId !== 'string') throw Error('Invalid Super-agent project binding; run /superagent setup')
  if (binding.ssh !== undefined) return sshBinding(binding)
  const config = instanceConfig(binding.stateDir)
  if (config.instanceId !== binding.instanceId || canonical(config.repository) !== binding.repository) throw Error('Super-agent instance identity changed; run /superagent setup')
  return binding
}
export function saveBinding(directory: string, binding: Binding): string {
  if (binding.ssh !== undefined) binding = sshBinding(binding)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${pathKey(binding.project)}.json`); const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(binding, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path)
  return path
}
export interface Connection { client: Client; project: string; binding?: Binding }
export async function connectionForProject(cwd: string, directory = connectionsDir(), connect = false): Promise<Connection | undefined> {
  const project = await projectPath(cwd); const binding = loadBinding(directory, project)
  if (binding?.ssh) {
    const remote = await import('./remote-connections.js')
    return { project, binding, client: connect ? await remote.connectRemote(binding) : remote.remoteClient(binding) }
  }
  if (binding) return { project, binding, client: instanceClient(binding.stateDir, binding.instanceId) }
  for (let parent = dirname(project); ; parent = dirname(parent)) {
    const ancestor = loadBinding(directory, parent)
    if (ancestor && !ancestor.ssh && workspaceContains(instanceConfig(ancestor.stateDir), project)) return { project: ancestor.project, binding: ancestor, client: instanceClient(ancestor.stateDir, ancestor.instanceId) }
    if (dirname(parent) === parent) break
  }
  try { return { project, client: fromEnvironment() } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
function workspaceContains(config: Pick<Instance, 'repository' | 'workspace'>, project: string): boolean {
  if (!config.workspace) return false
  const root = canonical(config.repository)
  if (pathKey(root) === pathKey(project)) return true
  const delta = relative(root, project)
  if (delta === '..' || delta.startsWith('..' + sep) || isAbsolute(delta)) return false
  const gitRoot = existsSync(join(project, '.git'))
  return config.workspace.repositories.some(member => {
    const target = canonical(join(root, member.path))
    if (pathKey(target) === pathKey(project)) return true
    const sub = relative(project, target)
    return !gitRoot && sub !== '..' && !sub.startsWith('..' + sep) && !isAbsolute(sub)
  })
}
export async function matchesProject(connection: Connection): Promise<boolean> {
  if (connection.binding) return true // explicitly confirmed project-to-instance association
  const settings = await connection.client.request('config') as { config?: { repository?: string; workspace?: Instance['workspace'] } }
  const repository = settings.config?.repository
  if (!repository) return false
  try { return pathKey(canonical(repository)) === pathKey(connection.project) || workspaceContains({ repository, workspace: settings.config?.workspace }, connection.project) } catch { return false }
}
export async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
