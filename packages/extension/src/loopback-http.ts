import { request } from 'node:http'
/** A fresh direct connection: model fetch/Undici proxy state and pre-restart pools are not management transport. */
export async function loopbackRequest(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; value: unknown }> {
  const target = new URL(url)
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.username || target.password) throw Error('Use a loopback HTTP endpoint')
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers, agent: false, signal: AbortSignal.timeout(10000) }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) { req.destroy(Error('Super-agent response exceeds 8 MiB')); return }
        chunks.push(chunk)
      })
      res.once('error', reject)
      res.once('end', () => {
        const status = res.statusCode || 500
        try { resolve({ status, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch { if (status < 200 || status >= 300) resolve({ status, value: {} }); else reject(Error('Invalid Super-agent JSON response')) }
      })
    })
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
