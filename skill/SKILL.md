---
name: omegacode
description: Author and run multi-agent workflows with the `omegacode` CLI — JavaScript files that orchestrate Codex (gpt-5.x) and Claude Code agents deterministically via agent()/parallel()/pipeline()/phase(). Use when a task is big enough to decompose and run in parallel, when you want independent perspectives and adversarial checks before committing, or when the work is too large for one context (broad audits, migrations, multi-source research, exhaustive reviews). Covers the file shape, the DSL, mixing providers, structured output, worktree isolation, determinism, resume, the live viewer, and every CLI command.
metadata:
  type: reference
---

# omegacode

Run a workflow file that orchestrates multiple agents deterministically. `omegacode run <file.workflow.js>` executes the file; it persists to `~/.omegacode/runs/<id>/` and prints a runId. Use `omegacode serve` (or `run --open`) to watch live progress. Each `agent()` call spawns a real **Codex** (gpt-5.x) or **Claude Code** agent — you pick the provider per call.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The file is where you encode that structure: what fans out, what verifies, what synthesizes.

When you write one, the right move is often **hybrid**: scout first (list the files, find the channels, scope the diff) to discover the work-list, then write a workflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across runs:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (example below)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

Every script must begin with `export const meta = {...}`:
```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',   // one-line summary
  phases: [                                            // one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
// ...
```

The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: `name`, `description`. Optional: `phases`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group.

