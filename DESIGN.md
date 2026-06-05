# Agent Workflows — design

A **standalone CLI** that runs **workflow files** written in a small JavaScript DSL
(`agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`) and orchestrates **coding agents** to do
the work. Each `agent()` call drives a real agent turn through a pluggable **`Worker`** backend — and
**two providers are first-class: Codex** (via the local `codex app-server`, JSON-RPC) **and Claude Code**
(via the `@anthropic-ai/claude-agent-sdk`). A single workflow can run entirely on one provider or mix
them per `agent()` call. The capability target is Claude Code's Workflows DSL; the orchestrator is a
script run from the command line.

No MCP server, no bb, no hosted service. Just a CLI, a DSL runtime, and two provider workers behind one
interface.

> Repo path is `~/codex-workflow-mcp` (chosen name). It's neither MCP-specific nor Codex-specific, so
> consider a provider-neutral name (e.g. `agent-workflows` / `conductor`) before first commit — the doc
> uses the package name `agent-workflows` throughout.

---

## 1. Goals / non-goals

**Goals (v1):**
- Author multi-agent workflows with a typed DSL: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`.
- **Two first-class providers behind one `Worker` interface:** Codex (via the `codex app-server`) and
  Claude Code (via the `@anthropic-ai/claude-agent-sdk`). Pick a default per workflow; override per
  `agent()` via `opts.provider`. Both reuse the user's existing provider auth.
- Real fan-out/streaming (`parallel`/`pipeline`) with a concurrency cap.
- Structured results via each provider's **native** structured output (Codex `outputSchema`, Claude
  Agent SDK `outputFormat: json_schema`) — re-validated client-side.
- Good live observability — a phase/agent progress tree in the terminal **and** an optional read-only
  **web viewer** that streams every run's tree to a browser (§10), reading on-disk run state.
- **Resumable by default:** every run is journaled; re-running replays completed agents and only
  re-executes the new/edited/unfinished suffix (crash-, Ctrl-C-, and *edit*-resume).

**Non-goals (v1):**
- No MCP server surface, no bb integration. Two first-class providers (Codex + Claude Code); no others
  in v1.
- No durable/hosted execution and **no executor daemon** — a run is one process that lives and dies with
  the CLI (foreground, or `--detach`ed; §10.3). The web viewer is *read-only* — it visualizes runs from
  their on-disk state, it never executes them.
- No reattaching to an in-flight provider turn after a crash — an interrupted agent re-runs on resume;
  its orphaned session is abandoned, not reconnected (v1).
- No nested `workflow()` (a workflow calling another workflow) in v1 — flat orchestration only.

**Trust model (load-bearing):** **workflow files are authored by agents**, not hand-written by a
trusted human. They are therefore untrusted code, and the engine runs them in a **hardened sandbox** —
exactly as Claude Code's Workflows do (§5). This tool deliberately matches Claude Code's working
execution model (hardened in-process `node:vm`, injected DSL globals, determinism shims, live-coroutine
execution, journal + replay-on-resume); the only material difference is that the subagents run on Codex
or Claude Code (selected per `agent()`), not on a single hardcoded provider.

---

## 2. Background: the two provider backends

Both providers expose the same logical shape — start an agent turn, stream progress, read a final result
+ usage + (optional) structured output — so they normalize cleanly behind one `Worker.runAgent()` (§6).

### 2.1 Codex — the `codex app-server`

The Codex app-server (`codex app-server`) is a JSON-RPC 2.0 process (newline-delimited JSON over stdio)
that exposes Codex's agent loop programmatically. Reference:
`https://developers.openai.com/codex/app-server`. Field shapes below are taken from the generated
`v2` protocol schema.

**Model:** `thread` → `turn` → `item`. To run one agent: start (or resume) a thread, start a turn with
user input, stream item/turn notifications, read the result off `turn/completed`.

**Lifecycle / methods we use:**
- `initialize` (with `clientInfo`, optional `capabilities.experimentalApi = true`) then the
  `initialized` notification.
- `thread/start` → returns a `threadId`. Params (`ThreadStartParams`): `model?`, `modelProvider?`,
  `serviceTier?`, `cwd?`, `approvalPolicy?` (`AskForApproval`), `sandbox?` (`SandboxMode`), `config?`,
  `baseInstructions?`, `developerInstructions?`, `personality?`, `dynamicTools?`, `ephemeral?`,
  `experimentalRawEvents` (bool, required), `persistExtendedHistory` (bool, required).
- `turn/start` → begins generation. Params (`TurnStartParams`): `threadId`, `input: UserInput[]`,
  `cwd?`, `approvalPolicy?`, `sandboxPolicy?` (`SandboxPolicy`), `model?`, `serviceTier?`, `effort?`
  (`ReasoningEffort`), `summary?`, `personality?`, `collaborationMode?`, and **`outputSchema?`**
  (Responses-API structured output — the key to `agent({schema})`).
- `turn/steer` (inject into an in-flight turn), `turn/interrupt` (cancel), `thread/resume`,
  `thread/unsubscribe`, `thread/archive`.
- `model/list` (discover models + `supportedReasoningEfforts`).

**`UserInput`** is a discriminated union: `{type:"text", text, text_elements}` |
`{type:"image", url}` | `{type:"localImage", path}` | `{type:"skill", name, path}` |
`{type:"mention", name, path}`. v1 sends `text`.

**Streaming notifications (per turn):** `turn/started`, `item/started`, `item/agentMessage/delta`
(streamed text), `item/completed` (authoritative final item — the `agentMessage` item carries the final
text), `turn/diff/updated`, `thread/tokenUsage/updated`, and finally **`turn/completed`**
(`TurnCompletedNotification = { threadId, turn }`, where `turn.status ∈ completed|interrupted|failed`).
The assistant's text is the final `agentMessage` item; the status is on `turn/completed`.

