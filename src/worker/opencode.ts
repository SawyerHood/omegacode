// OpencodeWorker — drives the OpenCode CLI one shot at a time: `opencode run --format json`,
// prompt on stdin, JSONL events parsed off stdout (subprocess mechanics live in subprocess-jsonl).
//
// Safety surface (full-access only): opencode has no OS-level sandbox and its app-level permission
// rules leave bash unconfined, so the ONLY accepted sandbox is danger-full-access (passed through
// as --dangerously-skip-permissions); read-only and workspace-write are rejected pre-spawn.
// `effort` is rejected too (opencode's --variant mapping is unverified — silently ignoring effort
// would also poison resume keys). `instructions` IS supported (as a delimited prompt preamble —
// `run` has no system-prompt flag): the runtime's corrective schema retry travels through it.
//
// Verified against opencode 1.16.2 (anomalyco/opencode @ e9e2612); older binaries are refused.

import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage } from "../dsl/types.js"
import type { Worker, WorkerContext, WorkerProgress } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"
import {
  captureStdout,
  exitError,
  runJsonlSubprocess,
  versionAtLeast,
  DEFAULT_STALL_TIMEOUT_MS,
  type SpawnProcess,
} from "./subprocess-jsonl.js"

const PROVIDER = "opencode" as const

/** The minimum CLI version whose flags and JSON event shapes this worker is verified against. */
export const OPENCODE_MIN_VERSION = "1.16.2"

export interface OpencodeWorkerOpts {
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess (runs AND --version). */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
  sessionID?: string
}