Script body hooks:
- agent(prompt: string, opts?: {provider?: 'codex' | 'claude-code' | 'opencode' | 'pi', model?: string, effort?: string, schema?: object, label?: string, sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access', cwd?: string, instructions?: string, maxTurns?: number, worktree?: boolean, key?: string}): Promise<any> — spawn an agent. Without schema, returns its final text as a string. With schema (a JSON Schema), the agent is forced to return JSON matching it and agent() returns the validated object — no parsing needed. Returns null if the user skips the agent mid-run (filter with .filter(Boolean)). opts.provider / opts.model: **default to omitting both** — the agent inherits the provider and model the workflow is being run with (set by `--provider`/`--model`, default `codex`), which is almost always correct. Only set them when the user explicitly asks for a specific provider/model, or you're highly confident a particular step needs a different one. opts.label overrides the display label. opts.sandbox defaults to `read-only`; use `workspace-write` (write to cwd + network) only when the agent must write. opts.worktree: true runs the agent in a fresh git worktree — EXPENSIVE (setup + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged. opts.key is a stable resume pin that survives prompt-wording/reordering edits.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to `null` and skips its remaining stages.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to `null` in the result array — the call itself never rejects, so `.filter(Boolean)` before using the results. Use ONLY when you genuinely need all results together.
- log(message: string): void — emit a progress message to the user (shown as a narrator line above the progress tree)
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under this title in the progress display
- args: any — the value passed via `--args '<json>'` / `--args-file <f>`, verbatim (undefined if not provided). Use this to parameterize a workflow — e.g. pass a research question, target path, or config object.
- budget: {total: number|null, spent(): number, remaining(): number} — the run's output-token target, set with `--budget N`. `budget.total` is null if no target was set. `budget.spent()` returns output tokens spent this run. `budget.remaining()` returns `max(0, total - spent())`, or `Infinity` if no target. The target is a HARD ceiling, not advisory: once `spent()` reaches `total`, further `agent()` calls throw. Use for dynamic loops: `while (budget.total && budget.remaining() > 50_000) { ... }`, or static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.
- now(): number / random(): number — journal-seeded deterministic time/RNG. Use these instead of `Date.now()`/`Math.random()` (which throw — see below).

Agents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the worker layer and the agent retries once on a mismatch.

## Providers

Every agent() runs under a provider/model. **By default, do NOT set `provider` or `model` per agent** — each agent inherits the provider/model the workflow is being run with (`--provider` / `--model`, default `codex`), which is almost always what you want. Most workflows (including the canonical example and the patterns above) omit them entirely. Pin them only when the user explicitly asks for a specific provider/model, or you're confident a particular step needs a different one. `omegacode doctor` shows which providers are installed/authed.

The four providers:
- **codex** (OpenAI, gpt-5.x) — the default. `opts.effort` tunes reasoning depth: `"minimal" | "low" | "medium" | "high" | "xhigh"`. Requires the `codex` CLI authenticated (ChatGPT login); its built-in tools (incl. hosted image generation) come from that auth, and it ignores `OPENAI_API_KEY`. Native structured output via a free-form working turn then a schema-constrained extraction turn.
- **claude-code** (Anthropic) — via the Claude Agent SDK; requires the `claude` CLI / SDK available. `opts.effort` accepts `"low" | "medium" | "high" | "xhigh" | "max"` (`max` is Opus-tier; the model silently downgrades unsupported levels). Structured output is delivered on the final result only (intermediate messages stay free-form).
- **opencode** (OpenCode CLI ≥ 1.16.2) — spawn-per-call subprocess backend. `model` is an open `provider/model` string routed by opencode (e.g. `"openrouter/anthropic/claude-sonnet-4.5"`); omit it to use opencode's own default resolution. **Requires `sandbox: "danger-full-access"`** — opencode has no enforceable confinement, so the default `read-only` sandbox is rejected with an actionable error. `effort` and `maxTurns` are rejected. Structured output via a silent extraction turn that reuses the working session.
- **pi** (`@earendil-works/pi-coding-agent` ≥ 0.79.1) — spawn-per-call subprocess backend. `model` is an open pi model reference (e.g. `"openrouter/moonshotai/kimi-k2.6"`). **Requires `sandbox: "danger-full-access"`** — pi's tool allowlists are not OS confinement, so `read-only`/`workspace-write` are rejected. `effort` maps onto pi's full thinking range (`none`→off … `max`→xhigh); `maxTurns` is rejected. Structured output via a silent tool-less extraction turn.

(`opts.effort` is a single union — `"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"` — and each worker maps to its nearest supported level: `minimal`→`low` on claude, `max`→`xhigh` on codex/pi; opencode rejects effort outright.)

codex and claude-code honor every `sandbox` mode (read-only by default); **opencode and pi are full-access-only** — every call on them needs an explicit `sandbox: "danger-full-access"` (per call or via `--sandbox`), a deliberate fail-closed choice because neither CLI can honestly enforce confinement. All providers honor `cwd`; `worktree: true` isolates parallel file edits regardless of provider. Outdated opencode/pi binaries are refused at runtime (`provider_outdated`); `omegacode doctor` flags them up front.

The default case — omit provider, so fan-out and synthesis run on whatever provider the workflow was invoked with:
```js
const findings = await parallel(AREAS.map(area => () =>
  agent(`Inspect ${area} and list concrete issues.`, { schema: FINDINGS_SCHEMA })))   // inherits the run's provider
const report = await agent(`Synthesize into a prioritized report:\n${JSON.stringify(findings.filter(Boolean), null, 2)}`)
return report
```
Pin a provider only when you mean to — e.g. a deliberate cross-provider verify pass (propose on the run's provider, refute on a different one) when the user has asked for that diversity:
```js
const verified = await pipeline(
  suspects,
  s => agent(`Is this a real bug? ${s.desc}`, { schema: VERDICT }),                          // run's provider
  (v, s) => agent(`Try to REFUTE that ${s.desc} is a bug; default to refuted if unsure.`,
    { provider: "claude-code", schema: VERDICT }).then(r => ({ ...s, real: v.real && !r.refuted })))
```

Scripts are plain JavaScript, NOT TypeScript — type annotations (`: string[]`), interfaces, and generics fail to parse. The script body runs in an async context — use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT `Date.now()`/`Math.random()`/argless `new Date()`, which throw (they would break resume) and are rejected by a submit-time lint; use the injected `now()`/`random()` instead, or pass timestamps in via `args`. No filesystem, network, or relative import/require in the workflow body (the agents do the I/O).

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote
```js
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter — no cross-item dependency
const c = await parallel(b.map(...))
```
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at 100 per workflow by default (override with `--concurrency N`) — excess calls queue and run as slots free up. You can pass more items than the cap to parallel()/pipeline() and they all complete; only up to the cap run at any moment. Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow. A single parallel()/pipeline() call accepts at most 4096 items; passing more is an explicit error, not a silent truncation.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{ key: 'bugs', prompt: '...' }, { key: 'perf', prompt: '...' }]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
// Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.
```

When a barrier IS correct — dedup across all findings before expensive verification:
```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA })))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT_SCHEMA })))
```

Loop-until-count pattern — accumulate to a target:
```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent("Find bugs in this codebase.", { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Loop-until-budget pattern — scale depth to `--budget`. Guard on budget.total: with no target set, remaining() is Infinity and the loop would run straight to the 1000-agent cap.
```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent("Find bugs in this codebase.", { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining() / 1000)}k remaining`)
}
```

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {                                              // loop-until-dry
  const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
    agent(f.prompt, { phase: 'Find', schema: BUGS })))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
    parallel(['correctness', 'security', 'repro'].map(lens => () =>   // ...each by 3 distinct lenses
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, { phase: 'Verify', schema: VERDICT })))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
// dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.
```

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
  ```js
  const votes = await parallel(Array.from({ length: 3 }, () => () =>
    agent(`Try to refute: ${claim}. Default to refuted=true if uncertain.`, { schema: VERDICT })))
  const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
  ```
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use a workflow for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

