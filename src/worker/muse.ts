// MuseWorker — drives the Muse Code CLI one shot at a time: `muse exec --json`,
// prompt via --prompt-file (stdin is reserved for --api-key-stdin, which we never use:
// auth lives in ~/.config/muse/auth.json), MSP JSONL events parsed off stdout
// (subprocess mechanics live in subprocess-jsonl).
//
// Safety surface: unlike opencode/pi, muse ships FIRST-PARTY confinement, all verified
// live against the meta backend (1.4.x):
//   read-only       → --disable-write --disable-shell (writes refused by the model itself;
//                       the attempt left no file behind)
//   workspace-write → --workspace <cwd> (policy-gated tools rooted at the run dir)
//   danger-full-access → --yolo (disables approval+sandbox, trusts the workspace)
// Approval must be "never": a one-shot subprocess cannot surface approval requests
// (same fail-closed rule as opencode/pi).
//
// Effort passes through VERBATIM — muse is the only backend whose scale covers the whole
// omegacode union including "ultra" (a muse-client-side tier: provider-highest + aggressive
// delegation, per Meta's docs). No nearest-mapping anywhere on this worker.
//
// Structured output is NATIVE: --output-schema <file> (meta provider only) shapes the final
// answer, so there is no extraction turn. The terminal text is parsed as JSON; a mismatch
// yields structured=undefined and the runtime's corrective schema retry runs the call again.
// maxTurns maps to --max-model-steps (also native — opencode/pi reject it).
//
// Caveats, all observed live:
// - The CLI emits NO usage telemetry, so usage is always zero: --budget cannot see muse
//   spend. Use --max-model-steps / bounded prompts as the cost lever instead.
// - Unknown --model values do NOT fail: the CLI falls back to its default model (observed:
//   exit 0, "Hello — how can I help?"). Always pass an explicit model (the run defaults do).
// - Exit codes are untrusted (0 on the fallback above): the run.terminal.* event decides.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { emptyUsage, type AgentResult, type AgentSpec } from "../dsl/types.js"
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

const PROVIDER = "muse" as const

/** The minimum CLI version whose flags and MSP event shapes this worker is verified against. */
export const MUSE_MIN_VERSION = "1.4.1"

export interface MuseWorkerOpts {
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess (runs AND --version). */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

export class MuseWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly stallTimeoutMs: number
  /** Once-per-worker version preflight (the factory caches one worker per provider). */
  private versionCheck: Promise<string> | null = null

