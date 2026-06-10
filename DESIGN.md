# Omegacode — design

A **standalone CLI** that runs **workflow files** written in a small JavaScript DSL
(`agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`) and orchestrates **coding agents** to do
the work. Each `agent()` call drives a real agent turn through a pluggable **`Worker`** backend — and
**two providers are first-class: Codex** (via the local `codex app-server`, JSON-RPC) **and Claude Code**
(via the `@anthropic-ai/claude-agent-sdk`). A single workflow can run entirely on one provider or mix
them per `agent()` call. The capability target is Claude Code's Workflows DSL; the orchestrator is a
script run from the command line.

No MCP server, no bb, no hosted service. Just a CLI, a DSL runtime, and two provider workers behind one
interface.

> **This document records the original design intent and is partly aspirational.** The shipped surface
> has diverged in places — most notably the CLI command set and a handful of options described below that
> were never built (called out inline as **not shipped**). **`skill/SKILL.md` is the canonical authoring
> and usage guide** (run `omegacode guide` to read it); when this design doc and SKILL.md / `omegacode
> --help` disagree, SKILL.md and the CLI win. §12 below lists the actual shipped CLI surface; §13 the
> actual repo layout.
>
> **Provider-set amendment (2026-06):** the shipped provider set is now **four**, not two. `opencode`
> (OpenCode CLI ≥ 1.16.2) and `pi` (`@earendil-works/pi-coding-agent` ≥ 0.79.1) joined as
> spawn-per-call subprocess workers (`src/worker/opencode.ts`, `src/worker/pi.ts`, shared mechanics in
> `src/worker/subprocess-jsonl.ts`). Both are **full-access-only**: neither CLI can enforce a confined
> sandbox, so `read-only`/`workspace-write` are rejected pre-spawn and calls require an explicit
> `sandbox: "danger-full-access"`. Both reject `maxTurns`; opencode also rejects `effort` (pi maps it
> onto `--thinking`). `instructions` maps to pi's `--append-system-prompt` and to a delimited prompt
> preamble on opencode. Structured output uses a silent extraction turn plus the central validation
> path. Bin overrides: `OPENCODE_BIN` / `PI_BIN`. Outdated binaries are refused (`provider_outdated`).
> The "two providers" framing below is historical.

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
  the CLI (foreground; the original `--detach` background mode in §10.3 is **not shipped** — background an
  agent-launched run from the calling shell instead). The web viewer is *read-only* — it visualizes runs
  from their on-disk state, it never executes them.
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
- `turn/interrupt` (cancel an in-flight turn). *(That is the full set the shipped worker calls —
  `initialize`, `thread/start`, `turn/start`, `turn/interrupt`. The protocol's `turn/steer`,
  `thread/resume`, `thread/unsubscribe`, `thread/archive`, and `model/list` are **not used**.)*

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
- **Options we use:** `cwd`, `model`, `maxTurns`, `settingSources: []` (SDK isolation), a
  **`canUseTool`** callback (the sandbox tool-gate, §6.4), and **`outputFormat: { type: 'json_schema',
  schema }`** for structured output (verified in the installed typings + the [Agent SDK
  structured-outputs docs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)).
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
 │ CLI  `omegacode run file --args …`     │
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

