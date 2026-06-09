import type { AgentResult, AgentSpec, Effort } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError } from "./index.js"
import { SubprocessJsonlWorker, type SubprocessSpawn } from "./subprocess-jsonl.js"

export interface OpenCodeWorkerOpts {
  bin?: string
  spawnChild?: SubprocessSpawn
}

export class OpenCodeWorker implements Worker {
  readonly id = "opencode" as const
  private readonly inner: SubprocessJsonlWorker

  constructor(private readonly opts: OpenCodeWorkerOpts = {}) {
    this.inner = new SubprocessJsonlWorker({
      provider: this.id,
      spawnChild: opts.spawnChild,
      buildTurn: (spec, prompt) => {
        if (spec.model && !spec.model.includes("/")) {
          throw new AgentError({
            provider: this.id,
            code: "invalid_model",
            message: 'opencode models must be in "provider/model" form, for example "anthropic/claude-sonnet-4"',
          })
        }
        const args = ["run", "--format", "json", "--dir", spec.cwd]
        if (spec.model) args.push("--model", spec.model)
        args.push("--dangerously-skip-permissions")
        const variant = toOpenCodeVariant(spec.effort)
        if (variant) args.push("--variant", variant)
        const stdin = spec.instructions ? `Instructions:\n${spec.instructions}\n\nPrompt:\n${prompt}` : prompt
        return { command: opts.bin ?? "opencode", args, cwd: spec.cwd, stdin }
      },
    })
  }

  runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    return this.inner.runSubprocessAgent(spec, ctx)
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

function toOpenCodeVariant(effort: Effort | undefined): string | undefined {
  return effort
}
