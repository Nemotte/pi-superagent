import { afterEach, expect, it, vi } from 'vitest'
import { lockSync } from 'proper-lockfile'
import * as supervision from '../src/supervision.js'
import { planService } from '../src/supervision-config.js'
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, statSync, chmodSync, linkSync, cpSync, readlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, hostname, userInfo } from 'node:os'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { initialize, readConfig } from '../src/config.js'
import { Runtime } from '../src/runtime.js'
import { prepareWorktree } from '../src/workspace.js'
import { captureWorkspace, prepareWorkspace, workspaceStatus } from '../src/multi-workspace.js'
import { git, repository, nestedWorkspace } from './fixtures/workspace.js'
const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
const load = async () => { expect(existsSync(new URL('../src/backup.ts', import.meta.url)), 'verified backup API').toBe(true); return import('../src/backup.js') }
function reseal(path: string, data: any) {
  delete data.checksum
  writeFileSync(path, JSON.stringify({ ...data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') }))
}
const driver = { send: async () => {}, stop: async () => {}, close: async () => {} }
async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sa backup 中文 '))); dirs.push(root)
  const repo = join(root, 'repo'), state = join(root, 'state'), backups = join(root, 'backups'); mkdirSync(backups); repository(repo)
  const config = initialize(state, { repository: repo, port: randomInt(20000, 30000), paused: true, management: 'token' })
  const runtime = new Runtime(state, driver); runtime.submit({ id: 'durable', text: 'Keep the accepted request' }); await runtime.close()
  writeFileSync(join(state, 'agent', 'auth.json'), JSON.stringify({ provider: { key: 'fixture-private-key' } }), { mode: 0o600 })
  return { root, repo, state, backups, config, backup: join(backups, 'one'), expectedId: config.instanceId }
}
it('creates a verified private snapshot with standalone SQLite and refuses to run it as an instance', async () => {
  const m = await load(), f = await fixture(), result = await m.createBackup(f.state, f.backup)
  expect(result.instanceId).toBe(f.config.instanceId); expect(JSON.stringify(result)).not.toContain('fixture-private-key')
  expect((await m.checkBackup(f.backup)).database?.schema).toBe(1)
  expect(readFileSync(join(f.backup, 'admin.token'), 'utf8')).toBe(readFileSync(join(f.state, 'admin.token'), 'utf8'))
  if (process.platform !== 'win32') expect(statSync(f.backup).mode & 0o777).toBe(0o700)
  expect(() => readConfig(f.backup)).toThrow(/BACKUP|snapshot/i)
  await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/EXISTS/)
})
it('rejects public snapshot directories and hardlinked payload files', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  if (process.platform !== 'win32') {
    chmodSync(f.backup, 0o755); await expect(m.checkBackup(f.backup)).rejects.toThrow(/PERMISSIONS/); chmodSync(f.backup, 0o700)
  }
  rmSync(join(f.backup, 'admin.token')); linkSync(join(f.state, 'admin.token'), join(f.backup, 'admin.token'))
  await expect(m.checkBackup(f.backup)).rejects.toThrow(/INTEGRITY/)
})
it('rejects critical directory and credential links even when the manifest was rebuilt to match them', async () => {
  const m = await load()
  for (const name of process.platform === 'win32' ? ['agent'] : ['agent', 'admin.token', 'state.sqlite-journal']) {
    const f = await fixture(); await m.createBackup(f.state, f.backup)
    const outside = join(f.root, 'outside'), dest = join(f.backup, name)
    if (name === 'agent') mkdirSync(outside); else writeFileSync(outside, 'external-private-value')
    rmSync(dest, { recursive: true, force: true }); symlinkSync(outside, dest, name === 'agent' ? process.platform === 'win32' ? 'junction' : 'dir' : 'file')
    const path = join(f.backup, '.pi-superagent-backup.json'), data = JSON.parse(readFileSync(path, 'utf8'))
    data.entries = data.entries.filter((e: any) => e.path !== name && !e.path.startsWith(name + '/'))
    data.entries.push({ path: name, kind: 'symlink', target: readlinkSync(dest), directory: name === 'agent' && process.platform === 'win32' }); data.entries.sort((a: any, b: any) => a.path < b.path ? -1 : 1)
    reseal(path, data)
    await expect(m.checkBackup(f.backup)).rejects.toThrow(/FILE_TYPE/)
  }
})
it('previews and restores original identity, credential, pending request and pause only into an absent original path', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  await expect(m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })).rejects.toThrow(/EXISTS/)
  renameSync(f.state, f.state + '.saved')
  await expect(m.restoreBackup(f.backup, join(f.root, 'different'), { expectedId: f.expectedId, confirmed: true })).rejects.toThrow(/PATH/)
  await expect(m.restoreBackup(f.backup, f.state, { expectedId: 'wrong', confirmed: true })).rejects.toThrow(/IDENTITY/)
  expect((await m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId })).restored).toBe(false); expect(existsSync(f.state)).toBe(false)
  expect((await m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })).restored).toBe(true)
  expect(readFileSync(join(f.state, 'agent', 'auth.json'), 'utf8')).toContain('fixture-private-key')
  const runtime = new Runtime(f.state, driver)
  try { expect(runtime.settings().config.paused).toBe(true); expect(runtime.submit({ id: 'durable', text: 'Keep the accepted request' }).id).toBe('manual:durable') } finally { await runtime.close() }
  expect(existsSync(join(f.state, 'supervision.json'))).toBe(false)
})
it('preserves modification times so the real SDK resumes the same most recently used session', async () => {
  const m = await load(), f = await fixture(), { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const sessions = join(f.state, 'sessions', 'router'), active = join(sessions, 'a-active.jsonl'), abandoned = join(sessions, 'z-abandoned.jsonl')
  mkdirSync(sessions, { recursive: true })
  for (const file of [active, abandoned]) writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: '2026-11-05T00:00:00.000Z', cwd: f.state }) + '\n')
  const now = Date.now(); utimesSync(active, new Date(now - 1000), new Date(now - 1000)); utimesSync(abandoned, new Date(now - 60000), new Date(now - 60000))
  expect(SessionManager.continueRecent(f.state, sessions).getSessionFile()).toBe(active)
  await m.createBackup(f.state, f.backup)
  for (const name of ['a-active.jsonl', 'z-abandoned.jsonl']) utimesSync(join(f.backup, 'sessions/router', name), new Date(), new Date())
  await m.checkBackup(f.backup); renameSync(f.state, f.state + '.saved')
  await m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })
  expect(SessionManager.continueRecent(f.state, sessions).getSessionFile()).toBe(active)
})
it('pins restoration to the recorded host and OS account', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  const path = join(f.backup, '.pi-superagent-backup.json'), data = JSON.parse(readFileSync(path, 'utf8'))
  expect(data.host).toBe(hostname()); expect(data.uid).toBe(process.getuid?.() ?? null)
  data.host = 'another-host'; reseal(path, data); renameSync(f.state, f.state + '.saved')
  await expect(m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })).rejects.toThrow(/HOST/)
  expect(existsSync(f.state)).toBe(false)
})
it('records and checks the OS account/profile even on platforms without a numeric uid', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  const path = join(f.backup, '.pi-superagent-backup.json'), data = JSON.parse(readFileSync(path, 'utf8'))
  expect(data.account).toEqual({ name: userInfo().username, home: userInfo().homedir })
  data.account.name = 'different-account'; reseal(path, data); renameSync(f.state, f.state + '.saved')
  await expect(m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })).rejects.toThrow(/HOST/)
  expect(existsSync(f.state)).toBe(false)
})
it('detects corruption of authoritative timestamps in the manifest itself', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  const path = join(f.backup, '.pi-superagent-backup.json'), data = JSON.parse(readFileSync(path, 'utf8'))
  data.entries.find((e: any) => e.kind === 'file').mtimeMs += 60000; writeFileSync(path, JSON.stringify(data))
  await expect(m.checkBackup(f.backup)).rejects.toThrow(/INTEGRITY/)
})
it('checkpoints an abruptly stopped writer WAL only in the snapshot, leaving source bytes intact', async () => {
  const m = await load(), f = await fixture()
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL'); db.prepare('INSERT INTO kv VALUES (?,?)').run('wal-marker', JSON.stringify('durable-after-crash')); console.log('ready'); setInterval(()=>{},1000);`, join(f.state, 'state.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    await new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(Error('writer exited early'))) })
    const exited = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGKILL'); await exited
    const wal = readFileSync(join(f.state, 'state.sqlite-wal')); await m.createBackup(f.state, f.backup)
    expect(readFileSync(join(f.state, 'state.sqlite-wal'))).toEqual(wal)
    expect(existsSync(join(f.backup, 'state.sqlite-wal'))).toBe(false)
    const db = new DatabaseSync(join(f.backup, 'state.sqlite'), { readOnly: true })
    try { expect(db.prepare("SELECT value FROM kv WHERE key='wal-marker'").get()?.value).toBe(JSON.stringify('durable-after-crash')) } finally { db.close() }
  } finally { if (child.exitCode === null && !child.signalCode) { const exited = new Promise<void>(r => child.once('exit', () => r())); child.kill('SIGKILL'); await exited } }
})
it('rejects changed payload, unknown schema, extra files and path traversal without creating a restore target', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  const manifest = join(f.backup, '.pi-superagent-backup.json'), raw = readFileSync(manifest, 'utf8')
  writeFileSync(join(f.backup, 'extra'), 'not covered'); await expect(m.checkBackup(f.backup)).rejects.toThrow(/INTEGRITY/); rmSync(join(f.backup, 'extra'))
  const data = JSON.parse(raw); data.format = 99; writeFileSync(manifest, JSON.stringify(data)); await expect(m.checkBackup(f.backup)).rejects.toThrow(/FORMAT/)
  data.format = 1; data.entries[0].path = '../escape'; writeFileSync(manifest, JSON.stringify(data)); await expect(m.checkBackup(f.backup)).rejects.toThrow(/FORMAT/)
  writeFileSync(manifest, raw); writeFileSync(join(f.backup, 'admin.token'), 'changed')
  renameSync(f.state, f.state + '.saved')
  await expect(m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })).rejects.toThrow(/INTEGRITY/); expect(existsSync(f.state)).toBe(false)
})
it('rejects a source repository inside the instance because original-path recovery needs it independently', async () => {
  const m = await load(), f = await fixture(), state = join(f.root, 'enclosing-state'), repo = join(state, 'source')
  repository(repo); initialize(state, { repository: repo, paused: true, port: randomInt(20000, 30000) })
  await expect(m.createBackup(state, join(f.backups, 'enclosing'))).rejects.toThrow(/PATH/)
  expect(existsSync(join(f.backups, 'enclosing'))).toBe(false)
})
it('refuses live instances and busy ports and leaves no partial destination', async () => {
  const m = await load(), f = await fixture(), runtime = new Runtime(f.state, driver)
  try { await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/BUSY/) } finally { await runtime.close() }
  const listener = createServer(); await new Promise<void>(r => listener.listen(f.config.port, '127.0.0.1', r))
  try { await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/BUSY/); expect(existsSync(f.backup)).toBe(false) } finally { listener.close() }
})
it('preserves uncommitted work and checks external worktree administration rather than copying or resetting it', async () => {
  const m = await load(), f = await fixture(), work = join(f.state, 'work', 'task-one')
  await prepareWorktree(f.repo, work, 'task-one'); writeFileSync(join(work, 'README.md'), 'staged change'); git(work, 'add', '.')
  writeFileSync(join(work, 'README.md'), 'unstaged change beyond the index')
  writeFileSync(join(work, 'untracked'), 'untracked change')
  await m.createBackup(f.state, f.backup); renameSync(f.state, f.state + '.saved')
  await m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })
  expect(git(work, 'diff', '--cached')).toContain('staged change'); expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('unstaged change beyond the index'); expect(readFileSync(join(work, 'untracked'), 'utf8')).toBe('untracked change')
  writeFileSync(join(work, 'README.md'), 'new index'); git(work, 'add', '.')
  await expect(m.checkBackup(f.backup)).rejects.toThrow(/GIT_CHANGED/)
  expect(git(work, 'diff', '--cached')).toContain('new index')
})
it('restores nested workspace files, persisted baselines and staged child changes without rewriting repository metadata', async () => {
  const m = await load(), f = await fixture(), app = join(f.root, 'app'); mkdirSync(app)
  const { members } = nestedWorkspace(app), state = join(f.root, 'workspace-state'), backup = join(f.backups, 'workspace')
  const config = initialize(state, { repository: app, workspace: { repositories: members }, paused: true, port: randomInt(20000, 30000) })
  const snapshot = await captureWorkspace(app, config.workspace!), work = join(state, 'work', 'nested-task')
  await prepareWorkspace(snapshot, work, 'nested-task')
  writeFileSync(join(work, 'frontends/portal/README.md'), 'frontend task change')
  writeFileSync(join(work, 'backend/exam/README.md'), 'staged exam change'); git(join(work, 'backend/exam'), 'add', '.')
  const runtime = new Runtime(state, driver); runtime.store.set('workspace:nested-task', snapshot); await runtime.close()
  await m.createBackup(state, backup); renameSync(state, state + '.saved')
  await m.restoreBackup(backup, state, { expectedId: config.instanceId, confirmed: true })
  const status = await workspaceStatus(snapshot, work, 'nested-task')
  expect(status.filter(r => r.changed).map(r => r.id).sort()).toEqual(['exam', 'portal'])
  const restored = new Runtime(state, driver)
  try { expect(restored.store.get('workspace:nested-task')).toEqual(snapshot) } finally { await restored.close() }
})
it('does not dereference work symlinks and refuses partial restore/backup markers on initialization', async () => {
  const m = await load(), f = await fixture(); mkdirSync(join(f.state, 'work')); writeFileSync(join(f.root, 'outside'), 'external-not-copied')
  if (process.platform !== 'win32') { symlinkSync(join(f.root, 'outside'), join(f.state, 'work', 'link')); await m.createBackup(f.state, f.backup); expect((await m.checkBackup(f.backup)).files).toBeGreaterThan(0) }
  const partial = join(f.root, 'partial'); mkdirSync(partial); writeFileSync(join(partial, '.pi-superagent-restoring'), 'in progress')
  expect(() => initialize(partial, { repository: f.repo })).toThrow(/INCOMPLETE/)
  writeFileSync(join(f.state, '.pi-superagent-restoring'), 'in progress'); expect(() => readConfig(f.state)).toThrow(/INCOMPLETE/)
})
it('refuses initialization racing a reserved restore target before its marker exists', async () => {
  const f = await fixture(), target = join(f.root, 'reserved'), unlock = lockSync(target, { realpath: false })
  try { expect(() => initialize(target, { repository: f.repo })).toThrow(); expect(existsSync(target)).toBe(false) } finally { unlock() }
})
it('serializes initialization with the maintenance control lock', async () => {
  const f = await fixture(), target = join(f.root, 'reserved'), unlock = lockSync(target + '.supervision-control', { realpath: false })
  try { expect(() => initialize(target, { repository: f.repo })).toThrow(); expect(existsSync(target)).toBe(false) } finally { unlock() }
})
it('requires disabled inactive supervision and never restores its machine-specific registration', async () => {
  const m = await load(), f = await fixture(), home = join(f.root, 'home'); mkdirSync(home)
  const record = planService(f.state, { home, uid: process.getuid?.() ?? 0, platform: 'linux', node: process.execPath, cliPath: fileURLToPath(import.meta.url), run: async () => '' })
  writeFileSync(join(f.state, 'supervision.json'), JSON.stringify(record))
  const status = vi.spyOn(supervision, 'serviceOperation').mockResolvedValue({ active: 'active', enabled: true })
  await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/SUPERVISION/)
  status.mockResolvedValue({ active: 'inactive', enabled: true }); await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/SUPERVISION/)
  status.mockResolvedValue({ active: 'inactive', enabled: false }); await m.createBackup(f.state, f.backup)
  expect(status.mock.calls.every(c => c[1] === 'status')).toBe(true)
  renameSync(f.state, f.state + '.saved'); await m.restoreBackup(f.backup, f.state, { expectedId: f.expectedId, confirmed: true })
  expect(existsSync(join(f.state, 'supervision.json'))).toBe(false)
})
it('waits for a timed-out database worker to terminate before reporting failure to its cleanup caller', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  const { database } = await import('../src/backup-database.js'), terminate = Worker.prototype.terminate
  let finished = false, ending: Promise<number> | undefined
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function(this: Worker) { ending = terminate.call(this).then(code => { finished = true; return code }); return ending })
  try { await expect(database(f.backup, f.config, false, { timeoutMs: 1 })).rejects.toThrow(/TIMEOUT/); expect(finished).toBe(true) }
  finally { await ending }
})
it('rejects unsupported database schemas without publishing a snapshot or changing the source', async () => {
  const m = await load(), f = await fixture(), db = new DatabaseSync(join(f.state, 'state.sqlite'))
  db.prepare("UPDATE kv SET value='2' WHERE key='schema'").run(); db.close()
  await expect(m.createBackup(f.state, f.backup)).rejects.toThrow(/SCHEMA/)
  expect(existsSync(f.backup)).toBe(false)
  const same = new DatabaseSync(join(f.state, 'state.sqlite'), { readOnly: true }); try { expect(same.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value).toBe('2') } finally { same.close() }
})
it('never prunes from the instance or source repository even if snapshot-shaped directories were placed there', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup)
  for (const root of [f.state, f.repo]) {
    cpSync(f.backup, join(root, 'a'), { recursive: true }); cpSync(f.backup, join(root, 'b'), { recursive: true })
    chmodSync(join(root, 'a'), 0o700); chmodSync(join(root, 'b'), 0o700)
    await m.checkBackup(join(root, 'a'))
    await expect(m.pruneBackups(root, f.state, { expectedId: f.expectedId, keep: 1, confirmed: true })).rejects.toThrow(/PATH/)
    expect(existsSync(join(root, 'a')) && existsSync(join(root, 'b'))).toBe(true)
  }
})
it('previews retention, keeps at least one verified snapshot, and never removes unknown or damaged directories', async () => {
  const m = await load(), f = await fixture(); await m.createBackup(f.state, f.backup); const second = join(f.backups, 'two'); await m.createBackup(f.state, second)
  const unknown = join(f.backups, 'other-data'); mkdirSync(unknown); writeFileSync(join(unknown, 'precious'), 'keep')
  const bad = join(f.backups, 'damaged'); await m.createBackup(f.state, bad); writeFileSync(join(bad, 'admin.token'), 'corrupt')
  const foreign = await fixture(), other = join(f.backups, 'other-instance'); await m.createBackup(foreign.state, other)
  if (process.platform !== 'win32') symlinkSync(foreign.backups, join(f.backups, 'outside-link'))
  const options = { expectedId: f.expectedId, keep: 1 }
  await expect(m.pruneBackups(f.backups, f.state, { ...options, keep: 0, confirmed: true })).rejects.toThrow(/KEEP/)
  const preview = await m.pruneBackups(f.backups, f.state, options)
  expect(preview.remove).toHaveLength(1); expect(preview.removed).toBe(0); expect(existsSync(f.backup)).toBe(true)
  expect((await m.pruneBackups(f.backups, f.state, { ...options, confirmed: true })).removed).toBe(1)
  expect(existsSync(join(unknown, 'precious'))).toBe(true); expect(existsSync(bad)).toBe(true); expect(existsSync(other)).toBe(true)
  expect([f.backup, second].filter(existsSync)).toHaveLength(1)
})
