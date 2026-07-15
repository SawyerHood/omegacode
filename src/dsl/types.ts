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

/**
 * Provider and model are specified together or not at all (both-or-neither). A lone `provider`
 * used to inherit the run-default `model` — a model meant for a DIFFERENT provider (a real run
 * passed gpt-5.5 to claude-code that way). Pairing them at every specification site (per-call
 * opts, meta defaults, CLI flags) makes that mix impossible; model strings themselves stay open.
 */
export type ProviderModelPair =
  | { provider: ProviderId; model: string }
  | { provider?: never; model?: never }

/** Options an author passes to `agent()`. All optional; defaults come from meta/config/CLI. */
interface AgentOptsBase {
  label?: string
  phase?: string
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

export type AgentOpts = AgentOptsBase & ProviderModelPair

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

/** The `meta` literal at the top of a workflow file. defaultProvider/defaultModel follow the
 *  same both-or-neither rule as agent() opts (see ProviderModelPair). */
interface MetaBase {
  name: string
  description: string
  phases?: Array<{ title: string; detail?: string }>
  defaultSandbox?: Sandbox
  whenToUse?: string
}

export type Meta = MetaBase &
  (
    | { defaultProvider: ProviderId; defaultModel: string }
    | { defaultProvider?: never; defaultModel?: never }
  )

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
  // Bounded out of the box: an unqualified parallel() of N thunks otherwise launches N PAID
  // subagents at once — real money, rate-limit thundering herd, and N concurrent subprocesses for
  // per-query providers. 16 mirrors Claude Code's cap ceiling; --concurrency lifts it deliberately.
  concurrency: 16,
  maxAgents: 1000,
  // A single fan-out can never usefully be wider than the lifetime cap: the (maxAgents+1)th agent
  // trips maxAgents mid-run regardless. Keep this <= maxAgents so the static ceiling stays coherent;
  // the dynamic remaining-allowance pre-check in parallel()/pipeline() is the real per-call guard.
  maxFanout: 1000,
  budget: null,
}
