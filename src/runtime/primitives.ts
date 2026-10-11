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
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type {
  AgentOpts,
  AgentResult,
  AgentSpec,
  AgentUsage,
  Effort,
  PipelineStage,
  ProviderId,
  RunDefaults,
  Sandbox,
  WorkflowGlobals,
  WorkflowOpts,
} from "../dsl/types.js"
import { addUsage, emptyUsage, PROVIDER_IDS } from "../dsl/types.js"
import type { WorkerFactory, WorkerProgress } from "../worker/index.js"
import { AgentError, AgentInterrupted } from "../worker/index.js"
import { withRetry } from "../worker/errors.js"
import { stripNullOptionals, validate, assertValidSchema } from "../worker/schema.js"
import { Journal, type LoadedJournal } from "./journal.js"
import { branchKey, chainKey, determinismLint, explicitKey, canonical, keyedSpec, ROOT_KEY } from "./keys.js"
import type { EventSink } from "./events.js"
import { parseWorkflow, runInSandbox } from "./sandbox.js"
import { resolveWorkflowName } from "./registry.js"
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
  effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
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

/**
 * Enforce the both-or-neither rule for (provider, model) at a single specification site. A lone
 * `provider` would otherwise inherit the run-default `model` — a model meant for a DIFFERENT
 * provider (a real run passed a run-wide gpt-5.5 to a per-call claude-code override that way);
 * a lone `model` is the same leak from the other side. Model strings themselves stay open
 * (each backend is authoritative) — this validates pairing, never model content.
 */
export function checkProviderModelPair(provider: string | undefined, model: string | undefined, site: string): void {
  if ((provider === undefined) === (model === undefined)) return
  const given = provider !== undefined ? `provider "${provider}" without model` : `model "${model}" without provider`
  throw new WorkflowError(
    `${site}: ${given} — provider and model must be specified together (set both, or omit both to inherit the run defaults)`,
  )
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
  /** Parent runtime for workflow() nesting: shared journal/events/workers/budget/counters. */
  parent?: Runtime
  /** Nesting depth (0 = top-level body). workflow() refuses to nest past 1. */
  depth?: number
  /** Lineage root for this runtime's KeyContext (child runtimes derive it from the call site). */
  rootBranchKey?: string
  /** Prefix for phase titles emitted under this runtime (child workflows group visibly). */
  phasePrefix?: string
  /** Hard ceiling on workflow execution time, forwarded to nested sandbox runs. */
  execTimeoutMs?: number
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
  /** Position of the next workflow() CALL within this branch (same collision rule as fan-out). */
  workflowIndex: number
  nowCounter: number
  rngState: number
}

/**
 * The branch substream is seeded from (run seed, branch key): stable on resume (the seed is
 * journaled), distinct per branch (concurrency-invariant), different across fresh runs.
 */
