// Shared mechanics for spawn-per-call CLI workers (opencode, pi): spawn with an injectable seam,
// prompt on stdin, strict-LF stdout framing with per-line JSON parse, a stderr ring buffer, a
// no-output stall watchdog, abort via SIGTERM→SIGKILL, and spawn-failure normalization into
// AgentError. Event SEMANTICS (what each JSON line means) stay in each worker — this module never
// interprets payloads.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { ProviderId } from "../dsl/types.js"
import { AgentError, AgentInterrupted } from "./index.js"

/** Spawns the child. Overridable in tests with a scripted fake process. */
export type SpawnProcess = (
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

/** Default no-output stall watchdog — ON in production, sized like the codex turn watchdog: it
 *  must exceed the longest expected silent stretch inside a healthy turn (a long quiet build or
 *  test run emits nothing until it finishes). A real hang is permanent; 30 minutes still beats a
 *  run that never settles. */
export const DEFAULT_STALL_TIMEOUT_MS = 30 * 60_000

/** Grace between SIGTERM and SIGKILL when aborting/stalling a child. */
export const DEFAULT_KILL_GRACE_MS = 5_000

const DEFAULT_STDERR_LIMIT = 16 * 1024

export interface JsonlRunOpts {
  provider: ProviderId
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Written to the child's stdin, which is then closed (also closed when omitted). */
  stdin?: string
  signal: AbortSignal
  /** Called with each stdout line that parses as JSON. A throw here fails the run. */
  onValue: (value: unknown) => void
  /** Non-JSON, non-empty stdout lines — diagnostics only, never fatal. */
  onTextLine?: (line: string) => void
  /** Fail after this much TOTAL stdout silence (ms). 0 disables. */
  stallTimeoutMs?: number
  killGraceMs?: number
  stderrLimit?: number
  spawnProcess?: SpawnProcess
}

export interface JsonlExit {
  code: number | null
  signal: string | null
  /** Bounded tail of stderr, for exit diagnostics. */
  stderrTail: string
}

/**
 * Run one JSONL-emitting subprocess to completion. Resolves with the exit status (zero or not —
 * the WORKER decides whether a nonzero exit is fatal, because an in-stream terminal event may
 * already explain it better). Rejects with AgentInterrupted on abort, a retryable `turn_stalled`
 * AgentError on watchdog fire, and `binary_not_found` / `spawn_failed` on spawn errors.
 */
export function runJsonlSubprocess(o: JsonlRunOpts): Promise<JsonlExit> {
  return new Promise<JsonlExit>((resolve, reject) => {
    if (o.signal.aborted) {
      reject(new AgentInterrupted())
      return
    }
    const spawnProcess: SpawnProcess =
      o.spawnProcess ?? ((bin, args, opts) => spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(o.bin, o.args, { cwd: o.cwd, env: o.env })
    } catch (err) {
      reject(spawnFailure(o.provider, o.bin, err))
      return
    }

    const stallMs = o.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    const graceMs = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    const stderrLimit = o.stderrLimit ?? DEFAULT_STDERR_LIMIT
    let settled = false
    let stdoutBuf = ""
    let stderrBuf = ""
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    // Settling stops parsing and detaches the abort listener, but deliberately does NOT clear the
    // SIGKILL escalation timer — a child that ignored SIGTERM must still die.
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      o.signal.removeEventListener("abort", onAbort)
      fn()
    }

    const killWithGrace = (): void => {
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      if (killTimer) return
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // best-effort
        }
      }, graceMs)
      killTimer.unref?.()
    }

    const onAbort = (): void => {
      killWithGrace()
      settle(() => reject(new AgentInterrupted()))
    }

    // Total-silence watchdog over stdout: any stdout data re-arms it. (stderr chatter is NOT
    // progress — a wedged CLI can spin on stderr forever.)
    const touch = (): void => {
      if (stallMs <= 0 || settled) return
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        killWithGrace()
        settle(() =>
          reject(
            new AgentError({
              provider: o.provider,
              code: "turn_stalled",
              message: `${o.bin} produced no output for ${stallMs}ms — failing instead of hanging forever`,
              retryable: true,
            }),
          ),
        )
      }, stallMs)
      watchdog.unref?.()
    }

    const deliver = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed) return
      let value: unknown
      try {
        value = JSON.parse(trimmed)
      } catch {
        o.onTextLine?.(trimmed)
        return
      }
      try {
        o.onValue(value)
      } catch (err) {
        // A throwing onValue is a worker bug — fail the run loudly rather than crash the
        // process from inside a stream handler.
        killWithGrace()
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (settled) return
      touch()
      stdoutBuf += chunk
      // Strict LF framing (pi's JSONL framing is LF-only; a trailing \r is JSON whitespace anyway).
      let nl = stdoutBuf.indexOf("\n")
      while (nl !== -1 && !settled) {
        const line = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        deliver(line)
        nl = stdoutBuf.indexOf("\n")
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk
      if (stderrBuf.length > stderrLimit) stderrBuf = stderrBuf.slice(stderrBuf.length - stderrLimit)
    })

    child.on("error", (err) => {
      settle(() => reject(spawnFailure(o.provider, o.bin, err)))
    })

    // 'exit' fires when the process dies (clear the escalation timer); 'close' fires once all
    // stdio has drained — resolve there so a final un-terminated line is not lost.
    child.on("exit", () => {
      if (killTimer) clearTimeout(killTimer)
    })
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      if (!settled && stdoutBuf.length > 0) {
        const rest = stdoutBuf
        stdoutBuf = ""
        deliver(rest)
      }
      settle(() => resolve({ code, signal: signal ?? null, stderrTail: stderrBuf.trim() }))
    })

    o.signal.addEventListener("abort", onAbort, { once: true })
    touch()

    // Prompt on stdin (never argv: avoids quoting and length limits). EPIPE from a child that
    // exits before reading is reported by the exit path, not the stream.
    child.stdin.on?.("error", () => {})
    if (o.stdin !== undefined) child.stdin.write(o.stdin, () => {})
    child.stdin.end?.()
  })
}

