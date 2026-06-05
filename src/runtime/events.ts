// The events.jsonl record schema — feeds both the terminal renderer and the viewer server.
// journal.jsonl is the resume log (completed results); events.jsonl is the observability log
// (live state, including in-flight and failed agents).

import type { ProviderId } from "../dsl/types.js"

export type AgentState = "queued" | "running" | "done" | "failed" | "skipped"

export type WorkflowEvent =
  | { t: number; type: "run"; status: "started" | "completed" | "failed" | "interrupted"; runId: string; workflowFile?: string; error?: string }
  | { t: number; type: "phase"; index: number; title: string }
  | {
      t: number
      type: "agent"
      index: number
      phaseIndex?: number
      phaseTitle?: string
      label: string
      provider: ProviderId
      model?: string
      state: AgentState
      cached?: boolean
      queuedAt?: number
      startedAt?: number
      lastProgressAt?: number
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
      lastTool?: string
      promptPreview?: string
      resultPreview?: string
      error?: string
    }
  | { t: number; type: "log"; message: string }

/** WorkflowEvent without the `t` timestamp — distributive so each variant keeps its own fields. */
export type WorkflowEventInput = WorkflowEvent extends infer E ? (E extends unknown ? Omit<E, "t"> : never) : never

/** Sink the runtime writes events to (one per run). Implemented over an events.jsonl file. */
export interface EventSink {
  emit(event: WorkflowEventInput): void
  close(): Promise<void>
}
