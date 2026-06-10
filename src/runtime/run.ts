// The orchestrator: read a workflow file, lint, set up the journal + event sink, build the runtime,
// run the sandbox, write the result. One process per run (foreground or detached by the CLI).

import { createHash, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULTS, type Effort, type ProviderId, type RunDefaults, type Sandbox } from "../dsl/types.js"
import { DefaultWorkerFactory } from "../worker/factory.js"
import { type EventListener, FileEventSink } from "./event-sink.js"
import { determinismLint, KEY_VERSION } from "./keys.js"
import {
  checkResumePreconditions,
  ensureRunDir,
  Journal,
  JournalNotFoundError,
  listRunIds,
  type LoadedJournal,
  runDir,
  writeResult,
} from "./journal.js"
import { checkSpecEnum, Runtime } from "./primitives.js"
import { parseWorkflow } from "./sandbox.js"
import { TerminalRenderer } from "./progress.js"
import { runInSandbox } from "./sandbox.js"

export interface RunOverrides {
  provider?: ProviderId
  model?: string
  effort?: Effort
  sandbox?: Sandbox
  cwd?: string
  concurrency?: number
  budget?: number | null
  /** Forwarded to the Claude worker when provider === "claude-code". */
  claudeModel?: string
  /** Path to the claude-code executable (forwarded to the Claude worker). */
  pathToClaudeCodeExecutable?: string
}

export interface RunOptions {
  file: string
  args?: unknown
  overrides?: RunOverrides
  resumeRunId?: string
  fake?: boolean
  /** Suppress the terminal renderer (still writes events.jsonl). */
  quiet?: boolean
  /** Extra event listener (e.g. an embedded UI). */
  onEvent?: EventListener
  /** Called once with the runId as soon as the run dir exists (e.g. to print the viewer URL). */
  onStart?: (runId: string) => void
  /** Abort the run programmatically (embedders/tests) — same path as Ctrl-C (SIGINT/SIGTERM). */
  signal?: AbortSignal
  /** Hard ceiling on total workflow execution time (forwarded to the sandbox). Default: unbounded. */
  execTimeoutMs?: number
}

export interface RunOutcome {
  runId: string
  result: unknown
  status: "completed" | "failed" | "interrupted"
  error?: string
}

