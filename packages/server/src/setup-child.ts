// One-shot, interactive setup only. No sessions, repository resources or agent tools.
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { configureAgentNetwork } from './network.js'
import { readConfig } from './config.js'
import { jobEnvironment } from './environment.js'
import { setupModel, type SetupInteraction, type SetupRequest } from './setup-model.js'
const send = (message: unknown) => { if (process.connected) process.send?.(message) }
const replies = new Map<number, (value: string) => void>(); let seq = 0; let started = false
process.on('disconnect', () => process.exit(0))
process.on('message', (message: any) => {
  if (message.type === 'answer') { replies.get(message.id)?.(message.value); return }
  if (message.type !== 'init' || started) return
  started = true
  void run(message.stateDir, message.request).then(value => send({ type: 'result', value }), () => send({ type: 'error', message: '实例模型操作未通过。请检查网络、登录方式及账号支持的型号，再运行 /superagent setup；未自动重试。' }))
})
async function run(stateDir: string, request: SetupRequest): Promise<unknown> {
  const config = readConfig(stateDir)
  // Also sanitize when launched directly; neither personal auth files nor ambient keys are used.
  const agent = join(stateDir, 'agent'); const env = jobEnvironment(join(agent, 'home'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env, { PI_CODING_AGENT_DIR: agent })
  configureAgentNetwork()
  const runtime = await ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: join(agent, 'models.json'), modelsStorePath: join(agent, 'catalog.json'), allowModelNetwork: false, refreshOnCreate: false })
  const interaction: SetupInteraction = {
    notify: event => send({ type: 'notify', event }),
    prompt: ({ signal, ...prompt }) => new Promise((resolve, reject) => {
      const id = ++seq
      const clear = () => { replies.delete(id); signal?.removeEventListener('abort', abort) }
      const abort = () => { clear(); send({ type: 'cancel-prompt', id }); reject(Error('Login prompt cancelled')) }
      if (signal?.aborted) { abort(); return }
      replies.set(id, value => { clear(); resolve(value) }); signal?.addEventListener('abort', abort, { once: true })
      send({ type: 'prompt', id, prompt })
    }),
  }
  return setupModel(runtime, request, interaction, config.instanceId)
}
