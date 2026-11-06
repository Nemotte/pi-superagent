import { fork } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import { jobEnvironment } from './environment.js'
export const ModelCatalogSchema = z.object({
  providers: z.array(z.object({ id: z.string().max(120), name: z.string().max(300), methods: z.array(z.enum(['oauth', 'api_key'])).max(2) })).max(1000),
  models: z.array(z.object({ provider: z.string().max(120), id: z.string().max(200), name: z.string().max(500).optional() })).max(20000),
})
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>
/** Fixed SDK, isolated environment, metadata only. Never import the SDK into the management process. */
export function readModelCatalog(stateDir: string, signal?: AbortSignal): Promise<ModelCatalog> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('Model catalog read cancelled')); return }
    const child = fork(new URL('./setup-child.js', import.meta.url), [], { execArgv: [], env: jobEnvironment(join(stateDir, 'agent', 'home')), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    let settled = false
    const finish = (error?: Error, result?: ModelCatalog) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (child.connected) child.disconnect(); child.kill()
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => finish(Error('Model catalog read cancelled'))
    const timer = setTimeout(() => finish(Error('型号目录读取超时；可在 Pi 中运行 /superagent models。')), 10000)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', () => finish(Error('无法启动型号目录进程。')))
    child.on('exit', () => finish(Error('型号目录进程提前退出。')))
    child.on('message', (message: any) => {
      if (settled) return
      if (message.type !== 'result') { finish(Error('型号目录读取未完成。')); return }
      const result = ModelCatalogSchema.safeParse(message.value)
      if (!result.success || JSON.stringify(result.data).length > 4 * 1024 * 1024) finish(Error('型号目录格式无效或过大。'))
      else finish(undefined, result.data)
    })
    child.send({ type: 'init', stateDir, request: { operation: 'catalog' } }, error => { if (error) finish(Error('型号目录进程连接失败。')) })
  })
}
