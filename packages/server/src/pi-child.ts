import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from 'typebox'
import { z } from 'zod'
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ResourceLoader } from '@earendil-works/pi-coding-agent'
import type { AgentTarget, Delivery } from './agent-protocol.js'
import { encodeDelivery, persistedDeliveryIds } from './delivery.js'
import { Jobs } from './jobs.js'
import { hostTools } from './agent-tools.js'
import { rolePrompt, agentInstructions } from './prompts.js'
import { configureAgentNetwork } from './network.js'
let session: AgentSession | undefined, manager: SessionManager | undefined, jobs: Jobs | undefined
let shuttingDown = false, initializing = false, lastError: string | undefined
const waiting = new Set<string>()
const calls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
function send(value: unknown): void { if (process.connected) process.send?.(value, () => {}) }
function reconcile(): void {
  const ids = persistedDeliveryIds(manager?.getSessionFile())
  for (const id of waiting) if (ids.has(id)) { waiting.delete(id); send({ type: 'event', event: { type: 'read', deliveryId: id } }); send({ type: 'ack', id }) }
}
async function rpc(name: string, args: unknown): Promise<unknown> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(Error('Host tool request timed out')) }, 30000)
    calls.set(id, { resolve, reject, timer }); send({ type: 'tool', id, name, args })
  })
}
async function initialize(target: AgentTarget): Promise<void> {
  if (!target.cwd || !target.agentDir || !target.sessionDir || !target.model) throw Error(`Configure ${target.role}Model before dispatching work`)
  configureAgentNetwork()
  mkdirSync(target.sessionDir, { recursive: true, mode: 0o700 })
  const modelRuntime = await ModelRuntime.create({ authPath: join(target.agentDir, 'auth.json'), modelsPath: join(target.agentDir, 'models.json'), modelsStorePath: join(target.agentDir, 'catalog.json'), allowModelNetwork: false })
  const model = modelRuntime.getModel(target.model.provider, target.model.id)
  if (!model) throw Error(`Unknown configured model ${target.model.provider}/${target.model.id}`)
  manager = SessionManager.continueRecent(target.cwd, target.sessionDir)
  const instructions = rolePrompt(target)
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: agentInstructions(target) }), getSystemPrompt: () => instructions, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  }
  const customTools = hostTools(target, async (name, args) => {
    if (name === 'report' && jobs?.running && (args as { state: string }).state === 'ready') throw Error('Background jobs are still running; inspect or cancel them before reporting ready')
    return rpc(name, args)
  })
  if (target.role === 'worker') {
    jobs = new Jobs(join(target.sessionDir, 'jobs'), target.cwd, job => {
      if (shuttingDown) return
      void session?.sendUserMessage(encodeDelivery({ id: `job:${job.id}`, text: JSON.stringify({ kind: 'job_result', job }) }), { deliverAs: 'followUp' }).catch(error => send({ type: 'event', event: { type: 'error', error: String(error) } }))
    }, join(target.agentDir, 'home'))
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} })
    customTools.push(
      { name: 'job_start', label: 'Start background job', description: 'Start a managed process and return immediately. Executable plus argv; no implicit shell.', parameters: Type.Object({ executable: Type.String({ minLength: 1, maxLength: 1000 }), args: Type.Array(Type.String({ maxLength: 10000 }), { maxItems: 100 }), timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 3600000 })) }), execute: async (_id, args) => { const a = z.object({ executable: z.string().min(1), args: z.array(z.string()), timeoutMs: z.number().int().min(1000).max(3600000).optional() }).parse(args); return result(jobs!.start(a.executable, a.args, a.timeoutMs)) } },
      { name: 'job_status', label: 'Read job status', description: 'Inspect bounded job output, exit status and interruptions.', parameters: Type.Object({ id: Type.Optional(Type.String()) }), execute: async (_id, args) => { const a = z.object({ id: z.string().optional() }).parse(args); return result(a.id ? jobs!.status(a.id) : jobs!.list()) } },
      { name: 'job_cancel', label: 'Cancel job', description: 'Terminate a managed process tree.', parameters: Type.Object({ id: Type.String() }), execute: async (_id, args) => { const a = z.object({ id: z.string() }).parse(args); await jobs!.cancel(a.id); return result(jobs!.status(a.id)) } },
    )
  }
  const tools = target.role === 'router' ? [] : ['read', 'write', 'edit', 'ls', 'find', 'grep']
  const created = await createAgentSession({ cwd: target.cwd, agentDir: target.agentDir, model, modelRuntime, resourceLoader, sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 }, compaction: { enabled: true } }), tools: [...tools, ...customTools.map(t => t.name)], customTools })
  session = created.session
  session.subscribe(event => {
    if (event.type === 'message_end') {
      if (event.message.role === 'assistant') lastError = event.message.stopReason === 'error' ? event.message.errorMessage || 'Model error' : undefined
      setImmediate(() => { try { reconcile() } catch (error) { send({ type: 'fatal', error: String(error) }) } })
    }
    if (event.type === 'agent_settled') setImmediate(() => { reconcile(); if (!jobs?.running) send({ type: 'event', event: { type: 'settled', failed: event.aborted || !!lastError, error: lastError } }) })
  })
  send({ type: 'ready' })
}
async function deliver(delivery: Delivery): Promise<void> {
  if (!session || !manager) throw Error('Agent not initialized')
  if (persistedDeliveryIds(manager.getSessionFile()).has(delivery.id)) { send({ type: 'ack', id: delivery.id }); return }
  if (waiting.has(delivery.id)) return
  waiting.add(delivery.id)
  if (delivery.wake === false) await session.sendCustomMessage({ customType: 'superagent-notice', content: encodeDelivery(delivery), display: false }, { triggerTurn: false })
  else await session.sendUserMessage(encodeDelivery(delivery), { deliverAs: 'steer', expandPromptTemplates: false })
  reconcile()
}
async function stop(): Promise<void> {
  if (shuttingDown) return; shuttingDown = true
  const force = setTimeout(() => process.exit(1), 2500)
  for (const c of calls.values()) { clearTimeout(c.timer); c.reject(Error('Host disconnected')) } calls.clear()
  await jobs?.close(); await session?.abort(); session?.dispose(); clearTimeout(force); process.exit(0)
}
process.on('message', (message: { type: string; target?: AgentTarget; delivery?: Delivery; id?: string; result?: unknown; error?: string }) => {
  if (message.type === 'init' && !initializing) { initializing = true; void initialize(message.target!).catch(error => send({ type: 'fatal', error: String(error) })) }
  if (message.type === 'deliver') void deliver(message.delivery!).catch(error => { waiting.delete(message.delivery!.id); send({ type: 'event', event: { type: 'error', error: String(error) } }); send({ type: 'nack', id: message.delivery!.id, error: String(error) }) })
  if (message.type === 'tool_result' && message.id) {
    const c = calls.get(message.id); if (!c) return; clearTimeout(c.timer); calls.delete(message.id)
    if (message.error) c.reject(Error(message.error)); else c.resolve(message.result)
  }
  if (message.type === 'stop') void stop()
})
process.on('disconnect', () => { void stop() }); process.on('SIGTERM', () => { void stop() }); process.on('SIGINT', () => { void stop() })
