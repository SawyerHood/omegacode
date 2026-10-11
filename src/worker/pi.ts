// PiWorker — drives the pi coding agent one shot at a time: `pi --mode json --no-session`, prompt
// on stdin, JSONL AgentEvents parsed off stdout (subprocess mechanics live in subprocess-jsonl).
//
// Safety surface (full-access only): pi's tool allowlists are model/tool-layer controls, not OS
// confinement (write/edit accept absolute paths; bash is unrestricted), so the ONLY accepted
// sandbox is danger-full-access; read-only and workspace-write are rejected pre-spawn. There is no
// native turn cap, so maxTurns is rejected. `effort` maps onto pi's --thinking levels, and
// `instructions` maps onto --append-system-prompt — the runtime's corrective schema retry travels
// through it.
//
// JSON print mode does NOT reflect stream failures in the exit code: terminal classification is
// driven by in-stream assistant stopReason ("error"/"aborted"), never the exit code alone.
//
// Verified against @earendil-works/pi-coding-agent 0.79.1 (earendil-works/pi @ 9ccfcd7); older
// binaries (including any from the renamed @mariozechner package, which caps at 0.73.1) are refused.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type Effort } from "../dsl/types.js"
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

const PROVIDER = "pi" as const

/** The minimum CLI version whose flags and JSONL event shapes this worker is verified against. */
export const PI_MIN_VERSION = "0.79.1"

/** omegacode effort → pi --thinking (pi clamps to the model's supported levels itself). */
const EFFORT_TO_THINKING: Record<Effort, string> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  // "ultra" is a muse-client-side tier above every thinking scale — pi's top level.
  ultra: "max",
}

/** pi gained a public "max" thinking level in 1.1.0 (verified live: --thinking max accepted
 *  on the meta backend). Older binaries top out at xhigh, so max maps down there — a safe
 *  undersell, never a spawn failure. */
const PI_MAX_VERSION = "1.1.0"

function toPiThinking(effort: Effort, version: string): string {
  if ((effort === "max" || effort === "ultra") && !versionAtLeast(version, PI_MAX_VERSION)) return "xhigh"
  return EFFORT_TO_THINKING[effort]
}

export interface PiWorkerOpts {
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess (runs AND --version). */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
}

