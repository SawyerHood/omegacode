import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentResult, AgentSpec, Effort } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { SubprocessJsonlWorker, type SubprocessSpawn } from "./subprocess-jsonl.js"

export interface PiWorkerOpts {
  bin?: string
  provider?: string
  model?: string
  spawnChild?: SubprocessSpawn
}

export class PiWorker implements Worker {
  readonly id = "pi" as const
  private readonly inner: SubprocessJsonlWorker

  constructor(private readonly opts: PiWorkerOpts = {}) {
    this.inner = new SubprocessJsonlWorker({
      provider: this.id,
      spawnChild: opts.spawnChild,
      allowedSandboxes: ["read-only"],
      buildTurn: (spec, prompt) => {
        const stateDir = mkdtempSync(join(tmpdir(), "omegacode-pi-"))
        const sessionDir = join(stateDir, "sessions")
        const agentDir = join(stateDir, "agent")
        const args = ["--mode", "json", "--print", "--no-session", "--no-approve", "--session-dir", sessionDir, "--tools", "read,grep,find,ls"]
        const provider = opts.provider
        const model = spec.model ?? opts.model
        if (provider) args.push("--provider", provider)
        if (model) args.push("--model", model)
        const thinking = toPiThinking(spec.effort)
        if (thinking) args.push("--thinking", thinking)
        const workspaceInstructions = [
          `Target workspace root: ${spec.cwd}`,
          "Treat the target workspace as read-only.",
          "Use absolute paths under the target workspace for read, grep, find, and ls tool calls.",
        ].join("\n")
        args.push("--append-system-prompt", spec.instructions ? `${workspaceInstructions}\n\n${spec.instructions}` : workspaceInstructions)
        return {
          command: opts.bin ?? "pi",
          args,
          cwd: stateDir,
          stdin: prompt,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_CODING_AGENT_SESSION_DIR: sessionDir,
          },
          cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
        }
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

function toPiThinking(effort: Effort | undefined): string | undefined {
  if (!effort) return undefined
  if (effort === "none") return "off"
  if (effort === "max") return "xhigh"
  return effort
}