**Approvals (server requests):** `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` arrive as server→client requests; the client answers
`accept | acceptForSession | decline | cancel`. For autonomous orchestration we set a non-interactive
policy (§6.4).

**Errors:** an `error` notification and/or `turn/completed { status: "failed" }` with `codexErrorInfo`
(`ContextWindowExceeded`, `UsageLimitExceeded`, `BadRequest`, …) and optional `httpStatusCode`.

**Auth:** the app-server uses the host's existing Codex login (ChatGPT or API key). v1 assumes the user
has run `codex` and is authenticated; we do not implement `account/login/*`.

**Concurrency:** a single app-server process multiplexes many threads, so N agents = N threads on one
process (bb confirms this model). We cap concurrency and clean up threads when done.

### 2.2 Claude Code — the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` (v0.3.x) exposes `query({ prompt, options })`, an **async generator of
`SDKMessage`s** (the SDK spawns the bundled `claude` binary as a subprocess and streams from it).

- **Drive one turn:** iterate the generator; `assistant` messages stream content blocks; the terminal
  **`result`** message (`SDKResultSuccess`) carries `result` (final text), **`structured_output`**,
  `usage`, `total_cost_usd`, `num_turns`. Errors come as `SDKResultError` with subtypes
  (`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`, …).
- **Options we use:** `cwd`, `model`, `permissionMode` (`default`|`acceptEdits`|`bypassPermissions`|
  `plan`), `allowedTools`/`disallowedTools`, `appendSystemPrompt` (instructions), `maxTurns`,
  `settingSources: []` (SDK isolation), and **`outputFormat: { type: 'json_schema', schema }`** for
  structured output (verified in the installed typings + the [Agent SDK structured-outputs
  docs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)).
- **Auth:** the host's existing Claude auth (`ANTHROPIC_API_KEY` or Claude Code login).
- **Process model:** each `query()` is its own session/subprocess (heavier per-call than Codex's
  multiplexed threads) — fine for v1; pool/reuse later if wide fan-out makes it bite (§8).

The two backends differ materially in only two places — **sandbox semantics** (Codex OS-sandbox vs
Claude tool-permissions) and **per-call effort** — both mapped in §6.4/§6.5.

---

## 3. Architecture

```
 workflow file (.workflow.js)         ← agent-authored DSL: export const meta + body + return
        ▼
 ┌─────────────────────────────────────────────┐
 │ CLI  `agent-workflows run file --args …`     │
 │  • compile + sandbox the file (node:vm, §5)  │
 │  • inject DSL globals + RunContext (caps)    │
 │  • execute → await result → print            │
 └───────────────┬─────────────────────────────┘
                 │ agent(prompt, opts)
                 ▼
 ┌─────────────────────────────────────────────┐
 │ Runtime: DSL primitives + scheduler          │
 │  • agent() → Worker.runAgent() (await a turn)│
 │  • parallel()/pipeline() fan-out + barrier   │
 │  • concurrency semaphore, caps, journal, UI  │
 └───────────────┬─────────────────────────────┘
                 │ worker = pick(opts.provider); worker.runAgent({prompt, opts})
                 ▼
 ┌──────────────────────────┐   ┌──────────────────────────┐
 │ CodexWorker              │   │ ClaudeWorker             │
 │ spawn `codex app-server` │   │ `query()` (Agent SDK)    │
 │ thread/start→turn/start  │   │ stream SDKMessages →     │
 │ →stream→turn/completed   │   │ result + structured_out  │
 └───────────┬──────────────┘   └───────────┬──────────────┘
             ▼ stdio JSON-RPC               ▼ bundled `claude` subprocess
   `codex app-server` process       Claude Agent SDK session
```

Three layers, each independently testable:
1. **`Worker`** — the provider drivers. Each owns its process/protocol and the single most important
   primitive: **`runAgent(spec) → { text, structured?, status, usage }`** (await a turn to completion).
   `CodexWorker` and `ClaudeWorker` implement the same interface; the runtime never branches on provider.
   This is the piece bb's runtime deliberately *doesn't* provide (its `runTurn` is fire-and-forget); here
   it is the core.
2. **Runtime** — the DSL primitives + a scheduler (concurrency, caps, journal, progress) over
   `Worker.runAgent`. Pure orchestration logic; unit-testable with a fake `Worker`.
3. **CLI** — argument parsing, file loading + sandboxing, config, output formatting, lifecycle (SIGINT →
   interrupt turns + clean up sessions).

---

## 4. The DSL (authoring surface)

**Injected globals + a `meta` block — matching Claude Code's Workflow syntax**, because workflow files
are **agent-authored** and run inside a hardened sandbox (§5) where `import`/`require` don't exist. An
agent that already knows Claude Code's Workflow tool can author for this tool unchanged. A workflow file
is a module whose first statement is `export const meta = {…}` (a pure literal), followed by a body that
uses the injected globals and ends with a top-level `return` of the result:

```js
// research.workflow.js  — agent-authored; runs in the sandbox (no imports)
export const meta = {
  name: "deep-research",
  description: "Fan out searches, verify, synthesize.",
  phases: [{ title: "Scope" }, { title: "Search" }, { title: "Verify & synthesize" }],
}

phase("Scope")
const { angles } = await agent(`Decompose into 5 search angles: ${args.question}`, {
  schema: { type: "object", required: ["angles"],
            properties: { angles: { type: "array", items: { type: "string" } } } },
})

phase("Search")
const findings = await parallel(
  angles.map((a) => () =>
    agent(`Research this angle, list key claims with sources: ${a}`, { sandbox: "read-only" })),
)

phase("Verify & synthesize")
return await agent(
  `Cross-check these findings, drop unsupported claims, write a cited report.\n\n${findings.join("\n\n")}`,
)
```

