import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { userInfo, hostname } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import { ConfigSchema, type Config } from './config.js'
import { registeredService } from './supervision-config.js'
import { serviceOperation } from './supervision.js'
import { backupManifest, backingUp, restoring, assertInstanceDirectory } from './instance-files.js'
import { BackupError, canonical, copyEntries, entrySchema, equal, samePayload, inside, json, limits, privateFile, scan, stat, validateEntries, validateInstanceEntries, syncDirectory, syncTree } from './backup-files.js'
import { database } from './backup-database.js'
import { captureGit, gitSchema, verifyGit } from './backup-git.js'
export { BackupError } from './backup-files.js'
const absolute = z.string().min(1).max(4096).refine(p => isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p))
const schema = z.object({ format: z.literal(1), id: z.string().uuid(), createdAt: z.iso.datetime(), serverVersion: z.literal('0.1.0-alpha.1'), platform: z.enum(['linux', 'darwin', 'win32']), host: z.string().min(1).max(255), account: z.object({ name: z.string().min(1).max(256), home: absolute }).strict(), uid: z.number().int().nonnegative().nullable(), origin: absolute, instanceId: z.string().uuid(), entries: z.array(entrySchema).max(limits.entries), git: gitSchema, database: z.object({ schema: z.literal(1), revision: z.number().int().positive(), paused: z.boolean() }).strict().nullable() }).strict()
type Manifest = z.infer<typeof schema>
const envelope = schema.extend({ checksum: z.string().regex(/^[a-f0-9]{64}$/) })
const checksum = (value: Manifest) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account = () => { const value = userInfo(); return { name: value.username, home: value.homedir } }
const parentLock = (directory: string) => join(directory, '.pi-superagent-backup-control')
async function acquire(path: string, stale = 120000) { try { return await lock(path, { realpath: false, stale }) } catch { throw new BackupError('BACKUP_BUSY') } }
async function offline(state: string, port: number) {
  const control = await acquire(state + '.supervision-control')
  let release: (() => Promise<void>) | undefined, server: ReturnType<typeof createServer> | undefined
  try {
    release = await acquire(state, 30000)
    server = createServer()
    await new Promise<void>((resolve, reject) => { server!.once('error', () => reject(new BackupError('BACKUP_BUSY'))); server!.listen(port, '127.0.0.1', resolve) })
    return async () => { try { await new Promise<void>(resolve => server!.close(() => resolve())) } finally { try { await release!() } finally { await control() } } }
  } catch (error) { if (server?.listening) server.close(); try { await release?.() } finally { await control() }; throw error }
}
async function configAt(directory: string): Promise<Config> {
  const raw = await json(join(directory, 'config.json'), 1024 * 1024)
  try { if (!(raw as any)?.instanceId || (raw as any)?.schema !== 1) throw Error(); return ConfigSchema.parse(raw) } catch { throw new BackupError('BACKUP_SCHEMA') }
}
const summary = (m: Manifest) => ({ backupId: m.id, instanceId: m.instanceId, createdAt: m.createdAt, origin: m.origin, host: m.host, uid: m.uid, platform: m.platform, database: m.database, files: m.entries.length, bytes: m.entries.reduce((n, e) => n + (e.kind === 'file' ? e.size : 0), 0), credentialsIncluded: true })
async function readSnapshot(directory: string, dependencies: boolean) {
  directory = await canonical(directory)
  const access = await stat(directory)
  if (!access?.isDirectory()) throw new BackupError('BACKUP_PATH')
  if (process.platform !== 'win32' && (access.mode & 0o077 || access.uid !== process.getuid!())) throw new BackupError('BACKUP_PERMISSIONS')
  if (await stat(join(directory, backingUp)) || await stat(join(directory, restoring))) throw new BackupError('BACKUP_INCOMPLETE')
  let encoded: z.infer<typeof envelope>
  try { encoded = envelope.parse(await json(join(directory, backupManifest))) } catch { throw new BackupError('BACKUP_FORMAT') }
  const { checksum: storedChecksum, ...m } = encoded
  if (checksum(m) !== storedChecksum) throw new BackupError('BACKUP_INTEGRITY')
  if (m.platform !== process.platform) throw new BackupError('BACKUP_PLATFORM')
  validateEntries(m.entries); validateInstanceEntries(m.entries)
  if (!samePayload(await scan(directory, [backupManifest], true), m.entries)) throw new BackupError('BACKUP_INTEGRITY')
  const config = await configAt(directory)
  if (config.instanceId !== m.instanceId || !equal(await database(directory, config), m.database)) throw new BackupError('BACKUP_IDENTITY')
  const gitFiles = m.entries.filter(e => e.path.startsWith('work/') && e.path.endsWith('/.git') && e.kind !== 'directory')
  if (gitFiles.length !== m.git.worktrees.length) throw new BackupError('BACKUP_FORMAT')
  for (const file of gitFiles) {
    const w = m.git.worktrees.find(w => w.path + '/.git' === file.path)
    if (!w || file.kind !== 'file' || w.branch !== `refs/heads/pi-superagent/${w.path.split('/')[1]}`) throw new BackupError('BACKUP_FORMAT')
    const pointer = (await fs.readFile(join(directory, file.path), 'utf8')).trim()
    if (!pointer.startsWith('gitdir: ') || resolve(m.origin, w.path, pointer.slice(8)) !== w.gitDir) throw new BackupError('BACKUP_FORMAT')
  }
  if (dependencies) await verifyGit(m.git, config, m.origin)
  return { directory, m, config }
}
export async function checkBackup(directory: string) { const { m } = await readSnapshot(directory, true); return { ...summary(m), verified: true } }
/** Offline, original instance only. No changes to the source DB, Git metadata or service manager. */
export async function createBackup(state: string, destination: string, options: { expectedId?: string } = {}) {
  state = await canonical(state); destination = await canonical(destination)
  assertInstanceDirectory(state)
  const config = await configAt(state)
  if (options.expectedId && options.expectedId !== config.instanceId) throw new BackupError('BACKUP_IDENTITY')
  const repository = await canonical(config.repository)
  if (inside(state, repository) || inside(state, destination) || inside(repository, destination) || !(await stat(dirname(destination)))?.isDirectory()) throw new BackupError('BACKUP_PATH')
  const unlockParent = await acquire(parentLock(dirname(destination)))
  let release: (() => Promise<void>) | undefined, created = false
  try {
    if (await stat(destination)) throw new BackupError('BACKUP_EXISTS')
    release = await offline(state, config.port)
    if (!equal(await configAt(state), config)) throw new BackupError('BACKUP_CHANGED')
    if (registeredService(state)) {
      const supervision = await serviceOperation(state, 'status', { expectedId: config.instanceId })
      if (!['inactive', 'failed'].includes(supervision.active) || supervision.enabled) throw new BackupError('BACKUP_SUPERVISION')
    }
    const entries = await scan(state); validateInstanceEntries(entries)
    const git = await captureGit(state, config, entries)
    if (git.repositories.some(r => inside(state, r.source) || inside(state, r.commonDir))) throw new BackupError('BACKUP_PATH')
    await fs.mkdir(destination, { mode: 0o700 }); created = true
    await privateFile(join(destination, backingUp), randomUUID()); await syncDirectory(destination)
    await copyEntries(state, destination, entries)
    const db = await database(destination, config, true)
    if (!equal(await scan(state), entries)) throw new BackupError('BACKUP_CHANGED')
    await verifyGit(git, config, state)
    const originals = new Map(entries.map(e => [e.path, e]))
    const payload = (await scan(destination, [backingUp])).map(e => {
      const original = originals.get(e.path)
      return e.kind === 'file' && original?.kind === 'file' && e.sha256 === original.sha256 ? { ...e, mtimeMs: original.mtimeMs } : e
    })
    const result = schema.parse({ format: 1, id: randomUUID(), createdAt: new Date().toISOString(), serverVersion: '0.1.0-alpha.1', platform: process.platform, host: hostname(), account: account(), uid: process.getuid?.() ?? null, origin: state, instanceId: config.instanceId, database: db, git, entries: payload })
    const text = JSON.stringify({ ...result, checksum: checksum(result) })
    if (Buffer.byteLength(text) > limits.manifest) throw new BackupError('BACKUP_LIMIT')
    await privateFile(join(destination, backupManifest), text + '\n')
    await syncTree(destination, result.entries)
    await fs.rm(join(destination, backingUp)); await syncDirectory(destination); await syncDirectory(dirname(destination))
    await readSnapshot(destination, true)
    return { ...summary(result), backup: destination, verified: true }
  } catch (error) { if (created) await fs.rm(destination, { recursive: true, force: true }); throw error }
  finally { try { await release?.() } finally { await unlockParent() } }
}
export async function restoreBackup(backup: string, target: string, options: { expectedId?: string; confirmed?: boolean } = {}) {
  if (!z.string().uuid().safeParse(options.expectedId).success) throw new BackupError('BACKUP_IDENTITY')
  backup = await canonical(backup); target = await canonical(target)
  const unlockParent = await acquire(parentLock(dirname(backup)))
  let release: (() => Promise<void>) | undefined, created = false
  try {
    const { m, config } = await readSnapshot(backup, true)
    if (m.host !== hostname() || !equal(m.account, account()) || m.uid !== (process.getuid?.() ?? null)) throw new BackupError('BACKUP_HOST')
    if (m.instanceId !== options.expectedId) throw new BackupError('BACKUP_IDENTITY')
    if (target !== m.origin || inside(backup, target)) throw new BackupError('BACKUP_PATH')
    if (await stat(target)) throw new BackupError('BACKUP_EXISTS')
    if (process.platform === 'linux' && await stat(join(userInfo().homedir, '.config/systemd/user', `pi-superagent-${m.instanceId}.service`))) throw new BackupError('BACKUP_SUPERVISION')
    release = await offline(target, config.port)
    if (!options.confirmed) return { ...summary(m), target, restored: false, requiresConfirmation: true }
    await fs.mkdir(target, { mode: 0o700 }); created = true
    await privateFile(join(target, restoring), m.id); await syncDirectory(target)
    await copyEntries(backup, target, m.entries, ['supervision.json'])
    const restoredEntries = await scan(target, [restoring]), expectedEntries = m.entries.filter(e => e.path !== 'supervision.json')
    if (!samePayload(restoredEntries, expectedEntries)) throw new BackupError('BACKUP_CHANGED')
    for (let i = 0; i < expectedEntries.length; i++) {
      const expected = expectedEntries[i], actual = restoredEntries[i]
      if (expected.kind === 'file' && actual.kind === 'file' && Math.abs(expected.mtimeMs - actual.mtimeMs) > 1) throw new BackupError('BACKUP_TIMESTAMPS')
    }
    if (!equal(await database(target, config), m.database)) throw new BackupError('BACKUP_CHANGED')
    await readSnapshot(backup, true)
    await syncTree(target, m.entries)
    await fs.rm(join(target, restoring)); await syncDirectory(target); await syncDirectory(dirname(target))
    return { ...summary(m), target, restored: true, started: false, supervision: 'not-restored' }
  } catch (error) { if (created) await fs.rm(target, { recursive: true, force: true }); throw error }
  finally { try { await release?.() } finally { await unlockParent() } }
}
export async function pruneBackups(root: string, state: string, options: { expectedId?: string; keep: number; confirmed?: boolean }) {
  if (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 1000) throw new BackupError('BACKUP_KEEP')
  if (!z.string().uuid().safeParse(options.expectedId).success) throw new BackupError('BACKUP_IDENTITY')
  root = await canonical(root); state = await canonical(state)
  const protectedRoots = [state]
  if (await stat(state)) {
    assertInstanceDirectory(state)
    const config = await configAt(state)
    if (config.instanceId !== options.expectedId) throw new BackupError('BACKUP_IDENTITY')
    protectedRoots.push(await canonical(config.repository))
  }
  if (protectedRoots.some(path => inside(path, root))) throw new BackupError('BACKUP_PATH')
  const unlock = await acquire(parentLock(root))
  try {
    const names = (await fs.readdir(root)).sort()
    if (names.length > 1000) throw new BackupError('BACKUP_LIMIT')
    const candidates: Array<{ path: string; m: Manifest }> = []; let skipped = 0
    for (const name of names) {
      if (name === basename(parentLock(root)) + '.lock') continue
      const path = join(root, name)
      if (!(await stat(path))?.isDirectory()) { skipped++; continue }
      try {
        const { m, config } = await readSnapshot(path, false)
        const protectedPaths = [...protectedRoots, await canonical(config.repository), ...m.git.repositories.map(r => r.source)]
        if (protectedPaths.some(p => inside(p, path) || inside(path, p))) { skipped++; continue }
        if (m.instanceId === options.expectedId && m.origin === state && m.host === hostname() && equal(m.account, account()) && m.uid === (process.getuid?.() ?? null)) candidates.push({ path, m }); else skipped++
      } catch { skipped++ }
    }
    candidates.sort((a, b) => b.m.createdAt.localeCompare(a.m.createdAt) || b.m.id.localeCompare(a.m.id))
    const remove = candidates.slice(options.keep), kept = candidates.slice(0, options.keep)
    let removed = 0
    if (options.confirmed) for (const entry of remove) {
      if (!equal((await readSnapshot(entry.path, false)).m, entry.m)) throw new BackupError('BACKUP_CHANGED')
      await fs.rm(entry.path, { recursive: true }); await syncDirectory(root); removed++
    }
    return { remove: remove.map(e => ({ path: e.path, backupId: e.m.id, createdAt: e.m.createdAt })), kept: kept.map(e => e.path), skipped, removed, requiresConfirmation: !options.confirmed }
  } finally { await unlock() }
}
