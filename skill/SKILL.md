---
name: authoring-codex-workflows
description: Author and run multi-agent Codex workflows with the `codex-workflows` CLI. Use when a task is big enough to fan out across many Codex agents and cross-check their work — broad codebase audits, large migrations, multi-source research, or any job you'd want decomposed and verified by independent agents. Covers the agent()/parallel()/pipeline()/phase() DSL, the `export const meta` file shape, structured output, git-worktree isolation, determinism rules, and how to run and resume.
metadata:
  type: reference
---

# Authoring Codex Workflows

A **workflow** is a small JavaScript file that orchestrates many **Codex agents** deterministically.
You write the file; the `codex-workflows` CLI runs it in a sandbox, and each `agent()` call spawns a
real Codex agent turn. The file holds the control flow (loops, fan-out, fan-in, conditionals) that a
single agent turn can't do reliably, and accumulates results in plain variables.

This is the Codex analog of Claude Code's Workflows. If you know that syntax, you already know this one.

## When to write a workflow

Reach for a workflow when the job is bigger than one agent can do well in one turn:
- **Comprehensive** — decompose the work and cover the parts in parallel (audit every package; review
  a diff along several angles; research a question from multiple directions).
- **Confident** — get independent perspectives and adversarially verify before trusting a result
  (have separate agents try to *refute* each finding).
- **Scale** — work that won't fit one context window: large migrations, repo-wide sweeps, many sources.

For a single self-contained task, just run one agent — don't write a workflow.

## File shape

A workflow file is a module whose **first statement is `export const meta = {…}`** (a pure literal),
followed by a body that uses the injected globals and ends with a top-level `return` of the result.
**Plain JavaScript** (TypeScript is transpiled before running). **No imports** — the globals are
already in scope.

```js
// review.workflow.js
export const meta = {
  name: "review-diff",
  description: "Review the staged diff along several angles, verify each finding.",
  phases: [{ title: "Review" }, { title: "Verify" }],   // optional; titles must match phase() calls
}

phase("Review")
const dimensions = ["correctness", "security", "performance"]
const reviews = await parallel(
  dimensions.map((d) => () =>
    agent(`Review the staged diff for ${d} issues. List each as {file, line, title, why}.`, {
      sandbox: "read-only",
      schema: { type: "object", required: ["findings"], properties: {
        findings: { type: "array", items: { type: "object",
          required: ["file", "title", "why"],
          properties: { file: { type: "string" }, line: { type: "number" },
            title: { type: "string" }, why: { type: "string" } } } } } },
    })),
)

phase("Verify")
const findings = reviews.flatMap((r) => r.findings)
const verdicts = await parallel(
  findings.map((f) => () =>
    agent(`Try to REFUTE this finding. Default to refuted=true if unsure.\n${JSON.stringify(f)}`, {
      sandbox: "read-only",
      schema: { type: "object", required: ["refuted"], properties: {
        refuted: { type: "boolean" }, reason: { type: "string" } } },
    }).then((v) => ({ ...f, real: !v.refuted }))),
)

return verdicts.filter((f) => f.real)
```

## The DSL (injected globals)

| Global | Signature | Notes |
|---|---|---|
| `agent` | `(prompt, opts?) => Promise<string \| T>` | Spawn one Codex agent turn. Returns its final text, or a validated `T` when `opts.schema` is set. |
| `parallel` | `(thunks) => Promise<T[]>` | Run thunks concurrently (under the cap), **await all** (barrier). **Wrap each call as `() => agent(...)`**, not `agent(...)`. |
| `pipeline` | `(items, ...stages) => Promise<R[]>` | Each item flows through all stages independently — **no barrier between stages**. Stage callbacks get `(prev, item, index)`. |
| `phase` | `(title) => void` | Open a named progress group; later `agent()` calls render under it. Match `meta.phases` titles exactly. |
| `log` | `(msg) => void` | Narrator line in the progress output. |
| `args` | value | The CLI input (`--args '<json>'`). `undefined` if not passed. |
| `now` | `() => number` | Replay-safe clock. **Use this, not `Date.now()`** (which throws). |
| `random` | `() => number` | Replay-safe RNG. **Use this, not `Math.random()`** (which throws). |

### `agent()` options

```
agent(prompt, {
  label?,                        // short label for the progress UI (no effect on resume)
  phase?,                        // override the current phase() group
  model?, effort?,               // Codex model + reasoning effort ("low"|"medium"|"high"|"xhigh")
  sandbox?,                      // "read-only" (default for research) | "workspace-write" | "danger-full-access"
  approval?,                     // "never" (default) | "on-request"
  cwd?,                          // working directory for this agent
  worktree?,                     // true | "branch-name": run in an isolated git worktree (see below)
  instructions?,                 // extra system instructions for this agent
  schema?,                       // JSON Schema → validated structured result (see below)
  key?,                          // pin a stable resume cache key (survives reordering)
})
```

