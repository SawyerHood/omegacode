// The orchestrator: read a workflow file, lint, set up the journal + event sink, build the runtime,
// run the sandbox, write the result. One process per run (foreground or detached by the CLI).

import { createHash, randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULTS, type Effort, type ProviderId, type RunDefaults, type Sandbox } from "../dsl/types.js"
import { DefaultWorkerFactory } from "../worker/factory.js"
import { type EventListener, FileEventSink } from "./event-sink.js"
import { determinismLint } from "./keys.js"
import { ensureRunDir, Journal, type LoadedJournal, runDir, writeResult } from "./journal.js"
import { Runtime } from "./primitives.js"
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
  const loaded: LoadedJournal = opts.resumeRunId
    ? Journal.load(runId)
    : { results: new Map(), startedOnly: new Set<string>() }
  const seed = loaded.meta?.seed ?? randomSeed()
  const baseTimeMs = loaded.meta?.createdAt ?? Date.now()

  ensureRunDir(runId)
  opts.onStart?.(runId)
  const journal = new Journal(runId)
  if (!loaded.meta) {
    journal.append({ type: "meta", runId, workflowFile: filePath, fileHash, args: opts.args ?? null, seed, createdAt: baseTimeMs })
  }

  const renderer = new TerminalRenderer({ enabled: !opts.quiet })
  const listeners: EventListener[] = [renderer.handle]
  if (opts.onEvent) listeners.push(opts.onEvent)
  const events = new FileEventSink(runId, { listeners })

  const factory = new DefaultWorkerFactory({ fake: opts.fake, codexBin: process.env.CODEX_BIN })

  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.once("SIGINT", onSig)
  process.once("SIGTERM", onSig)

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
  try {
    const runtime = new Runtime({ runId, defaults, factory, journal, loaded, events, args: opts.args, seed, baseTimeMs, signal: ac.signal })
    result = await runInSandbox({ body: parsed.body, filename: filePath, globals: runtime.globals() })
    writeResult(runId, result ?? null)
  } catch (err) {
    status = ac.signal.aborted ? "interrupted" : "failed"
    error = err instanceof Error ? err.message : String(err)
  } finally {
    clearInterval(heartbeat)
    process.removeListener("SIGINT", onSig)
    process.removeListener("SIGTERM", onSig)
    await factory.shutdownAll()
    events.emit({ type: "run", status, runId, error })
    await events.close()
  }

  return { runId, result, status, error }
}

function resolveDefaults(meta: { defaultProvider?: ProviderId; defaultModel?: string; defaultSandbox?: Sandbox }, opts: RunOptions): RunDefaults {
  const o = opts.overrides ?? {}
  return {
    provider: o.provider ?? meta.defaultProvider ?? DEFAULTS.provider,
    model: o.model ?? meta.defaultModel,
    effort: o.effort,
    sandbox: o.sandbox ?? meta.defaultSandbox ?? DEFAULTS.sandbox,
    approval: DEFAULTS.approval,
    cwd: resolve(o.cwd ?? process.cwd()),
    concurrency: o.concurrency ?? DEFAULTS.concurrency,
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
