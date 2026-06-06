---
name: agent-workflows
description: Author and run multi-agent workflows with the `agent-workflows` CLI — JavaScript files that orchestrate Codex (gpt-5.x) and Claude Code agents via a small DSL (agent()/parallel()/pipeline()/phase()). Use when a task is big enough to decompose and run in parallel, when you want independent perspectives and adversarial checks before committing, or when the work is too large for one context (broad audits, migrations, multi-source research, exhaustive reviews). Covers the file shape, the DSL, mixing providers, structured output, sandbox/worktree, determinism, resume, the live viewer, and every CLI command.
metadata:
  type: reference
---

# agent-workflows

`agent-workflows` is a CLI that runs a **JavaScript workflow file** which orchestrates many **agents**
deterministically. You write the file; the CLI executes it in a hardened sandbox, and each `agent()`
call spawns a real agent turn — a **Codex** (gpt-5.x) or **Claude Code** agent, your choice per call.
The file holds the control flow (loops, fan-out, fan-in, conditionals) that a single agent turn can't do
reliably, and accumulates results in plain variables.

This is the standalone-CLI analog of Claude Code's built-in Workflows. If you know that, you know this —
the differences are: it runs `.js` files from the terminal (not a tool call), each `agent()` picks a
**provider** (`codex` or `claude-code`), and runs persist to `~/.agent-workflows/runs/<id>/` with a live
web viewer.

```bash
agent-workflows run myflow.workflow.js          # run a workflow file
agent-workflows run myflow.workflow.js --open   # …and open the live viewer
agent-workflows serve                           # the viewer (all runs), http://127.0.0.1:4123
```

## When to use a workflow

Reach for a workflow to be **comprehensive** (decompose and cover in parallel), to be **confident**
(independent perspectives and adversarial checks before committing), or to take on **scale** one context
can't hold (migrations, audits, broad sweeps). The file is where you encode that structure: what fans
out, what verifies, what synthesizes. For a single-fact lookup, just answer directly — don't write a
workflow.

Common shapes (each is one fan-out you can chain across runs):
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — a judge panel of N independent approaches → scored synthesis.
- **Review** — dimensions → find → adversarially verify (the canonical example below).
- **Research** — multi-modal sweep → deep-read → synthesize.
- **Migrate** — discover sites → transform each (worktree isolation) → verify.

## File shape

Every workflow begins with `export const meta = {...}`, then the body:

```js
export const meta = {
  name: "review-changes",                       // required
  description: "Review the diff across dimensions, verify each finding",  // required
  phases: [{ title: "Review" }, { title: "Verify" }],  // optional, for the progress UI
}
// body starts here — top-level await is available
phase("Review")
const findings = await agent("List risky changes in the diff.", { schema: FINDINGS })
```

`meta` **must be a pure literal** — no variables, function calls, spreads, or template interpolation.
Required: `name`, `description`. Optional: `phases` (array of `{title, detail?}`); use the same titles in
`phase()` calls. Scripts are plain **JavaScript** (not TypeScript — no type annotations). Relative
`import`/`require` and network are unavailable; the body runs in an async context (use `await` directly).

## The DSL (injected globals)

- **`agent(prompt: string, opts?): Promise<string | T>`** — spawn one agent. Without a `schema` it
  resolves to the agent's final text; with a `schema` it returns a validated object `T`. Returns `null`
  if the user skips it mid-run (filter with `.filter(Boolean)`).
- **`parallel(thunks: Array<() => Promise<T>>): Promise<T[]>`** — run tasks concurrently. **This is a
  BARRIER**: it awaits all thunks. A thunk that throws resolves to `null` in the result array (the call
  itself never rejects) — `.filter(Boolean)` before using results.
- **`pipeline(items, stage1, stage2, ...): Promise<any[]>`** — run each item through all stages
  independently, **no barrier between stages**. Item A can be in stage 3 while item B is still in stage 1.
  Each stage callback gets `(prevResult, originalItem, index)`. A stage that throws drops that item to
  `null`. **This is the default for multi-stage work.**
