import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname, basename, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { lockSync } from 'proper-lockfile'
import { GitHubConfigSchema } from './sources/github-config.js'
import { configureManagement, ManagementMode } from './management.js'
import { assertInstanceDirectory } from './instance-files.js'

export const ModelSchema = z.object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(200) }).strict()
export const RuleSchema = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,64}$/), instruction: z.string().min(1).max(4000), enabled: z.boolean() }).strict()
export const RepositoryMemberSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), path: z.string().min(1).max(500).refine(p => p === '.' || (!/[\\\\:\x00-\x1f\x7f]/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..' || ['.git', '.pi'].includes(s.toLowerCase()))), 'Use a portable workspace-relative path') }).strict()
export const WorkspaceSchema = z.object({ repositories: z.array(RepositoryMemberSchema).min(1).max(32) }).strict().refine(w => new Set(w.repositories.map(r => r.id)).size === w.repositories.length && new Set(w.repositories.map(r => r.path.toLowerCase())).size === w.repositories.length, 'Duplicate workspace member id or path')
export type WorkspaceConfig = z.infer<typeof WorkspaceSchema>
export const ConfigSchema = z.object({
  schema: z.literal(1).default(1), instanceId: z.string().uuid().default(() => randomUUID()),
  repository: z.string().refine(isAbsolute, 'Repository must be an absolute path'),
  workspace: WorkspaceSchema.nullable().default(null),
  port: z.number().int().min(1024).max(65535).default(4317),
  maxWorkers: z.number().int().min(1).max(16).default(3),
  mode: z.enum(['off', 'observe', 'auto']).default('observe'), paused: z.boolean().default(false),
  routerModel: ModelSchema.nullable().default(null), workerModel: ModelSchema.nullable().default(null),
  github: GitHubConfigSchema.nullable().default(null),
  team: z.object({ communication: z.string().max(8000).default('Keep messages concise; speak only when a person needs to act or can use a result.'), scope: z.string().max(8000).default('Stop at a reviewable result. Ask one concrete question when a design decision is required.'), delivery: z.string().max(8000).default('Verify changes and include evidence in the ticket conversation. Publish or deploy only when explicitly authorized.') }).strict().default(() => ({ communication: 'Keep messages concise; speak only when a person needs to act or can use a result.', scope: 'Stop at a reviewable result. Ask one concrete question when a design decision is required.', delivery: 'Verify changes and include evidence in the ticket conversation. Publish or deploy only when explicitly authorized.' })),
  rules: z.array(RuleSchema).max(30).default([]).refine(rules => new Set(rules.map(r => r.id)).size === rules.length, 'Duplicate rule IDs'),
}).strict().refine(c => !c.workspace || !c.github?.enabled, 'Workspace mode supports manual sources; multi-repository GitHub channels are not configured').refine(c => c.rules.reduce((n, r) => n + r.instruction.length, 0) + Object.values(c.team).join('').length <= 32000, 'Team instructions and rules exceed the 32000-character context budget')
export type Config = z.infer<typeof ConfigSchema>
export const defaultStateDir = () => process.env.PI_SUPERAGENT_HOME || join(homedir(), '.pi-superagent', 'default')
/** The one lock file every process derives: runtime, supervision, backup and the clients that wait for a stop. */
export const instanceLockPath = (stateDir: string): string => resolve(stateDir) + '.lock'
export const supervisionLockPath = (stateDir: string): string => resolve(stateDir) + '.supervision-control'
export function initialize(input: string, settings: { repository: string; port?: number; paused?: boolean; maxWorkers?: number; workspace?: WorkspaceConfig | null; management?: ManagementMode }): Config {
  // One canonical spelling: `state/.lock` and `state.lock` are different files.
  const stateDir = resolve(input)
  const { config, management } = initialConfig(stateDir, settings)
  mkdirSync(dirname(stateDir), { recursive: true, mode: 0o700 })
  let unlock: () => void
  try { unlock = lockSync(supervisionLockPath(stateDir), { realpath: false, stale: 120000 }) } catch { throw Error('INSTANCE_BUSY') }
  try { return initializeFiles(stateDir, config, management) } finally { unlock() }
}
function initialConfig(stateDir: string, input: Parameters<typeof initialize>[1]) {
  assertInstanceDirectory(stateDir)
  if (lstatSync(instanceLockPath(stateDir), { throwIfNoEntry: false })) throw Error('INSTANCE_BUSY')
  const { management = 'local', ...settings } = input
  ManagementMode.parse(management)
  const config = ConfigSchema.parse({ ...settings, repository: resolve(input.repository) })
  if (config.workspace) {
    let parent = resolve(stateDir); const suffix: string[] = []
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) throw Error('Cannot resolve instance directory')
      suffix.unshift(basename(parent)); parent = next
    }
    const inside = relative(realpathSync(config.repository), join(realpathSync(parent), ...suffix))
    if (!inside || inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) throw Error('Instance secrets must be outside the workspace root')
  }
  return { config, management }
}
function initializeFiles(stateDir: string, config: Config, management: ManagementMode): Config {
  assertInstanceDirectory(stateDir)
  if (lstatSync(instanceLockPath(stateDir), { throwIfNoEntry: false })) throw Error('INSTANCE_BUSY')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (existsSync(join(stateDir, 'config.json')) || existsSync(join(stateDir, 'admin.token'))) throw Error('Instance already initialized')
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  configureManagement(stateDir, management, config.instanceId)
  mkdirSync(join(stateDir, 'agent'), { recursive: true, mode: 0o700 })
  return config
}
export function readConfig(path: string): Config { const stateDir = resolve(path); assertInstanceDirectory(stateDir); return ConfigSchema.parse(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))) }
export function readToken(path: string): string {
  const token = readFileSync(join(resolve(path), 'admin.token'), 'utf8').trim()
  if (token.length < 32) throw Error('Invalid administrator token')
  return token
}