function newKeyContext(key: string, runSeed: number): KeyContext {
  return { branchKey: key, agentIndex: 0, fanoutIndex: 0, workflowIndex: 0, nowCounter: 0, rngState: seedFromKey(key, runSeed) }
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
  /** Run-shared tallies (display/phase/agent counters). One box per run — children share it. */
  private readonly tally: { display: number; phase: number; agents: number }
  private currentPhase: { index: number; title: string } | undefined
  private readonly phaseByTitle: Map<string, number>
  // Phases that have emitted their non-pending event. A declared phase reserves its index (and
  // emits a pending event) at construction, but is only "announced" when phase() reaches it —
  // that second emit is what places the terminal renderer's header at the right spot in the stream.
  private readonly announcedPhases: Set<number>
  private readonly sem: Semaphore
  private readonly worktreeMutex = new Semaphore(1)
  private readonly explicitKeys: Set<string>
  private readonly ctxStore = new AsyncLocalStorage<KeyContext>()
  private readonly rootCtx: KeyContext
  // In-flight agent() promises so the run loop can await settlement and a fire-and-forget agent()
  // (launched without `await`) can't turn into an unhandledRejection crash after "completed".
  // Shared across nesting: the top-level settle() drains the whole tree.
  private readonly inFlight: Set<Promise<unknown>>
  private ownUsage = emptyUsage()

  /** Run-shared token accumulator. Children spend from (and report into) the same budget. */
  get totalUsage(): AgentUsage {
    return this.o.parent ? this.o.parent.totalUsage : this.ownUsage
  }
  set totalUsage(v: AgentUsage) {
    if (this.o.parent) this.o.parent.totalUsage = v
    else this.ownUsage = v
  }

  constructor(private readonly o: RuntimeOpts) {
    const parent = o.parent
    // Run-shared machinery: a child runtime borrows the parent's semaphore, in-flight set,
    // key registries and phase map so indices/transcripts never collide across nesting levels.
    // Only the ambient phase pointer and KeyContext lineage stay per-runtime.
    this.sem = parent ? parent.sem : new Semaphore(o.defaults.concurrency)
    this.phaseByTitle = parent ? parent.phaseByTitle : new Map()
    this.announcedPhases = parent ? parent.announcedPhases : new Set()
    this.explicitKeys = parent ? parent.explicitKeys : new Set()
    this.inFlight = parent ? parent.inFlight : new Set()
    this.tally = parent ? parent.tally : { display: 0, phase: 0, agents: 0 }
    this.rootCtx = newKeyContext(o.rootBranchKey ?? ROOT_KEY, o.seed)
    if (!parent) {
      // Fresh display indices start past anything a prior attempt journaled, so an agent whose key is
      // NOT in the journal can never collide with a journaled agent's index/transcript (see agentImpl).
      this.tally.display = Math.max(0, ...o.loaded.indexByKey.values())
    }
    // Reserve indices 1..N for declared phases in meta order, so phase() calls with matching
    // titles land in their declared slot regardless of execution order. meta.phases isn't
    // shape-validated (it's display-only), so skip entries without a usable title.
    for (const p of o.declaredPhases ?? []) {
      if (typeof p?.title !== "string" || p.title.length === 0) continue
      const title = this.phaseTitle(p.title)
      if (this.phaseByTitle.has(title)) continue
      const index = ++this.tally.phase
      this.phaseByTitle.set(title, index)
      this.o.events.emit({ type: "phase", index, title, pending: true })
    }
  }

  /** Apply this runtime's phase prefix (child workflows group visibly under their ref). */
  private phaseTitle(title: string): string {
    return this.o.phasePrefix ? `${this.o.phasePrefix} › ${title}` : title
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
      workflow: this.workflow.bind(this) as WorkflowGlobals["workflow"],
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
    const full = this.phaseTitle(title)
    let index = this.phaseByTitle.get(full)
    if (index === undefined) {
      index = ++this.tally.phase
      this.phaseByTitle.set(full, index)
    }
    // First actual entry emits the non-pending event — even for a declared phase, whose pending
    // event already reserved the index. Folds clear `pending` on this re-emit (same index).
    if (!this.announcedPhases.has(index)) {
      this.announcedPhases.add(index)
      this.o.events.emit({ type: "phase", index, title: full })
    }
    return index
  }

  private phase(title: string): void {
    const t = String(title)
    this.currentPhase = { index: this.ensurePhase(t), title: this.phaseTitle(t) }
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
    // Pairing is checked on the RAW opts (after the enum checks, so a typo'd provider still reports
    // as invalid): a lone provider/model here would silently mix with the other half of the run
    // defaults — the exact leak this rule exists to prevent. resolveDefaults covers the CLI/meta sites.
    checkProviderModelPair(opts?.provider, opts?.model, "agent()")
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
    if (++this.tally.agents > this.o.defaults.maxAgents) {
      throw new WorkflowError(`agent() call cap reached (${this.o.defaults.maxAgents}) — likely a runaway loop`)
    }
    // Display index: stable per JOURNAL KEY across resume attempts (L12). The journal records
    // (key, index) on started/result entries; reusing that index means events and the transcript
    // file agents/<index>.jsonl keep pointing at the same logical agent on resume — a re-run
    // truncates only its OWN transcript, and a cached replay's drilldown finds the original one.
    // Keys not in the journal allocate fresh indices past the journaled maximum (no collision).
    const index = this.o.loaded.indexByKey.get(key) ?? ++this.tally.display
    const label = opts?.label ?? firstLine(spec.prompt)
    // opts.phase overrides the ambient phase() group for this call.
    const phaseRef = opts?.phase != null ? { index: this.ensurePhase(String(opts.phase)), title: this.phaseTitle(String(opts.phase)) } : this.currentPhase
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

  /**
   * Run a saved workflow inline (one level deep) and return its result. The child shares
   * this run's journal (namespaced keys), budget, workers, semaphore, signal and viewer
   * feed — only the KeyContext lineage, args and (optionally) defaults are its own.
   *
   * Resume safety: the child lineage mixes the call-site position, the ref, the child's file
   * hash AND the canonical args — so editing the leaf file, passing different args, or moving
   * the call all miss the cache and re-run, while an unchanged subtree replays instantly.
   */
  private async workflow<T = unknown>(ref: string, args?: unknown, opts?: WorkflowOpts): Promise<T> {
    const depth = this.o.depth ?? 0
    if (depth >= 1) {
      throw new WorkflowError("workflow() nests one level deep: conductors call leaves, leaves may not call workflow()")
    }
    if (typeof ref !== "string" || ref.length === 0) throw new WorkflowError("workflow() requires a registry name or file path")
    if (opts?.schema !== undefined) {
      try {
        assertValidSchema(opts.schema)
      } catch (err) {
        throw new WorkflowError(`workflow() schema does not compile: ${(err as Error).message}`)
      }
    }
    // Synchronous prefix (like agentImpl): derive the child lineage from THIS branch's position
    // before any await, so concurrent workflow() calls stay distinct and resume-stable.
    const ctx = this.ctx()
    const filePath = resolveWorkflowRef(ref, this.o.defaults.cwd)
    const source = readFileSync(filePath, "utf8")
    const fileHash = sha256(source)
    const lint = determinismLint(source)
    if (lint.length > 0) {
      throw new WorkflowError(
        `determinism lint failed for workflow "${ref}": ` + lint.map((f) => `${f.token} → use ${f.use}`).join("; "),
      )
    }
    const parsed = parseWorkflow(source)
    const callIndex = ctx.workflowIndex++
    const lineage = branchKey(
      ctx.branchKey,
      `workflow:${ref}:${fileHash.slice(0, 16)}:${sha256(canonical(args ?? null)).slice(0, 16)}`,
      callIndex,
    )
    const agentsBefore = this.tally.agents
    this.log(`→ workflow "${parsed.meta.name}" (${ref})`)
    const child = new Runtime({
      runId: this.o.runId,
      defaults: resolveChildDefaults(this.o.defaults, parsed.meta),
      factory: this.o.factory,
      journal: this.o.journal,
      loaded: this.o.loaded,
      events: this.o.events,
      args,
      seed: this.o.seed,
      baseTimeMs: this.o.baseTimeMs,
      signal: this.o.signal,
      parent: this,
      depth: depth + 1,
      rootBranchKey: lineage,
      phasePrefix: parsed.meta.name,
      execTimeoutMs: this.o.execTimeoutMs,
      declaredPhases: parsed.meta.phases,
    })
    const result = await runInSandbox({
      body: parsed.body,
      filename: filePath,
      globals: child.globals(),
      signal: this.o.signal,
      execTimeoutMs: this.o.execTimeoutMs,
    })
    const made = this.tally.agents - agentsBefore
    this.log(`← workflow "${parsed.meta.name}" → done (${made} agent calls): ${preview(result)}`)
    if (opts?.schema !== undefined) {
      // No corrective retry here (unlike agent()): the subtree already spent its budget —
      // a mismatch means the LEAF shape drifted, so fail loudly and let the author fix it.
      const check = validate(opts.schema, stripNullOptionals(result, opts.schema))
      if (!check.ok) throw new WorkflowError(`workflow "${parsed.meta.name}" result failed schema: ${check.errors}`)
      return stripNullOptionals(result, opts.schema) as T
    }
    return result as T
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

/**
 * Resolve a workflow() ref the same way the CLI resolves run targets: an existing path wins;
 * an arg that LOOKS like a path (separator or .js suffix) but doesn't exist is an error rather
 * than a silent registry fall-through; otherwise look up the registry name across tiers.
 */
function resolveWorkflowRef(ref: string, cwd: string): string {
  if (ref.includes("/") || ref.endsWith(".js")) {
    const p = resolve(cwd, ref)
    if (!existsSync(p)) throw new WorkflowError(`workflow file not found: "${ref}" (resolved to ${p})`)
    return p
  }
  return resolveWorkflowName(ref, cwd)
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

/**
 * Child-run defaults: the parent's resolved policy, overridden per-field by the leaf's meta.
 * The meta provider/model pair stays atomic (a lone half throws — the cross-provider leak).
 * Everything the leaf meta cannot express (cwd, concurrency, caps, budget, approval) inherits.
 */
function resolveChildDefaults(
  d: RunDefaults,
  meta: { defaultProvider?: ProviderId; defaultModel?: string; defaultSandbox?: Sandbox; defaultEffort?: Effort },
): RunDefaults {
  checkProviderModelPair(meta.defaultProvider, meta.defaultModel, "meta.defaultProvider/defaultModel")
  const provider = meta.defaultProvider ?? d.provider
  const model = meta.defaultModel ?? d.model
  const sandbox = meta.defaultSandbox ?? d.sandbox
  const effort = meta.defaultEffort ?? d.effort
  checkSpecEnum("provider", provider)
  checkSpecEnum("sandbox", sandbox)
  checkSpecEnum("effort", effort)
  return { ...d, provider, model, sandbox, effort }
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