export class OpencodeWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly stallTimeoutMs: number
  /** Once-per-worker version preflight (the factory caches one worker per provider). */
  private versionCheck: Promise<void> | null = null

  constructor(opts: OpencodeWorkerOpts = {}) {
    this.bin = opts.bin ?? "opencode"
    this.spawnProcess = opts.spawnProcess
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    // Fail closed on everything this backend cannot honestly enforce.
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "opencode has no enforceable turn cap (its `steps` config is advisory); omit maxTurns or use the claude-code provider",
      })
    }
    if (spec.effort !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "opencode does not support effort yet (its --variant runtime behavior is unverified); omit effort for provider \"opencode\"",
      })
    }
    if (spec.sandbox !== "danger-full-access") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `opencode cannot enforce a "${spec.sandbox}" sandbox (no OS-level confinement; bash is unrestricted) — set sandbox: "danger-full-access" to use provider "opencode"`,
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `opencode runs as a one-shot subprocess and cannot surface approval requests to omegacode — use approval: "never" with provider "opencode"`,
      })
    }
    await this.ensureVersion()

    const args = [
      "run",
      "--format",
      "json",
      // The boolean thinking gate defaults to false in noninteractive mode; without it the JSON
      // stream carries no `reasoning` events at all.
      "--thinking",
      ...(spec.model ? ["--model", spec.model] : []),
      // danger-full-access is the only sandbox that reaches this point: permission asks would
      // otherwise be auto-REJECTED by noninteractive opencode (fail-closed, but useless).
      "--dangerously-skip-permissions",
    ]

    const working = await this.runTurn(spec, args, withInstructions(spec, spec.prompt), ctx, true)
    if (!spec.schema) return { text: working.text, status: "completed", usage: working.usage }

    // Extraction turn (two-phase structured output, codex precedent): silent, reuses the working
    // turn's session so the model keeps its context. Instructions are forwarded so the runtime's
    // corrective schema retry reaches the turn that actually emits JSON.
    const extractionArgs = working.sessionID ? [...args, "--session", working.sessionID] : args
    const extraction = await this.runTurn(
      spec,
      extractionArgs,
      withInstructions(spec, extractionPrompt(spec, working)),
      ctx,
      false,
    )
    let structured: unknown
    try {
      structured = parseJsonLoose(extraction.text)
    } catch {
      structured = undefined
    }
    return {
      text: extraction.text,
      structured,
      status: "completed",
      // Per-process usage is per-turn (unlike codex's thread-cumulative counters): sum both turns.
      usage: addUsage(working.usage, extraction.usage),
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  // -------------------------------------------------------------------------

  private ensureVersion(): Promise<void> {
    if (!this.versionCheck) {
      this.versionCheck = this.checkVersion().catch((err: unknown) => {
        // Do not cache failures — a transient --version hiccup must not poison the worker.
        this.versionCheck = null
        throw err
      })
    }
    return this.versionCheck
  }

  private async checkVersion(): Promise<void> {
    const out = await captureStdout({
      provider: PROVIDER,
      bin: this.bin,
      args: ["--version"],
      env: this.env(),
      spawnProcess: this.spawnProcess,
    })
    if (!versionAtLeast(out, OPENCODE_MIN_VERSION)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_outdated",
        message: `opencode ${out || "(unknown version)"} is below the minimum supported ${OPENCODE_MIN_VERSION} — upgrade the opencode CLI`,
        retryable: false,
      })
    }
  }

  private env(): NodeJS.ProcessEnv {
    // Never let a run trigger a self-update mid-flight.
    return { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" }
  }

  /** Run one `opencode run` subprocess to completion and map its JSONL events. */
  private async runTurn(
    spec: AgentSpec,
    args: string[],
    prompt: string,
    ctx: WorkerContext,
    forwardProgress: boolean,
  ): Promise<TurnOutcome> {
    let text = ""
    let usage = emptyUsage()
    let sessionID: string | undefined
    let streamError: AgentError | undefined
    const forward = (e: WorkerProgress): void => {
      if (forwardProgress) ctx.onProgress(e)
    }

    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args,
      cwd: spec.cwd,
      env: this.env(),
      stdin: prompt,
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        if (sessionID === undefined && typeof value.sessionID === "string") sessionID = value.sessionID
        const part = isObject(value.part) ? value.part : undefined
        switch (value.type) {
          case "text": {
            const t = strOf(part?.text) ?? strOf(value.text)
            if (t !== undefined) {
              // Terminal text PARTS are whole blocks, not deltas — separate them so a multi-part
              // answer doesn't run together.
              const chunk = text.length > 0 ? "\n\n" + t : t
              text += chunk
              forward({ kind: "text", text: chunk })
            }
            return
          }
          case "reasoning": {
            const t = strOf(part?.text) ?? strOf(value.text)
            if (t !== undefined) forward({ kind: "reasoning", text: t })
            return
          }
          case "tool_use": {
            // opencode emits only TERMINAL tool parts (completed/errored), so the tool call and
            // its result surface together as a pair.
            const p = part ?? value
            const state = isObject(p.state) ? p.state : undefined
            const status = strOf(state?.status)
            if (status !== "completed" && status !== "error") return
            const id = strOf(p.callID)
            const name = strOf(p.tool) ?? "tool"
            forward({ kind: "tool", id, name, input: state?.input })
            forward({
              kind: "tool-result",
              id,
              name,
              output: strOf(state?.output) ?? strOf(state?.error),
              isError: status === "error",
            })
            return
          }
          case "step_finish": {
            const tokens = isObject(part?.tokens) ? part.tokens : isObject(value.tokens) ? value.tokens : undefined
            const cost = numOf(part?.cost) ?? numOf(value.cost) ?? 0
            if (tokens) {
              const cache = isObject(tokens.cache) ? tokens.cache : undefined
              usage = {
                // Cache reads/writes fold into input (Claude precedent).
                inputTokens: usage.inputTokens + (numOf(tokens.input) ?? 0) + (numOf(cache?.read) ?? 0) + (numOf(cache?.write) ?? 0),
                outputTokens: usage.outputTokens + (numOf(tokens.output) ?? 0) + (numOf(tokens.reasoning) ?? 0),
                costUsd: usage.costUsd + cost,
              }
              forward({ kind: "usage", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } })
            }
            return
          }
          case "error": {
            // Terminal regardless of exit code: in attach mode opencode can exit 0 AFTER an error
            // event, so the exit code alone must never decide success.
            if (!streamError) streamError = toStreamError(value)
            return
          }
          default:
            // Unknown event types are forward-compatible noise.
            return
        }
      },
    })

    if (streamError) throw streamError
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (exit.code !== 0) {
      // Concurrent one-shot runs can race on opencode's local database ("database is locked",
      // observed live with two parallel agents) — transient contention, so let withRetry back off
      // instead of failing the agent on the first collision.
      if (/database is locked/i.test(exit.stderrTail)) {
        throw new AgentError({
          provider: PROVIDER,
          code: "provider_busy",
          message: `opencode exited with transient database contention — retrying\n--- stderr (tail) ---\n${exit.stderrTail}`,
          retryable: true,
        })
      }
      throw exitError(PROVIDER, this.bin, exit)
    }
    if (text.length === 0) {
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "opencode exited 0 without producing any assistant text" })
    }
    return { text, usage, sessionID }
  }
}

/** Delimited preamble injection — `opencode run` has no system-prompt flag, so instructions are
 *  prompt-level (documented as such). This is the path the corrective schema retry travels. */
function withInstructions(spec: AgentSpec, prompt: string): string {
  if (!spec.instructions) return prompt
  return `<instructions>\n${spec.instructions}\n</instructions>\n\n${prompt}`
}

function extractionPrompt(spec: AgentSpec, working: TurnOutcome): string {
  // With a session id the model retains the working turn's context; without one, replay the
  // working answer so extraction never depends on lost state.
  const context = working.sessionID ? "" : `Earlier you produced this answer:\n\n${working.text}\n\n`
  return (
    context +
    "Return your final answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

function toStreamError(value: Record<string, unknown>): AgentError {
  const err = isObject(value.error) ? value.error : undefined
  const data = err && isObject(err.data) ? err.data : undefined
  const name = strOf(err?.name) ?? strOf(value.name)
  const message = strOf(data?.message) ?? strOf(err?.message) ?? strOf(value.message) ?? "opencode reported an error"
  return new AgentError({
    provider: PROVIDER,
    code: name === "ProviderAuthError" ? "provider_auth" : "provider_error",
    message: name ? `${name}: ${message}` : message,
    retryable: false,
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