`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `now`, `random` are **injected globals** (no
import line). A shipped ambient `codex-workflows.d.ts` types them so authors — human or agent — still
get full editor autocomplete and typechecking. Schemas are **JSON Schema** (the portable default that
maps straight to Codex `outputSchema`).

**Primitives (injected globals):**

| Primitive | Signature | Semantics |
|---|---|---|
| `agent` | `(prompt: string, opts?: AgentOpts) => Promise<string \| T>` | Run one agent turn (Codex or Claude Code, per `opts.provider`); resolve with its final text, or (with `schema`) a validated `T`. |
| `parallel` | `(thunks: Array<() => Promise<T>>) => Promise<T[]>` | Barrier; run thunks concurrently (under the cap), await all. A thunk that throws rejects the array (or `parallelSettled` for `{status,value}[]`). |
| `pipeline` | `(items, ...stages) => Promise<R[]>` | Each item streams through all stages independently (no barrier between stages); stage callbacks get `(prev, item, index)`. |
| `phase` | `(title: string) => void` | Open a named progress group; subsequent `agent()` calls render under it. |
| `log` | `(msg: string) => void` | Emit a narrator line to the progress UI. |
| `args` | `unknown` | The CLI-supplied input (`--args <json>` / `--arg k=v` / `--args-file`). |
| `now` | `() => number` | Journal-seeded clock (deterministic across resume, unlike `Date.now()`). |
| `random` | `() => number` | Journal-seeded RNG (deterministic across resume, unlike `Math.random()`). |

**`AgentOpts`:** `{ provider?: "codex" | "claude-code", label?, phase?, model?, effort?:
"low"|"medium"|"high"|"xhigh", cwd?, sandbox?: "read-only"|"workspace-write"|"danger-full-access",
approval?: "never"|"on-request", instructions?, schema?: JSONSchema, worktree?: boolean | string,
key?: string }`.
- `provider` selects the backend for this call; default = `meta.defaultProvider` → `--provider` → config.
- `schema` → the provider's native structured output (Codex `outputSchema` / Claude `outputFormat`),
  re-validated client-side (§6.3).
- `sandbox`/`approval` map per provider (§6.4); `effort` maps natively on Codex, best-effort on Claude
  (§6.5).
- `worktree` → run this agent in an isolated git worktree (§7), for parallel mutators.
- `key` pins an explicit, stable resume cache key (§9) so the call replays even if its position or prompt
  wording changes; omit it to use the default chained key. (`label`/`phase`/`key` do **not** affect the
  chained key — `provider` and the other semantics-bearing opts do.)

The `meta` block may set `defaultProvider` (and default `model`/`sandbox`) for the whole workflow. The
file is **not** an importable module — there is no `defineWorkflow`/default-export wiring, because the
sandbox (§5) has no module loader; the `export const meta` statement is the one piece read statically
(its pure-literal form enforced), and the body runs against injected globals. Schemas are plain JSON
Schema (the portable shape both providers accept).

---

## 5. Execution model — a hardened in-process VM (matching Claude Code)

Because workflow files are **agent-authored** (untrusted), the engine runs them the way Claude Code's
Workflows run — a **live async coroutine inside a hardened `node:vm`**, plus a journal:

1. **Compile.** Parse the file (acorn; esbuild→JS first if authored in TS), validate the
   `export const meta` pure literal, rewrite the body so every `await` funnels through a frozen
   `Promise.resolve` trampoline, and compile to a `vm.Script` with `importModuleDynamically` throwing.
2. **Sandbox.** Run it in `vm.createContext(globals, { codeGeneration: { strings: false, wasm: false } })`
   — no `eval`/`new Function`/wasm-from-bytes — with intrinsics frozen and dangerous globals removed
   (no `require`, `process`, `fs`, `fetch`, `import`). Inject only the DSL globals (`agent`, `parallel`,
   `pipeline`, `phase`, `log`, `args`, `now`, `random`) + `console`/timers. Determinism shims make
   `Date.now`/`Math.random`/`new Date()` throw; a static lint flags them at submit time.
3. **Execute — live coroutine.** The script runs as one live async function with real `await`s.
   `agent()` is a real async host function that spawns a provider turn (Codex or Claude Code, §6) and
   resolves when it completes; `parallel`/`pipeline` are real concurrency over those awaits. This is
   **identical to Claude Code's working model** — the script is *not* re-run per step; it holds one live
   execution. Each `agent()` first consults the journal and returns a completed result instantly on
   resume (§9).

The orchestration script's **only** capability is calling `agent()`; everything dangerous (writes,
commands, network) happens inside the **provider** subagents it spawns (Codex or Claude Code), gated by
each agent's `sandbox`/approval policy (§6.4) — the script itself cannot touch the host. Same defense
posture as Claude Code, where an approved dynamic workflow acts only through its subagents.

- **Failure** = the run throws; the CLI prints the error, interrupts in-flight turns, archives spawned
  threads, exits non-zero — the journal is intact, so `--resume` continues from the last completed agent.
- **SIGINT (Ctrl-C)** = `turn/interrupt` active turns + archive/unsubscribe, then exit; fully resumable.
- **Approval gate.** Before running an agent-authored workflow the CLI shows the script + its inferred
  phase/agent plan and asks to proceed (Claude Code's "Run a dynamic workflow?" analog); `--yes` or an
  allowlist skips it for trusted/CI use.

---

## 6. The workers — the core engine

A **`Worker`** is a provider backend that runs one agent turn to completion. `agent()` is a thin call
onto a worker; the runtime, journal, resume, worktrees, and progress are provider-agnostic and only ever
see the normalized result.

```ts
interface Worker {
  id: "codex" | "claude-code"
  runAgent(spec: AgentSpec, ctx: { signal: AbortSignal; onProgress: (e) => void }): Promise<AgentResult>
}
type AgentResult = {
  text: string
  structured?: unknown                       // present when spec.schema was set
  status: "completed" | "failed" | "interrupted"
  usage: { inputTokens; outputTokens; costUsd }
}
```

`agent(prompt, opts)` resolves the worker (`opts.provider` → `meta.defaultProvider` → `--provider` →
config), then calls `worker.runAgent(...)`. One workflow can mix providers per call. The runtime keeps a
small registry of live workers and lazily starts each provider the first time it's used.

### 6.1 `CodexWorker` (codex app-server)
- Spawn `codex app-server` (one process per run, multiplexes threads — a pool is the throughput escape
  hatch, §8); newline-delimited JSON-RPC framing; `initialize`/`initialized` handshake.
- `runAgent`: `thread/start` (cwd, model, sandbox, approvalPolicy, instructions, `experimentalRawEvents:
  false`) → `thread/start` returns a `threadId` → `turn/start` (input text, model, effort, sandboxPolicy,
  approvalPolicy, **`outputSchema`** when `schema` set). Subscribe by `threadId`: accumulate
  `item/agentMessage/delta`, capture the final `agentMessage` item, resolve on **`turn/completed`**;
  surface `thread/tokenUsage/updated`. Cleanup with `thread/unsubscribe`/`thread/archive`.
- Errors from `codexErrorInfo` (`UsageLimitExceeded`/429 → backoff+retry; `ContextWindowExceeded` →
  fail). Interrupt via `turn/interrupt`.

### 6.2 `ClaudeWorker` (Claude Agent SDK)
- `runAgent`: call `query({ prompt, options })` and iterate the `SDKMessage` async generator. Accumulate
  `assistant` text; on the terminal **`result`** message return `{ text: m.result, structured:
  m.structured_output, usage: m.usage, status }`. Options: `cwd`, `model`, `permissionMode`,
  `allowedTools`/`disallowedTools`, `appendSystemPrompt` (instructions), `outputFormat` (when `schema`
  set), `maxTurns`, `settingSources: []`. Abort via the generator's abort/interrupt.
- One `query()` per agent (its own session/subprocess). Errors come as `SDKResultError` subtypes
  (rate-limit/turns/budget/structured-retries) → mapped to the same typed `AgentError` + backoff.

### 6.3 Structured output (`agent({schema})`) — native on both
Both providers support structured output natively, so this is **not** prompt-and-parse and **not** an
injected tool on either side:
- **Codex:** `turn/start.outputSchema` → conforming JSON in the final message.
- **Claude:** `options.outputFormat = { type: "json_schema", schema }` → `SDKResultSuccess.structured_output`.

Both run a built-in conformance retry (Claude surfaces `error_max_structured_output_retries` when it
gives up). The worker returns the structured object and the runtime **re-validates** it client-side
against the schema regardless (never trust the wire blindly); a validation miss fails the agent with the
raw text retained. (An earlier draft wrongly claimed Claude lacked native structured output — corrected:
it's `outputFormat`, confirmed in the SDK typings + docs.)

### 6.4 Sandbox / approvals — the one semantic gap, mapped per provider
The shared `sandbox` enum means different *kinds* of enforcement per provider:

| `sandbox` | Codex (OS-level sandbox) | Claude Code (tool permissions) |
|---|---|---|
| `read-only` | `sandboxPolicy: readOnly` | deny `Edit`/`Write`/`Bash` (+ `permissionMode: plan`) |
| `workspace-write` | `workspaceWrite`, `writableRoots = cwd/worktree` | `acceptEdits` + allow `Edit`/`Write`/`Bash` |
| `danger-full-access` | `dangerFullAccess` | `bypassPermissions` |

**Caveat worth stating in the workflow author's mental model:** on Codex, `read-only` is an OS guarantee
(the agent *cannot* write even if it tries); on Claude it's a tool-gate (we don't hand it the write
tools, but there's no OS jail). For untrusted/destructive tasks prefer Codex's sandbox or worktree
isolation. Approvals default to non-interactive: Codex auto-answers `item/*requestApproval` per policy;
Claude auto-allows via `permissionMode`/`canUseTool`. An interactive `--approve` mode prompts the human.

### 6.5 Effort, errors, retries (normalized)
- **Effort:** native per-turn on Codex (`turn/start.effort`); on Claude there is no clean per-`query()`
  effort knob, so it maps to model choice/settings or is omitted — documented, not faked.
- **Errors/retries** are normalized at the worker boundary into a typed `AgentError` (rate-limit →
  exponential backoff + retry; context-window → fail so the workflow can branch; connection → retry),
  invisible to the DSL except via `log`. A per-turn **stall watchdog** (no events for N seconds) can
  interrupt+retry on either provider; configurable, off by default.

---

## 7. cwd, workspace, and worktree isolation

Every agent runs in a `cwd` (default: the CLI's `--cwd`, else process cwd); `sandbox` controls writes.
Read-only / independent agents share the base cwd. For **parallel agents that mutate the same repo**,
`agent({ worktree: true })` runs that agent in an isolated git worktree, **matching Claude Code's
workflow-worktree behavior exactly**:

- **Create.** `git worktree add <gitRoot>/.agent-workflows/worktrees/<runId>-<index>` on a fresh branch
  `cw/<runId>-<index>`, then `git worktree lock` it. Creation is **serialized (concurrency 1)** even
  when the agents themselves run in parallel — concurrent `git worktree add` is racy. The agent's `cwd`
  becomes the worktree and its `sandbox` is forced to `workspace-write` scoped to it; the prompt gets a
  suffix noting it is an isolated copy whose changes don't affect the main dir or other agents.
- **Teardown (in `finally`, the clean-vs-dirty rule).** Detect whether the agent changed anything via
  `git status --porcelain` (uncommitted changes) and `git rev-list --count <base>..HEAD` (commits
  ahead). If **unchanged** → `git worktree remove` (auto-cleanup, no trace left). If **changed** →
  **`git worktree unlock` and preserve it for review** — the branch and worktree remain so you can
  inspect or merge each agent's work afterward. Cleanup errors are swallowed (best-effort), exactly as
  Claude Code does.
- **Requires** the `cwd` to be a git repo; otherwise `worktree: true` throws with an actionable message
  (no silent fallback to the shared dir).

`worktree: "my-branch"` (string form) pins the branch name. The runtime's `worktree` helper shells out
to `git worktree add/remove/lock/unlock` + `git status` / `git rev-list`. **Worktree isolation is
provider-agnostic** — both Codex and Claude honor a per-agent `cwd`, so it works identically on either
backend (and is the recommended way to give a Claude write-agent a hard boundary, since Claude's
`read-only` is a tool-gate, not an OS sandbox — §6.4). (Cosmetic divergence from Claude Code: the
directory lives under `.agent-workflows/` instead of `.claude/`; the create/lock/serialize and
clean-vs-dirty/preserve-on-changes semantics are identical.)

---

## 8. Concurrency, caps, budget

- **Concurrency cap** (default 8, `--concurrency` / config): a semaphore gates how many `runAgent`
  calls execute at once; `parallel`/`pipeline` submit all thunks but only N run concurrently. The cap is
  global across providers. Codex agents multiplex over one app-server process (a **process pool** is the
  escape hatch if it saturates); Claude agents are one subprocess per `query()`, so under wide Claude
  fan-out the cap also bounds subprocess count — consider a session pool if startup overhead bites.
- **Lifetime agent cap** (default 1000): a runaway-loop backstop; exceeding it throws.
- **Fan-out cap** per `parallel`/`pipeline` call (default 4096): explicit error, not silent truncation.
- **Budget** (token/cost ceiling) is **out of scope v1** (aggregate usage is reported; no hard stop).

---

## 9. Resume (first-class)

Every run is journaled, so any run can be resumed — after a crash, a Ctrl-C, or (most usefully) an
**edit**. This is the headline iteration feature: change a late stage of an expensive workflow, re-run,
and only the changed suffix actually calls Codex.

**Journal.** Each `agent()` result is appended to `~/.agent-workflows/runs/<runId>/journal.jsonl` as
`{ key, index, promptHash, optsHash, status, result, usage, threadId, worktreeBranch?, durationMs }`,
alongside run metadata (`workflowFile`, `fileHash`, `args`, `seed`, `codexVersion`, defaults). It is
append-only and fsync'd per result, so a hard kill loses at most the single in-flight agent.

**Keys + longest-unchanged-prefix replay.** Each call's key chains:
`key_i = sha256(key_{i-1} ‖ prompt ‖ canonical(keyedOpts))`, where `keyedOpts` are the
semantics-bearing fields (**`provider`**, `model`, `effort`, `schema`, `sandbox`, `cwd`, `instructions`)
— **not** `label`/`phase`/`key`. So switching an agent's provider invalidates *that* call's cached
result (and the suffix after it), which is correct — a Codex result and a Claude result aren't
interchangeable. On `--resume`, the workflow file is re-run **live**; an `agent()` call whose key matches
a *completed* journal entry returns its result instantly (no provider turn), and the first call that is
new/edited/divergent — plus everything after it — runs live. Because keys chain, this is
automatic: editing step 7 of a 10-step workflow replays 1–6 and runs 7–10. `agent(prompt, { key })`
pins an explicit stable key for a call that should survive reordering or prompt-wording changes.

**Determinism — enforced by the sandbox (as in Claude Code).** Replay is correct only if the script is
deterministic between agent calls, so the hardened VM (§5) makes raw `Date.now()`/`Math.random()`/
`new Date()` **throw**, and a static lint rejects them at submit time. For legitimate time/randomness the
injected **`now()` / `random()` are seeded from the journal** (`seed` stored on the first run, replayed
on resume), so they reproduce across replays. Even so the chained-key model is graceful by construction:
any residual nondeterminism (e.g. map/set iteration order feeding a prompt) only *shortens the replayed
prefix* — a changed key re-runs that call and everything after it; it can never reuse a wrong result.

**Worktree interplay (§7).** A `worktree: true` agent's *file changes* live in its preserved branch,
not the journal; the journal stores the agent's return value + the `worktreeBranch` ref. On resume a
completed worktree agent replays its return value and points at the existing branch — it is **not**
re-run and its edits are **not** re-applied (they're already committed on the branch). A worktree agent
that was *in-flight* at kill time has no journal entry, so it re-runs into a fresh worktree.

**In-flight on crash.** An agent with a `started` but no `result` entry is re-run on resume — its
orphaned provider session (Codex thread or Claude `query()`) is abandoned, not reattached (v1) —
matching Claude Code's started-hit-respawn rule.

**CLI:** `--resume <runId>` resumes a specific run; `run` prints the `runId` + the exact resume command
on completion/failure (as Claude Code does); `--resume-last` resumes the most recent run of the same
file. Resuming a run whose file was edited is the intended path — the chained-key prefix replay is what
makes "edit + re-run" cheap.

---

## 10. Observability, the viewer server, and process model

### 10.1 Terminal output (default)
- **Progress (stderr):** a live phase/agent tree — phases as groups, agents as rows ticking
  `queued → running → done/failed`, with provider, model, elapsed, token counts, and the latest `log()`
  narrator line. Plain/no-TTY mode prints line events. (Render with `ink` or a minimal ANSI tree.)
- **Result (stdout):** the workflow's return value — text as-is, objects as pretty JSON; `--json`
  wraps `{ result, usage, durationMs, agents: [...] }` for piping.

### 10.2 The viewer server (HTTP visualization)
Every run already persists to `~/.agent-workflows/runs/<runId>/`, so the web UI is just a **reader of
on-disk state** — no new source of truth, no coupling to the run process. Two pieces:

- **Each run writes `events.jsonl`** to its run dir — the same phase/agent transitions + `log()` lines
  that drive the terminal tree, serialized: `{ t, type: "run"|"phase"|"agent"|"log", ... }` (agent
  events carry index, provider, model, state, tokens, durationMs, prompt/result previews). `journal.jsonl`
  stays the *resume* log (completed results only); `events.jsonl` is the *observability* log (live state,
  including in-flight and failed agents). Both are append-only.
- **`agent-workflows serve [--port 4123]`** starts a small **localhost-only viewer server** that reads
  the runs directory:
  - `GET /` — a single-page dashboard listing all runs (active + recent), each as a live phase/agent tree.
  - `GET /api/runs`, `GET /api/runs/:id` (snapshot folded from `events.jsonl`),
    `GET /api/runs/:id/agents/:idx` (full prompt, result, usage, tool calls).
  - `GET /api/runs/:id/stream` — **SSE**: the server `fs.watch`-tails `events.jsonl` and pushes new
    events; the browser tree updates live (queued→running→done, tokens, elapsed).

The server is **stateless and read-only** — it owns no execution, can be restarted any time, and simply
projects the files (closer to `vite preview` than a job daemon). `run --open` auto-starts it (if the port
isn't already bound) and opens the browser to that run's page; `run --ui` instead self-serves a
single-run UI from the run process (ephemeral, dies with the run) when you don't want a central server.

### 10.2b Per-agent transcripts — the live chat-feed drilldown (two-stream model)
The phase/agent tree is a *summary*; clicking an agent opens a **live chat feed** of that agent's actual
conversation. This is a deliberate two-stream split:

- **`events.jsonl` (per run) = the summary stream** — phase/agent state transitions for the list + tree.
  Lean; one event per state change.
- **`agents/<index>.jsonl` (per agent) = the conversation stream** — the agent's messages as they
  happen, written from the worker's `onProgress`: `ChatChunk` = `meta` (the agent's prompt + provider/
  model) · `text` (assistant message chunks) · `reasoning` (thinking) · `tool` (`{id?, name, input}`) ·
  `tool-result` (`{id?, output, isError}`) · `status` (`running|done|failed`). Both `CodexWorker`
  (`item/agentMessage/delta`, reasoning deltas, `item/started`/`completed`) and `ClaudeWorker`
  (assistant text / `thinking` / `tool_use` blocks + `tool_result`) emit these; the runtime fans them to
  the agent's transcript file (truncated on a re-run; written once per live run, replayed agents keep
  their prior transcript).

Why split: the high-volume conversation content must not bloat the summary stream that the list/tree
read, and the drilldown only needs one agent's stream at a time. The viewer adds
`GET /api/runs/:id/agents/:index` (snapshot) + `.../stream` (SSE tail of the agent jsonl); the web UI
renders the feed like bb's thread timeline (assistant prose, dimmed reasoning, `$ command` mono cards +
terminal output blocks, shimmer while running) and live-tails it for in-flight agents. Architectural
note: this is the one place observability reaches into worker internals — the `WorkerProgress` contract
had to widen from summary signals (`tool`/`usage`) to full conversation chunks for every provider.

### 10.3 Is there a daemon? — the process model
**No executor daemon, by design.** Execution stays one-process-per-run (§5). Because the run dir *is* the
IPC, "visualize running workflows" needs only (a) runs writing `events.jsonl` and (b) the read-only
viewer above — never a central process that runs workflows.

- **Foreground (default).** `run` executes in your terminal and exits when done; watch it live in the
  browser via `serve`/`--open` while it runs.
- **Detached/background.** `run --detach` double-forks a **detached run process** (stdio →
  `runs/<runId>/run.log`) that executes independently and writes journal + events as usual; attach with
  the viewer or `agent-workflows tail <runId>`. Still one process per run — just backgrounded, no central
  executor.
- **Control (cancel/pause) from the UI — optional, additive.** Observation needs no channel back to the
  run. For *control*, a run can listen on `runs/<runId>/control.sock` (unix socket) or watch a
  `control.json`; the viewer's `POST /api/runs/:id/cancel` forwards a request the run honors by aborting
  (interrupt provider turns, then stop). v1 ships observation-only; control is a small follow-up.

**When a real (executor) daemon would be warranted:** a persistent job queue, cross-run global resource
governance, scheduled/triggered runs, or an always-on multi-user dashboard. All out of scope for v1 — and
if ever built, that daemon would host the *same* `Worker` + runtime, and the viewer/UI wouldn't change
(it already reads files). Noted as a future direction.

---

## 11. Configuration & auth

- **Auth:** each worker inherits the host's existing provider auth — Codex login for `CodexWorker`,
  `ANTHROPIC_API_KEY` / Claude Code login for `ClaudeWorker`. `agent-workflows doctor` checks **whichever
  providers are enabled**: Codex via `model/list` succeeding, Claude via a trivial `query()` round-trip,
  printing actionable errors otherwise. A workflow only needs auth for the provider(s) it actually uses.
- **Config** (`agent-workflows.config.{ts,json}`, + env + flags, increasing precedence): default
  `provider`, `model`, `effort`, `sandbox`, `approval`, `concurrency`, `cwd`, and per-provider settings
  (`codexBin` app-server path; Claude `model`/`pathToClaudeCodeExecutable`).

---

## 12. CLI surface

```
agent-workflows run <file.workflow.js> [--args <json> | --arg k=v ... | --args-file f.json]
                                       [--provider codex|claude-code] [--cwd <dir>] [--model m] [--effort e]
                                       [--concurrency N] [--approve interactive|auto]
                                       [--json] [--verbose] [--dry-run]
agent-workflows run <file> --resume <runId>   # re-run live; replay completed agents from the journal
agent-workflows run <file> --resume-last      # resume the most recent run of this file
agent-workflows run <file> [--detach] [--open | --ui]   # background the run / open the web UI
agent-workflows serve [--port 4123]  # start the read-only viewer server (dashboard over all runs)
agent-workflows tail <runId>         # stream a detached run's progress to the terminal
agent-workflows runs [--file f]      # list runs (runId, file, status, #agents, when) for resume
agent-workflows validate <file>      # compile the workflow, print its plan (static estimate)
agent-workflows doctor [--provider]  # check enabled providers' binary/auth
agent-workflows list [dir]           # list *.workflow.js in a directory (optional)
```

`--provider` sets the **default** worker for the run; individual `agent()` calls override it via
`opts.provider`. `--open` auto-starts the viewer (§10.2) and opens the run in a browser; `--detach`
backgrounds the run (§10.3). On completion *or* failure, `run` prints the `runId` and the exact
`--resume` command. `--dry-run` prints the inferred phase/agent structure (best-effort static analysis)
without calling any provider.

---

## 13. Repo layout

```
agent-workflows/
  package.json            # ESM, "bin": { "agent-workflows": "dist/cli.js" }
                          # deps: @anthropic-ai/claude-agent-sdk, ajv (schema validate); build: tsup
  tsconfig.json
  src/
    cli.ts                # arg parsing, config, sandbox compile+run, output, signals
    dsl/
      globals.ts          # the injected DSL globals (agent/parallel/pipeline/phase/log/now/random)
      types.ts            # AgentOpts, AgentSpec, AgentResult, Meta, RunContext
      ambient.d.ts        # shipped ambient types for authors (globals + meta)
    runtime/
      sandbox.ts          # node:vm compile + harden (codeGen off, freeze, shims) + meta parse
      run.ts              # build RunContext, execute, caps, seeded now/random, approval gate, --detach
      primitives.ts       # agent/parallel/pipeline/phase/log over Worker.runAgent + semaphore
      journal.ts          # journal read/write (jsonl), resume lookup, seed persistence
      events.ts           # events.jsonl writer (run/phase/agent/log) — feeds terminal UI + viewer
      keys.ts             # chained call-key hashing (incl. provider) + determinism lint
      progress.ts         # phase/agent progress model + terminal renderer (cached vs live agents)
      worktree.ts         # git worktree helper (create/lock/clean-vs-dirty teardown)
    server/
      serve.ts            # viewer HTTP server: /api/runs, SSE stream (fs.watch tail of events.jsonl)
      web/                # tiny SPA dashboard (phase/agent tree, live via SSE) — static, no heavy build
    worker/
      index.ts            # Worker interface + registry/picker (provider → worker)
      schema.ts           # JSON Schema → per-provider output format; client-side validate
      codex.ts            # CodexWorker: spawn app-server, JSON-RPC, thread/turn, outputSchema
      codex-protocol.ts   # method + param/result types (hand-typed from v2; generate if it drifts)
      claude.ts           # ClaudeWorker: query() loop, outputFormat, permissionMode mapping
      errors.ts           # normalize codexErrorInfo / SDKResultError → AgentError + backoff
  examples/
    deep-research.workflow.js
    code-review.workflow.js
  skill/SKILL.md          # authoring guide that ships with the tool
  test/                   # runtime tests with a fake Worker; worker tests vs mock app-server / SDK
```

`worker/index.ts` is the seam: the runtime depends only on `Worker`, so a new provider is one file. The
`codex-protocol.ts` types can be generated from the Codex `app-server-protocol` `v2` schema or
hand-written for just the methods we use (start hand-written; generate if drift bites).

---

## 14. Milestones

- **M0 — `Worker` interface + Codex driver spike.** Define `Worker`/`AgentSpec`/`AgentResult`;
  `CodexWorker` spawn + handshake + `runAgent` for a single text turn. *Exit:* a one-line `agent()`
  workflow prints a real Codex answer; `doctor` validates Codex auth.
- **M1 — DSL + sandbox + runtime + journal write.** The hardened `node:vm` (compile/freeze/shims, §5),
  injected globals (+ seeded `now`/`random`), the concurrency semaphore + caps, the live progress tree,
  and the **journal write** (every `agent()` result + chained key → `runs/<runId>/`). *Exit:* a 2-stage
  parallel→synthesize workflow runs sandboxed, fans out, renders progress, emits a complete journal;
  runtime unit-tested with a fake `Worker`.
- **M2 — `ClaudeWorker` (first-class).** The Agent SDK `query()` loop → `runAgent`; `provider` opt +
  picker; `--provider` default; `doctor` covers Claude. *Exit:* the **same** workflow file runs on
  `--provider claude-code`; a workflow that sets `provider` per `agent()` mixes Codex + Claude in one
  run; the journal keys include `provider` (switching provider re-runs that call on resume).
- **M3 — Structured output + opts (both providers).** `schema` → Codex `outputSchema` / Claude
  `outputFormat` + client-side validate/retry; `model/effort/cwd/sandbox/approval` mapped per provider
  (§6.4/§6.5); keyed-opts hashing finalized. *Exit:* `agent({schema})` yields a validated typed object on
  **both** providers; the `sandbox` enum maps correctly on each.
- **M4 — Resume (replay).** `--resume <runId>` / `--resume-last`; chained-key lookup short-circuits
  completed agents; new/edited/divergent suffix runs live; seeded `now`/`random` replay; the
  raw-`Date.now`/`Math.random` lint; the resume command printed on exit. *Exit:* run a workflow, kill it
  mid-fan-out, `--resume` completes it with **no duplicate provider turns**; edit a late stage and
  resume, asserting only the changed suffix calls a provider.
- **M5 — Robustness.** Approvals/auto-approver per provider, error mapping + retries/backoff, SIGINT
  cleanup (interrupt + session cleanup, journal-safe), `--json`/`--verbose`, config + `doctor`. *Exit:*
  a failing/ratelimited agent retries then surfaces cleanly on either provider; Ctrl-C leaves no orphan
  sessions and is resumable.
- **M6 — Examples + worktrees + skill.** `deep-research` and `code-review` example workflows; `worktree:
  true` isolation for parallel editors (with the resume interplay from §9); the shipped `skill/SKILL.md`
  authoring guide; `validate`/`--dry-run` plan output. *Exit:* both examples run end-to-end on each
  provider; parallel editing agents don't clobber each other; a resumed worktree agent replays its
  return value + branch ref without re-running.
- **M7 — Viewer server + web UI.** `events.jsonl` writer (folds in alongside the terminal renderer);
  `agent-workflows serve` + the SPA dashboard with live SSE; `run --open`/`--detach`/`tail`. *Exit:*
  `serve` shows all runs; opening a live run streams its tree updating in real time; a `--detach`ed run
  keeps going after the launching terminal closes and remains visible in the dashboard. (Control/cancel
  from the UI is a follow-up.)

---

## 15. Risks / open questions

1. **App-server protocol drift.** The app-server is evolving (experimental fields, v2 schema). Mitigate:
   pin a known-good `codex` version, keep `protocol.ts` minimal, validate against it in `doctor`, and
   treat unknown notifications as ignorable.
2. **Structured-output fidelity (not availability).** Both providers support it natively (Codex
   `outputSchema`, Claude `outputFormat: json_schema` — confirmed in typings + docs), but strict-mode
   nuances differ (OpenAI strict requires `additionalProperties:false` + all-keys-required; Claude/Zod
   conventions differ). Normalize schemas per provider in `worker/schema.ts` and always re-validate
   client-side; on a miss, one corrective retry then fail with the raw text retained.
2b. **Provider parity gaps.** `sandbox` is an OS jail on Codex but a tool-gate on Claude (§6.4) — same
   enum, different guarantee; document it and steer untrusted writes to Codex/worktrees. Per-call
   `effort` is native on Codex, not cleanly exposed on Claude (§6.5). The progress UI must render both
   (Codex token usage vs Claude `usage`/`total_cost_usd`).
3. **Headless auth.** Requires the host to be logged into Codex; CI/non-interactive needs a token path
   (`account/login/start` with `apiKey`) — document, but out of v1 scope.
4. **Autonomous approvals safety.** Running agents `approvalPolicy:"never"` with `workspace-write` is
   powerful; default research agents to `read-only`, require explicit opt-in (per-agent `sandbox`/
   `worktree`) for writes, and offer `--approve interactive`.
5. **Parallel file mutation.** Without worktrees, concurrent `workspace-write` agents in one cwd race.
   The `worktree` helper is the answer; document that parallel editors must use it.
6. **Throughput.** One app-server multiplexing many threads may bottleneck; the process pool (§8) is the
   escape hatch — measure before building it.
7. **Long turns / cancellation.** Map SIGINT and per-turn watchdog to `turn/interrupt`; ensure threads
   are archived so the app-server doesn't leak sessions.
8. **Cost.** No budget ceiling in v1 — a wide fan-out can spend quickly; surface aggregate usage
   prominently and add a `--max-agents`/budget guard if needed. Resume directly mitigates this: a failed
   wide run is re-run for the price of only its unfinished agents.
9. **Viewer exposure.** `events.jsonl` and the dashboard surface prompts/results, which may be
   sensitive. The viewer binds `127.0.0.1` only by default; a non-local bind requires `--host` + a token.
   Bound `events.jsonl` growth like the terminal log (cap + rotate); the journal (resume) is separate and
   unaffected. `fs.watch` tailing must tolerate partial last lines and missing dirs (a run that hasn't
   written yet shows "starting").
10. **No executor daemon.** A detached run still dies if its own process is killed (it's not supervised);
   `--detach` is OS backgrounding, not a job manager. If supervised/restartable background runs become a
   real need, that's the (out-of-scope) executor-daemon direction in §10.3, not a patch to `--detach`.
11. **Resume determinism.** Replay only short-circuits calls whose chained key matches. Nondeterminism
   (raw `Date.now`/`Math.random`, or set/map iteration order feeding a prompt) shortens the replayed
   prefix — never corrupts it. Mitigate with the seeded `ctx.now()`/`ctx.random()` helpers + the
   startup lint; document that side-effecting agents (writes) are resumed via their preserved worktree
   branch (§7, §9), not by re-applying changes. The one true footgun — a journaled result that is no
   longer valid because the *world* changed (files moved, a dependency updated) — is the author's call;
   `--no-resume` / a fresh `runId` always forces a clean run.

---

## 16. Why this shape

- **This is Claude Code's working model, provider-agnostic.** Workflow files are agent-authored, so the
  threat model is Claude Code's: a hardened in-process `node:vm` (no `require`/`fs`/`import`/`eval`,
  frozen intrinsics, determinism shims, injected DSL globals), **live-coroutine** execution (the script
  holds real `await`s — it is *not* re-run per step), a journal written as it goes, and resume =
  re-run-from-top with journaled calls short-circuited. We deliberately match it rather than reinvent; the
  difference is that `agent()` drives a **Codex** *or* **Claude Code** turn behind one `Worker` interface
  (§6). (We do *not* adopt the bb-server "suspend and re-run every tick" model — a CLI, like Claude Code,
  keeps one live execution and re-runs from the top only on resume.)
- **The hard part is the workers, not the DSL.** `Worker.runAgent` (await a turn to completion, capture
  text/structured result, normalize sandbox/approval/errors across two providers) is the real
  engineering; the DSL is a thin scheduler over it, and everything above the worker (runtime, journal,
  resume, worktrees, UI) is provider-agnostic by construction.
- **It composes outward and upward.** A third provider is one `Worker` file. And if a hosted/MCP/bb
  version is ever wanted, the `Worker` + runtime are the reusable core; only the entry point (CLI vs MCP
  tool vs server engine) and the durability story change.
