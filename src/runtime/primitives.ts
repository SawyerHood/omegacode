// The DSL primitives, bound to a Runtime. agent() resolves a spec, computes its chained resume key,
// replays a completed journal entry if present, else runs the worker; parallel()/pipeline() fan out
// under the concurrency cap. now()/random() are journal-seeded for deterministic replay.
//
// Keys are per-branch deterministic (see keys.ts): each parallel() thunk and each pipeline()
// (item, stage) runs inside a child KeyContext whose lineage descends from its parent branch, the
// fan-out CALL's position within that branch (a per-branch call counter — two sequential identical
// fan-outs must not collide), and the thunk/item/stage index. An agent()'s journal key therefore
// depends only on WHERE it sits in the call tree, never on the wall-clock order sibling branches
// finish in. now()/random() also draw from per-branch substreams.

import { AsyncLocalStorage } from "node:async_hooks"
import type {
  AgentOpts,
  AgentResult,
  AgentSpec,
  PipelineStage,
  RunDefaults,
  WorkflowGlobals,
} from "../dsl/types.js"
import { addUsage, emptyUsage, PROVIDER_IDS } from "../dsl/types.js"
import type { WorkerFactory, WorkerProgress } from "../worker/index.js"
import { AgentError, AgentInterrupted } from "../worker/index.js"
import { withRetry } from "../worker/errors.js"
import { stripNullOptionals, validate } from "../worker/schema.js"
import { Journal, type LoadedJournal } from "./journal.js"
import { branchKey, chainKey, explicitKey, keyedSpec, ROOT_KEY } from "./keys.js"
import type { EventSink } from "./events.js"
import { AgentTranscript } from "./transcript.js"
import { Semaphore } from "./semaphore.js"
import { createWorktree, findGitRoot, teardownWorktree, type Worktree } from "./worktree.js"

export class WorkflowError extends Error {}

/**
 * A single agent's failure (worker error wrap, persistent schema miss, worktree setup, …).
 * parallel()/pipeline() degrade it to a null item — unlike run-level WorkflowErrors
 * (budget/caps/duplicate keys), which abort the whole fan-out (see isControlFlow).
 */
export class AgentFailedError extends WorkflowError {}

/** Valid values for the enum-typed spec fields, validated at spec resolution (H14). */
export const SPEC_ENUMS = {
  provider: PROVIDER_IDS,
  sandbox: ["read-only", "workspace-write", "danger-full-access"],
  effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  approval: ["never", "on-request"],
} as const satisfies Record<string, readonly string[]>

/**
 * Reject an out-of-enum spec field. Workflow bodies are untyped JS, so `agent("x", { sandbox:
 * "readonly" })` arrives here unchecked — passed through, it falls off the worker policy switches
 * (codex sends `undefined`; Claude treats anything ≠ read-only as writable), silently voiding the
 * sandbox guarantee. CLI flags are validated separately; this covers the workflow-body path.
 */
export function checkSpecEnum(field: keyof typeof SPEC_ENUMS, value: string | undefined): void {
  const allowed: readonly string[] = SPEC_ENUMS[field]
  if (value !== undefined && !allowed.includes(value)) {
    throw new WorkflowError(`invalid ${field} "${value}" — must be one of ${allowed.join(", ")}`)
  }
}

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
  /** meta.phases, announced as pending phase events up front so the viewer shows the full plan. */
  declaredPhases?: Array<{ title: string; detail?: string }>
}

/**
 * Per-branch deterministic state. Each branch (root body, a parallel() thunk, a pipeline() item or
 * stage) carries its own lineage key, a per-branch agent counter, a per-branch fan-out call counter
 * (so keys are concurrency-invariant AND repeated identical fan-outs stay distinct) and per-branch
 * now()/random() substreams seeded from the branch key.
 */
interface KeyContext {
  branchKey: string
  agentIndex: number
  /** Position of the next parallel()/pipeline() CALL within this branch (see parallel/pipeline). */
  fanoutIndex: number
  nowCounter: number
  rngState: number
}

/**
 * The branch substream is seeded from (run seed, branch key): stable on resume (the seed is
 * journaled), distinct per branch (concurrency-invariant), different across fresh runs.
 */
function newKeyContext(key: string, runSeed: number): KeyContext {
  return { branchKey: key, agentIndex: 0, fanoutIndex: 0, nowCounter: 0, rngState: seedFromKey(key, runSeed) }
}

/** Derive a non-zero 32-bit rng seed from a branch key hash mixed with the run seed. */
function seedFromKey(key: string, runSeed: number): number {
  let h = runSeed | 0
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  }
  return (h >>> 0) || 1
}

