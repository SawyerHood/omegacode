// Library surface (for embedding / tests). The CLI is the primary entry point.

export type {
  AgentOpts,
  AgentResult,
  AgentSpec,
  AgentStatus,
  AgentUsage,
  Approval,
  Effort,
  JSONSchema,
  Meta,
  PipelineStage,
  ProviderId,
  RunDefaults,
  Sandbox,
  WorkflowBudget,
  WorkflowGlobals,
} from "./dsl/types.js"
export { PROVIDER_IDS } from "./dsl/types.js"

export { runWorkflow } from "./runtime/run.js"
export type { RunOptions, RunOutcome, RunOverrides } from "./runtime/run.js"
export { parseWorkflow, runInSandbox, WorkflowSyntaxError } from "./runtime/sandbox.js"
export { listWorkflows, resolveWorkflowName, workflowDirs, WorkflowNotFoundError } from "./runtime/registry.js"
export type { RegistryEntry, Tier } from "./runtime/registry.js"
export { Journal, dataRoot, runDir } from "./runtime/journal.js"
export type { AgentState, EventSink, WorkflowEvent, WorkflowEventInput } from "./runtime/events.js"
export type { EventListener } from "./runtime/event-sink.js"
export type { Worker, WorkerContext, WorkerFactory, WorkerProgress } from "./worker/index.js"
export { AgentError, AgentInterrupted } from "./worker/index.js"
