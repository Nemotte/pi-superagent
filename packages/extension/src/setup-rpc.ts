import { fork } from 'node:child_process'
import { join } from 'node:path'
export interface LoginPrompt { type: 'text' | 'secret' | 'manual_code' | 'select'; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }
export interface LoginEvent { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; links?: Array<{ url: string; label?: string }> }
export interface LoginUI { prompt(prompt: LoginPrompt, signal: AbortSignal): Promise<string | undefined>; notify(event: LoginEvent): void; dispose?(): void }
export interface SetupBackend { setupPath: string; setupEnvironment(home: string): NodeJS.ProcessEnv }
export function setupRpc(backend: SetupBackend, stateDir: string, request: unknown, ui?: LoginUI, timeout = 360000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = fork(backend.setupPath, [], { execArgv: [], env: backend.setupEnvironment(join(stateDir, 'agent', 'home')), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    const prompts = new Map<number, AbortController>(); let settled = false
    const timer = setTimeout(() => finish(Error('初始化超时；可以重新运行 /superagent setup。')), timeout)
    function finish(error?: Error, result?: unknown) {
      if (settled) return; settled = true; clearTimeout(timer)
      for (const controller of prompts.values()) controller.abort(); prompts.clear()
      if (child.connected) child.disconnect(); child.kill()
      try { ui?.dispose?.() } catch { /* cleanup must not change the login outcome */ }
      if (error) reject(error); else resolve(result)
    }
    child.on('error', () => finish(Error('无法启动实例认证进程。')))
    child.on('exit', () => finish(Error('初始化进程提前退出。')))
    child.on('message', (message: any) => {
      if (settled) return
      if (message.type === 'result') finish(undefined, message.value)
      else if (message.type === 'error') finish(Error(message.message))
      else if (message.type === 'notify') {
        try { ui?.notify(message.event) } catch { finish(Error('登录界面未能显示认证进度；实例保留，请重新运行 /superagent setup。')) }
      }
      else if (message.type === 'cancel-prompt') { prompts.get(message.id)?.abort(); prompts.delete(message.id) }
      else if (message.type === 'prompt') {
        if (!ui) { finish(Error('登录需要交互界面。')); return }
        const controller = new AbortController(); prompts.set(message.id, controller)
        void Promise.resolve().then(() => ui.prompt(message.prompt, controller.signal)).then(value => {
          prompts.delete(message.id)
          if (settled || controller.signal.aborted) return
          if (value === undefined) { finish(Error('已取消登录；实例保留，可以稍后继续。')); return }
          if (child.connected) child.send({ type: 'answer', id: message.id, value }, error => { if (error) finish(Error('初始化连接已关闭。')) })
        }).catch(() => {
          if (settled || controller.signal.aborted) return
          finish(Error('登录界面未能完成；实例保留，请重新运行 /superagent setup。'))
        })
      }
    })
    child.send({ type: 'init', stateDir, request }, error => { if (error) finish(Error('初始化连接失败。')) })
  })
}
