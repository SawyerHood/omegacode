// Mirrors the omegacode viewer API (src/server/serve.ts + runtime/events.ts + runtime/transcript.ts).

export type ProviderId = "codex" | "claude-code" | (string & {})
export type RunStatus = "started" | "completed" | "failed" | "interrupted" | "unknown" | "stale"
export type AgentState = "queued" | "running" | "done" | "failed" | "skipped"

export interface AgentSnapshot {
  index: number
  phaseIndex?: number
  phaseTitle?: string
  label: string
  provider: ProviderId
  model?: string
  state: AgentState
  cached?: boolean
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  lastTool?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  t: number
}

export interface PhaseSnapshot {
  index: number
  title: string
  agents: AgentSnapshot[]
}

export interface RunSnapshot {
  runId: string
  status: RunStatus
  name?: string
  workflowFile?: string
  error?: string
  startedAt?: number
  endedAt?: number
  phases: PhaseSnapshot[]
  agents: AgentSnapshot[]
  logs: Array<{ t: number; message: string }>
}

export interface RunSummary {
  runId: string
  name?: string
  status: RunStatus
  agents: number
  startedAt?: number
  endedAt?: number
}

export type WorkflowEvent =
  | { t: number; type: "run"; status: RunStatus; workflowFile?: string; error?: string }
  | { t: number; type: "phase"; index: number; title: string }
  | ({ t: number; type: "agent" } & Omit<AgentSnapshot, "t">)
  | { t: number; type: "log"; message: string }

export type ChatChunk =
  | { t: number; kind: "meta"; index: number; label: string; provider: ProviderId; model?: string; prompt: string }
  | { t: number; kind: "text"; text: string }
  | { t: number; kind: "reasoning"; text: string }
  | { t: number; kind: "tool"; id?: string; name: string; input?: unknown }
  | { t: number; kind: "tool-result"; id?: string; name?: string; output?: string; isError?: boolean }
  | { t: number; kind: "status"; state: "running" | "done" | "failed"; error?: string; cached?: boolean }

export const isTerminalRun = (s: RunStatus): boolean => s === "completed" || s === "failed" || s === "interrupted" || s === "stale"
export const isTerminalAgent = (s: AgentState): boolean => s === "done" || s === "failed" || s === "skipped"
