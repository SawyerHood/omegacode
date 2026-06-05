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
  WorkflowGlobals,
} from "./dsl/types.js"

export { runWorkflow } from "./runtime/run.js"
export type { RunOptions, RunOutcome, RunOverrides } from "./runtime/run.js"
export { parseWorkflow, runInSandbox, WorkflowSyntaxError } from "./runtime/sandbox.js"
export { Journal, dataRoot, runDir } from "./runtime/journal.js"
export type { WorkflowEvent } from "./runtime/events.js"
export type { Worker, WorkerContext, WorkerFactory } from "./worker/index.js"
export { AgentError, AgentInterrupted } from "./worker/index.js"
