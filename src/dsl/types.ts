// Shared type contracts for the whole system. Everything compiles against these.

/** The closed set of backend providers. Model strings stay open — each backend is authoritative. */
export const PROVIDER_IDS = ["codex", "claude-code", "opencode", "pi"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** read-only: no writes; workspace-write: write within cwd; danger-full-access: unrestricted. */
export type Sandbox = "read-only" | "workspace-write" | "danger-full-access"

// Union of both providers' reasoning-effort levels. codex: none/minimal/low/medium/high/xhigh;
// claude-code: low/medium/high/xhigh/max. Each worker maps to its nearest supported value.
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type Approval = "never" | "on-request"

/** A plain JSON Schema object (draft-07-ish). We do not constrain it further at the type level. */
export type JSONSchema = Record<string, unknown>

/** Options an author passes to `agent()`. All optional; defaults come from meta/config/CLI. */
export interface AgentOpts {
  provider?: ProviderId
  label?: string
  phase?: string
  model?: string
  effort?: Effort
  cwd?: string
  sandbox?: Sandbox
  approval?: Approval
  instructions?: string
  schema?: JSONSchema
  worktree?: boolean | string
  /** Pin a stable resume cache key; otherwise the chained key is used. */
  key?: string
  /** Hard cap on agent turns (provider-enforced where supported). */
  maxTurns?: number
}

/** A fully-resolved request handed to a Worker (no undefined for required policy fields). */
export interface AgentSpec {
  prompt: string
  provider: ProviderId
  model?: string
  effort?: Effort
  cwd: string
  sandbox: Sandbox
  approval: Approval
  instructions?: string
  schema?: JSONSchema
  maxTurns?: number
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 }
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

export type AgentStatus = "completed" | "failed" | "interrupted"

/** Normalized result every Worker returns. */
export interface AgentResult {
  text: string
  /** Present only when the spec carried a schema. Already client-side validated. */
  structured?: unknown
  status: AgentStatus
  usage: AgentUsage
}

/** The `meta` literal at the top of a workflow file. */
export interface Meta {
  name: string
  description: string
  phases?: Array<{ title: string; detail?: string }>
  defaultProvider?: ProviderId
  defaultModel?: string
  defaultSandbox?: Sandbox
  whenToUse?: string
}

/** The token budget surfaced to a workflow. `total` is the ceiling (null = no ceiling). */
export interface WorkflowBudget {
  total: number | null
  spent(): number
  remaining(): number
}

/** The injected globals available inside a workflow file. */
export interface WorkflowGlobals {
  agent: <T = string>(prompt: string, opts?: AgentOpts) => Promise<T>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<T[]>
  pipeline: (items: unknown[], ...stages: PipelineStage[]) => Promise<unknown[]>
  phase: (title: string) => void
  log: (msg: string) => void
  now: () => number
  random: () => number
  budget: WorkflowBudget
  args: unknown
}

export type PipelineStage = (prev: unknown, item: unknown, index: number) => unknown | Promise<unknown>

/** Resolved per-run defaults (filled at the CLI/config boundary). */
export interface RunDefaults {
  provider: ProviderId
  model?: string
  effort?: Effort
  sandbox: Sandbox
  approval: Approval
  cwd: string
  concurrency: number
  /** Lifetime agent() call cap (runaway-loop backstop). */
  maxAgents: number
  /** Max items per parallel()/pipeline() call. */
  maxFanout: number
  /** Output-token ceiling for the run (null = no ceiling). */
  budget: number | null
}

export const DEFAULTS: Omit<RunDefaults, "cwd"> = {
  provider: "codex",
  sandbox: "read-only",
  approval: "never",
  concurrency: 100,
  maxAgents: 1000,
  maxFanout: 4096,
  budget: null,
}
