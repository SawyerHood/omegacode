import type { AgentResult, AgentSpec, AgentUsage, ProviderId } from "../dsl/types.js"

/** Conversation/progress signals a worker emits while a turn runs (drives the live chat feed). */
export type WorkerProgress =
  | { kind: "text"; text: string } // assistant message text (chunk or delta)
  | { kind: "reasoning"; text: string } // thinking / reasoning text
  | { kind: "tool"; id?: string; name: string; input?: unknown } // tool / command / file-change use
  | { kind: "tool-result"; id?: string; name?: string; output?: string; isError?: boolean }
  | { kind: "usage"; usage: Partial<AgentUsage> }

export interface WorkerContext {
  signal: AbortSignal
  onProgress: (e: WorkerProgress) => void
}

/** A provider backend: runs one agent turn to completion. */
export interface Worker {
  readonly id: ProviderId
  runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult>
  shutdown(): Promise<void>
}

/** Lazily constructs and caches one worker per provider. */
export interface WorkerFactory {
  get(id: ProviderId): Worker
  shutdownAll(): Promise<void>
}

/** A worker raised this when a turn failed for a provider reason (after retries). */
export class AgentError extends Error {
  readonly provider: ProviderId
  readonly code: string
  readonly retryable: boolean
  constructor(args: { provider: ProviderId; code: string; message: string; retryable?: boolean }) {
    super(args.message)
    this.name = "AgentError"
    this.provider = args.provider
    this.code = args.code
    this.retryable = args.retryable ?? false
  }
}

/** Raised when an agent turn was interrupted (Ctrl-C, cancel, stall-abort). */
export class AgentInterrupted extends Error {
  constructor(message = "agent interrupted") {
    super(message)
    this.name = "AgentInterrupted"
  }
}