export class Runtime {
  private displayIndex = 0
  private agentCalls = 0
  private phaseIndex = 0
  private currentPhase: { index: number; title: string } | undefined
  private readonly phaseByTitle = new Map<string, number>()
  // Phases that have emitted their non-pending event. A declared phase reserves its index (and
  // emits a pending event) at construction, but is only "announced" when phase() reaches it —
  // that second emit is what places the terminal renderer's header at the right spot in the stream.
  private readonly announcedPhases = new Set<number>()
  private readonly sem: Semaphore
  private readonly worktreeMutex = new Semaphore(1)
  private readonly explicitKeys = new Set<string>()
  private readonly ctxStore = new AsyncLocalStorage<KeyContext>()
  private readonly rootCtx: KeyContext
  // In-flight agent() promises so the run loop can await settlement and a fire-and-forget agent()
  // (launched without `await`) can't turn into an unhandledRejection crash after "completed".
  private readonly inFlight = new Set<Promise<unknown>>()
  totalUsage = emptyUsage()

  constructor(private readonly o: RuntimeOpts) {
    this.sem = new Semaphore(o.defaults.concurrency)
    this.rootCtx = newKeyContext(ROOT_KEY, o.seed)
    // Fresh display indices start past anything a prior attempt journaled, so an agent whose key is
    // NOT in the journal can never collide with a journaled agent's index/transcript (see agentImpl).
    this.displayIndex = Math.max(0, ...o.loaded.indexByKey.values())
    // Reserve indices 1..N for declared phases in meta order, so phase() calls with matching
    // titles land in their declared slot regardless of execution order. meta.phases isn't
    // shape-validated (it's display-only), so skip entries without a usable title.
    for (const p of o.declaredPhases ?? []) {
      if (typeof p?.title !== "string" || p.title.length === 0) continue
      if (this.phaseByTitle.has(p.title)) continue
      const index = ++this.phaseIndex
      this.phaseByTitle.set(p.title, index)
      this.o.events.emit({ type: "phase", index, title: p.title, pending: true })
    }
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

  /** The active branch context (root body if none is on the stack). */
  private ctx(): KeyContext {
    return this.ctxStore.getStore() ?? this.rootCtx
  }

  private now(): number {
    return this.o.baseTimeMs + this.ctx().nowCounter++
  }

  private random(): number {
    // mulberry32 over the per-branch rng substream.
    const ctx = this.ctx()
    let t = (ctx.rngState = (ctx.rngState + 0x6d2b79f5) | 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  private ensurePhase(title: string): number {
    let index = this.phaseByTitle.get(title)
    if (index === undefined) {
      index = ++this.phaseIndex
      this.phaseByTitle.set(title, index)
    }
    // First actual entry emits the non-pending event — even for a declared phase, whose pending
    // event already reserved the index. Folds clear `pending` on this re-emit (same index).
    if (!this.announcedPhases.has(index)) {
      this.announcedPhases.add(index)
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
    const spec: AgentSpec = {
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
    // Validate the RESOLVED values so both per-call opts and run defaults are covered (H14).
    // Provider included: an unknown provider would otherwise only fail at the factory — and not
    // at all under --fake, where it silently routes to the FakeWorker.
    checkSpecEnum("provider", spec.provider)
    checkSpecEnum("sandbox", spec.sandbox)
    checkSpecEnum("effort", spec.effort)
    checkSpecEnum("approval", spec.approval)
    return spec
  }

  private agent<T = string>(prompt: string, opts?: AgentOpts): Promise<T> {
    // Track every agent() promise so the run loop can await settlement (an agent() launched without
    // `await` would otherwise reject after the body "completed" → unhandledRejection crash).
    const p = this.agentImpl<T>(prompt, opts)
    this.inFlight.add(p)
    const done = () => this.inFlight.delete(p)
    p.then(done, done)
    return p
  }

  /** Wait for every in-flight agent() to settle. Rejections are already surfaced via events/journal. */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight))
    }
  }

  private async agentImpl<T = string>(prompt: string, opts?: AgentOpts): Promise<T> {
    // Synchronous prefix: chain the key off THIS branch's lineage + local index (concurrency-
    // invariant), then assign the display index (journal-stable, see below).
    const ctx = this.ctx()
    const localIndex = ctx.agentIndex++
    const promptStr = String(prompt)
    const spec = this.resolveSpec(promptStr, opts)
    // Key off the RESOLVED spec (not raw opts) so defaults/CLI overrides invalidate the cache (H8).
    const key = opts?.key
      ? explicitKey(opts.key)
      : chainKey(ctx.branchKey, localIndex, promptStr, keyedSpec(spec, opts?.worktree))
    if (opts?.key) {
      // Explicit keys must be unique within a run, or two calls collide on the same journal slot and
      // the earlier call replays the later call's result on resume (last-write-wins). Fail fast.
      if (this.explicitKeys.has(key)) {
        throw new WorkflowError(`duplicate explicit agent key "${opts.key}" — keys must be unique within a run`)
      }
      this.explicitKeys.add(key)
    }
    if (++this.agentCalls > this.o.defaults.maxAgents) {
      throw new WorkflowError(`agent() call cap reached (${this.o.defaults.maxAgents}) — likely a runaway loop`)
    }
    // Display index: stable per JOURNAL KEY across resume attempts (L12). The journal records
    // (key, index) on started/result entries; reusing that index means events and the transcript
    // file agents/<index>.jsonl keep pointing at the same logical agent on resume — a re-run
    // truncates only its OWN transcript, and a cached replay's drilldown finds the original one.
    // Keys not in the journal allocate fresh indices past the journaled maximum (no collision).
    const index = this.o.loaded.indexByKey.get(key) ?? ++this.displayIndex
    const label = opts?.label ?? firstLine(spec.prompt)
    // opts.phase overrides the ambient phase() group for this call.
    const phaseRef = opts?.phase != null ? { index: this.ensurePhase(String(opts.phase)), title: String(opts.phase) } : this.currentPhase
    const phaseIndex = phaseRef?.index
    const phaseTitle = phaseRef?.title

    // Resume replay: a COMPLETED journal entry short-circuits the worker. A journaled failure must
    // NOT replay as success — re-run it (it may be a transient that now succeeds).
    const cached = this.o.loaded.results.get(key)
    if (cached && cached.status === "completed") {
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
      // Budget is re-checked INSIDE the slot: queued agents all passed the pre-admission check at
      // usage≈0, so without this they would overrun the ceiling on a fan-out.
      const budgetTotal = this.o.defaults.budget
      if (budgetTotal != null && this.totalUsage.outputTokens >= budgetTotal) {
        throw new WorkflowError(`token budget exceeded (${this.totalUsage.outputTokens} / ${budgetTotal} output tokens)`)
      }
      const startedAt = Date.now()
      this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "running", startedAt })
      this.o.journal.append({ type: "started", key, index, label, provider: spec.provider })

      let worktree: (Worktree & { gitRoot: string }) | undefined
      const runSpec = { ...spec }
      // Transcript files are agents/<index>.jsonl — the address the server/viewer resolve from agent
      // events. The index is journal-key-stable across resume attempts (see above), so a re-run
      // truncates THIS agent's transcript, never an unrelated agent's that shifted submit position.
      const transcript = new AgentTranscript(this.o.runId, index)
      transcript.write({ kind: "meta", index, label, provider: spec.provider, model: spec.model, prompt: spec.prompt })
      transcript.write({ kind: "status", state: "running" })
      // Usage accumulates across the corrective-retry attempt(s) — do not lose the first attempt's.
      let attemptUsage = emptyUsage()
      // Tracked so the post-teardown worktree event (below) can re-state the right terminal state.
      let succeeded = false
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
        // Wrap the worker call in withRetry so a retryable AgentError (429/overload) backs off
        // instead of killing the agent and usually the whole run.
        let result = await withRetry(() => worker.runAgent(runSpec, workerCtx), this.o.signal)
        attemptUsage = result.usage
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
            result = await withRetry(() => worker.runAgent(corrective, workerCtx), this.o.signal)
            attemptUsage = addUsage(attemptUsage, result.usage)
            value = this.finalizeResult(spec, result)
          } else {
            throw err
          }
        }
        const durationMs = Date.now() - startedAt
        this.totalUsage = addUsage(this.totalUsage, attemptUsage)
        const branch = worktree?.branch
        this.o.journal.append({ type: "result", key, index, status: result.status, result: value, usage: attemptUsage, provider: spec.provider, worktreeBranch: branch, durationMs })
        // Surface the validated structured output in the chat feed as a JSON code block
        // (uniform across providers — Claude's lives only in the result channel, and codex's
        // extraction turn is silent).
        if (spec.schema && value !== undefined) {
          // Leading blank line so the fence starts its own line even when coalesced after prose.
          transcript.write({ kind: "text", text: "\n\n```json\n" + JSON.stringify(value, null, 2) + "\n```\n" })
        }
        transcript.write({ kind: "status", state: "done" })
        this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "done", durationMs, inputTokens: attemptUsage.inputTokens, outputTokens: attemptUsage.outputTokens, costUsd: attemptUsage.costUsd, resultPreview: preview(value) })
        succeeded = true
        return value as T
      } catch (err) {
        const durationMs = Date.now() - startedAt
        const message = err instanceof Error ? err.message : String(err)
        // Failed turns still bill (L6): fold the provider-reported usage of the failing attempt into
        // the run totals and the journal, so budget ceilings see the spend end-to-end. attemptUsage
        // already holds any completed-but-rejected attempts (e.g. a persistent schema miss).
        if (err instanceof AgentError && err.usage) attemptUsage = addUsage(attemptUsage, err.usage)
        this.totalUsage = addUsage(this.totalUsage, attemptUsage)
        this.o.journal.append({
          type: "result",
          key,
          index,
          status: err instanceof AgentInterrupted ? "interrupted" : "failed",
          result: null,
          usage: attemptUsage,
          provider: spec.provider,
          durationMs,
        })
        transcript.write({ kind: "status", state: "failed", error: message })
        this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: "failed", durationMs, inputTokens: attemptUsage.inputTokens, outputTokens: attemptUsage.outputTokens, costUsd: attemptUsage.costUsd, error: message })
        throw err instanceof AgentError || err instanceof AgentInterrupted ? err : new AgentFailedError(`agent failed: ${message}`)
      } finally {
        await transcript.close().catch(() => {})
        if (worktree) {
          // Thread the creation-time base through teardown (H10): the git-config fallback lives in
          // the SHARED .git/config, so parallel worktrees overwrite each other (last-writer-wins).
          const teardown = await this.worktreeMutex
            .run(() => teardownWorktree({ gitRoot: worktree!.gitRoot, worktree: { path: worktree!.path, branch: worktree!.branch, base: worktree!.base } }))
            .catch(() => undefined)
          if (teardown?.changed) {
            // Trailing event re-stating the terminal state with where the preserved edits live (L14)
            // — renderers dedupe terminal rows, so this only surfaces the worktree fields.
            this.o.events.emit({ type: "agent", index, phaseIndex, phaseTitle, label, provider: spec.provider, model: spec.model, state: succeeded ? "done" : "failed", worktreeBranch: teardown.preservedBranch, worktreePath: teardown.preservedPath })
          }
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
    // Each fan-out CALL is its own lineage node, keyed by this branch's call counter: two
    // sequential identical parallel() calls in one branch must derive distinct child lineages, or
    // their agents collide on the same journal slots → wrong-result replay on resume (C1).
    const ctx = this.ctx()
    const callKey = branchKey(ctx.branchKey, "parallel", ctx.fanoutIndex++)
    const results = await Promise.all(
      thunks.map(async (fn, i) => {
        if (typeof fn !== "function")
          throw new WorkflowError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)")
        const child = newKeyContext(branchKey(callKey, "branch", i), this.o.seed)
        try {
          return await this.ctxStore.run(child, fn)
        } catch (err) {
          // Control-flow errors (Ctrl-C, budget/fan-out caps, runaway-loop) must propagate — turning
          // them into null silently poisons results and lets a doomed body keep running/spinning.
          if (isControlFlow(err)) throw err
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
    // Same call-counter lineage as parallel(): repeated identical pipeline() calls stay distinct.
    const ctx = this.ctx()
    const callKey = branchKey(ctx.branchKey, "pipeline", ctx.fanoutIndex++)
    return await Promise.all(
      items.map(async (item, index) => {
        // Each item is its own branch; each stage descends one more level. Keys depend on the
        // (call, item, stage) position, never on which item finishes first.
        const itemCtx = newKeyContext(branchKey(callKey, "item", index), this.o.seed)
        let prev: unknown = item
        try {
          for (let s = 0; s < stages.length; s++) {
            if (prev === null) break
            const stage = stages[s]!
            const stageCtx = newKeyContext(branchKey(itemCtx.branchKey, "stage", s), this.o.seed)
            const value = prev
            prev = await this.ctxStore.run(stageCtx, () => stage(value, item, index))
          }
          return prev
        } catch (err) {
          if (isControlFlow(err)) throw err
          this.log(`pipeline[${index}] failed: ${(err as Error).message}`)
          return null
        }
      }),
    )
  }
}

/**
 * Errors that must abort the whole fan-out rather than degrade to a null result: interruption
 * (Ctrl-C) and the runtime's own invariants (budget/agent caps, duplicate explicit keys). A single
 * agent's failure — AgentError from the worker, or its AgentFailedError wrap (e.g. a persistent
 * schema miss) — nulls only its own item, matching the baseline per-item semantics.
 */
function isControlFlow(err: unknown): boolean {
  return err instanceof AgentInterrupted || (err instanceof WorkflowError && !(err instanceof AgentFailedError))
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