### Structured output

Pass `schema` (JSON Schema) and the agent returns a **validated object** of that shape (backed by
Codex's native per-turn `outputSchema`). Use it whenever a later step needs to read fields rather than
parse prose. Without a schema, `agent()` returns the final text.

### Writing files / parallel mutation — use worktrees

Read-only agents (research, review, analysis) should set `sandbox: "read-only"`. Agents that **edit
files** need `sandbox: "workspace-write"`. If **multiple write-agents run in parallel** on the same
repo, give each `worktree: true` so it runs in an isolated `git worktree` and they don't clobber each
other. After the agent finishes: an unchanged worktree is auto-removed; a worktree with changes is
**preserved on its own branch** for you to review/merge. (Requires the cwd to be a git repo.)

## Rules that bite

- **First statement must be `export const meta = { name, description }`**, a pure literal (no variables,
  calls, or template interpolation).
- **No `Date.now()` / `Math.random()` / `new Date()`** — they throw (replay determinism). Use `now()` /
  `random()`. Pass any real timestamps in via `args`; for N independent samples, vary the agent prompt
  or `label` by index, don't rely on randomness.
- **No `import`, `require`, `fs`, `process`, network** — the workflow file is sandboxed. All real work
  (reading/writing files, running commands, searching the web) happens **inside the Codex agents** you
  spawn, never in the orchestration script itself.
- `parallel`/`pipeline` results: a thunk that errors becomes `null` in the array — **`.filter(Boolean)`**
  before using results.
- **`DEFAULT TO pipeline()`.** Use a `parallel` barrier only when a stage genuinely needs *all* prior
  results at once (dedup/merge across the whole set, early-exit on an empty result, or comparing items
  to each other). Otherwise `pipeline` is faster (wall-clock = slowest single item, not sum of stages).
- **Caps:** ≤16 concurrent agents; 1000 agents total per run (a runaway-loop backstop); ≤4096 items per
  `parallel`/`pipeline` call. If you cap coverage yourself (top-N, sampling), `log()` what you dropped.

## Patterns

- **Parallel fan-out → synthesize.** `parallel` N agents over a list, then one agent to merge/rank.
- **Pipeline (preferred for multi-stage).** `pipeline(items, find, verify)` — each item is verified as
  soon as its find stage returns, no waiting on the slowest finder.
- **Adversarial verify.** For each candidate finding, spawn 1–3 independent agents prompted to *refute*
  it (default to refuted-if-unsure); keep it only if it survives. Prevents plausible-but-wrong results.
- **Perspective-diverse verify.** When a finding can fail in more than one way, give each verifier a
  distinct lens (correctness / security / does-it-reproduce) instead of N identical skeptics.
- **Loop-until-dry.** For unknown-size discovery, keep spawning finders until K consecutive rounds turn
  up nothing new (dedupe against everything seen so far, not just confirmed results).
- **Completeness critic.** A final agent that asks "what's missing — an angle not covered, a claim not
  verified?"; its answer becomes the next round of work.

**Scale to the request.** "Find any bugs" → a few finders, single-vote verify. "Thoroughly audit this"
→ a larger finder pool, 3–5-vote adversarial verification, a synthesis stage.

## Running and resuming

```bash
codex-workflows run review.workflow.js --args '{"target":"HEAD~1"}'
codex-workflows run review.workflow.js --resume <runId>     # replay completed agents, run the rest
codex-workflows run review.workflow.js --resume-last        # resume the most recent run of this file
codex-workflows runs                                        # list runs you can resume
codex-workflows validate review.workflow.js                 # typecheck + print the inferred plan
```

**Resume is first-class and cheap.** Every completed `agent()` result is journaled, so a run that
crashed, was Ctrl-C'd, or that you **edited** can be re-run and only the new/changed/unfinished agents
actually call Codex — the unchanged prefix replays from the journal instantly. This is the normal way
to iterate: run, edit a late stage, `--resume`, repeat. (Completed inferences are never re-run on
resume; only agents that hadn't finished re-run.) The CLI prints the exact `--resume` command when a run
ends.

## Checklist before you run

- [ ] `export const meta = {...}` is the first statement and a pure literal.
- [ ] Body uses only injected globals; no imports, no `Date.now`/`Math.random`.
- [ ] Research/review agents are `sandbox: "read-only"`; parallel editors use `worktree: true`.
- [ ] Steps that feed later steps use `schema` for a validated object.
- [ ] `parallel`/`pipeline` results are `.filter(Boolean)`'d.
- [ ] Verification uses independent agents prompted to refute, not the same agent self-checking.
- [ ] Coverage matches the ask; anything you cap is `log()`'d.