  constructor(opts: MuseWorkerOpts = {}) {
    this.bin = opts.bin ?? "muse"
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
    // Fail closed on everything this backend cannot honestly do headless.
    if (spec.model === undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message:
          "muse worker requires an explicit model: unknown models silently fall back to the " +
          "CLI default (observed live), so omitting it could bill an unintended tier — set a model",
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `muse runs as a one-shot subprocess and cannot surface approval requests to omegacode — use approval: "never" with provider "muse"`,
      })
    }
    // The runtime host derives a process-lifetime tool-output root from TMPDIR and refuses
    // to start when it lands INSIDE the workspace (observed live from /tmp) — fail here with
    // an actionable message instead of a cryptic host-startup failure after spawn.
    if (isInsideDir(tmpdir(), spec.cwd)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message:
          `muse cannot run with cwd inside TMPDIR (${tmpdir()}): its tool-output root would land ` +
          `inside the workspace — run the workflow from a directory outside TMPDIR`,
      })
    }
    await this.ensureVersion()

    // Prompt + schema travel as files: stdin is reserved for --api-key-stdin (never used —
    // auth comes from ~/.config/muse/auth.json) and argv has length limits workflow prompts
    // routinely exceed (synthesis prompts carry whole finding sets).
    const scratch = mkdtempSync(join(tmpdir(), "omegacode-muse-"))
    try {
      const promptFile = join(scratch, "prompt.txt")
      writeFileSync(promptFile, withInstructions(spec, spec.prompt))
      const args = [
        "exec",
        "--json",
        // NOTE: no --no-session-log: the runtime host REQUIRES session logging for local
        // session messaging (observed live: "session logging is required"). Logs persist
        // under muse's session dir; omegacode's journal remains the source of truth.
        // Headless: user-input prompts auto-cancel instead of hanging the subprocess.
        "--user-input-auto-resolve",
        "--model",
        spec.model,
        ...(spec.effort ? ["--reasoning-effort", spec.effort] : []),
        "--prompt-file",
        promptFile,
        ...(spec.schema ? ["--output-schema", writeSchema(scratch, spec.schema)] : []),
        ...(spec.maxTurns !== undefined ? ["--max-model-steps", String(spec.maxTurns)] : []),
        ...sandboxArgs(spec),
      ]
      return await this.runTurn(spec, args, ctx)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  // -------------------------------------------------------------------------

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
    const out = await captureStdout({
      provider: PROVIDER,
      bin: this.bin,
      args: ["--version"],
      spawnProcess: this.spawnProcess,
    })
    if (!versionAtLeast(out, MUSE_MIN_VERSION)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_outdated",
        message: `muse ${out || "(unknown version)"} is below the minimum supported ${MUSE_MIN_VERSION} — upgrade the Muse Code CLI`,
        retryable: false,
      })
    }
    return out
  }

  /** Run one `muse exec` subprocess to completion and map its MSP events. */
  private async runTurn(spec: AgentSpec, args: string[], ctx: WorkerContext): Promise<AgentResult> {
    let deltas = ""
    let terminal: { ok: boolean; text: string; reason?: string } | undefined
    let streamError: AgentError | undefined

    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args,
      cwd: spec.cwd,
      env: { ...process.env },
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        const payload = isObject(value.payload) ? value.payload : undefined
        switch (value.payload_type) {
          case "run.output.delta": {
            const t = strOf(payload?.text)
            if (t !== undefined) {
              deltas += t
              ctx.onProgress({ kind: "text", text: t })
            }
            return
          }
          case "run.terminal.completed": {
            terminal = { ok: true, text: strOf(payload?.text) ?? "" }
            return
          }
          case "run.terminal.failed": {
            const reason = strOf(payload?.reason) ?? "muse reported failure"
            streamError = new AgentError({ provider: PROVIDER, code: "provider_error", message: reason, retryable: false })
            return
          }
          default:
            // Task/task-stream internals (reminder agents, status noise) are
            // forward-compatible noise — the terminal event is authoritative.
            return
        }
      },
    })

    if (streamError) throw streamError
    if (ctx.signal.aborted) throw new AgentInterrupted()
    // Exit codes are untrusted (observed exit 0 on a fallback-model run): only the terminal
    // event decides success. A nonzero exit WITHOUT one is a spawn-level failure.
    if (!terminal) {
      if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "muse exited 0 without a terminal event" })
    }
    const text = terminal.text !== "" ? terminal.text : deltas
    if (text.length === 0) {
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "muse completed without producing any assistant text" })
    }
    if (!spec.schema) return { text, status: "completed", usage: emptyUsage() }
    let structured: unknown
    try {
      structured = parseJsonLoose(text)
    } catch {
      structured = undefined
    }
    return { text, structured, status: "completed", usage: emptyUsage() }
  }
}

/** Sandbox → first-party confinement flags. Danger is --yolo (approval+sandbox off, workspace
 *  trusted); the rest keep the sandbox ON and differ in what stays enabled. */
function sandboxArgs(spec: AgentSpec): string[] {
  switch (spec.sandbox) {
    case "read-only":
      // Writes AND shell off at the CLI: the model itself reports "Filesystem writes are
      // disabled" (verified live — the attempt left no file). Reads stay approval-free.
      return ["--disable-write", "--disable-shell", "--approval-mode", "never"]
    case "workspace-write":
      // Policy-gated tools rooted at the run dir; network stays at the proxy-only default.
      return ["--workspace", spec.cwd, "--approval-mode", "never"]
    case "danger-full-access":
      return ["--yolo"]
  }
}

/** Delimited preamble injection — `muse exec` takes the prompt as arg/file with no
 *  system-prompt flag, so instructions are prompt-level (documented as such). This is the
 *  path the corrective schema retry travels. */
function withInstructions(spec: AgentSpec, prompt: string): string {
  if (!spec.instructions) return prompt
  return `<instructions>\n${spec.instructions}\n</instructions>\n\n${prompt}`
}

function writeSchema(scratch: string, schema: Record<string, unknown>): string {
  const path = join(scratch, "schema.json")
  writeFileSync(path, JSON.stringify(schema))
  return path
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** True when `dir` resolves inside `parent` (or is the same directory). */
function isInsideDir(parent: string, dir: string): boolean {
  const rel = relative(resolve(parent), resolve(dir))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
