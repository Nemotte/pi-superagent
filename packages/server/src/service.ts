import { Runtime } from './runtime.js'
import { PiDriver } from './pi-driver.js'
import { serveApi } from './http.js'
import { readToken } from './config.js'
import { readManagement } from './management.js'
import type { GitHubClientFactory } from './sources/github-source.js'
export async function startService(stateDir: string, options: { port?: number; onShutdown?: () => void; githubClient?: GitHubClientFactory; now?: () => number } = {}) {
  let runtime: Runtime
  const driver = new PiDriver({ tool: (target, name, args) => runtime.tool(target, name, args), event: (target, event) => runtime.event(target, event) })
  runtime = new Runtime(stateDir, driver, { githubClient: options.githubClient, now: options.now })
  try {
    const api = await serveApi(runtime, readManagement(stateDir) === 'local' ? undefined : readToken(stateDir), options.port, { shutdown: options.onShutdown })
    runtime.start()
    let closing: Promise<void> | undefined
    return { runtime, url: api.url, close: () => closing ??= (async () => { await api.close(); await runtime.close() })() }
  } catch (error) { await runtime.close(); throw error }
}