- **`phase(title)`** — start a phase; subsequent `agent()` calls group under it in the UI.
- **`log(msg)`** — emit a progress line.
- **`now()` / `random()`** — journal-seeded deterministic time/RNG. **Use these instead of `Date.now()`
  / `new Date()` / `Math.random()`, which throw** (they'd break replay) and are rejected by the lint.
- **`budget`** — `{ total: number|null, spent(): number, remaining(): number }`. `spent()` is output
  tokens used this run. With `--budget N`, `agent()` throws once the ceiling is hit. Use for dynamic
  loops: `while (budget.total && budget.remaining() > 50_000) { ... }`.
- **`args`** — the value from `--args '<json>'` / `--args-file f` (undefined if not passed).

### `agent()` options
`{ provider, model, effort, sandbox, cwd, schema, instructions, maxTurns, worktree, label, key }`
- **`provider`** — `"codex"` (default) or `"claude-code"`. **Mix providers freely across a workflow**
  (e.g. Codex for breadth, Claude for synthesis).
- **`model`** — e.g. `"gpt-5.5"` (codex) or a Claude model id.
- **`effort`** — `"low" | "medium" | "high"` (codex reasoning effort).
- **`sandbox`** — `"read-only"` (default), `"workspace-write"` (write to `cwd` + network), or
  `"danger-full-access"`.
- **`cwd`** — working directory for the agent (defaults to the run's cwd).
- **`schema`** — a JSON Schema. The agent is forced to return validated JSON matching it (native
  structured output per provider); `agent()` returns the parsed object. One corrective retry on a miss.
- **`instructions`** — extra system instructions appended for that agent.
- **`maxTurns`** — cap the agent's internal turns.
- **`worktree`** — run the agent in a fresh git worktree (isolate parallel file edits; auto-removed if
  unchanged). EXPENSIVE — only when agents mutate files concurrently.
- **`label`** — display label in the UI/logs.
- **`key`** — a stable resume pin (survives prompt-wording/reordering edits).

## pipeline vs parallel — DEFAULT TO pipeline

`pipeline()` has no barrier between stages, so wall-clock = the slowest single-item chain, not
sum-of-slowest-per-stage. A **barrier** (`parallel` between stages) is correct ONLY when stage N needs
*all* of stage N-1 at once — dedup/merge across the full set, an early-exit on total count, or a prompt
that references "the other findings." It is **not** justified by "I need to flatten/map/filter first"
(do that inside a stage) or "it's cleaner." Smell test: if you wrote `const a = await parallel(...);
const b = transform(a); const c = await parallel(b...)` and the middle transform has no cross-item
dependency, rewrite as a pipeline with the transform inside a stage.

**Canonical multi-stage pattern** — pipeline by default; each dimension verifies as soon as its review
completes:
```js
export const meta = { name: "review", description: "Review dimensions, verify each finding",
  phases: [{ title: "Review" }, { title: "Verify" }] }
const DIMENSIONS = [{ key: "bugs", prompt: "..." }, { key: "perf", prompt: "..." }]
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, schema: FINDINGS }),
  (review) =>
    parallel(review.findings.map((f) => () =>
      agent(`Adversarially verify, default to refuted if unsure: ${f.title}`, { schema: VERDICT, provider: "claude-code" })
        .then((v) => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.real)
return { confirmed }
```

**Barrier IS correct** when you must dedup across all findings before expensive verification:
```js
const all = await parallel(DIMENSIONS.map((d) => () => agent(d.prompt, { schema: FINDINGS })))
const deduped = dedupe(all.filter(Boolean).flatMap((r) => r.findings))   // needs ALL at once
const verified = await parallel(deduped.map((f) => () => agent(verifyPrompt(f), { schema: VERDICT })))
```

## Loops

```js
// loop-until-count — accumulate to a target
const bugs = []
while (bugs.length < 10) { const r = await agent("Find bugs.", { schema: BUGS }); bugs.push(...r.bugs); log(`${bugs.length}/10`) }

// loop-until-budget — scale depth to --budget (guard on budget.total or it runs to the agent cap)
while (budget.total && budget.remaining() > 50_000) { const r = await agent("Find bugs.", { schema: BUGS }); bugs.push(...r.bugs) }

// loop-until-dry — keep finding until K rounds turn up nothing new (catches the tail a fixed count misses)
const seen = new Set(); let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map((f) => () => agent(f.prompt, { schema: BUGS })))).filter(Boolean).flatMap((r) => r.bugs)
  const fresh = found.filter((b) => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach((b) => seen.add(key(b)))
}
```

## Quality patterns

Pick by task and compose freely; scale to the ask ("find any bugs" → a few finders, single-vote verify;
"thoroughly audit" → larger pool, 3–5 vote adversarial pass, synthesis):
- **Adversarial verify** — spawn N independent skeptics per finding, each prompted to REFUTE (default to
  refuted if uncertain). Kill if a majority refute. Stops plausible-but-wrong findings.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security, perf,
  does-it-reproduce) rather than N identical refuters.
- **Judge panel** — generate N independent attempts from different angles, score with parallel judges,
  synthesize from the winner while grafting the best of the runners-up.
- **Multi-modal sweep** — parallel agents each searching a different way (by container, by content, by
  entity, by time); each blind to the others.
- **Completeness critic** — a final agent that asks "what's missing?"; its answer is the next round.
- **No silent caps** — if you bound coverage (top-N, sampling, no-retry), `log()` what was dropped.

## Determinism, caps, safety

- **Deterministic**: use `now()`/`random()`; `Date.now()`/`new Date()`/`Math.random()` throw and are
  rejected by a submit-time lint. `meta` must be a pure literal.
- **Caps**: concurrent `agent()` calls are capped (default 8, `--concurrency N`, max ~`cores-2`); excess
  queues. Lifetime cap 1000 agents (runaway backstop); ≤4096 items per `parallel`/`pipeline` call.
- **Sandbox**: agents are `read-only` by default. Use `workspace-write` only when an agent must write,
  and `worktree: true` when parallel agents edit files.
- **Cross-boundary values**: return JSON-serializable data from `agent()`/stages.

## Resume

Every run journals each completed `agent()` result keyed by a hash chain over the file + the call's
prompt/options. Re-running with `--resume <runId>` replays the **longest unchanged prefix** instantly and
re-runs only from the first edited/added call onward. Edit your workflow and resume to iterate without
paying for already-completed agents. Pin a call with `key` to keep its cache across reorders/edits.

## CLI commands

```
agent-workflows run <file.workflow.js> [options]   Run a workflow
  --args '<json>' | --args-file <f>   input exposed as the `args` global
  --provider codex|claude-code        default provider for agents that don't set one
  --model <m> --effort <e> --sandbox <s> --cwd <dir>
  --concurrency <N>                   max concurrent agents (default 8)
  --budget <N>                        output-token ceiling (enables budget.* enforcement)
  --resume <runId>                    replay unchanged prefix, re-run the rest
  --fake                              run with a fake worker (no real agents) — fast smoke test
  --json                             print {runId, status, result, error} as JSON
  --open                             open the live viewer to this run

agent-workflows serve [--port 4123] [--host h]     Live read-only web viewer of all runs
agent-workflows runs [--prune --keep N]            List runs (or prune old ones)
agent-workflows validate <file.workflow.js>        Parse + check meta without running
agent-workflows doctor                             Check codex/claude availability + data dir
agent-workflows install-skill [--claude] [--agents]  Install this skill into agent skill dirs
```

## The viewer

`agent-workflows serve` (or `run --open`) starts a localhost web UI that reads `~/.agent-workflows/runs`:
a run list, a live phase/agent tree, and a per-agent **chat-feed drilldown** (the agent's messages,
reasoning, command/tool cards with output, and structured results). It streams live via SSE and never
executes anything — it only projects on-disk run state.

## Quick checklist

1. `export const meta = { name, description, phases? }` (pure literal) first.
2. Default to `pipeline()`; use `parallel()` (barrier) only when a stage needs all prior results at once.
3. Give each `agent()` a `schema` when you need structured data; mix `provider` per call.
4. Use `now()`/`random()`, never `Date.now()`/`Math.random()`.
5. Verify findings adversarially before trusting them; `log()` anything you cap.
6. `run --open` to watch; `--resume <runId>` to iterate cheaply.