export class PiWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly stallTimeoutMs: number
  /** Once-per-worker version preflight (the factory caches one worker per provider). */
  private versionCheck: Promise<string> | null = null

  constructor(opts: PiWorkerOpts = {}) {
    this.bin = opts.bin ?? "pi"
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
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "pi has no native turn cap (the agent loop runs until no tool calls remain); omit maxTurns or use the claude-code provider",
      })
    }
    if (spec.sandbox !== "danger-full-access") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `pi cannot enforce a "${spec.sandbox}" sandbox (tool allowlists are not OS confinement; bash is unrestricted) — set sandbox: "danger-full-access" to use provider "pi"`,
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `pi runs as a one-shot subprocess and cannot surface approval requests to omegacode — use approval: "never" with provider "pi"`,
      })
    }
    const version = await this.ensureVersion()

    const args = this.baseArgs(spec, version)
    const working = await this.runTurn(spec, args, spec.prompt, ctx, true)
    if (!spec.schema) return { text: working.text, status: "completed", usage: working.usage }

    // Extraction turn (two-phase structured output, codex precedent): silent, tool-less, no
    // thinking. --no-session means there is NO conversational continuity, so the working answer is
    // replayed in the prompt. Instructions are forwarded (same --append-system-prompt) so the
    // runtime's corrective schema retry reaches the turn that actually emits JSON.
    const extractionArgs = [
      "--mode",
      "json",
      "--no-session",
      "--no-tools",
      ...(spec.model ? ["--model", spec.model] : []),
      "--thinking",
      "off",
      ...(spec.instructions ? ["--append-system-prompt", spec.instructions] : []),
    ]
    const extraction = await this.runTurn(spec, extractionArgs, extractionPrompt(spec, working.text), ctx, false)
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
      // Per-process usage is per-turn: sum both turns.
      usage: addUsage(working.usage, extraction.usage),
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  // -------------------------------------------------------------------------

  private baseArgs(spec: AgentSpec, version: string): string[] {
    return [
      "--mode",
      "json",
      // omegacode owns history/resume — never litter ~/.pi/agent/sessions.
      "--no-session",
      // Model passes through verbatim (provider/model prefixes and slashes included). Authors
      // should use effort, not ":<thinking>" model suffixes — the worker always controls thinking
      // via the flag when effort is set.
      ...(spec.model ? ["--model", spec.model] : []),
      ...(spec.effort ? ["--thinking", toPiThinking(spec.effort, version)] : []),
      ...(spec.instructions ? ["--append-system-prompt", spec.instructions] : []),
    ]
  }

  private ensureVersion(): Promise<string> {
    if (!this.versionCheck) {
      this.versionCheck = this.checkVersion().catch((err: unknown) => {
        // Do not cache failures — a transient --version hiccup must not poison the worker.
        this.versionCheck = null
        throw err
      })
    }
    return this.versionCheck
  }

  private async checkVersion(): Promise<string> {
    // Isolate the probe: old pi binaries wrote files (agent-dir lock, repo-local .pi) even on
    // --version, so it runs with a scratch agent dir and a neutral cwd regardless of version.
    const scratch = mkdtempSync(join(tmpdir(), "omegacode-pi-version-"))
    let out: string
    try {
      out = await captureStdout({
        provider: PROVIDER,
        bin: this.bin,
        args: ["--version"],
        cwd: tmpdir(),
        env: { ...process.env, PI_CODING_AGENT_DIR: scratch },
        spawnProcess: this.spawnProcess,
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    if (!versionAtLeast(out, PI_MIN_VERSION)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_outdated",
        message:
          `pi ${out || "(unknown version)"} is below the minimum supported ${PI_MIN_VERSION} — ` +
          `upgrade with: npm i -g @earendil-works/pi-coding-agent (the renamed @mariozechner/pi-coding-agent package is outdated)`,
        retryable: false,
      })
    }
    return out
  }

  /** Run one pi subprocess to completion and map its JSONL AgentEvents. */
  private async runTurn(
    spec: AgentSpec,
    args: string[],
    prompt: string,
    ctx: WorkerContext,
    forwardProgress: boolean,
  ): Promise<TurnOutcome> {
    let deltaText = ""
    let finalText: string | undefined
    let usage = emptyUsage()
    let streamError: AgentError | undefined
    let sawAborted = false
    const forward = (e: WorkerProgress): void => {
      if (forwardProgress) ctx.onProgress(e)
    }

    const readAssistantTerminal = (message: Record<string, unknown>): void => {
      const stop = strOf(message.stopReason)
      if (stop === "error" && !streamError) {
        streamError = new AgentError({
          provider: PROVIDER,
          code: "provider_error",
          message: strOf(message.errorMessage) ?? "pi assistant message ended with stopReason \"error\"",
          retryable: false,
        })
      } else if (stop === "aborted") {
        sawAborted = true
      }
    }

    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args,
      cwd: spec.cwd,
      // Runs deliberately inherit the user's env UN-isolated: pi's auth lives inside the agent
      // dir (~/.pi/agent/auth.json), so a scratch PI_CODING_AGENT_DIR would break every run.
      // --no-session keeps run state out of the user's session history; only the --version
      // probe (which needs no auth) gets the scratch-dir treatment.
      env: process.env,
      stdin: prompt,
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        switch (value.type) {
          case "message_update": {
            const ev = isObject(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined
            if (!ev) return
            if (ev.type === "text_delta" && typeof ev.delta === "string") {
              deltaText += ev.delta
              forward({ kind: "text", text: ev.delta })
            } else if (ev.type === "thinking_delta" && typeof ev.delta === "string") {
              forward({ kind: "reasoning", text: ev.delta })
            } else if (ev.type === "error" && isObject(ev.error)) {
              readAssistantTerminal(ev.error)
            }
            return
          }
          case "message_end": {
            const message = isObject(value.message) ? value.message : undefined
            if (!message || message.role !== "assistant") return
            // The LAST assistant message's text is the result; per-message usage sums across the
            // agent loop's API rounds (cache reads/writes fold into input, Claude precedent).
            const text = assistantText(message)
            if (text.length > 0) finalText = text
            const u = isObject(message.usage) ? message.usage : undefined
            if (u) {
              const cost = isObject(u.cost) ? u.cost : undefined
              usage = {
                inputTokens: usage.inputTokens + (numOf(u.input) ?? 0) + (numOf(u.cacheRead) ?? 0) + (numOf(u.cacheWrite) ?? 0),
                outputTokens: usage.outputTokens + (numOf(u.output) ?? 0),
                costUsd: usage.costUsd + (numOf(cost?.total) ?? 0),
              }
              forward({ kind: "usage", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } })
            }
            readAssistantTerminal(message)
            return
          }
          case "tool_execution_start": {
            forward({
              kind: "tool",
              id: strOf(value.toolCallId),
              name: strOf(value.toolName) ?? "tool",
              input: value.args,
            })
            return
          }
          case "tool_execution_end": {
            forward({
              kind: "tool-result",
              id: strOf(value.toolCallId),
              name: strOf(value.toolName),
              output: stringifyResult(value.result),
              isError: value.isError === true,
            })
            return
          }
          // session header, agent/turn/message lifecycle, tool_execution_update: not needed.
          default:
            return
        }
      },
    })

    if (streamError) throw streamError
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (sawAborted) {
      // pi aborted internally without omegacode asking — not a success, not our interrupt.
      throw new AgentError({ provider: PROVIDER, code: "aborted", message: "pi aborted the request", retryable: false })
    }
    if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
    const text = finalText ?? deltaText
    if (text.length === 0) {
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "pi exited 0 without producing any assistant text" })
    }
    return { text, usage }
  }
}

function extractionPrompt(spec: AgentSpec, workingText: string): string {
  // --no-session means no conversational continuity: replay the working answer explicitly.
  return (
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    "Return that answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

/** Concatenate an assistant message's text content blocks. */
function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return ""
  let out = ""
  for (const block of message.content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") out += block.text
  }
  return out
}

function stringifyResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  if (typeof result === "string") return result
  // ToolResultMessage-shaped results carry content blocks; surface their text.
  if (isObject(result) && Array.isArray(result.content)) {
    const text = result.content
      .map((b: unknown) => (isObject(b) && typeof b.text === "string" ? b.text : ""))
      .join("")
    if (text.length > 0) return text
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
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
