import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
export interface SetupRequest { operation: 'catalog' | 'check' | 'login' | 'probe'; provider?: string; method?: 'oauth' | 'api_key'; model?: string }
export type SetupInteraction = Parameters<ModelRuntime['login']>[2]
export async function setupModel(runtime: ModelRuntime, request: SetupRequest, interaction?: SetupInteraction, deviceId?: string): Promise<unknown> {
  if (request.operation === 'catalog') return {
    providers: runtime.getProviders().map(p => ({ id: p.id, name: p.name, methods: [...(p.auth.oauth ? ['oauth'] : []), ...(p.auth.apiKey?.login ? ['api_key'] : [])] })),
    models: runtime.getModels().map(m => ({ provider: m.provider, id: m.id, name: m.name })),
  }
  if (!request.provider || !runtime.getProvider(request.provider)) throw Error('Unknown model provider')
  if (request.operation === 'check') return { ready: Boolean(await runtime.getAuth(request.provider).catch(() => undefined)) }
  if (request.operation === 'login') {
    if (!request.method || !interaction) throw Error('Login interaction required')
    await runtime.login(request.provider, request.method, interaction, { agentName: 'Pi Super-agent', ...(deviceId ? { getDeviceId: () => deviceId } : {}) })
    return { ready: Boolean(await runtime.getAuth(request.provider)) }
  }
  if (request.operation !== 'probe') throw Error('Unknown setup operation')
  const model = runtime.getModel(request.provider, request.model || '')
  if (!model) throw Error('Unknown model')
  const response = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, { maxTokens: 32, maxRetries: 0, signal: AbortSignal.timeout(30000) })
  if (response.stopReason === 'error' || response.stopReason === 'aborted') throw Error('模型请求未通过；请检查网络、账号支持的型号和额度。')
  return { verified: true }
}