`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `now`, `random`, `budget` are **injected
globals** (no import line). Shipped ambient type declarations (`src/dsl/ambient.d.ts`, the
`omegacode/ambient` types) type them so authors — human or agent — still get full editor autocomplete
and typechecking. Schemas are **JSON Schema** (the portable default that maps straight to Codex
`outputSchema`).

**Primitives (injected globals):**

| Primitive | Signature | Semantics |
|---|---|---|
| `agent` | `(prompt: string, opts?: AgentOpts) => Promise<string \| T>` | Run one agent turn (Codex or Claude Code, per `opts.provider`); resolve with its final text, or (with `schema`) a validated `T`. |
| `parallel` | `(thunks: Array<() => Promise<T>>) => Promise<(T \| null)[]>` | Barrier; run thunks concurrently (under the cap), await all. A thunk that fails resolves to `null` in the results (filter with `.filter(Boolean)`); interrupts and cap/budget errors propagate and abort the fan-out. *(An earlier draft's `parallelSettled` was **not shipped**.)* |
| `pipeline` | `(items, ...stages) => Promise<R[]>` | Each item streams through all stages independently (no barrier between stages); stage callbacks get `(prev, item, index)`. A failing item resolves to `null` and skips its remaining stages. |
| `phase` | `(title: string) => void` | Open a named progress group; subsequent `agent()` calls render under it. |
| `log` | `(msg: string) => void` | Emit a narrator line to the progress UI. |
| `args` | `unknown` | The CLI-supplied input (`--args <json>` / `--args-file <f>`). |
| `now` | `() => number` | Journal-seeded clock (deterministic across resume, unlike `Date.now()`). |
| `random` | `() => number` | Journal-seeded RNG (deterministic across resume, unlike `Math.random()`). |
| `budget` | `{ total, spent(), remaining() }` | The run's output-token ceiling (`--budget`, §8); `total` is `null` when no ceiling is set. |

**`AgentOpts`:** `{ provider?: "codex" | "claude-code", label?, phase?, model?, effort?:
"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" (the union of both providers' levels; each
worker maps to its nearest supported value), cwd?, sandbox?:
"read-only"|"workspace-write"|"danger-full-access", approval?: "never"|"on-request", instructions?,
schema?: JSONSchema, worktree?: boolean | string, key?: string, maxTurns?: number }`.
- `provider` selects the backend for this call; default = `--provider` → `meta.defaultProvider` →
  built-in (`codex`).
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

1. **Compile.** Extract and validate the leading `export const meta = {…}` literal (it must be the
   file's first statement; the literal is evaluated alone in a throwaway, codegen-disabled vm
   context), strip it while preserving line numbers, and compile the body to a `vm.Script` with
   `importModuleDynamically` throwing. Workflow files are **plain JavaScript** — no TypeScript, no
   imports. *(The original sketch's acorn AST parse, esbuild TS support, and per-`await`
   `Promise.resolve` trampoline were **not shipped**; the meta literal is brace-scanned + vm-evaluated
   instead.)*
2. **Sandbox.** Run it in a `vm.createContext(globals, { codeGeneration: { strings: false, wasm:
   false } })` — no `eval`/`new Function`/wasm-from-bytes — with no host globals reachable (no
   `require`, `process`, `fs`, `fetch`, `import`). Inject only the DSL globals (`agent`, `parallel`,
   `pipeline`, `phase`, `log`, `args`, `now`, `random`, `budget`) + `console` and
   `setTimeout`/`clearTimeout`. Determinism shims make `Date.now`/`Math.random`/`new Date()` throw,
   and the determinism-critical intrinsics (`Date`, `Math`) are frozen so the shims can't be
   reassigned; a static lint flags raw clock/RNG use at submit time. *(Full SES-style freezing of
   every intrinsic is **not shipped**.)*
3. **Execute — live coroutine.** The script runs as one live async function with real `await`s.
   `agent()` is a real async host function that spawns a provider turn (Codex or Claude Code, §6) and
   resolves when it completes; `parallel`/`pipeline` are real concurrency over those awaits. This is
   **identical to Claude Code's working model** — the script is *not* re-run per step; it holds one live
   execution. Each `agent()` first consults the journal and returns a completed result instantly on
   resume (§9). The vm `timeout` bounds the synchronous prefix; the async remainder races the run's
   abort signal (and an optional execution-time ceiling) so an `await`-forever can't hang the CLI.

The orchestration script's **only** capability is calling `agent()`; everything dangerous (writes,
commands, network) happens inside the **provider** subagents it spawns (Codex or Claude Code), gated by
each agent's `sandbox`/approval policy (§6.4) — the script itself cannot touch the host. Same defense
posture as Claude Code, where an approved dynamic workflow acts only through its subagents.

- **Failure** = the run throws; the CLI prints the error, interrupts in-flight turns, and exits
  non-zero — the journal is intact, so `--resume` continues from the last completed agent.
- **SIGINT (Ctrl-C)** = interrupt active turns + clean up provider sessions, then exit; fully resumable.
- **Approval gate — not shipped.** The original design had the CLI show the script + its inferred
  phase/agent plan and ask to proceed before running an agent-authored workflow (Claude Code's "Run a
  dynamic workflow?" analog), with `--yes`/an allowlist for trusted/CI use. As shipped, `run` executes
  immediately — review the file (or `omegacode validate` it) before running untrusted workflows. A
  pre-launch gate remains a future direction.

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

`agent(prompt, opts)` resolves the worker (`opts.provider` → `--provider` → `meta.defaultProvider` →
built-in default), then calls `worker.runAgent(...)`. One workflow can mix providers per call. The
runtime keeps a
small registry of live workers and lazily starts each provider the first time it's used.

### 6.1 `CodexWorker` (codex app-server)
- Spawn `codex app-server` (one process per run, multiplexes threads — a pool is the throughput escape
  hatch, §8); newline-delimited JSON-RPC framing; `initialize`/`initialized` handshake.
- `runAgent`: `thread/start` (cwd, model, sandbox, approvalPolicy, instructions, `experimentalRawEvents:
  false`) → `thread/start` returns a `threadId` → `turn/start` (input text, model, effort, sandboxPolicy,
  approvalPolicy, **`outputSchema`** when `schema` set). Subscribe by `threadId`: accumulate
  `item/agentMessage/delta`, capture the final `agentMessage` item, resolve on **`turn/completed`**;
  surface `thread/tokenUsage/updated`. *(No per-thread cleanup is shipped — the worker never calls
  `thread/unsubscribe`/`thread/archive`; threads end when the per-run app-server process exits.)*
- Errors from `codexErrorInfo` (`UsageLimitExceeded`/429 → classified retryable; `ContextWindowExceeded`
  → fail). Interrupt via `turn/interrupt`.

### 6.2 `ClaudeWorker` (Claude Agent SDK)
- `runAgent`: call `query({ prompt, options })` and iterate the `SDKMessage` async generator. Accumulate
  `assistant` text; on the terminal **`result`** message return `{ text: m.result, structured:
  m.structured_output, usage: m.usage, status }`. Options: `cwd`, `model`, `maxTurns`,
  `settingSources: []`, the `canUseTool` sandbox gate (§6.4), and `outputFormat` (when `schema` is
  set). Abort via the generator's abort/interrupt.
- One `query()` per agent (its own session/subprocess). Errors come as `SDKResultError` subtypes
  (rate-limit/turns/budget/structured-retries) → mapped to the same typed `AgentError` with the same
  retryable classification.

### 6.3 Structured output (`agent({schema})`) — native on both
Both providers support structured output natively, so this is **not** prompt-and-parse and **not** an
injected tool on either side:
- **Codex:** `turn/start.outputSchema` → conforming JSON in the final message.
- **Claude:** `options.outputFormat = { type: "json_schema", schema }` → `SDKResultSuccess.structured_output`.

Both run a built-in conformance retry (Claude surfaces `error_max_structured_output_retries` when it
gives up). The worker returns the structured object and the runtime **re-validates** it client-side
against the schema regardless (never trust the wire blindly); a validation miss gets one corrective
retry, then fails the agent with the raw text retained. (An earlier draft wrongly claimed Claude lacked
native structured output — corrected: it's `outputFormat`, confirmed in the SDK typings + docs.)

*As shipped, the codex worker runs `agent({schema})` as **two turns on one thread**: a free-form
working turn, then a schema-constrained extraction turn carrying `outputSchema` — because Codex's
`outputSchema` constrains every assistant message in a turn, which would cripple the working phase.*

### 6.4 Sandbox / approvals — the one semantic gap, mapped per provider
The shared `sandbox` enum means different *kinds* of enforcement per provider:

| `sandbox` | Codex (OS-level sandbox) | Claude Code (`canUseTool` permission gate) |
|---|---|---|
| `read-only` | `sandboxPolicy: readOnly` | deny write/edit tools; shell limited to read-only commands |
| `workspace-write` | `workspaceWrite`, `writableRoots = cwd/worktree` | write tools allowed, path-checked against the agent's `cwd` |
| `danger-full-access` | `dangerFullAccess` | no tool gate |

**Caveat worth stating in the workflow author's mental model:** on Codex, `read-only` is an OS guarantee
(the agent *cannot* write even if it tries); on Claude it's a tool-gate (we deny the write tools and
path-check the rest, but there's no OS jail — arbitrary shell can't be fully confined). For
untrusted/destructive tasks prefer Codex's sandbox or worktree isolation. Approvals are
non-interactive: Codex auto-answers `item/*requestApproval` — fail-closed (decline) for `read-only`
agents and whenever the request can't be matched to a known turn, but command/file escalations from
`workspace-write`/`danger-full-access` agents are **auto-accepted** (an accepted escalation can run
outside the OS sandbox, so the hard fail-closed guarantee holds only for `read-only`); Claude is
gated via `canUseTool`. *(The interactive `--approve` mode from the original design is **not
shipped**.)*

### 6.5 Effort, errors, retries (normalized)
- **Effort:** native per-turn on Codex (`turn/start.effort`); on Claude there is no clean per-`query()`
  effort knob, so it maps to model choice/settings or is omitted — documented, not faked.
- **Errors/retries** are normalized at the worker boundary into a typed `AgentError` carrying a
  retryable classification (rate-limit/connection → retryable; context-window/turn-cap → not),
  invisible to the DSL except via `log`. *(The per-turn **stall watchdog** — interrupt+retry after N
  seconds of silence — was designed but is **not shipped**.)*

---

## 7. cwd, workspace, and worktree isolation

Every agent runs in a `cwd` (default: the CLI's `--cwd`, else process cwd); `sandbox` controls writes.
Read-only / independent agents share the base cwd. For **parallel agents that mutate the same repo**,
`agent({ worktree: true })` runs that agent in an isolated git worktree, **matching Claude Code's
workflow-worktree behavior exactly**:

- **Create.** `git worktree add <gitRoot>/.omegacode/worktrees/<runId>-<index>` on a fresh branch
  (`aw/<runId>-<index>`), then `git worktree lock` it. Creation is **serialized (concurrency 1)** even
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
directory lives under `.omegacode/` instead of `.claude/`; the create/lock/serialize and
clean-vs-dirty/preserve-on-changes semantics are identical.)

---

## 8. Concurrency, caps, budget

- **Concurrency cap** (default 100, `--concurrency`): a semaphore gates how many `runAgent`
  calls execute at once; `parallel`/`pipeline` submit all thunks but only N run concurrently. The cap is
  global across providers. Codex agents multiplex over one app-server process (a **process pool** is the
  escape hatch if it saturates); Claude agents are one subprocess per `query()`, so under wide Claude
  fan-out the cap also bounds subprocess count — consider a session pool if startup overhead bites.
- **Lifetime agent cap** (default 1000): a runaway-loop backstop; exceeding it throws.
- **Fan-out cap** per `parallel`/`pipeline` call (default 4096): explicit error, not silent truncation.
- **Budget** (output-token ceiling): set with `--budget N` and surfaced to the workflow as the injected
  `budget = { total, spent(), remaining() }` global. The ceiling is hard — once `spent()` reaches `total`,
  further `agent()` calls throw. With no `--budget` the ceiling is inert (`total` is `null`). *(This was
  marked out-of-scope in an earlier draft; it shipped.)*

---

## 9. Resume (first-class)

Every run is journaled, so any run can be resumed — after a crash, a Ctrl-C, or (most usefully) an
**edit**. This is the headline iteration feature: change a late stage of an expensive workflow, re-run,
and only the changed suffix actually calls Codex.

**Journal.** Each `agent()` result is appended to `~/.omegacode/runs/<runId>/journal.jsonl` as one
JSON line carrying its resume key, status, return value, usage, provider, worktree ref, and timing,
alongside a run-metadata line (`workflowFile`, `fileHash`, `args`, `seed`, the key-scheme version). It
is append-only, one line per result, so a hard kill loses at most the in-flight agents.

**Keys + longest-unchanged-prefix replay.** Each call's key chains:
`key_i = sha256(key_{i-1} ‖ prompt ‖ canonical(keyedOpts))`, where `keyedOpts` are the
semantics-bearing fields — **`provider`**, `model`, `effort`, `schema`, `sandbox`, `cwd`,
`instructions`, and the other options that change what the agent does — **not** the cosmetic
`label`/`phase`/`key`. So switching an agent's provider invalidates *that* call's cached
result (and the suffix after it), which is correct — a Codex result and a Claude result aren't
interchangeable. On `--resume`, the workflow file is re-run **live**; an `agent()` call whose key matches
a *completed* journal entry returns its result instantly (no provider turn), and the first call that is
new/edited/divergent — plus everything after it — runs live. Because keys chain, this is
automatic: editing step 7 of a 10-step workflow replays 1–6 and runs 7–10. Inside
`parallel()`/`pipeline()` each branch chains off its structural position (thunk index / item × stage),
never wall-clock completion order, so fan-out keys stay deterministic under concurrency.
`agent(prompt, { key })` pins an explicit stable key for a call that should survive reordering or
prompt-wording changes (duplicate explicit keys are rejected).

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
on completion/failure (as Claude Code does). Resuming a run whose file was edited is the intended path —
the chained-key prefix replay is what makes "edit + re-run" cheap. *(`--resume-last` — resume the most
recent run of the same file — was in an earlier draft but is **not shipped**; pass the explicit `runId`
printed at the end of the prior run.)*

---

## 10. Observability, the viewer server, and process model

### 10.1 Terminal output (default)
- **Progress (stderr):** phases as groups, agents ticking `queued → running → done/failed`, with
  provider, model, elapsed, token counts, and `log()` narrator lines. *(The shipped renderer prints a
  readable **line stream** — the live in-place ANSI/`ink` tree from the original sketch is a
  follow-up; the web viewer is the rich live view.)*
- **Result (stdout):** the workflow's return value — text as-is, objects as pretty JSON; `--json`
  wraps `{ runId, status, url, result, error }` for piping (§12). *(The richer
  `{ result, usage, durationMs, agents: [...] }` envelope from the original sketch is **not
  shipped** — usage/per-agent detail lives in `events.jsonl` and the viewer, §10.2.)*

### 10.2 The viewer server (HTTP visualization)
Every run already persists to `~/.omegacode/runs/<runId>/`, so the web UI is just a **reader of
on-disk state** — no new source of truth, no coupling to the run process. Two pieces:

- **Each run writes `events.jsonl`** to its run dir — the same phase/agent transitions + `log()` lines
  that drive the terminal tree, serialized: `{ t, type: "run"|"phase"|"agent"|"log", ... }` (agent
  events carry index, provider, model, state, tokens, durationMs, prompt/result previews). `journal.jsonl`
  stays the *resume* log (completed results only); `events.jsonl` is the *observability* log (live state,
  including in-flight and failed agents). Both are append-only.
- **`omegacode serve [--port 4123]`** starts a small **localhost-only viewer server** that reads
  the runs directory:
  - `GET /` — a single-page dashboard listing all runs (active + recent), each as a live phase/agent tree.
  - `GET /api/runs`, `GET /api/runs/:id` (snapshot folded from `events.jsonl`),
    `GET /api/runs/:id/agents/:idx` (full prompt, result, usage, tool calls).
  - `GET /api/runs/:id/stream` — **SSE**: the server `fs.watch`-tails `events.jsonl` and pushes new
    events; the browser tree updates live (queued→running→done, tokens, elapsed).

The server is **stateless and read-only** — it owns no execution, can be restarted any time, and simply
projects the files (closer to `vite preview` than a job daemon). **As shipped, `run` auto-starts the
viewer by default** (reusing one if the port is already bound, spawning a detached idle-shutdown one
otherwise) and prints the run's URL; `--open` additionally launches the browser, and `--no-serve` opts
out. The viewer is a separate React/Vite app under `viewer/`, served as a built bundle (not the tiny
inline SPA the original layout in §13 imagined). *(`run --ui` — a single-run UI self-served from the run
process — is **not shipped**; the central viewer covers the same need.)*

### 10.2b Per-agent transcripts — the live chat-feed drilldown (two-stream model)
The phase/agent tree is a *summary*; clicking an agent opens a **live chat feed** of that agent's actual
conversation. This is a deliberate two-stream split:

- **`events.jsonl` (per run) = the summary stream** — phase/agent state transitions for the list + tree.
  Lean; one event per state change.
- **`agents/*.jsonl` (one file per agent) = the conversation stream** — the agent's messages as they
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

- **Foreground (shipped).** `run` executes in your terminal and exits when done; it auto-starts the
  viewer and prints the run's URL so you can watch it live in the browser while it runs. To run in the
  background, an agent launching a workflow backgrounds the `omegacode run …` process from its own shell
  (see SKILL.md) — the run still writes journal + events as usual and stays visible in the viewer.
- **`run --detach` / `omegacode tail <runId>` — not shipped.** The original design called for a
  double-forked detached run process (stdio → `runs/<runId>/run.log`) plus a `tail` command to stream a
  detached run's progress to the terminal. Neither exists; background a run from the calling shell and
  watch it in the viewer instead.
- **Control (cancel/pause) from the UI — not shipped.** The viewer is observation-only; there is no
  `POST /api/runs/:id/cancel`, control socket, or `control.json`. The original additive-control sketch
  (below) is a future direction, not a current capability.

**When a real (executor) daemon would be warranted:** a persistent job queue, cross-run global resource
governance, scheduled/triggered runs, or an always-on multi-user dashboard. All out of scope — and if
ever built, that daemon would host the *same* `Worker` + runtime, and the viewer/UI wouldn't change (it
already reads files). Noted as a future direction.

---

## 11. Configuration & auth

- **Auth:** each worker inherits the host's existing provider auth — Codex login for `CodexWorker`,
  `ANTHROPIC_API_KEY` / Claude Code login for `ClaudeWorker`. A workflow only needs auth for the
  provider(s) it actually uses. *(As shipped, `omegacode doctor` is a lightweight binary check — it runs
  `codex --version` / `claude --version` and reports the data dir; it does **not** do the live
  `model/list` / `query()` round-trips the original design described.)*
- **Config:** there is **no config file** (`omegacode.config.{ts,json}` was designed but **not
  shipped**). Per-run defaults resolve in decreasing precedence: CLI flags
  (`--provider`/`--model`/`--effort`/`--sandbox`/`--cwd`/`--concurrency`/`--budget`), then `meta`
  (`defaultProvider`/`defaultModel`/`defaultSandbox`), then the built-in `DEFAULTS`
  (`provider: codex`, `sandbox: read-only`, `approval: never`, `concurrency: 100`,
  `maxAgents: 1000`, `maxFanout: 4096`). The codex app-server binary can be overridden via the `CODEX_BIN`
  environment variable, and the data dir (default `~/.omegacode`) via `OMEGACODE_HOME`.

---

## 12. CLI surface

This is the **actually shipped** command set (run `omegacode --help`); it is narrower than the original
sketch. Several originally-designed commands/flags — `omegacode tail`, `omegacode list`, `--resume-last`,
`--detach`, `--ui`, `--approve`, `--dry-run`, `--verbose`, `--arg k=v`, and a `validate`-time plan/static
estimate — were **not shipped**. `validate` only parses the file and prints its `meta` (no plan), and
`doctor` is a binary-presence check (no `--provider` flag).

```
omegacode run <file.workflow.js | name> [--args <json> | --args-file f.json]
                                 [--provider codex|claude-code] [--model m] [--effort e]
                                 [--sandbox read-only|workspace-write|danger-full-access] [--cwd <dir>]
                                 [--concurrency N] [--budget N] [--resume <runId>]
                                 [--fake] [--json] [--open] [--no-serve] [--port N]
omegacode serve [--port 4123] [--host h] [--idle-shutdown]   # read-only viewer over all runs
omegacode runs [--prune --keep N] [--prune-stale]            # list runs (or prune old / dead ones)
omegacode workflows [--json]            # list saved/named workflows (project, user, builtin tiers)
omegacode save <file> [--project] [--force]   # save a workflow into the user (or project) registry
omegacode validate <file.workflow.js | name>  # parse the file + print its meta (no plan / no run)
omegacode doctor                        # check codex/claude binary presence + print the data dir
omegacode guide                         # print the authoring guide (the body of skill/SKILL.md)
omegacode install-skill [--claude] [--agents]   # install skill/SKILL.md into agent skill dirs
```

`--provider` sets the **default** worker for the run; individual `agent()` calls override it via
`opts.provider`. By default `run` auto-starts the viewer and prints the run's URL; `--open` also launches
the browser, `--no-serve` opts out, and `--json` keeps stdout pure JSON (the URL moves to a `url` field).
On completion *or* failure, `run` prints the `runId` and the exact `--resume` command. `--fake` swaps in
the in-process fake worker (no real provider calls) for offline smoke tests. `guide` and `install-skill`
both read the single source of truth `skill/SKILL.md`.

**Named workflows** (`runtime/registry.ts`): `run`/`validate` accept a bare name — anything without a
path separator or `.js` suffix — resolved by **`meta.name`** (not filename) across three tiers, highest
first: *project* (every `.omegacode/workflows/` from cwd up to the repo/home boundary; nearer shadows
farther), *user* (`<dataRoot>/workflows/`), *builtin* (the package `builtins/` dir, shipped in the npm
tarball). Only `.js` files ≤ 512 KiB with a valid `meta` load; invalid/oversize files are skipped.
`save` validates via `parseWorkflow` and copies to `<tier>/<meta.name>.workflow.js` (no overwrite
without `--force`). Six built-ins ship. Two are ports of Claude Code's bundled workflows: `deep-research`
(scope → 5 parallel web searches → fetch/dedup top 15 → 3-vote adversarial verify, 2/3 refutes kill →
cited report) and `code-review` (per-angle finders → independent CONFIRMED/PLAUSIBLE/REFUTED verifier
per finding → gap-sweep at xhigh/max → ranked, capped report; `LEVEL_PARAMS` scale by level). The other
four are omegacode-original multi-provider workflows, built on the premise that two models' errors are
decorrelated: `multi-provider-review` (Codex and Claude each review the entire feature/branch
independently with identical prompts, blind to each other, then a synthesis merges both — consensus
findings ranked first, unique catches attributed via `foundBy`, disagreements called out); `bake-off`
(both implement the same task in isolated worktrees with per-run neutral branch names, blind A/B judges
from both providers score the committed diffs, tie-break on splits, both branches preserved);
`provider-debate` (propose → attack → rebut for 1-5 rounds, attacker and proposer on opposite providers,
then a judge rules on survived/conceded/open); and `second-opinion` (both answer at low effort, a cheap
comparator checks substantive agreement — agree merges and returns, disagree escalates both to xhigh with
the other's answer in hand, then an adjudicator decides; a failed comparator counts as disagreement).

---

## 13. Repo layout

The **actual** tree — principal modules; small extracted helpers come and go as the code evolves (the
original sketch listed a `dsl/globals.ts` and an inline `server/web/` SPA that do not exist, and
predated the separate `viewer/` React app and several runtime modules):

```
omegacode/
  package.json            # ESM, "bin": { "omegacode": "dist/cli.js" }, package "exports" → dist
                          # deps: @anthropic-ai/claude-agent-sdk, ajv (schema validate)
                          # build: viewer bundle then tsup (see "scripts")
  tsup.config.ts
  tsconfig.json
  src/
    cli.ts                # arg parsing, sandbox compile+run, output, signals, viewer auto-start
    index.ts              # library entrypoint (the embedding API surfaced via package "exports")
    dsl/
      types.ts            # ProviderId/Sandbox/Effort/AgentOpts/AgentSpec/AgentResult/Meta/RunDefaults…
      ambient.d.ts        # shipped ambient types for authors (globals + meta)
                          # (the injected globals themselves live in runtime/primitives.ts + run.ts —
                          #  there is no dsl/globals.ts)
    runtime/
      sandbox.ts          # node:vm compile + harden (codeGen off, freeze, shims) + meta parse
      run.ts              # orchestrator: lint, journal + event sink, runtime, run the sandbox, heartbeat
      primitives.ts       # Runtime: agent/parallel/pipeline/phase/log/now/random/budget over runAgent
      semaphore.ts        # concurrency semaphore (gates runAgent; mutex(1) for worktree creation)
      journal.ts          # journal read/write (jsonl), resume lookup, seed persistence, data dir
      registry.ts         # named-workflow registry (project/user/builtin tiers, meta.name lookup)
      keys.ts             # chained call-key hashing (incl. provider) + determinism lint
      events.ts           # event types (run/phase/agent/log)
      event-sink.ts       # events.jsonl writer + in-process listener fan-out (terminal UI + viewer)
      transcript.ts       # per-agent conversation transcript writer (agents/*.jsonl)
      jsonl-writer.ts     # shared append-only JSONL write-stream wrapper (transcript + event sink)
      progress.ts         # phase/agent progress model + terminal renderer (cached vs live agents)
      worktree.ts         # git worktree helper (create/lock/clean-vs-dirty teardown)
    server/
      serve.ts            # viewer HTTP server: /api/runs, SSE stream (fs.watch tail of events.jsonl)
      tail.ts             # jsonl tail/offset helpers for the server (dependency-free, testable)
    worker/
      index.ts            # Worker interface + WorkerContext + AgentError/AgentInterrupted
      factory.ts          # provider → worker resolution (fake / codex / claude); caches per provider
      schema.ts           # JSON Schema → per-provider output format; client-side validate
      codex.ts            # CodexWorker: spawn app-server, JSON-RPC, thread/turn, two-turn structured output
      codex-protocol.ts   # method + param/result types + sandbox/approval/effort mappers (hand-typed)
      jsonrpc-stdio.ts    # JSON-RPC-over-stdio client (child process + framing + pending-request lifecycle)
      claude.ts           # ClaudeWorker: query() loop, outputFormat, canUseTool sandbox gate
      fake.ts             # in-process FakeWorker (--fake): synthesizes deterministic text/structured output
      errors.ts           # normalize codexErrorInfo / SDKResultError → AgentError; retry classification
  viewer/                 # the web viewer — a standalone React + Vite app (built into a static bundle
                          #  by the build script, then served by src/server/serve.ts)
  examples/
    hello.workflow.js  deep-research.workflow.js  code-review.workflow.js
    explore-codebase.workflow.js  parity-audit.workflow.js  omega-logos.workflow.js
  skill/SKILL.md          # the canonical authoring guide that ships with the tool
  test/                   # node:test suites (run via `npm test`)
```

`worker/index.ts` + `worker/factory.ts` are the seam: the runtime depends only on `Worker`, so a new
provider is one file plus a factory branch. The `codex-protocol.ts` types are hand-written for just the
methods we use.

---

## 14. Milestones

> **Planning record.** These were the original milestone targets. The core engine (M0–M6: both real
> workers, sandbox/runtime/journal, structured output, resume, worktrees, examples + skill) and the
> viewer (M7) all landed, but several *exit-criteria* features named below were trimmed and **not
> shipped** — `--resume-last`, `--detach`, `omegacode tail`, `--dry-run`, `--verbose`, a config file, and
> the live-auth `doctor` round-trips (the shipped `doctor` is a binary-presence check). See §12 for the
> commands and flags that actually exist.

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
  `omegacode serve` + the SPA dashboard with live SSE; `run --open`/`--detach`/`tail`. *Exit:*
  `serve` shows all runs; opening a live run streams its tree updating in real time; a `--detach`ed run
  keeps going after the launching terminal closes and remains visible in the dashboard. (Control/cancel
  from the UI is a follow-up.)

---

## 15. Risks / open questions

1. **App-server protocol drift.** The app-server is evolving (experimental fields, v2 schema). Mitigate:
   pin a known-good `codex` version, keep the hand-typed protocol module minimal, and treat unknown
   notifications as ignorable. (The shipped `doctor` checks binary presence only — it does not validate
   the protocol version.)
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
   powerful; default research agents to `read-only` and require explicit opt-in (per-agent `sandbox`/
   `worktree`) for writes. (An interactive `--approve` mode is a future direction — not shipped.)
5. **Parallel file mutation.** Without worktrees, concurrent `workspace-write` agents in one cwd race.
   The `worktree` helper is the answer; document that parallel editors must use it.
6. **Throughput.** One app-server multiplexing many threads may bottleneck; the process pool (§8) is the
   escape hatch — measure before building it.
7. **Long turns / cancellation.** SIGINT maps to `turn/interrupt` (shipped). The per-turn stall
   watchdog and `thread/archive` cleanup are future directions — **not shipped** (§6.1, §6.5);
   today threads live as long as the per-run app-server process.
8. **Cost.** A wide fan-out can spend quickly. *(An earlier draft said "no budget ceiling in v1" —
   the guards since shipped: the `--budget` output-token ceiling (§8), the lifetime agent cap, and the
   fan-out cap.)* Resume directly mitigates this too: a failed wide run is re-run for the price of only
   its unfinished agents.
9. **Viewer exposure.** `events.jsonl` and the dashboard surface prompts/results, which may be
   sensitive. The viewer binds `127.0.0.1` only by default; a non-local bind requires an explicit
   `--host` opt-in (there is no auth/token layer — do not expose it beyond localhost).
   Bound `events.jsonl` growth like the terminal log (cap + rotate); the journal (resume) is separate and
   unaffected. `fs.watch` tailing must tolerate partial last lines and missing dirs (a run that hasn't
   written yet shows "starting").
10. **No executor daemon.** A run dies if its own process is killed (it's not supervised). Backgrounding
   a run (from the calling shell — there is no built-in `--detach`, §10.3) is OS backgrounding, not a job
   manager. If supervised/restartable background runs become a real need, that's the (out-of-scope)
   executor-daemon direction in §10.3.
11. **Resume determinism.** Replay only short-circuits calls whose chained key matches. Nondeterminism
   (raw `Date.now`/`Math.random`, or set/map iteration order feeding a prompt) shortens the replayed
   prefix — never corrupts it. Mitigate with the seeded `now()`/`random()` globals + the startup lint;
   document that side-effecting agents (writes) are resumed via their preserved worktree branch
   (§7, §9), not by re-applying changes. The one true footgun — a journaled result that is no longer
   valid because the *world* changed (files moved, a dependency updated) — is the author's call; resume
   is opt-in (`--resume <runId>`), so running without it always forces a clean run.

---

## 16. Why this shape

- **This is Claude Code's working model, provider-agnostic.** Workflow files are agent-authored, so the
  threat model is Claude Code's: a hardened in-process `node:vm` (no `require`/`fs`/`import`/`eval`,
  frozen `Date`/`Math` determinism shims, injected DSL globals), **live-coroutine** execution (the script
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
