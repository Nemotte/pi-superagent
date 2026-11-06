import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
export class BackupError extends Error { constructor(readonly code: string) { super(code) } }
export const equal = isDeepStrictEqual
export const relativeName = z.string().min(1).max(4096).refine(p => !/[\\:\x00-\x1f\x7f]/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..'))
const base = { path: relativeName }
export const entrySchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('directory') }).strict(),
  z.object({ ...base, kind: z.literal('file'), size: z.number().int().nonnegative().max(512 * 1024 ** 3), mtimeMs: z.number().min(0).max(8640000000000000), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('symlink'), target: z.string().min(1).max(32768).refine(t => !t.includes('\0')), directory: z.boolean() }).strict(),
])
export type Entry = z.infer<typeof entrySchema>
/** Transport may change snapshot mtimes; the manifest remains the restore-time authority. */
export function samePayload(a: Entry[], b: Entry[]): boolean {
  const stripTimes = (entries: Entry[]) => entries.map(e => { if (e.kind !== 'file') return e; const { mtimeMs: _time, ...rest } = e; return rest })
  return equal(stripTimes(a), stripTimes(b))
}
export const limits = { entries: 100000, bytes: 512 * 1024 ** 3, manifest: 32 * 1024 ** 2 }
export async function stat(path: string) { try { return await fs.lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error } }
export async function canonical(path: string): Promise<string> {
  path = resolve(path)
  const value = await stat(path)
  if (value) { if (value.isSymbolicLink()) throw new BackupError('BACKUP_PATH'); return fs.realpath(path) }
  const parent = dirname(path)
  if (parent === path) throw new BackupError('BACKUP_PATH')
  return join(await canonical(parent), basename(path))
}
export function inside(parent: string, path: string) { const delta = relative(parent, path); return !delta || delta !== '..' && !delta.startsWith('..' + sep) && !isAbsolute(delta) }
export async function json(path: string, budget = limits.manifest): Promise<unknown> {
  const s = await stat(path)
  if (!s?.isFile() || s.nlink > 1 || s.size > budget) throw new BackupError('BACKUP_FORMAT')
  try { return JSON.parse(await fs.readFile(path, 'utf8')) } catch { throw new BackupError('BACKUP_FORMAT') }
}
export async function privateFile(path: string, data: string): Promise<void> {
  const handle = await fs.open(path, 'wx', 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
}
/** Persist publication/marker directory entries on POSIX. Windows directory fsync is unsupported. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
export async function syncTree(root: string, entries: Entry[]): Promise<void> {
  for (const e of [...entries].reverse()) if (e.kind === 'directory') await syncDirectory(join(root, e.path))
  await syncDirectory(root)
}
const noFollow = constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
async function digest(path: string, size: number): Promise<string> {
  const handle = await fs.open(path, noFollow), hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024)
  let used = 0
  try {
    if (!(await handle.stat()).isFile()) throw new BackupError('BACKUP_FILE_TYPE')
    while (true) { const { bytesRead } = await handle.read(chunk); if (!bytesRead) break; used += bytesRead; if (used > size) throw new BackupError('BACKUP_CHANGED'); hash.update(chunk.subarray(0, bytesRead)) }
    if (used !== size) throw new BackupError('BACKUP_CHANGED')
    return hash.digest('hex')
  } finally { await handle.close() }
}
/** Enumerates links themselves, never their contents. */
export async function scan(root: string, ignored: string[] = [], rejectHardlinks = false): Promise<Entry[]> {
  if (!(await stat(root))?.isDirectory()) throw new BackupError('BACKUP_PATH')
  const entries: Entry[] = []; let bytes = 0
  const walk = async (directory: string, depth: number) => {
    if (depth > 64) throw new BackupError('BACKUP_LIMIT')
    for (const name of (await fs.readdir(join(root, directory))).sort()) {
      const path = directory ? directory + '/' + name : name
      if (!directory && ignored.includes(name)) continue
      if (!relativeName.safeParse(path).success) throw new BackupError('BACKUP_PATH')
      if (entries.length >= limits.entries) throw new BackupError('BACKUP_LIMIT')
      const file = join(root, path), s = await fs.lstat(file)
      if (s.isSymbolicLink()) {
        const target = await fs.readlink(file)
        entries.push({ path, kind: 'symlink', target, directory: process.platform === 'win32' && await fs.stat(file).then(s => s.isDirectory(), () => false) })
      } else if (s.isDirectory()) { entries.push({ path, kind: 'directory' }); await walk(path, depth + 1) }
      else if (s.isFile()) {
        bytes += s.size
        if (bytes > limits.bytes) throw new BackupError('BACKUP_LIMIT')
        if (rejectHardlinks && s.nlink > 1) throw new BackupError('BACKUP_INTEGRITY')
        entries.push({ path, kind: 'file', size: s.size, mtimeMs: s.mtimeMs, sha256: await digest(file, s.size), executable: process.platform !== 'win32' && !!(s.mode & 0o111) })
      } else throw new BackupError('BACKUP_FILE_TYPE')
    }
  }
  await walk('', 0)
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
export function validateEntries(entries: Entry[]): void {
  const seen = new Map<string, Entry>()
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new BackupError('BACKUP_FORMAT')
    const parts = entry.path.split('/')
    for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join('/'))?.kind !== 'directory') throw new BackupError('BACKUP_FORMAT')
    seen.set(entry.path, entry)
  }
}
export function validateInstanceEntries(entries: Entry[]): void {
  const files = new Set(['config.json', 'state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm', 'state.sqlite-journal', 'management.json', 'admin.token', 'github.token', 'agent/auth.json', 'agent/models.json', 'supervision.json', 'service.env.json'])
  const directories = new Set(['agent', 'sessions', 'work'])
  for (const e of entries) if (files.has(e.path) && e.kind !== 'file' || directories.has(e.path) && e.kind !== 'directory') throw new BackupError('BACKUP_FILE_TYPE')
}
export async function copyEntries(source: string, target: string, entries: Entry[], excluded: string[] = []): Promise<void> {
  validateEntries(entries)
  for (const entry of entries) {
    if (excluded.includes(entry.path)) continue
    const dest = join(target, entry.path), src = join(source, entry.path)
    if (entry.kind === 'directory') await fs.mkdir(dest, { mode: 0o700 })
    else if (entry.kind === 'symlink') await fs.symlink(entry.target, dest, entry.directory ? 'junction' : 'file')
    else {
      const input = await fs.open(src, noFollow)
      try {
        if (!(await input.stat()).isFile()) throw new BackupError('BACKUP_FILE_TYPE')
        const output = await fs.open(dest, 'wx', entry.executable ? 0o700 : 0o600), chunk = Buffer.allocUnsafe(1024 * 1024)
        let used = 0
        try {
          while (true) {
            const { bytesRead } = await input.read(chunk); if (!bytesRead) break
            used += bytesRead; if (used > entry.size) throw new BackupError('BACKUP_CHANGED')
            let offset = 0
            while (offset < bytesRead) { const { bytesWritten } = await output.write(chunk, offset, bytesRead - offset); if (!bytesWritten) throw new BackupError('BACKUP_IO'); offset += bytesWritten }
          }
          if (used !== entry.size) throw new BackupError('BACKUP_CHANGED')
          await output.utimes(entry.mtimeMs / 1000, entry.mtimeMs / 1000)
          await output.sync()
        } finally { await output.close() }
      } finally { await input.close() }
    }
  }
}
