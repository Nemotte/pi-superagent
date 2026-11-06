import * as http from 'node:http'
/** Run after SDK imports: its Undici dependency replaces Node's startup dispatcher. */
export function configureAgentNetwork(): void {
  if (process.env.NODE_USE_ENV_PROXY === '0') return
  if (!['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some(key => process.env[key]?.trim())) return
  if (!('setGlobalProxyFromEnv' in http) || typeof http.setGlobalProxyFromEnv !== 'function') {
    throw Error('HTTP proxy support requires Node http.setGlobalProxyFromEnv; use Node.js 24.14.1 or newer')
  }
  http.setGlobalProxyFromEnv()
}
