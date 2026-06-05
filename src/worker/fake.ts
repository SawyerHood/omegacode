// A deterministic in-process worker for smoke tests and `--provider fake`. Never calls a real
// provider: it echoes a canned answer derived from the prompt, and for schema'd calls synthesizes a
// value that satisfies the schema's top-level shape.

import { createHash } from "node:crypto"
import { emptyUsage, type AgentResult, type AgentSpec, type JSONSchema } from "../dsl/types.js"
import { validate } from "./schema.js"
import type { Worker, WorkerContext } from "./index.js"

export class FakeWorker implements Worker {
  readonly id = "codex" as const // satisfies ProviderId; selected only via the explicit registry
  private readonly delayMs: number
  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (this.delayMs) await sleep(this.delayMs, ctx.signal)
    ctx.onProgress({ kind: "reasoning", text: `(fake) considering: ${firstLine(spec.prompt)}` })

    if (spec.schema) {
      const structured = synthesize(spec.schema)
      const check = validate(spec.schema, structured)
      const text = JSON.stringify(structured, null, 2)
      ctx.onProgress({ kind: "text", text })
      return {
        text,
        structured: check.ok ? structured : structured,
        status: "completed",
        usage: { ...emptyUsage(), inputTokens: spec.prompt.length, outputTokens: 16 },
      }
    }

    const id = createHash("sha256").update(spec.prompt).digest("hex").slice(0, 8)
    const text = `[fake:${spec.provider}] ${firstLine(spec.prompt)} (#${id})`
    ctx.onProgress({ kind: "text", text })
    return {
      text,
      status: "completed",
      usage: { ...emptyUsage(), inputTokens: spec.prompt.length, outputTokens: text.length },
    }
  }

  async shutdown(): Promise<void> {}
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? s
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

function synthesize(schema: JSONSchema): unknown {
  const type = schema.type
  if (type === "string") return "fake"
  if (type === "number" || type === "integer") return 0
  if (type === "boolean") return false
  if (type === "array") return [synthesize((schema.items as JSONSchema) ?? {})]
  if (type === "object" || schema.properties) {
    const props = (schema.properties as Record<string, JSONSchema>) ?? {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) out[k] = synthesize(v)
    return out
  }
  return "fake"
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      reject(new Error("aborted"))
    })
  })
}
