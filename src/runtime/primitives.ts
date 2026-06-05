// The DSL primitives, bound to a Runtime. agent() resolves a spec, computes its chained resume key,
// replays a completed journal entry if present, else runs the worker; parallel()/pipeline() fan out
// under the concurrency cap. now()/random() are journal-seeded for deterministic replay.

import type {
  AgentOpts,
  AgentResult,
  AgentSpec,
  PipelineStage,
  RunDefaults,
  WorkflowGlobals,
} from "../dsl/types.js"
import { addUsage, emptyUsage } from "../dsl/types.js"
import type { WorkerFactory, WorkerProgress } from "../worker/index.js"
import { AgentError, AgentInterrupted } from "../worker/index.js"
import { stripNullOptionals, validate } from "../worker/schema.js"
import { Journal, type LoadedJournal } from "./journal.js"
import { chainKey, ROOT_KEY } from "./keys.js"
import type { EventSink } from "./events.js"
import { AgentTranscript } from "./transcript.js"
import { Semaphore } from "./semaphore.js"
import { createWorktree, findGitRoot, teardownWorktree, type Worktree } from "./worktree.js"

export class WorkflowError extends Error {}

export interface RuntimeOpts {
  runId: string
  defaults: RunDefaults
  factory: WorkerFactory
  journal: Journal
  loaded: LoadedJournal
  events: EventSink
  args: unknown
  seed: number
  baseTimeMs: number
  signal: AbortSignal
}

export class Runtime {
  private prevKey = ROOT_KEY
  private agentCount = 0
  private phaseIndex = 0
  private currentPhase: { index: number; title: string } | undefined
  private readonly phaseByTitle = new Map<string, number>()
  private readonly sem: Semaphore
  private readonly worktreeMutex = new Semaphore(1)
  private rngState: number
  private nowCounter = 0
  totalUsage = emptyUsage()

  constructor(private readonly o: RuntimeOpts) {
    this.sem = new Semaphore(o.defaults.concurrency)
    this.rngState = (o.seed >>> 0) || 1
  }

  globals(): WorkflowGlobals {
    const total = this.o.defaults.budget
    const budget = Object.freeze({
      total,
      spent: () => this.totalUsage.outputTokens,
      remaining: () => (total == null ? Infinity : Math.max(0, total - this.totalUsage.outputTokens)),
    })
    return {
      agent: this.agent.bind(this) as WorkflowGlobals["agent"],
      parallel: this.parallel.bind(this),
      pipeline: this.pipeline.bind(this),
      phase: this.phase.bind(this),
      log: this.log.bind(this),
      now: this.now.bind(this),
      random: this.random.bind(this),
      budget,
      args: this.o.args,
    }
  }

  private now(): number {
    return this.o.baseTimeMs + this.nowCounter++
  }

