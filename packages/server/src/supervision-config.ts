import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readConfig } from './config.js'
export class ServiceError extends Error { constructor(readonly code: string) { super(code) } }
const pathSchema = z.string().min(1).max(4096).refine(v => isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v))
const schema = z.object({ schema: z.literal(1), kind: z.literal('systemd-user'), instanceId: z.string().uuid(), stateDir: pathSchema, uid: z.number().int().nonnegative(), home: pathSchema, node: pathSchema, cliPath: pathSchema, unitName: z.string(), unitFile: pathSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export type Registration = z.infer<typeof schema>
export interface ServiceHost { platform: string; uid: number; home: string; node: string; cliPath: string; run(args: string[]): Promise<string>; linger?(): Promise<boolean | undefined> }
export const serviceActions = ['plan', 'status', 'install', 'enable', 'disable', 'uninstall'] as const
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const literal = (value: string) => { if (/[\x00-\x1f\x7f]/.test(value)) throw new ServiceError('SERVICE_PATH'); return value.replaceAll('%', '%%') }
const word = (value: string) => '"' + literal(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
export function renderUnit(r: Omit<Registration, 'digest'>): string {
  const args = ['-i', `HOME=${r.home}`, `PATH=${dirname(r.node)}:/usr/local/bin:/usr/bin:/bin`, 'LANG=C.UTF-8', r.node, join(dirname(r.cliPath), 'supervised-child.js'), 'serve', '--supervised', '--expected-instance-id', r.instanceId, '--state-dir', r.stateDir]
  return `[Unit]\nDescription=Pi Super-agent ${r.instanceId}\nStartLimitIntervalSec=300\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=:/usr/bin/env ${args.map(word).join(' ')}\nRestart=on-failure\nRestartSec=35s\nTimeoutStopSec=30s\nKillMode=control-group\nUMask=0077\nStandardOutput=append:${literal(join(r.stateDir, 'service.log'))}\nStandardError=inherit\n\n[Install]\nWantedBy=default.target\n`
}
export function planService(stateDir: string, host: ServiceHost): Registration {
  const instanceId = readConfig(stateDir).instanceId, unitName = `pi-superagent-${instanceId}.service`
  const fields = { schema: 1 as const, kind: 'systemd-user' as const, instanceId, stateDir: realpathSync(stateDir), uid: host.uid, home: realpathSync(host.home), node: realpathSync(host.node), cliPath: realpathSync(host.cliPath), unitName, unitFile: join(realpathSync(host.home), '.config/systemd/user', unitName) }
  try { return schema.parse({ ...fields, digest: hash(renderUnit(fields)) }) } catch { throw new ServiceError('SERVICE_PATH') }
}
export function registeredService(stateDir: string): Registration | undefined {
  const file = join(stateDir, 'supervision.json')
  if (!existsSync(file)) { try { lstatSync(file); throw new ServiceError('SERVICE_IDENTITY') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error } }
  try {
    if (!lstatSync(file).isFile()) throw Error()
    const r = schema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (r.stateDir !== realpathSync(stateDir) || r.instanceId !== readConfig(stateDir).instanceId || r.unitName !== `pi-superagent-${r.instanceId}.service` || r.unitFile !== join(r.home, '.config/systemd/user', r.unitName) || r.digest !== hash(renderUnit(r))) throw Error()
    return r
  } catch { throw new ServiceError('SERVICE_IDENTITY') }
}
export function verifyUnit(r: Registration, allowMissing = false): void {
  let stat
  try { stat = lstatSync(r.unitFile) } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new ServiceError('SERVICE_OWNERSHIP') }
  if (!stat.isFile() || process.platform !== 'win32' && stat.uid !== r.uid || hash(readFileSync(r.unitFile, 'utf8')) !== r.digest) throw new ServiceError('SERVICE_OWNERSHIP')
}
export function serviceEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const file = join(stateDir, 'service.env.json')
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 65536 || process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid!())) throw Error()
    const value = JSON.parse(readFileSync(file, 'utf8')), allowed = /^(PATH|LANG|LANGUAGE|TZ|LC_[A-Z_]+|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, v]) => !allowed.test(key) || typeof v !== 'string' || v.length > 8192 || /[\x00\r\n]/.test(v))) throw Error()
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ServiceError('SERVICE_ENV') }
}
export function assertSupervisedServe(stateDir: string, expectedId?: string): void {
  const r = registeredService(stateDir)
  if (!r || r.instanceId !== expectedId || r.uid !== process.getuid?.() || r.node !== realpathSync(process.execPath) || r.cliPath !== realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))) throw new ServiceError('SERVICE_IDENTITY')
  verifyUnit(r)
  serviceEnvironment(stateDir) // Validation only. supervised-child supplies these before the service Node process starts.
}
export function hostIdentity() {
  const user = userInfo()
  return { platform: process.platform, uid: user.uid, home: user.homedir, node: process.execPath, cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)) }
}
