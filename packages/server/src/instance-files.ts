import { lstatSync } from 'node:fs'
import { join } from 'node:path'
export const backupManifest = '.pi-superagent-backup.json'
export const backingUp = '.pi-superagent-backing-up'
export const restoring = '.pi-superagent-restoring'
/** A snapshot or half-published restore must never be opened as another live instance. */
export function assertInstanceDirectory(directory: string): void {
  for (const file of [backingUp, restoring, backupManifest]) {
    if (lstatSync(join(directory, file), { throwIfNoEntry: false })) throw Error(file === backupManifest ? 'BACKUP_SNAPSHOT_NOT_INSTANCE' : 'BACKUP_INCOMPLETE')
  }
}
