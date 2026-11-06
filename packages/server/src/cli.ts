#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createBackup, checkBackup, restoreBackup, pruneBackups } from './backup.js'
import { parseArgs } from './cli-options.js'
import { initialize, readConfig, type Config } from './config.js'
import { configureManagement, ManagementMode, readManagement } from './management.js'
import { InstanceClient } from './client.js'
import { startService } from './service.js'
import { serviceOperation } from './supervision.js'
import { assertSupervisedServe, registeredService } from './supervision-config.js'
import { discoverWorkspace, repositoryMember, validateWorkspace, workspaceConfig } from './repositories.js'
const help = `Pi Super-agent 0.1.0-alpha.1 (Node.js 24+)
Usage: pi-superagent <command> [arguments] [--state-dir PATH]
  init --repo PATH [--port 4317] [--paused] [--max-workers 1] [--management local|token]
                                Initialize one repository instance
  discover --repo ROOT          Discover workspace repositories without modifying them
  init --workspace --repo ROOT [--member RELATIVE_PATH ...]
                                Initialize one multi-repository workspace
  workspace [TICKET_ID]         Inspect members, pinned heads and per-repository results
  serve                         Run in the foreground
  start | shutdown              Start / stop (systemd when registered, otherwise detached)
  service plan|status           Inspect Linux user-service plan / registration
  service install|enable|disable|uninstall --yes
                                Explicitly manage systemd user supervision (install offline)
  management local|token        Change access mode offline (local trusts this machine)
                                [--expected-instance-id ID]
  status | tickets | events | sources | decisions | triggers | threads
                                Inspect service state and records
  github poll                   Poll GitHub now (respects rate limits)
  diagnostics ID                Read bounded session and job diagnostics
  request TEXT [--id ID]         Submit an explicit task
  show ID                       Show ticket details
  followup ID TEXT [--id ID]     Add input to a ticket
  stop ID | retry ID            Revoke / retry a ticket
  pause | resume                Pause / resume dispatch
  config                        Show versioned configuration
  model router|worker PROVIDER MODEL  Configure a model
  doctor                        Check Node, Git and repository
  backup DEST                   Verified offline snapshot (includes credentials)
  backup-check BACKUP            Verify payload, schema and external Git dependencies
  restore BACKUP                Preview same-host original-path restore; --yes to apply
                                --expected-instance-id UUID (target must not exist)
  backup-prune ROOT --keep N     Preview retention of this instance's verified snapshots
                                --expected-instance-id UUID; --yes to delete
Unregistered start is detached; use service install to opt into Linux systemd user supervision. GitHub uses an instance PAT; Feishu is deferred.`
const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2)); const [id, ...rest] = o.args
  if (o.command === 'help') { print(help); return }
  if (o.command === 'version') { print('0.1.0-alpha.1'); return }
  if (o.command === 'discover') { print(await discoverWorkspace(o.repository)); return }
  if (o.command === 'init') {
    let workspace: Config['workspace'] = null
    if (o.workspace) {
      const members = o.members.length ? o.members.map(repositoryMember) : (await discoverWorkspace(o.repository)).repositories
      workspace = workspaceConfig(await validateWorkspace(o.repository, { repositories: members.map(({ id, path }) => ({ id, path })) }))
    } else execFileSync('git', ['-C', o.repository, 'rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' })
    const config = initialize(o.stateDir, { repository: o.workspace ? realpathSync(o.repository) : o.repository, workspace, management: o.management, port: o.port, paused: o.paused, maxWorkers: o.maxWorkers })
    print({ instanceId: config.instanceId, stateDir: o.stateDir, url: `http://127.0.0.1:${config.port}`, management: readManagement(o.stateDir), ...(o.management === 'token' ? { tokenFile: join(o.stateDir, 'admin.token') } : {}), next: 'Run serve and open the Web panel. Configure model credentials separately.' }); return
  }
  if (['backup', 'backup-check', 'restore', 'backup-prune'].includes(o.command)) {
    if (o.args.length !== 1) throw Error('Exactly one backup/destination/root path is required')
    if (o.command === 'backup') print(await createBackup(o.stateDir, id, { expectedId: o.expectedInstanceId }))
    else if (o.command === 'backup-check') print(await checkBackup(id))
    else if (o.command === 'restore') print(await restoreBackup(id, o.stateDir, { expectedId: o.expectedInstanceId, confirmed: o.confirmed }))
    else {
      if (o.keep === undefined) throw Error('backup-prune requires --keep N')
      print(await pruneBackups(id, o.stateDir, { expectedId: o.expectedInstanceId, keep: o.keep, confirmed: o.confirmed }))
    }
    return
  }
  if (o.expectedInstanceId && readConfig(o.stateDir).instanceId !== o.expectedInstanceId) throw Error('Instance identity mismatch')
  if (o.command === 'service') {
    if (o.args.length !== 1 || !['plan', 'status', 'install', 'enable', 'disable', 'uninstall'].includes(id)) throw Error('Usage: service plan|status|install|enable|disable|uninstall [--yes]')
    print(await serviceOperation(o.stateDir, id, { confirmed: o.confirmed, expectedId: o.expectedInstanceId })); return
  }
  if (o.supervised && o.command !== 'serve') throw Error('--supervised is only valid for serve')
  if (o.command === 'management') {
    if (o.args.length !== 1) throw Error('Usage: management local|token (stop the service first)')
    configureManagement(o.stateDir, ManagementMode.parse(id), o.expectedInstanceId)
    print({ management: readManagement(o.stateDir) }); return
  }
  if (o.command === 'doctor') {
    const config = readConfig(o.stateDir)
    print({ node: process.version, platform: process.platform, git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      repository: config.workspace ? config.repository : execFileSync('git', ['-C', config.repository, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
      ...(config.workspace ? { repositories: (await validateWorkspace(config.repository, config.workspace)).map(({ id, path, head, dirty }) => ({ id, path, head, dirty })) } : {}), stateDir: o.stateDir,
      authFileConfigured: existsSync(join(o.stateDir, 'agent', 'auth.json')), service: await new InstanceClient(o.stateDir).request('status').catch(error => String(error)) }); return
  }
  if (o.command === 'serve') {
    if (o.supervised) assertSupervisedServe(o.stateDir, o.expectedInstanceId)
    else if (registeredService(o.stateDir)) throw Error('Instance is systemd-managed; use start or shutdown, not bare serve')
    let service: Awaited<ReturnType<typeof startService>> | undefined
    const stop = () => { void service?.close().catch(error => { console.error(error); process.exitCode = 1 }) }
    service = await startService(o.stateDir, { onShutdown: stop })
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    print(`Pi Super-agent listening at ${service.url}`); return
  }
  if (['start', 'shutdown'].includes(o.command) && registeredService(o.stateDir)) {
    const managed = await serviceOperation(o.stateDir, o.command === 'start' ? 'start' : 'stop', { confirmed: true, expectedId: o.expectedInstanceId })
    if (o.command === 'shutdown') { print(managed); return }
    const client = new InstanceClient(o.stateDir), deadline = performance.now() + 15000
    while (performance.now() < deadline) { const ready = await client.request('status').catch(() => undefined); if (ready) { print({ url: client.url, status: ready, supervision: managed }); return }; await sleep(100) }
    throw Error('Managed service start not verified; use service status and inspect service.log')
  }
  const client = new InstanceClient(o.stateDir)
  if (o.command === 'start') {
    const status = await client.request('status').catch(() => undefined)
    if (status) { print(status); return }
    const log = join(o.stateDir, 'service.log'); const fd = openSync(log, 'a', 0o600); chmodSync(log, 0o600)
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--state-dir', o.stateDir], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
    closeSync(fd); child.unref()
    for (let i = 0; i < 60; i++) { await sleep(100); const ready = await client.request('status').catch(() => undefined); if (ready) { print({ url: client.url, status: ready }); return } }
    throw Error(`Service did not start; inspect ${log}`)
  }
  if (['status', 'tickets', 'events', 'config', 'sources', 'decisions', 'triggers', 'threads'].includes(o.command)) { print(await client.request(o.command)); return }
  if (o.command === 'workspace') { print(await client.request(id ? `tickets/${encodeURIComponent(id)}/workspace` : 'workspace')); return }
  if (o.command === 'github' && id === 'poll') { print(await client.request('sources/github/poll', 'POST')); return }
  if (o.command === 'diagnostics') { if (!id) throw Error('Ticket ID is required'); print(await client.request(`tickets/${encodeURIComponent(id)}/diagnostics`)); return }
  if (o.command === 'shutdown') { print(await client.request('shutdown', 'POST')); return }
  if (o.command === 'request') { print(await client.request('tickets', 'POST', { id: o.requestId || randomUUID(), text: o.args.join(' ') })); return }
  if (['show', 'followup', 'stop', 'retry'].includes(o.command)) {
    if (!id) throw Error('Ticket ID is required'); const path = `tickets/${encodeURIComponent(id)}`
    print(await client.request(o.command === 'show' ? path : `${path}/${o.command}`, o.command === 'show' ? 'GET' : 'POST', o.command === 'followup' ? { id: o.requestId || randomUUID(), text: rest.join(' ') } : undefined)); return
  }
  if (['pause', 'resume', 'model'].includes(o.command)) {
    const settings = await client.request('config') as { config: Config; revision: number }
    if (o.command === 'model') {
      if (!['router', 'worker'].includes(id) || rest.length !== 2) throw Error('Usage: model router|worker PROVIDER MODEL')
      settings.config[id === 'router' ? 'routerModel' : 'workerModel'] = { provider: rest[0], id: rest[1] }
    } else settings.config.paused = o.command === 'pause'
    print(await client.request('config', 'PUT', settings)); return
  }
  throw Error(`Unknown command: ${o.command}\n${help}`)
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
