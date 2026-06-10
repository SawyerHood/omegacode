import type { ProviderId } from "../dsl/types.js"
import { AgentError, type Worker, type WorkerFactory } from "./index.js"
import { FakeWorker } from "./fake.js"
import { CodexWorker } from "./codex.js"
import { ClaudeWorker } from "./claude.js"
import { OpencodeWorker } from "./opencode.js"
import { PiWorker } from "./pi.js"

export interface FactoryOpts {
  /** Use the in-process FakeWorker for every provider (smoke tests, --fake). */
  fake?: boolean
  codexBin?: string
  claudeModel?: string
  /** Path to the claude-code executable (forwarded to the SDK). */
  pathToClaudeCodeExecutable?: string
  opencodeBin?: string
  piBin?: string
}

export class DefaultWorkerFactory implements WorkerFactory {
  private readonly cache = new Map<ProviderId, Worker>()
  constructor(private readonly opts: FactoryOpts = {}) {}

  get(id: ProviderId): Worker {
    let w = this.cache.get(id)
    if (!w) {
      w = this.create(id)
      this.cache.set(id, w)
    }
    return w
  }

  private create(id: ProviderId): Worker {
    if (this.opts.fake) return new FakeWorker()
    switch (id) {
      case "codex":
        return new CodexWorker({ bin: this.opts.codexBin })
      case "claude-code":
        return new ClaudeWorker({
          model: this.opts.claudeModel,
          pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
        })
      case "opencode":
        return new OpencodeWorker({ bin: this.opts.opencodeBin })
      case "pi":
        return new PiWorker({ bin: this.opts.piBin })
      default: {
        // Exhaustive: a new ProviderId must be handled here, and an unknown runtime value
        // must fail loudly instead of silently routing to a billed provider.
        const unknown: never = id
        throw new AgentError({
          provider: id,
          code: "unknown_provider",
          message: `unknown provider: ${String(unknown)}`,
        })
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const w of this.cache.values()) {
      try {
        await w.shutdown()
      } catch {
        // best-effort
      }
    }
    this.cache.clear()
  }
}