Every run has a runId (printed on completion). To resume after a script edit or interruption, re-run with `--resume <runId>` — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same file + same args → 100% cache hit. `Date.now()`/`Math.random()`/`new Date()` are unavailable in scripts (they would break this) — use `now()`/`random()`, or pass timestamps via `args`. Pin a call with `opts.key` to keep its cached result across reorders/edits.

## CLI commands

```
omegacode run <file.workflow.js | name> [--args '<json>' | --args-file <f>]
                                       [--provider codex|claude-code|opencode|pi] [--model m] [--effort e]
                                       [--sandbox read-only|workspace-write|danger-full-access] [--cwd dir]
                                       [--concurrency N] [--budget N] [--resume <runId>] [--fake] [--json] [--open]
omegacode serve [--port 4123] [--host h]      Live read-only web viewer of all runs
omegacode runs [--prune --keep <N>]           List runs (or prune old ones)
omegacode workflows [--json]                  List saved/named workflows (project, user, builtin)
omegacode save <file.workflow.js> [--project] [--force]   Save a workflow under its meta.name
omegacode validate <file.workflow.js | name>  Parse + check meta without running
omegacode doctor                              Check codex/claude availability + data dir
omegacode install-skill [--claude] [--agents] Install this skill into agent skill dirs
```

`--fake` runs with a fake worker (no real agents) for a fast smoke test; `--json` prints `{runId, status, url, result, error}` (and still starts the viewer). The viewer (`serve` / `run --open`, and auto-started by `run`) reads `~/.omegacode/runs` and shows a run list, a live phase/agent tree, and a per-agent chat-feed drilldown; it streams via SSE and never executes anything.

## Saved / named workflows

`run` and `validate` accept a bare name instead of a path (anything with a path separator or `.js` suffix is treated as a file). A name is the workflow's **`meta.name`** — not its filename — and resolves across three tiers, highest precedence first: **project** (every `.omegacode/workflows/` from cwd up to the repo root; nearer shadows farther), **user** (`~/.omegacode/workflows/`), and the package **built-ins**. `omegacode save <file>` copies a validated workflow into the user tier (`--project` for the project tier; `--force` to overwrite); `omegacode workflows` lists everything visible.

Six built-ins ship with the package. Two are ports of Claude Code's bundled workflows:
- **`deep-research`** — `omegacode run deep-research --args '"<question>"'`: scope → 5 parallel web searches → fetch/dedup top sources → 3-vote adversarial verification per claim → cited report.
- **`code-review`** — `omegacode run code-review [--args '{"target": "...", "level": "high|xhigh|max"}']`: one finder per review angle, an independent verifier per finding (CONFIRMED/PLAUSIBLE/REFUTED), a gap-sweep at xhigh/max, ranked report.

The other four are omegacode-original multi-provider workflows — designs where two models' decorrelated errors are the point:
- **`multi-provider-review`** — `omegacode run multi-provider-review [--args '{"target": "..."}']`: Codex and Claude each review the entire feature/branch independently (identical prompts, blind to each other), then a synthesis agent merges both — consensus findings ranked first, unique catches attributed, disagreements called out. Target defaults to the current branch vs its merge-base with the default branch.
- **`bake-off`** — `omegacode run bake-off --args '"<task>"'`: both providers implement the same task in isolated worktrees (committed work only), blind A/B judges from both providers score the diffs, a tie-break settles splits, and the report names what to graft from the loser. Both branches are preserved.
- **`provider-debate`** — `omegacode run provider-debate --args '"<question>"'` (or `'{"question": "...", "rounds": 2, "proposer": "codex"}'`): one provider proposes, the other attacks, N rounds of rebuttal, then a judge rules — recommendation, survived/conceded points, open questions.
- **`second-opinion`** — `omegacode run second-opinion --args '"<question>"'`: both providers answer at low effort; if they agree the merged answer returns cheap, if they disagree both escalate to xhigh effort with the other's answer in hand and an adjudicator decides.

## Running a workflow for a user (from an agent)

When you (an agent such as Claude Code or Codex) run a workflow on a user's behalf, do two things:

- **Background it (Claude Code) or block on it (Codex).** A workflow can run for many minutes (it spawns many agents). If you are **Claude Code**, launch `omegacode run …` in the background (your background-shell / detached process) and poll or await it for the result — don't run it in the foreground and block. If you are **Codex**, block on the run until it completes (run it in the foreground and wait for the result) unless the user specifies otherwise — Codex has no reliable background-shell to poll from, so blocking is the correct default.
- **Link the viewer so the user can track progress.** The moment a run starts it prints `view: http://127.0.0.1:4123/#/run/<id>` (and `--json` returns the same in the `url` field). Surface that URL to the user as a clickable link *immediately* — before the run finishes — so they can watch live: the phase tree and per-agent chat feed stream in real time. Then check back when the run completes and report the result.

The viewer auto-starts on `run` (reused if already up) and idle-shuts-down once no run is active and no one is watching, so there's nothing to clean up.
