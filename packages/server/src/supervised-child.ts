// systemd's main process. Load private environment before starting the service Node process.
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { parseArgs } from './cli-options.js'
import { assertSupervisedServe, registeredService, serviceEnvironment, ServiceError } from './supervision-config.js'
try {
  const o = parseArgs(process.argv.slice(2))
  if (o.command !== 'serve' || !o.supervised || !o.expectedInstanceId || o.args.length) throw new ServiceError('SERVICE_ACTION')
  assertSupervisedServe(o.stateDir, o.expectedInstanceId)
  const r = registeredService(o.stateDir)!
  const child = spawn(r.node, [r.cliPath, 'serve', '--supervised', '--expected-instance-id', r.instanceId, '--state-dir', r.stateDir], {
    env: { HOME: r.home, PATH: `${dirname(r.node)}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', ...serviceEnvironment(r.stateDir) }, stdio: 'inherit',
  })
  process.once('SIGTERM', () => { child.kill('SIGTERM') }); process.once('SIGINT', () => { child.kill('SIGINT') })
  child.once('error', () => { console.error('SUPERVISED_SPAWN_FAILED'); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
} catch (error) { console.error(error instanceof ServiceError ? error.code : 'SUPERVISED_START_FAILED'); process.exitCode = 1 }