/** How often a live run refreshes its heartbeat file (see the deadman switch below). */
const HEARTBEAT_MS = 5000

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const filePath = resolve(opts.file)
  const source = readFileSync(filePath, "utf8")
  const fileHash = sha256(source)

  const findings = determinismLint(source)
  if (findings.length > 0) {
    throw new Error(
      "determinism lint failed: " + findings.map((f) => `${f.token} → use ${f.use}`).join("; "),
    )
  }

  const parsed = parseWorkflow(source)
  const defaults = resolveDefaults(parsed.meta, opts)

  const runId = opts.resumeRunId ?? newRunId()
  let loaded: LoadedJournal = { results: new Map(), indexByKey: new Map() }
  if (opts.resumeRunId) {
    // A typo'd / unknown run id must fail loudly: silently starting a fresh run under the typo'd id
    // re-pays the whole workflow with no resume benefit.
    if (!Journal.exists(runId)) throw new JournalNotFoundError(runId, listRunIds())
    loaded = Journal.load(runId)
    // A journaled result is only safe to replay if the file/args/key-version still match.
    checkResumePreconditions(loaded.meta, { fileHash, args: opts.args ?? null, keyVersion: KEY_VERSION })
  }
  const seed = loaded.meta?.seed ?? randomSeed()
  const baseTimeMs = loaded.meta?.createdAt ?? Date.now()

  ensureRunDir(runId)
  opts.onStart?.(runId)
  const journal = new Journal(runId)
  if (!loaded.meta) {
    journal.append({ type: "meta", runId, workflowFile: filePath, fileHash, args: opts.args ?? null, seed, createdAt: baseTimeMs, keyVersion: KEY_VERSION })
  }

  const renderer = new TerminalRenderer({ enabled: !opts.quiet })
  const listeners: EventListener[] = [renderer.handle]
  if (opts.onEvent) listeners.push(opts.onEvent)
  const events = new FileEventSink(runId, { listeners })

  const factory = new DefaultWorkerFactory({
    fake: opts.fake,
    codexBin: process.env.CODEX_BIN,
    opencodeBin: process.env.OPENCODE_BIN,
    piBin: process.env.PI_BIN,
    // Claude-specific factory defaults (L5). Only forwarded when the provider is claude-code; a
    // per-call opts.model still overrides via AgentSpec.model.
    claudeModel: opts.overrides?.claudeModel ?? (defaults.provider === "claude-code" ? defaults.model : undefined),
    pathToClaudeCodeExecutable: opts.overrides?.pathToClaudeCodeExecutable,
  })

  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.once("SIGINT", onSig)
  process.once("SIGTERM", onSig)
  // An embedder-provided signal aborts exactly the way Ctrl-C does.
  if (opts.signal?.aborted) ac.abort()
  else opts.signal?.addEventListener("abort", onSig, { once: true })

  events.emit({ type: "run", status: "started", runId, workflowFile: filePath })

  // Deadman switch: touch a heartbeat file while the run is alive. SIGINT/SIGTERM and
  // crashes still write a terminal event below, but a SIGKILL / power loss / closed
  // terminal cannot — those leave the run stuck at "started". The viewer and CLI treat
  // a "started" run with a stale heartbeat as dead, instead of a perpetual spinner.
  const heartbeatFile = join(runDir(runId), ".heartbeat")
  const beat = (): void => {
    try {
      writeFileSync(heartbeatFile, String(Date.now()))
    } catch {
      // best effort — never let heartbeat failure break a run
    }
  }
  beat()
  const heartbeat = setInterval(beat, HEARTBEAT_MS)
  heartbeat.unref()

  let status: RunOutcome["status"] = "completed"
  let result: unknown
  let error: string | undefined
  const runtime = new Runtime({ runId, defaults, factory, journal, loaded, events, args: opts.args, seed, baseTimeMs, signal: ac.signal, declaredPhases: parsed.meta.phases })
  try {
    // The abort signal MUST reach the sandbox (M13 wiring): the vm timeout bounds only synchronous
    // execution, so without it `await new Promise(() => {})` in a workflow body would hang this
    // await forever after Ctrl-C — the finally below (interrupted status, events.close) never runs.
    result = await runInSandbox({
      body: parsed.body,
      filename: filePath,
      globals: runtime.globals(),
      signal: ac.signal,
      execTimeoutMs: opts.execTimeoutMs,
    })
    // Await any agent() the body launched without awaiting, so a late rejection can't crash the
    // process after we've declared "completed".
    await runtime.settle()
    writeResult(runId, result ?? null)
  } catch (err) {
    status = ac.signal.aborted ? "interrupted" : "failed"
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await runtime.settle()
    clearInterval(heartbeat)
    process.removeListener("SIGINT", onSig)
    process.removeListener("SIGTERM", onSig)
    opts.signal?.removeEventListener("abort", onSig)
    await factory.shutdownAll()
    events.emit({ type: "run", status, runId, error })
    await events.close()
  }

  return { runId, result, status, error }
}

function resolveDefaults(meta: { defaultProvider?: ProviderId; defaultModel?: string; defaultSandbox?: Sandbox }, opts: RunOptions): RunDefaults {
  const o = opts.overrides ?? {}
  // An invalid concurrency (0 / NaN / fractional) would build a Semaphore that never admits anyone:
  // every agent() queues forever while the heartbeat keeps beating, so the deadman never flags it.
  // Fail here, before the run dir / event sink / heartbeat exist.
  const concurrency = o.concurrency ?? DEFAULTS.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`invalid concurrency: ${concurrency} — must be a positive integer`)
  }
  // An invalid sandbox/effort from meta.defaultSandbox or a library-caller override would flow
  // unvalidated into every spec and fall off the worker policy switches (H14) — e.g. "readonly"
  // (typo for "read-only") becomes effectively writable. Fail here, like concurrency above.
  // resolveSpec re-checks the resolved per-call values, covering workflow-body opts too.
  const sandbox = o.sandbox ?? meta.defaultSandbox ?? DEFAULTS.sandbox
  checkSpecEnum("sandbox", sandbox)
  checkSpecEnum("effort", o.effort)
  // meta.defaultProvider arrives from an untyped workflow file — a typo here would otherwise ride
  // into every spec and only fail at the factory (or not at all under --fake).
  const provider = o.provider ?? meta.defaultProvider ?? DEFAULTS.provider
  checkSpecEnum("provider", provider)
  return {
    provider,
    model: o.model ?? meta.defaultModel,
    effort: o.effort,
    sandbox,
    approval: DEFAULTS.approval,
    cwd: resolve(o.cwd ?? process.cwd()),
    concurrency,
    maxAgents: DEFAULTS.maxAgents,
    maxFanout: DEFAULTS.maxFanout,
    budget: o.budget ?? DEFAULTS.budget,
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function newRunId(): string {
  return "wf_" + randomBytes(6).toString("hex")
}

function randomSeed(): number {
  return randomBytes(4).readUInt32LE(0)
}
