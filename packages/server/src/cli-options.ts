import { parseArgs as parse } from 'node:util'
import { resolve } from 'node:path'
import { defaultStateDir } from './config.js'
import { ManagementMode } from './management.js'
export function parseArgs(args: string[]) {
  const { values, positionals } = parse({ args, allowPositionals: true, options: {
    yes: { type: 'boolean' }, keep: { type: 'string' }, supervised: { type: 'boolean' }, 'state-dir': { type: 'string' }, management: { type: 'string' }, 'expected-instance-id': { type: 'string' }, repo: { type: 'string' }, port: { type: 'string' }, paused: { type: 'boolean' }, 'max-workers': { type: 'string' }, workspace: { type: 'boolean' }, member: { type: 'string', multiple: true }, id: { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' },
  } })
  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw Error('Port must be an integer between 1024 and 65535')
  const maxWorkers = values['max-workers'] === undefined ? undefined : Number(values['max-workers'])
  if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16)) throw Error('max-workers must be an integer between 1 and 16')
  if (values.member?.length && !values.workspace) throw Error('--member requires --workspace')
  const keep = values.keep === undefined ? undefined : Number(values.keep)
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > 1000)) throw Error('keep must be an integer between 1 and 1000')
  return { keep, confirmed: values.yes, supervised: values.supervised, management: values.management === undefined ? undefined : ManagementMode.parse(values.management), expectedInstanceId: values['expected-instance-id'], workspace: values.workspace, members: values.member || [], paused: values.paused, maxWorkers, command: values.help ? 'help' : values.version ? 'version' : positionals[0] || 'help', args: positionals.slice(1), stateDir: resolve(values['state-dir'] || defaultStateDir()), repository: resolve(values.repo || process.cwd()), port, requestId: values.id }
}
