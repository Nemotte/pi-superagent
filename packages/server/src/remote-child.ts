// One SSH stdio control operation. stdout is a private JSONL protocol, never a log.
import { fork, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { remoteOperation, remoteIdentity, RemoteError } from './remote-control.js'
import { jobEnvironment } from './environment.js'
const modelSchema = z.object({ operation: z.literal('model'), stateDir: z.string().min(1).max(4096).refine(p => isAbsolute(p) && !/[\x00-\x1f\x7f]/.test(p)), expected: z.unknown(), request: z.object({ operation: z.enum(['catalog', 'check', 'login', 'probe']), provider: z.string().min(1).max(120).optional(), model: z.string().min(1).max(200).optional(), method: z.enum(['oauth', 'api_key']).optional() }).strict() }).strict()
const controller = new AbortController(), decoder = new StringDecoder('utf8'), prompts = new Set<number>()
let child: ChildProcess | undefined, buffer = '', size = 0, started = false, finished = false
const deadline = setTimeout(() => end({ type: 'error', code: 'TIMEOUT' }), 370000)
function cleanup() { clearTimeout(deadline); controller.abort(); prompts.clear(); if (child?.connected) child.disconnect(); child?.kill() }
function end(message?: unknown) {
  if (finished) return; finished = true; cleanup()
  if (message) process.stdout.write(JSON.stringify(message) + '\n', () => process.exit(0))
  else process.exit(0)
}
function send(message: unknown) {
  const line = JSON.stringify(message) + '\n'
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) { end({ type: 'error', code: 'OUTPUT_LIMIT' }); return }
  if (!finished) process.stdout.write(line)
}
function model(input: unknown) {
  const r = modelSchema.parse(input); remoteIdentity(r.stateDir, r.expected)
  child = fork(fileURLToPath(new URL('./setup-child.js', import.meta.url)), [], { execArgv: [], env: jobEnvironment(join(r.stateDir, 'agent', 'home')), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  child.on('error', () => end({ type: 'error', code: 'MODEL_START' }))
  child.on('exit', () => end({ type: 'error', code: 'MODEL_EXIT' }))
  child.on('message', (m: any) => {
    if (m.type === 'result') end({ type: 'result', value: m.value })
    else if (m.type === 'error') end({ type: 'error', code: 'MODEL_FAILED' })
    else if (m.type === 'prompt') { prompts.add(m.id); send(m) }
    else if (m.type === 'cancel-prompt') { prompts.delete(m.id); send(m) }
    else if (m.type === 'notify') send(m)
  })
  child.send({ type: 'init', stateDir: r.stateDir, request: r.request }, error => { if (error) end({ type: 'error', code: 'MODEL_START' }) })
}
async function receive(message: unknown) {
  const m = z.object({ type: z.enum(['init', 'answer']), request: z.unknown().optional(), id: z.number().int().positive().optional(), value: z.string().max(32768).optional() }).strict().parse(message)
  if (m.type === 'answer') {
    if (!m.id || m.value === undefined || !prompts.delete(m.id) || !child?.connected) return
    child.send({ type: 'answer', id: m.id, value: m.value }, error => { if (error) end({ type: 'error', code: 'MODEL_EXIT' }) }); return
  }
  if (started) throw new RemoteError('PROTOCOL'); started = true
  if ((m.request as any)?.operation === 'model') model(m.request)
  else if ((m.request as any)?.operation === 'tunnel') {
    const value = await remoteOperation({ ...(m.request as object), operation: 'connect' }, controller.signal)
    clearTimeout(deadline); send({ type: 'ready', value })
  } else end({ type: 'result', value: await remoteOperation(m.request, controller.signal) })
}
process.stdin.on('data', (chunk: Buffer) => {
  size += chunk.length
  if (size > 256 * 1024) { end({ type: 'error', code: 'INPUT_LIMIT' }); return }
  buffer += decoder.write(chunk)
  while (!finished && buffer.includes('\n')) {
    const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    try { void receive(JSON.parse(line)).catch(error => end({ type: 'error', code: error instanceof RemoteError ? error.code : 'OPERATION_FAILED' })) }
    catch { end({ type: 'error', code: 'PROTOCOL' }) }
  }
})
process.stdin.on('end', () => end()); process.stdin.on('error', () => end()); process.stdout.on('error', () => end())
process.once('SIGTERM', () => end()); process.once('SIGINT', () => end())
