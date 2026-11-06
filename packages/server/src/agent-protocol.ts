import type { Config } from './config.js'
export interface AgentTarget {
  role: 'router' | 'worker'; key: string; cwd?: string; sessionDir?: string; agentDir?: string
  github?: boolean
  workspace?: NonNullable<Config['workspace']> & { instructions?: string }
  ticketId?: string; assignmentId?: string; model?: Config['workerModel']; instructions?: string
}
export interface Delivery { id: string; text: string; wake?: false }
export interface AgentEvent { type: 'read' | 'settled' | 'error'; deliveryId?: string; error?: string; failed?: boolean }
export interface AgentDriver {
  send(target: AgentTarget, delivery: Delivery): Promise<void>
  stop(key: string): Promise<void>
  close(): Promise<void>
}
export type AgentToolHandler = (target: AgentTarget, name: string, args: unknown) => Promise<unknown>
export type AgentEventHandler = (target: AgentTarget, event: AgentEvent) => void