/** The standard "process exited nonzero with no recognized terminal event" failure. */
export function exitError(provider: ProviderId, bin: string, exit: JsonlExit): AgentError {
  const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "null"}`
  const tail = exit.stderrTail ? `\n--- stderr (tail) ---\n${exit.stderrTail}` : ""
  return new AgentError({
    provider,
    code: "provider_exit",
    message: `${bin} exited (${how}) without a result${tail}`,
    retryable: false,
  })
}

function spawnFailure(provider: ProviderId, bin: string, err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err)
  const notFound = /ENOENT|not found|not recognized|EACCES/i.test(message)
  return new AgentError({
    provider,
    code: notFound ? "binary_not_found" : "spawn_failed",
    message: notFound
      ? `cannot execute "${bin}" — is the ${provider} CLI installed and on PATH? (${message})`
      : `failed to spawn ${bin}: ${message}`,
    retryable: !notFound,
  })
}

// ---------------------------------------------------------------------------
// Version preflight helpers (workers and doctor share these).
// ---------------------------------------------------------------------------

/** Run a quick metadata command (e.g. `--version`) and capture trimmed stdout. */
export function captureStdout(o: {
  provider: ProviderId
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  spawnProcess?: SpawnProcess
}): Promise<string> {
  const ac = new AbortController()
  let out = ""
  const run = runJsonlSubprocess({
    provider: o.provider,
    bin: o.bin,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    signal: ac.signal,
    // Version output is plain text, but tolerate JSON-shaped lines too.
    onValue: (v) => {
      out += (typeof v === "string" ? v : JSON.stringify(v)) + "\n"
    },
    onTextLine: (line) => {
      out += line + "\n"
    },
    stallTimeoutMs: o.timeoutMs ?? 10_000,
    killGraceMs: 1_000,
    spawnProcess: o.spawnProcess,
  })
  return run.then((exit) => {
    if (exit.code !== 0) throw exitError(o.provider, o.bin, exit)
    return out.trim()
  })
}

/** First dotted number in a version string ("1.16.2", "opencode 1.16.2", "v0.79.1"). */
export function parseVersion(s: string): number[] | undefined {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
}

export function versionAtLeast(found: string, min: string): boolean {
  const a = parseVersion(found)
  const b = parseVersion(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}
