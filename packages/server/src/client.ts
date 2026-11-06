import { request } from 'node:http'
import { readConfig, readToken } from './config.js'
import { readManagement } from './management.js'
export class InstanceClient {
  readonly url: string
  private token?: string
  private checked = false
  constructor(readonly stateDir: string) { this.url = `http://127.0.0.1:${readConfig(stateDir).port}`; this.token = readManagement(stateDir) === 'local' ? undefined : readToken(stateDir) }
  private async fetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    // CLI lifecycle traffic always goes directly to this loopback port, independent of model/proxy fetch state.
    return new Promise((resolve, reject) => {
      const req = request(`${this.url}/api/v1/${path}`, { method, agent: false, signal: AbortSignal.timeout(10000), headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), 'x-superagent-local': '1', 'content-type': 'application/json',
      } }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 8 * 1024 * 1024) { req.destroy(Error('Super-agent response exceeds 8 MiB')); return }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          const status = response.statusCode || 500
          let value: { error?: string }
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          catch { reject(Error(status < 200 || status >= 300 ? `HTTP ${status}` : 'Invalid Super-agent JSON response')); return }
          if (status < 200 || status >= 300) reject(Error(value?.error || `HTTP ${status}`))
          else resolve(value)
        })
      })
      req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (!this.checked) {
      const status = await this.fetch('status') as { protocol: number; instanceId: string }
      if (status.protocol !== 1 || status.instanceId !== readConfig(this.stateDir).instanceId) throw Error('Incompatible API protocol or wrong instance')
      this.checked = true
    }
    return this.fetch(path, method, body)
  }
}
