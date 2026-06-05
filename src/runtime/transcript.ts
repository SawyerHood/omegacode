// Per-agent transcript: the streaming conversation of one agent, written to
// runs/<runId>/agents/<index>.jsonl. This is the source for the viewer's live chat-feed drilldown
// (observability only — distinct from journal.jsonl, which stores the final result for resume).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import type { ProviderId } from "../dsl/types.js"
import { runDir } from "./journal.js"

export type ChatChunk =
  | { t: number; kind: "meta"; index: number; label: string; provider: ProviderId; model?: string; prompt: string }
  | { t: number; kind: "text"; text: string }
  | { t: number; kind: "reasoning"; text: string }
  | { t: number; kind: "tool"; id?: string; name: string; input?: unknown }
  | { t: number; kind: "tool-result"; id?: string; name?: string; output?: string; isError?: boolean }
  | { t: number; kind: "status"; state: "running" | "done" | "failed"; error?: string; cached?: boolean }

/** A ChatChunk without the `t` timestamp — distributive so each variant keeps its own fields. */
export type ChatChunkInput = ChatChunk extends infer E ? (E extends unknown ? Omit<E, "t"> : never) : never

export function agentsDir(runId: string): string {
  return join(runDir(runId), "agents")
}

export function agentTranscriptPath(runId: string, index: number): string {
  return join(agentsDir(runId), `${index}.jsonl`)
}

// Coalescing + truncation keep transcripts from exploding (Codex streams token-level text deltas —
// thousands of one-line chunks per answer). Text/reasoning deltas are buffered and flushed as one
// chunk on a boundary; large tool I/O is head+tail truncated.
const TEXT_FLUSH_MS = 120
const TEXT_FLUSH_BYTES = 2048
const TOOL_OUTPUT_MAX = 32 * 1024
const TOOL_INPUT_MAX = 8 * 1024

export class AgentTranscript {
  private readonly stream: WriteStream
  private pending: { kind: "text" | "reasoning"; text: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(runId: string, index: number) {
    mkdirSync(agentsDir(runId), { recursive: true })
    // Truncate: a (re-)run of this agent replaces any partial transcript from a prior attempt.
    this.stream = createWriteStream(agentTranscriptPath(runId, index), { flags: "w" })
  }

  write(chunk: ChatChunkInput): void {
    if (chunk.kind === "text" || chunk.kind === "reasoning") {
      if (this.pending && this.pending.kind !== chunk.kind) this.flushPending()
      if (!this.pending) this.pending = { kind: chunk.kind, text: "" }
      this.pending.text += chunk.text
      if (this.pending.text.length >= TEXT_FLUSH_BYTES) this.flushPending()
      else this.arm()
      return
    }
    this.flushPending()
    if (chunk.kind === "tool-result" && typeof chunk.output === "string") {
      this.writeLine({ ...chunk, output: truncate(chunk.output, TOOL_OUTPUT_MAX) })
    } else if (chunk.kind === "tool" && chunk.input !== undefined) {
      this.writeLine({ ...chunk, input: capInput(chunk.input, TOOL_INPUT_MAX) })
    } else {
      this.writeLine(chunk)
    }
  }

  close(): Promise<void> {
    this.flushPending()
    return new Promise((resolve) => this.stream.end(resolve))
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flushPending(), TEXT_FLUSH_MS)
    this.timer.unref?.()
  }

  private flushPending(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    const p = this.pending
    this.pending = null
    this.writeLine({ kind: p.kind, text: p.text })
  }

  private writeLine(chunk: ChatChunkInput): void {
    this.stream.write(JSON.stringify({ ...chunk, t: Date.now() } as ChatChunk) + "\n")
  }
}

/** Head+tail truncation with a marker for large strings. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.75)
  const tail = max - head
  return `${s.slice(0, head)}\n…[${s.length - max} chars truncated]…\n${s.slice(s.length - tail)}`
}

/** Cap a (possibly structured) tool input; if its JSON is too big, store a truncated string. */
function capInput(input: unknown, max: number): unknown {
  let s: string
  try {
    s = JSON.stringify(input)
  } catch {
    return input
  }
  if (typeof s !== "string" || s.length <= max) return input
  return truncate(s, max)
}
