import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Decision, Repositories, Thread, Ticket, Trigger, TriggerDisposition } from './core/index.js'

export interface Effect { kind: string; key: string; payload: unknown; generation: number; seq: number; attempts: number; due: number; error: string }
/** Single connection; the service must acquire its instance lock before opening this store. */
export class Store implements Repositories {
  readonly db: DatabaseSync
  private depth = 0
  private callbacks: Array<Array<() => void>> = []
  private closed = false
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const schema = this.get<number>('schema')
      if (schema !== undefined && schema !== 1) throw Error(`Unsupported database schema ${schema}`)
      this.atomic(() => {
        for (const table of ['trigger', 'disposition', 'thread', 'ticket', 'decision']) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
        this.db.exec(`CREATE TABLE IF NOT EXISTS effect (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL,
          value TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL,
          error TEXT NOT NULL DEFAULT '', UNIQUE(kind, key));
          CREATE INDEX IF NOT EXISTS effect_due ON effect(due);
          CREATE INDEX IF NOT EXISTS effect_due_kind ON effect(due, kind);
          CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, value TEXT NOT NULL);`)
        this.set('schema', 1)
      })
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  atomic<T>(run: () => T): T {
    const level = this.depth++; const name = `tx_${level}`; this.callbacks[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = run(); this.db.exec(`RELEASE ${name}`)
      const callbacks = this.callbacks.pop()!; this.depth--
      if (level) this.callbacks[level - 1].push(...callbacks)
      else for (const fn of callbacks) { try { fn() } catch (error) { console.error('afterCommit:', String(error)) } }
      return result
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); this.callbacks.pop(); this.depth--; throw error
    }
  }
  afterCommit(fn: () => void): void { if (this.depth) this.callbacks[this.depth - 1].push(fn); else fn() }
  get<T>(key: string): T | undefined { return this.read<T>('kv', key, 'key') }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  private read<T>(table: string, id: string, column = 'id'): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE ${column}=?`).get(id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  private save(table: string, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value))
  }
  private list<T>(table: string, where = ''): T[] { return this.db.prepare(`SELECT value FROM ${table} ${where} ORDER BY rowid`).all().map(r => JSON.parse(String(r.value)) as T) }
  readonly triggers = {
    get: (id: string) => this.read<Trigger>('trigger', id),
    save: (value: Trigger) => this.save('trigger', value.id, value),
    disposition: (id: string) => this.read<TriggerDisposition>('disposition', id),
    saveDisposition: (id: string, value: TriggerDisposition) => this.save('disposition', id, value),
  }
  readonly threads = {
    get: (id: string) => this.read<Thread>('thread', id), save: (v: Thread) => this.save('thread', v.key, v),
    list: () => this.list<Thread>('thread'),
    active: () => this.list<Thread>('thread', "WHERE json_array_length(value, '$.pending') > 0 OR json_extract(value, '$.evaluating') IS NOT NULL"),
  }
  readonly tickets = {
    get: (id: string) => this.read<Ticket>('ticket', id), save: (v: Ticket) => this.save('ticket', v.id, v),
    list: () => this.list<Ticket>('ticket'), open: () => this.list<Ticket>('ticket', "WHERE json_extract(value, '$.ended') IS NULL"),
    active: () => this.list<Ticket>('ticket', "WHERE json_array_length(value, '$.undelivered') > 0 OR json_extract(value, '$.assignments[#-1].state') IN ('pending','running')"),
  }
  readonly decisions = {
    get: (id: string) => this.read<Decision>('decision', id), save: (v: Decision) => this.save('decision', v.id, v),
    byThread: (id: string) => this.db.prepare("SELECT value FROM decision WHERE json_extract(value, '$.threadKey')=? ORDER BY rowid").all(id).map(r => JSON.parse(String(r.value)) as Decision),
  }
  records(kind: 'trigger' | 'decision' | 'ticket' | 'thread', offset = 0, limit = 50): unknown[] {
    return this.db.prepare(`SELECT value FROM ${kind} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(Math.min(100, limit), offset).map(r => JSON.parse(String(r.value)))
  }
  threadTriggers(thread: string, offset = 0, limit = 20): Trigger[] {
    return this.db.prepare(`SELECT t.value FROM trigger t WHERE EXISTS (SELECT 1 FROM json_each(t.value, '$.threads') ref WHERE json_extract(ref.value, '$.source') || ':' || json_extract(ref.value, '$.id') = ?) ORDER BY json_extract(t.value, '$.at'), t.id LIMIT ? OFFSET ?`)
      .all(thread, limit, offset).map(r => JSON.parse(String(r.value)))
  }
  searchTickets(query = '', state: 'all' | 'open' | 'ended' = 'all', offset = 0, limit = 50): Ticket[] {
    const filter = state === 'all' ? '' : ` AND json_extract(value, '$.ended') IS ${state === 'open' ? '' : 'NOT '}NULL`
    return this.db.prepare(`SELECT value FROM ticket WHERE instr(lower(json_extract(value, '$.title') || ' ' || id), lower(?)) > 0${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(query, Math.min(100, limit), offset).map(r => JSON.parse(String(r.value)) as Ticket)
  }
  enqueue(kind: string, key: string, payload: unknown): void {
    this.db.prepare(`INSERT INTO effect(kind,key,value,due) VALUES (?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET
      value=excluded.value,generation=generation+1,due=excluded.due,attempts=0,error=''`).run(kind, key, JSON.stringify(payload), Date.now())
  }
  pendingEffects(): Effect[] {
    return this.db.prepare('SELECT * FROM effect ORDER BY seq').all().map(row => ({ ...row, payload: JSON.parse(String(row.value)) })) as unknown as Effect[]
  }
  /** The effects a scheduler tick may run: due now, in enqueue order, bounded so a backlog cannot starve the event loop. */
  dueEffects(now: number, limit = 256): Effect[] {
    return this.db.prepare('SELECT * FROM effect WHERE due<=? ORDER BY seq LIMIT ?').all(now, limit).map(row => ({ ...row, payload: JSON.parse(String(row.value)) })) as unknown as Effect[]
  }
  finishEffect(e: Effect): void { this.db.prepare('DELETE FROM effect WHERE seq=? AND generation=?').run(e.seq, e.generation) }
  deferEffect(e: Effect, delay = 1000): void { this.db.prepare('UPDATE effect SET due=? WHERE seq=? AND generation=?').run(Date.now() + delay, e.seq, e.generation) }
  failEffect(e: Effect, error: string, now = Date.now()): void {
    this.db.prepare('UPDATE effect SET attempts=attempts+1, error=?, due=? WHERE seq=? AND generation=?')
      .run(error.slice(0, 1000), now + Math.min(60000, 1000 * 2 ** Math.min(e.attempts, 8)), e.seq, e.generation)
  }
  audit(value: unknown): void { this.db.prepare('INSERT INTO audit(at,value) VALUES (?,?)').run(new Date().toISOString(), JSON.stringify(value)) }
  events(after = 0, limit = 100): unknown[] {
    return this.db.prepare('SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT ?').all(after, Math.min(100, limit)).map(row => ({ id: row.seq, at: row.at, event: JSON.parse(String(row.value)) }))
  }
}
