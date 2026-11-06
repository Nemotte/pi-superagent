import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { ConfigSchema, type Config } from './config.js'
import { BackupError, equal, stat } from './backup-files.js'
// Fixed native-only worker: long integrity checks/checkpoints must not starve the parent's lock heartbeat.
const code = `
const {parentPort, workerData} = require('node:worker_threads');
const {DatabaseSync} = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.path, {readOnly: !workerData.normalize});
  if (db.prepare('PRAGMA integrity_check').all().some(r => Object.values(r)[0] !== 'ok')) throw Error('BACKUP_DATABASE');
  const row = db.prepare("SELECT value FROM kv WHERE key='schema'").get();
  if (row?.value !== '1') throw Error('BACKUP_SCHEMA');
  const size = db.prepare("SELECT length(value) AS size FROM kv WHERE key='settings'").get()?.size;
  if (!size || size > 1024 * 1024) throw Error('BACKUP_DATABASE');
  const settings = JSON.parse(db.prepare("SELECT value FROM kv WHERE key='settings'").get().value);
  if (workerData.normalize) {
    const check = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (check.busy) throw Error('BACKUP_DATABASE');
    if (Object.values(db.prepare('PRAGMA journal_mode=DELETE').get())[0] !== 'delete') throw Error('BACKUP_DATABASE');
  } else if (Object.values(db.prepare('PRAGMA journal_mode').get())[0] !== 'delete') throw Error('BACKUP_DATABASE');
  db.close(); db = undefined;
  parentPort.postMessage({settings});
} catch (error) {
  try { db?.close() } catch {}
  parentPort.postMessage({error: error.message === 'BACKUP_SCHEMA' ? 'BACKUP_SCHEMA' : 'BACKUP_DATABASE'});
}
`
export async function database(directory: string, config: Config, normalize = false, { timeoutMs = 60000 }: { timeoutMs?: number } = {}): Promise<{ schema: 1; revision: number; paused: boolean } | null> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new BackupError('BACKUP_LIMIT')
  const path = join(directory, 'state.sqlite'), value = await stat(path)
  if (!value) {
    if (await stat(path + '-wal') || await stat(path + '-shm') || await stat(path + '-journal')) throw new BackupError('BACKUP_DATABASE')
    return null
  }
  if (!value.isFile()) throw new BackupError('BACKUP_DATABASE')
  if (!normalize && (await stat(path + '-wal') || await stat(path + '-shm') || await stat(path + '-journal'))) throw new BackupError('BACKUP_DATABASE')
  const result = await new Promise<any>((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { path, normalize }, execArgv: [], stdout: true, stderr: true })
    worker.stdout.resume(); worker.stderr.resume()
    let expired = false, failed = false, message: any
    const timer = setTimeout(() => {
      expired = true
      // Cleanup must not remove files/release locks while native SQLite still owns them.
      void worker.terminate().then(() => reject(new BackupError('BACKUP_DATABASE_TIMEOUT')), () => reject(new BackupError('BACKUP_DATABASE')))
    }, timeoutMs)
    worker.on('message', value => { message = value })
    worker.once('error', () => { failed = true; clearTimeout(timer) })
    worker.once('exit', code => { clearTimeout(timer); if (expired) return; if (failed || code || !message) reject(new BackupError('BACKUP_DATABASE')); else resolve(message) })
  })
  if (result.error) throw new BackupError(result.error)
  const settings = ConfigSchema.safeParse(result.settings?.config), revision = result.settings?.revision
  if (!settings.success || !Number.isSafeInteger(revision) || revision < 1) throw new BackupError('BACKUP_DATABASE')
  for (const key of ['schema', 'instanceId', 'repository', 'port', 'workspace'] as const) if (!equal(settings.data[key], config[key])) throw new BackupError('BACKUP_IDENTITY')
  if (normalize) for (const suffix of ['-wal', '-shm', '-journal']) await rm(path + suffix, { force: true })
  return { schema: 1, revision, paused: settings.data.paused }
}
