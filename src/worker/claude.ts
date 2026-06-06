// ClaudeWorker — drives Claude Code via @anthropic-ai/claude-agent-sdk `query()`.
// Structured output uses the SDK's native `outputFormat: { type: "json_schema" }`; sandbox maps to a
// canUseTool gate (read-only denies write tools). One query() per agent turn.

import { query, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { emptyUsage, type AgentResult, type AgentSpec, type Sandbox } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { toClaudeOutputFormat } from "./schema.js"

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"])

export interface ClaudeWorkerOpts {
  model?: string
  pathToClaudeCodeExecutable?: string
}

export class ClaudeWorker implements Worker {
  readonly id = "claude-code" as const
  constructor(private readonly opts: ClaudeWorkerOpts = {}) {}

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    ctx.signal.addEventListener("abort", onAbort, { once: true })

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model ?? this.opts.model,
      maxTurns: spec.maxTurns,
      settingSources: [],
      permissionMode: "default",
      abortController: abort,
      canUseTool: (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
        if (deniesTool(spec.sandbox, toolName)) {
          return Promise.resolve({ behavior: "deny", message: `${toolName} not allowed in ${spec.sandbox} mode` })
        }
        return Promise.resolve({ behavior: "allow", updatedInput: input })
      },
    }
    // codex-only "minimal" maps to the SDK's lowest; the rest match the SDK effort levels.
    if (spec.effort) options.effort = spec.effort === "minimal" ? "low" : spec.effort
    if (spec.schema) options.outputFormat = toClaudeOutputFormat(spec.schema)
    if (spec.instructions) options.systemPrompt = { type: "preset", preset: "claude_code", append: spec.instructions }
    if (this.opts.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = this.opts.pathToClaudeCodeExecutable

    try {
      let last: SDKMessage | undefined
      for await (const message of query({ prompt: spec.prompt, options })) {
        last = message
        if (message.type === "assistant") {
          for (const block of asBlocks((message.message as { content?: unknown }).content)) {
            if (block.type === "text" && typeof block.text === "string") {
              ctx.onProgress({ kind: "text", text: block.text })
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              ctx.onProgress({ kind: "reasoning", text: block.thinking })
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              ctx.onProgress({ kind: "tool", id: typeof block.id === "string" ? block.id : undefined, name: block.name, input: block.input })
            }
          }
        } else if (message.type === "user") {
          for (const block of asBlocks((message.message as { content?: unknown }).content)) {
            if (block.type === "tool_result") {
              const out = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
              ctx.onProgress({ kind: "tool-result", id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, output: out, isError: block.is_error === true })
            }
          }
        }
      }

      if (!last || last.type !== "result") {
        throw new AgentError({ provider: "claude-code", code: "no_result", message: "claude query ended without a result" })
      }
      const usage = {
        ...emptyUsage(),
        inputTokens: numOr(last.usage?.input_tokens),
        outputTokens: numOr(last.usage?.output_tokens),
        costUsd: numOr(last.total_cost_usd),
      }
      if (last.subtype !== "success") {
        const retryable = last.subtype === "error_max_turns" || /rate|overload|529|429/i.test(last.subtype)
        throw new AgentError({ provider: "claude-code", code: last.subtype, message: `claude result: ${last.subtype}`, retryable })
      }
      return {
        text: last.result,
        structured: spec.schema ? last.structured_output : undefined,
        status: "completed",
        usage,
      }
    } catch (err) {
      if (ctx.signal.aborted) throw new AgentInterrupted()
      if (err instanceof AgentError || err instanceof AgentInterrupted) throw err
      throw new AgentError({ provider: "claude-code", code: "sdk_error", message: (err as Error).message, retryable: true })
    } finally {
      ctx.signal.removeEventListener("abort", onAbort)
    }
  }

  async shutdown(): Promise<void> {}
}

function deniesTool(sandbox: Sandbox, toolName: string): boolean {
  if (sandbox === "read-only") return WRITE_TOOLS.has(toolName)
  return false
}

/** Coerce SDK message content into an array of block-like records. */
function asBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
}

function numOr(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
