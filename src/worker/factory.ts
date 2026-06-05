import type { ProviderId } from "../dsl/types.js"
import type { Worker, WorkerFactory } from "./index.js"
import { FakeWorker } from "./fake.js"
import { CodexWorker } from "./codex.js"
import { ClaudeWorker } from "./claude.js"

export interface FactoryOpts {
  /** Use the in-process FakeWorker for every provider (smoke tests, --fake). */
  fake?: boolean
  codexBin?: string
  claudeModel?: string
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
    if (id === "codex") return new CodexWorker({ bin: this.opts.codexBin })
    return new ClaudeWorker({ model: this.opts.claudeModel })
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