  private random(): number {
    // mulberry32
    let t = (this.rngState += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private ensurePhase(title: string): number {
    let index = this.phaseByTitle.get(title)
    if (index === undefined) {
      index = ++this.phaseIndex
      this.phaseByTitle.set(title, index)
      this.o.events.emit({ type: "phase", index, title })
    }
    return index
  }

  private phase(title: string): void {
    const t = String(title)
    this.currentPhase = { index: this.ensurePhase(t), title: t }
  }

  private log(msg: string): void {
    this.o.events.emit({ type: "log", message: String(msg) })
  }

  private resolveSpec(prompt: string, opts: AgentOpts | undefined): AgentSpec {
    const d = this.o.defaults
    return {
      prompt,
      provider: opts?.provider ?? d.provider,
      model: opts?.model ?? d.model,
      effort: opts?.effort ?? d.effort,
      cwd: opts?.cwd ?? d.cwd,
      sandbox: opts?.sandbox ?? d.sandbox,
      approval: opts?.approval ?? d.approval,
      instructions: opts?.instructions,
      schema: opts?.schema,
      maxTurns: opts?.maxTurns,
    }
  }

  private async agent<T = string>(prompt: string, opts?: AgentOpts): Promise<T> {
    // Synchronous prefix: assign the chained key + index in deterministic call order.
    const key = chainKey(this.prevKey, String(prompt), opts)
    this.prevKey = key
    const index = ++this.agentCount
    if (this.agentCount > this.o.defaults.maxAgents) {
      throw new WorkflowError(`agent() call cap reached (${this.o.defaults.maxAgents}) — likely a runaway loop`)
    }
    const budgetTotal = this.o.defaults.budget
    if (budgetTotal != null && this.totalUsage.outputTokens >= budgetTotal) {
      throw new WorkflowError(`token budget exceeded (${this.totalUsage.outputTokens} / ${budgetTotal} output tokens)`)
    }
    const spec = this.resolveSpec(String(prompt), opts)
    const label = opts?.label ?? firstLine(spec.prompt)
    // opts.phase overrides the ambient phase() group for this call.
    const phaseRef = opts?.phase != null ? { index: this.ensurePhase(String(opts.phase)), title: String(opts.phase) } : this.currentPhase
    const phaseIndex = phaseRef?.index
    const phaseTitle = phaseRef?.title

    // Resume replay: a completed journal entry short-circuits the worker.
    const cached = this.o.loaded.results.get(key)
    if (cached) {
      this.o.events.emit({
        type: "agent",
        index,
        phaseIndex,
        phaseTitle,
        label,
        provider: cached.provider,
        model: spec.model,
        state: "done",
        cached: true,
        durationMs: cached.durationMs,
        resultPreview: preview(cached.result),
      })
      this.totalUsage = addUsage(this.totalUsage, cached.usage)
      return cached.result as T
    }

    this.o.events.emit({
      type: "agent",
      index,
      phaseIndex,
      phaseTitle,
      label,
      provider: spec.provider,
      model: spec.model,
      state: "queued",
      queuedAt: Date.now(),
      promptPreview: preview(spec.prompt),
    })

    return (await this.sem.run(async () => {
      if (this.o.signal.aborted) throw new AgentInterrupted()
      const startedAt = Date.now()
      this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "running", startedAt })
      this.o.journal.append({ type: "started", key, index, label, provider: spec.provider })

      let worktree: (Worktree & { gitRoot: string }) | undefined
      const runSpec = { ...spec }
      const transcript = new AgentTranscript(this.o.runId, index)
      transcript.write({ kind: "meta", index, label, provider: spec.provider, model: spec.model, prompt: spec.prompt })
      transcript.write({ kind: "status", state: "running" })
      try {
        if (opts?.worktree) {
          worktree = await this.setupWorktree(runSpec, opts.worktree, index)
        }
        const worker = this.o.factory.get(runSpec.provider)
        const workerCtx = {
          signal: this.o.signal,
          onProgress: (e: WorkerProgress) => {
            switch (e.kind) {
              case "text":
                transcript.write({ kind: "text", text: e.text })
                break
              case "reasoning":
                transcript.write({ kind: "reasoning", text: e.text })
                break
              case "tool":
                transcript.write({ kind: "tool", id: e.id, name: e.name, input: e.input })
                this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "running", lastTool: e.name })
                break
              case "tool-result":
                transcript.write({ kind: "tool-result", id: e.id, name: e.name, output: e.output, isError: e.isError })
                break
              case "usage":
                this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "running", inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens })
                break
            }
          },
        }
        let result = await worker.runAgent(runSpec, workerCtx)
        let value: unknown
        try {
          value = this.finalizeResult(spec, result)
        } catch (err) {
          // One corrective retry on a schema-validation miss (DESIGN §6.3).
          if (spec.schema && err instanceof WorkflowError && err.message.startsWith("structured output failed schema")) {
            this.o.events.emit({ type: "log", message: `[${label}] structured output retry: ${err.message}` })
            const corrective = {
              ...runSpec,
              instructions: `${runSpec.instructions ?? ""}\n\nYour previous response did not match the required JSON schema (${err.message}). Respond again with ONLY a JSON value that exactly matches the schema.`.trim(),
            }
            result = await worker.runAgent(corrective, workerCtx)
            value = this.finalizeResult(spec, result)
          } else {
            throw err
          }
        }
        const durationMs = Date.now() - startedAt
        this.totalUsage = addUsage(this.totalUsage, result.usage)
        const branch = worktree?.branch
        this.o.journal.append({ type: "result", key, index, status: result.status, result: value, usage: result.usage, provider: spec.provider, worktreeBranch: branch, durationMs })
        transcript.write({ kind: "status", state: "done" })
        this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "done", durationMs, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.usage.costUsd, resultPreview: preview(value) })
        return value as T
      } catch (err) {
        const durationMs = Date.now() - startedAt
        const message = err instanceof Error ? err.message : String(err)
        transcript.write({ kind: "status", state: "failed", error: message })
        this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "failed", durationMs, error: message })
        throw err instanceof AgentError || err instanceof AgentInterrupted ? err : new WorkflowError(`agent failed: ${message}`)
      } finally {
        await transcript.close().catch(() => {})
        if (worktree) {
          await this.worktreeMutex.run(() => teardownWorktree({ gitRoot: worktree!.gitRoot, worktree: { path: worktree!.path, branch: worktree!.branch } })).catch(() => {})
        }
      }
    })) as T
  }

  private finalizeResult(spec: AgentSpec, result: AgentResult): unknown {
    if (!spec.schema) return result.text
    if (result.structured !== undefined) {
      const normalized = stripNullOptionals(result.structured, spec.schema)
      const check = validate(spec.schema, normalized)
      if (!check.ok) throw new WorkflowError(`structured output failed schema: ${check.errors}`)
      return normalized
    }
    throw new WorkflowError("agent({schema}) returned no structured output")
  }

  private async setupWorktree(spec: AgentSpec, wt: boolean | string, index: number): Promise<Worktree & { gitRoot: string }> {
    const gitRoot = await findGitRoot(spec.cwd)
    if (!gitRoot) throw new WorkflowError("worktree: true requires the cwd to be a git repository")
    const created = await this.worktreeMutex.run(() =>
      createWorktree({ gitRoot, runId: this.o.runId, index, branch: typeof wt === "string" ? wt : undefined }),
    )
    spec.cwd = created.path
    spec.sandbox = "workspace-write"
    spec.instructions = `${spec.instructions ?? ""}\n\nYou are in an isolated git worktree at ${created.path}; changes here do not affect the main directory or other agents.`.trim()
    return { ...created, gitRoot }
  }

  private async parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
    if (!Array.isArray(thunks)) throw new WorkflowError("parallel() expects an array of functions")
    if (thunks.length > this.o.defaults.maxFanout)
      throw new WorkflowError(`parallel(): ${thunks.length} items exceeds the ${this.o.defaults.maxFanout} fan-out cap`)
    const results = await Promise.all(
      thunks.map(async (fn, i) => {
        if (typeof fn !== "function")
          throw new WorkflowError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)")
        try {
          return await fn()
        } catch (err) {
          this.log(`parallel[${i}] failed: ${(err as Error).message}`)
          return null as unknown as T
        }
      }),
    )
    return results
  }

  private async pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new WorkflowError("pipeline() expects an array as the first argument")
    if (items.length > this.o.defaults.maxFanout)
      throw new WorkflowError(`pipeline(): ${items.length} items exceeds the ${this.o.defaults.maxFanout} fan-out cap`)
    return await Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = item
        try {
          for (const stage of stages) {
            if (prev === null) break
            prev = await stage(prev, item, index)
          }
          return prev
        } catch (err) {
          this.log(`pipeline[${index}] failed: ${(err as Error).message}`)
          return null
        }
      }),
    )
  }
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? s
  return line.length > 60 ? line.slice(0, 59) + "…" : line
}

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v)
  if (!s) return ""
  return s.length > 400 ? s.slice(0, 399) + "…" : s
}
