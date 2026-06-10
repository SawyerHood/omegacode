# Plan: Add `opencode` and `pi` providers to omegacode

## Provenance

- omegacode checkout: `/Users/sawyerhood/omegacode`
- opencode source: `/tmp/omegacode-harness-research/opencode` at commit `e9e2612706a489ede34793dd572b775904869f65`; locally installed CLI reports **1.16.2**
- pi source: `/tmp/omegacode-harness-research/pi` at commit `9ccfcd7cfcacdf593c0b24929d1d847e6cdf6711`; package `@earendil-works/pi-coding-agent` **0.79.1**, now also the locally installed version (the stale 0.54.0 install from the renamed `@mariozechner/pi-coding-agent` package was replaced on 2026-06-09)
- A prior draft (`plans/opencode-pi-provider-support-plan.md`) was mined for ideas. Its upstream SHAs are stale (`a86ecf3…` / `20b78ea…`), and several of its claims (e.g. a pi `--approve` flag, models.dev catalog counts) were **not** confirmed by the fresh discovery pass; everything below is restated against the verified findings only.

## Executive summary

Add two new backend provider IDs — `opencode` and `pi` — to omegacode's closed provider set, implemented as **spawn-per-call subprocess workers** that parse each CLI's newline-delimited JSON output and normalize it into the existing `WorkerProgress` / `AgentResult` contract (`src/worker/index.ts`).

Key shape of the change:

- **Provider IDs stay closed; model strings stay open.** `ProviderId` becomes a shared 4-member tuple (`codex | claude-code | opencode | pi`); `model` remains an unconstrained pass-through string, because both upstreams have large, auth-filtered, user-extensible model catalogs (`packages/opencode/src/provider/provider.ts:1884-1941`; pi `model-registry.ts:688-720`).
- **Subprocess-first.** `opencode run --format json` and `pi --mode json` are verified one-shot JSONL surfaces. Persistent alternatives (`opencode serve` + SDK/SSE; `pi --mode rpc`) are stronger long-term but deferred — spawn-per-call is simpler, abortable by process kill, and fixture-testable with the same `spawnChild` seam pattern the Codex worker already uses.
- **Full-access only; everything else fails closed.** Neither CLI provides OS-level sandboxing, so both providers support exactly one sandbox mode: `danger-full-access`. `read-only` and `workspace-write` are rejected for both, as are `maxTurns` (both) and `effort` (opencode), with `AgentError code: "unsupported_option"`, following the Codex `maxTurns` precedent (`src/worker/codex.ts:128-139`). **Consequence:** since omegacode's default sandbox is `read-only` (`src/dsl/types.ts:129-137`), every opencode/pi call requires an explicit `sandbox: "danger-full-access"` (per call or via `--sandbox`) — the rejection error says so, and docs flag it prominently.
- **Newest upstream versions are required.** The workers target the verified surfaces only: doctor and a once-per-worker version preflight enforce minimums — opencode ≥ **1.16.2** and pi ≥ **0.79.1** (`@earendil-works/pi-coding-agent`) — and refuse older binaries with `AgentError code: "provider_outdated"`. No feature detection, no compatibility fallbacks.
- **`instructions` is supported on both providers** — it must be, because the runtime's single corrective schema retry is delivered by appending corrective text to `runSpec.instructions` and re-invoking the worker (`src/runtime/primitives.ts:376-384`). Pi maps it to the verified `--append-system-prompt` flag; opencode (which has no system-prompt flag on `run`) injects it as a delimited prompt preamble.
- **Structured output via extraction turn + central validation**, mirroring Codex's two-phase pattern (`src/worker/codex.ts:161-206`): workers do a best-effort silent extraction; `RuntimePrimitives` keeps owning normalization, Ajv validation, and the single corrective retry (`src/runtime/primitives.ts:371-385, 443-450`).
- Existing Codex/Claude behavior, resume keys, journal format, and the two-provider builtins are **unchanged** in v1.

## Source-backed facts

### omegacode integration surface

| Fact | Evidence |
|---|---|
| `Worker` = `{ id: ProviderId, runAgent(spec, ctx), shutdown() }`; `WorkerContext` = `{ signal, onProgress }` | `src/worker/index.ts:11-21` |
| `WorkerProgress` kinds: `text`, `reasoning`, `tool`, `tool-result`, `usage` | `src/worker/index.ts:3-10` |
| `AgentSpec`: `prompt, provider, model?, effort?, cwd, sandbox, approval, instructions?, schema?, maxTurns?` | `src/dsl/types.ts:36-48` |
| `AgentResult` = `{ text, structured?, status, usage }`; `AgentUsage` = `{ inputTokens, outputTokens, costUsd }` | `src/dsl/types.ts:50-77` |
| **`DEFAULTS.sandbox` is `"read-only"`** — plain `agent()` calls inherit it unless overridden | `src/dsl/types.ts:129-137` |
| `ProviderId` is currently `"codex" \| "claude-code"`, duplicated in `src/dsl/ambient.d.ts:10`, with a packaging test enforcing sync | `src/dsl/types.ts:3`; `test/packaging.test.ts:151-169` |
| CLI whitelist is a local `PROVIDERS` array; help/usage hard-code `codex\|claude-code` | `src/cli.ts:134, 381, 610` |
| `resolveSpec` validates `sandbox`/`effort`/`approval` but **not** `provider`; unknown providers fail later at the factory with `unknown_provider` (and `fake:true` accepts any id) | `src/runtime/primitives.ts:42-47, 223-227`; `src/worker/factory.ts:29-48` |
| Factory caches one worker per id; switch is compile-time exhaustive (`const unknown: never = id`) | `src/worker/factory.ts:16-43` |
| `withRetry` retries only `retryable` `AgentError`s; aborts → `AgentInterrupted`; failed-turn usage is folded into journaled usage | `src/worker/errors.ts:11-39`; `src/runtime/primitives.ts:367-369, 405-424` |
| Workers must short-circuit pre-aborted signals with `AgentInterrupted` | `src/worker/codex.ts:128-129`; `src/worker/claude.ts:66-67` |
| Structured output: workers return raw `structured`; runtime does `stripNullOptionals` → Ajv validate → one corrective retry → JSON-fenced transcript projection | `src/runtime/primitives.ts:371-399, 443-450`; `src/worker/schema.ts:151-197` |
| **The corrective schema retry re-invokes the worker with corrective text appended to `runSpec.instructions`** — a worker that rejects `instructions` breaks the retry pre-spawn | `src/runtime/primitives.ts:376-384` |
| Claude precedent: `spec.instructions` maps to a system-prompt append | `src/worker/claude.ts:96` |
| Codex precedents to copy: reject `maxTurns` pre-spawn (`unsupported_option`); request + turn-stall watchdogs with retryable `turn_stalled`; bounded stderr ring buffer in exit diagnostics; `binary_not_found` on spawn failure | `src/worker/codex.ts:54-70, 128-139, 631-660`; `src/worker/jsonrpc-stdio.ts:114-119, 225-284` |
| Claude precedent: app-layer (non-OS) sandbox enforcement via `canUseTool` is an accepted model; Claude ignores `spec.approval` | `src/worker/claude.ts:1-7, 80-92, 152-185` |
| Resume keys include resolved `provider/model/effort`, so new providers invalidate caches correctly with zero changes — and `effort` must not be silently dropped by a worker, or identical runs become cache-distinct | `src/runtime/keys.ts:46-77, 121-131` |
| Viewer accepts arbitrary provider strings but maps every non-`claude-code` provider to the OpenAI icon | `viewer/src/lib/types.ts:3`; `viewer/src/components/glyphs.tsx:41-45` |
| Doctor rows are hard-coded binary names: fake, `codex --version`, `claude --version`, data dir | `src/cli.ts:545-558` |
| `ambient.d.ts` must stay import-free (postbuild rejects imports), so the provider union must be re-inlined there | `scripts/postbuild.mjs:33-45` |

### opencode (commit `e9e2612`)

- One-shot: `opencode run [message..]` with `--model provider/model` (split on **first** slash only; model IDs may contain slashes), `--format json`, `--dir`, `--session/-s`, `--dangerously-skip-permissions`, `--thinking`, `--variant`, etc. (`packages/opencode/src/cli/cmd/run.ts:122-240, 29-36`).
- Prompt may be piped on stdin; argv + stdin are concatenated if both present (`run.ts:38-48, 351-358`). There is **no system-prompt flag** on `run` — prompt text is the only verified injection surface.
- `--thinking` is a **boolean** ("show thinking blocks"); in noninteractive mode it defaults to `false` (`run.ts:212-215, 251`). JSON `reasoning` events are emitted **only when thinking is true** and the part has `time.end` (`run.ts:696-698`).
- `--variant` is documented as "model variant (provider-specific reasoning effort, e.g., high, max, minimal)" and is passed through to the session prompt input (`run.ts:208-211, 487-496, 782-856`); runtime behavior for values a model doesn't support is unverified.
- `--format json` emits LF-delimited JSONL with envelope `{type, timestamp, sessionID, ...payload}` (`run.ts:613-622`). Event types: `tool_use` (completed/errored tool parts only), `step_start`, `step_finish` (includes `cost` and `tokens {input, output, reasoning, cache}`), `text` (only parts with `time.end`), `reasoning` (only with thinking enabled), `error` (`run.ts:650-720`; part shapes in `packages/core/src/v1/session.ts:93-313`). **No deltas** are emitted in JSON mode.
- **Exit-code trap:** an in-stream `error` event must be treated as fatal regardless of exit code — in `--attach` mode the process can exit 0 after an error (`run.ts:769-804`).
- No enforceable read-only/workspace sandbox. Permissions are app-level: default agent rules allow `*`, ask for `doom_loop`/`external_directory`, deny `question`/`plan_*` (`agent/agent.ts:95-124`); noninteractive `run` **auto-rejects** asks unless `--dangerously-skip-permissions` (which replies `once`) (`run.ts:731-750`).
- No CLI timeout flag; agent `steps` is a soft config-level cap that injects instructions and disables tools rather than failing (`agent.ts:276`; `session/prompt.ts:1137-1344`).
- Model optional: default resolution = configured → recent → first-available with priority sort (`provider/provider.ts:1884-1941`). `opencode models [provider] [--verbose] [--refresh]` lists `providerID/modelID` per line (`cli/cmd/models.ts:8-64`).
- Isolation env: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_PERMISSION`, `OPENCODE_PURE` (`packages/core/src/flag/flag.ts:14-75`). Config loading can mutate the filesystem (seeds global config, writes `.gitignore`, installs deps) (`config/config.ts:236-446`).
- No `doctor` command; auth errors surface as `ProviderAuthError` message errors (`session/message-error.ts:4-12`).
- Server mode exists (`opencode serve` + `POST /session`, `prompt`, `prompt_async`, `abort`, SSE `GET /global/event`, JS SDK) — viable later upgrade, not v1.

### pi (commit `9ccfcd7`)

- One-shot: `pi --mode json` (print mode, JSONL session events; `modes/print-mode.ts:103-108`); prompt assembled from stdin → `@file` contents → first argv message (`main.ts:52-72`; `cli/initial-message.ts:16-42`).
- Strict **LF-only** JSONL framing (`modes/rpc/jsonl.ts:4-40`).
- First record may be a session header `{type:'session', version, id, timestamp, cwd, parentSession?}` (`print-mode.ts:111-117`). Events: `agent_start/agent_end`, `turn_start/turn_end`, message lifecycle, `message_update` (with nested `assistantMessageEvent` text/thinking/tool-call deltas, done, error), tool execution events (`packages/agent/src/types.ts:403-418`; `agent-loop.ts:313-340`).
- Assistant messages carry content blocks (`text`/`thinking`/`toolCall`), `usage {input, output, cacheRead, cacheWrite, totalTokens, cost{…, total}}`, `stopReason`, `errorMessage` (`packages/ai/src/types.ts:241-311`). Failures are **in-stream** (`stopReason: 'error' | 'aborted'`); JSON print mode does **not** reflect them in the exit code (`print-mode.ts:129-151`). Preflight failures (bad args, missing model) still exit 1 with stderr (`main.ts:476-758`).
- **System-prompt surface exists:** `--system-prompt` (replace) and `--append-system-prompt` (repeatable append) are parsed in `cli/args.ts:93-97`, documented in help (`args.ts:241-242`), and wired into the resource loader (`main.ts:632-634`). (Verified in 0.79.1 source — the required minimum version.)
- `--no-session` keeps session state in memory (`main.ts:253-260`). SIGTERM → exit 143, SIGHUP → 129; no SIGINT handler in print/rpc mode (`print-mode.ts:47-63`).
- Model: `--provider`, `--model` (provider-prefixed, optional `:<thinking>` suffix), fuzzy resolution, auth-filtered availability (`cli/args.ts:87-130`; `core/model-resolver.ts:71-470`; `model-registry.ts:688-720`). `--list-models` prints auth-available models; "No models available…" indicates installed-but-not-authed (`cli/list-models.ts:29-40`; `core/auth-guidance.ts:6-16`).
- Thinking levels: `off|minimal|low|medium|high|xhigh` (no public `max`; some model metadata maps pi `xhigh` → provider `max`); default `medium`; clamped to nearest supported level (`cli/args.ts:57-61, 130-139`; `core/defaults.ts:1-3`; `packages/ai/src/models.ts:48-80`, `models.generated.ts:134`).
- Tools: built-ins `read, bash, edit, write, grep, find, ls`; defaults `read, bash, edit, write`; read-only helper set `read, grep, find, ls`; controls `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates` (`core/tools/index.ts:83-183`; `core/sdk.ts:52-71, 244-250`; `cli/args.ts:116-167`).
- **No write confinement** (absolute paths accepted by `write`/`edit`; `bash` arbitrary) and **no native max-turns** (loop runs until no tool calls/queued messages) (`core/tools/path-utils.ts:44-53`, `write.ts:181-225`, `edit.ts:287-361`; `agent-loop.ts:169-268`).
- **No native structured-output mode** (no response-format/json-schema surface found in `packages/ai`/`agent`/`coding-agent`).
- Isolation: `PI_CODING_AGENT_DIR` overrides the `~/.pi/agent` config dir (auth.json, models.json, sessions) (`config.ts:463-536`). **Caution:** the old 0.54.0 binary was observed attempting filesystem writes (a `settings.json.lock` under the agent dir and a repo-local `.pi`) even on `pi --version`; 0.79.1 is not yet confirmed clean, so probes run with an isolated agent dir and neutral cwd regardless of version.
- RPC mode (`pi --mode rpc`) supports `prompt`, `abort`, `get_available_models`, `get_state`, etc. over JSONL — viable later upgrade, not v1.

## Design decisions

1. **Closed provider set, shared tuple.** Add `export const PROVIDER_IDS = ["codex", "claude-code", "opencode", "pi"] as const` in `src/dsl/types.ts` and derive `ProviderId` from it; CLI and runtime validation consume the same tuple. Re-inline the union literal in `ambient.d.ts` (it must stay import-free per `scripts/postbuild.mjs:33-45`); the existing packaging sync test catches drift. *(Good draft idea, confirmed viable.)*
2. **Model strings are pass-through.** No model unions, no vendored catalogs, no execution-time catalog validation. Both backends are authoritative for what runs (auth-filtered, user-extensible). Discovery (`opencode models`, `pi --list-models`) is UX-only and deferred to an optional follow-up.
3. **Spawn-per-call subprocess workers in v1.** Rationale: deterministic lifecycle; abort = kill the child (pi handles SIGTERM cleanly; opencode spawn cancellation terminates the run); per-process usage is per-turn (simpler than Codex's thread-cumulative accounting); testable via a `spawnChild` seam exactly like `test/codex-worker.test.ts:24-93`. Persistent modes (`pi --mode rpc`, `opencode serve`) are documented follow-ups, gated on the v1 parsers being stable.
4. **Shared subprocess/JSONL helper, provider-local semantics.** One new module owns spawn/line-split/stderr-ring/watchdog/abort/exit-normalization mechanics (modeled on `jsonrpc-stdio.ts`); each worker owns its event mapping. Do not abstract event semantics.
5. **Full-access only; fail closed on everything else.** Both new providers support a single sandbox mode, `danger-full-access`. `read-only` and `workspace-write` are rejected with `unsupported_option` — neither CLI can honestly enforce confinement (pi's tool allowlists are model/tool-layer controls, not OS confinement, and opencode's permission rules leave bash unconfined). `maxTurns` (both) and `effort` (opencode) are likewise rejected, never silently weakened or ignored. (Silently ignoring `effort` would also poison resume semantics: `effort` participates in resume keys, `src/runtime/keys.ts:52-77`, so a no-op `effort` would make behaviorally identical runs cache-distinct.) Precedents: Codex rejecting `maxTurns` pre-spawn; Codex approvals failing closed on unknown turns. **Known consequence:** omegacode's default `sandbox: "read-only"` (`src/dsl/types.ts:129-137`) is rejected by both workers, so every opencode/pi call requires an explicit `sandbox: "danger-full-access"`; the rejection error message states this remedy, and docs/SKILL flag it prominently.
6. **Approval is not bridged (Claude precedent).** Neither CLI can surface an approval request to omegacode in one-shot mode. Like `ClaudeWorker` (`src/worker/claude.ts:80-92`), the new workers do not consume `spec.approval`; enforcement is sandbox-driven, and permission asks fail closed (details below). This avoids breaking workflows that inherit a default `approval` value.
7. **`instructions` is supported on both providers — it is load-bearing.** The runtime's single corrective schema retry is delivered by appending corrective text to `runSpec.instructions` and calling `worker.runAgent` again (`src/runtime/primitives.ts:376-384`); a worker that rejects `instructions` would fail every corrective retry pre-spawn. Mapping: **pi** → `--append-system-prompt` (verified in 0.79.1 source — the required minimum — `cli/args.ts:93-97`, `main.ts:632-634`; Claude precedent for system-append, `claude.ts:96`). **opencode** → no system-prompt flag exists on `run`, so `spec.instructions` is injected as a clearly delimited preamble block prepended to the stdin prompt; documented honestly as prompt-level (not system-level) injection. Both workers forward instructions to the extraction turn too, so corrective schema guidance reaches the turn that produces JSON.
8. **Structured output = provider-local extraction + central finalization.** Neither CLI has native schema output (verified for pi; for opencode, none found on the `run` surface). Reuse Codex's two-phase pattern with a second silent subprocess invocation; runtime validation/retry is untouched.
9. **`codex` remains `DEFAULTS.provider`.** No behavioral change to defaults, builtins, or examples in v1.
10. **Inherit the user's environment by default.** Auth lives in the user's home (`~/.pi/agent/auth.json`, opencode XDG data). Workers add only targeted env (`OPENCODE_DISABLE_AUTOUPDATE=1` always, to prevent mid-run self-updates); test isolation uses the documented env vars. Project-level opencode config is honored by default (open question below).
11. **Require the newest verified upstream versions.** Minimums: opencode ≥ **1.16.2**, pi ≥ **0.79.1** (`@earendil-works/pi-coding-agent` — note the package renamed from `@mariozechner/pi-coding-agent`, whose last release was 0.73.1, so installs under the old name are inherently outdated). Doctor flags older binaries as `outdated`; each worker runs `<bin> --version` once per worker instance (the factory caches one worker per id) and rejects with `AgentError code: "provider_outdated"` whose message includes the upgrade command. The flag tables and event parsers in this plan target the verified 1.16.2 / 0.79.1 surfaces only — no feature detection, no fallbacks for older binaries.

## Phased implementation

### Phase 1 — Provider ID centralization + validation (no new workers)

**Files changed:** `src/dsl/types.ts`, `src/dsl/ambient.d.ts`, `src/cli.ts`, `src/runtime/primitives.ts`, `src/runtime/run.ts`, `test/packaging.test.ts`, `test/cli.test.ts`, `test/primitives.test.ts`.

1. `src/dsl/types.ts`: add `PROVIDER_IDS` tuple; `export type ProviderId = (typeof PROVIDER_IDS)[number]`. Export the tuple from `src/index.ts`.
2. `src/dsl/ambient.d.ts:10`: `type OmegacodeProviderId = "codex" | "claude-code" | "opencode" | "pi"` (inlined; packaging test updated).
3. `src/cli.ts:134`: replace local `PROVIDERS` with the shared tuple; update usage strings (`cli.ts:381, 610`) to `--provider codex|claude-code|opencode|pi`.
4. `src/runtime/primitives.ts:42-47`: add `provider: PROVIDER_IDS` to `SPEC_ENUMS` and validate it in `resolveSpec` alongside sandbox/effort/approval — closes the gap where plain-JS workflows pass typo providers through to the factory (and only fail there, or not at all under `--fake`).
5. `src/runtime/run.ts:179-207` (`resolveDefaults`): validate the resolved default provider (covers `meta.defaultProvider` typos at run setup).
6. Keep `DefaultWorkerFactory`'s `unknown_provider` throw as the second fail-closed guard.

**Validation:** `--provider pi --fake` round-trips; `--provider open-code` rejected at CLI; `agent("x", {provider: "open-code"})` rejected pre-factory; packaging sync test passes; all existing tests green.

### Phase 2 — Shared subprocess/JSONL helper

**File added:** `src/worker/subprocess-jsonl.ts` (+ `test/subprocess-jsonl.test.ts`).

Responsibilities (mechanics only):

- Spawn `bin` + argv with `cwd`, merged env, `stdio: ['pipe','pipe','pipe']`; injectable `spawnChild` seam matching `CodexWorkerOpts.spawnChild` / `JsonRpcStdioClient` (`src/worker/jsonrpc-stdio.ts:84-88`).
- Write prompt to stdin, then end stdin.
- Split stdout on `\n` **only** (pi's framing is strict LF; do not use readline's Unicode-separator semantics — `pi/modes/rpc/jsonl.ts:4-12`); yield parsed JSON objects; surface non-JSON lines to a diagnostics hook rather than crashing.
- Drain stderr into a bounded ring buffer; include the tail in exit diagnostics (mirrors `jsonrpc-stdio.ts:114-119, 281-284`).
- Output-stall watchdog (default on in production, like Codex's `turnStallTimeoutMs`, `codex.ts:54-70`): no stdout line for N ms → kill child, reject with retryable `AgentError code: "turn_stalled"`.
- Abort: on `ctx.signal` abort, SIGTERM the child (pi maps it to exit 143), escalate to SIGKILL after a grace window, reject `AgentInterrupted`. Pre-aborted signals short-circuit before spawn.
- Spawn `ENOENT` → `AgentError code: "binary_not_found"` (Codex precedent).
- Nonzero exit without a recognized in-stream terminal event → `AgentError code: "provider_exit"` with exit code + stderr tail, `retryable: false`.

### Phase 3 — `OpencodeWorker`

**Files:** add `src/worker/opencode.ts`, `test/opencode-worker.test.ts`; change `src/worker/factory.ts` (import, `FactoryOpts.opencodeBin?`, switch case), `src/runtime/run.ts` (forward `OPENCODE_BIN` env override, parallel to `CODEX_BIN` at `run.ts:26-38`), `test/factory.test.ts`.

**Command shape** (prompt on stdin, never argv — avoids quoting/length issues; `run.ts:38-48` confirms stdin-only works):

```sh
opencode run \
  --format json \
  --thinking \                             # noninteractive default is false (run.ts:251); required for reasoning events (run.ts:696-698)
  [--model '<spec.model verbatim>'] \      # omitted when spec.model unset → opencode default resolution
  [--dangerously-skip-permissions] \       # only when sandbox = danger-full-access
  < prompt-on-stdin
```

Run with `cwd: spec.cwd` (preferred over `--dir`, which mutates the CLI's own cwd to the same effect). Env additions: `OPENCODE_DISABLE_AUTOUPDATE=1`. **Version preflight:** on first `runAgent` per worker instance, run `<bin> --version` and reject with `AgentError code: "provider_outdated"` if below **1.16.2** (the verified surface). When `spec.instructions` is set, it is prepended to the stdin prompt as a clearly delimited preamble block (e.g. `<instructions>…</instructions>\n\n<prompt>`), since `run` has no system-prompt flag — this is the path the runtime's corrective schema retry travels (`primitives.ts:376-384`), so it must not be rejected.

**Pre-spawn rejections (fail closed), all `AgentError` with `retryable: false`:**

| Spec field | Behavior | Code |
|---|---|---|
| `maxTurns` set | reject (opencode `steps` is a soft config cap that injects instructions rather than enforcing; not equivalent) | `unsupported_option` |
| `sandbox: read-only` | reject (no enforceable mechanism verified; permission rules are app-level and bash is unconfined). **This is omegacode's default sandbox** (`types.ts:129-137`), so the error message must name the remedy: `set sandbox: "danger-full-access" to use provider "opencode"` | `unsupported_option` |
| `sandbox: workspace-write` | reject (same) | `unsupported_option` |
| `sandbox: danger-full-access` | allowed; pass `--dangerously-skip-permissions` so permission asks are auto-approved (mirrors Codex's danger→approval-never collapse, `codex-protocol.ts:148-152`) | — |
| `effort` set | **reject** in v1. `--variant` is documented as provider-specific reasoning effort (`run.ts:208-211`) and is the likely mapping target, but its runtime behavior for values a model doesn't support is unverified; silently ignoring `effort` is not fail-closed and would make resume keys (`keys.ts:52-77`) distinguish behaviorally identical runs. Map once verified — see Open questions | `unsupported_option` |
| `instructions` set | **supported**: prepended to the prompt as a delimited preamble (prompt-level injection; documented as such). Required for the corrective schema retry | — |
| `approval` | not consumed (Claude precedent); without `--dangerously-skip-permissions`, opencode auto-rejects asks in noninteractive mode (`run.ts:731-750`) — inherently fail-closed | — |

**Event mapping (`--format json` JSONL → `WorkerProgress` / result):**

| opencode event | Condition | Mapping |
|---|---|---|
| `{type:'session'…}` envelope `sessionID` | first events | capture `sessionID` for the extraction turn |
| `text` | part has `time.end` | append `part.text` to result text; emit `{kind:'text', text}` |
| `reasoning` | part has `time.end`; emitted because the worker always passes `--thinking` | emit `{kind:'reasoning', text}` |
| `tool_use`, `part.state.status === 'completed'` | completed tool part | emit `{kind:'tool', id: part.callID, name: part.tool, input: state.input}` then `{kind:'tool-result', id: callID, output, isError:false}` (opencode emits only terminal tool parts, so tool+result pair together) |
| `tool_use`, `state.status === 'error'` | errored tool part | same pair with `isError: true`, output = state error text |
| `step_start` | — | ignore |
| `step_finish` | — | accumulate usage from `part.tokens`/`part.cost`; emit `{kind:'usage', …}` |
| `error` | **any time, regardless of exit code** | terminal failure: `AgentError` with code derived from error name (`ProviderAuthError` → `provider_auth`, `retryable:false`; default `provider_error`, `retryable:false`), message from payload |
| unknown `type` | — | ignore (forward compatibility) |

**Usage normalization:** `inputTokens = tokens.input + tokens.cache.(read+write fields present)`, `outputTokens = tokens.output + tokens.reasoning`, `costUsd = cost`, summed across `step_finish` events of the run (verify exact cache field names against fixtures; Claude precedent folds cache into input, `claude.ts:374-386`).

**Completion:** process exit 0 with ≥1 `text` part and no `error` event → `status: 'completed'`, text = concatenated text parts. Exit 0 with zero text and no error → `AgentError code: 'no_result'` (Claude precedent). Error event → failure even on exit 0. Abort → `AgentInterrupted`.

### Phase 4 — `PiWorker`

**Files:** add `src/worker/pi.ts`, `test/pi-worker.test.ts`; change `src/worker/factory.ts` (`FactoryOpts.piBin?`, switch case), `src/runtime/run.ts` (forward `PI_BIN`), `test/factory.test.ts`.

**Command shape** (prompt on stdin; `main.ts:52-72` confirms stdin is the first prompt source):

```sh
pi --mode json --no-session \
  [--model '<spec.model verbatim>'] \              # pass-through incl. provider/ prefix and slashes; omit when unset
  [--thinking '<mapped effort>'] \                 # omit when spec.effort unset (pi defaults to medium)
  [--append-system-prompt '<spec.instructions>'] \ # omit when unset; carries the corrective schema retry
  < prompt-on-stdin
```

`--no-session` always: omegacode owns history/resume; don't litter `~/.pi/agent/sessions`. **Version preflight:** on first `runAgent` per worker instance, run `<bin> --version` with a scratch `PI_CODING_AGENT_DIR` and neutral cwd, and reject with `AgentError code: "provider_outdated"` if below **0.79.1** (message includes `npm i -g @earendil-works/pi-coding-agent`). If `spec.model` already carries a `provider/` prefix, do **not** also pass `--provider`. Document that authors should not use `:<thinking>` model suffixes (use `effort`); the worker passes the model verbatim and `--thinking` from `spec.effort` — precedence between the two is an open question.

**Effort → `--thinking` mapping** (pi clamps to the model's supported levels, `ai/models.ts:48-80`):

| omegacode effort | pi thinking |
|---|---|
| `none` | `off` |
| `minimal` | `minimal` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `xhigh` (pi has no public `max`; model metadata maps pi `xhigh` → provider `max` where applicable, `models.generated.ts:134`) |
| unset | flag omitted (pi default `medium`) |

**Sandbox / approval / limits / instructions:**

| Spec field | Behavior | Code |
|---|---|---|
| `sandbox: read-only` | reject — full-access-only policy. Pi's tool allowlists (e.g. `read,grep,find,ls`) are model/tool-layer controls, not OS confinement, so omegacode does not present them as a sandbox. **This is omegacode's default sandbox** (`types.ts:129-137`), so the error message must name the remedy: `set sandbox: "danger-full-access" to use provider "pi"` | `unsupported_option` |
| `sandbox: workspace-write` | reject — pi accepts absolute write paths and unconfined bash; cwd is not a sandbox (`path-utils.ts:44-53`, `write.ts:181-225`, `bash.ts:269-400`) | `unsupported_option` |
| `sandbox: danger-full-access` | allowed; default tool set | — |
| `maxTurns` set | reject — no native cap exists (`agent-loop.ts:169-268`) | `unsupported_option` |
| `instructions` set | **supported**: pass via `--append-system-prompt` (verified in 0.79.1 source — the required minimum: `cli/args.ts:93-97`, help `args.ts:241-242`, wired in `main.ts:632-634`; Claude system-append precedent `claude.ts:96`). Required for the corrective schema retry | — |
| `approval` | not consumed (Claude precedent). Pi has no permission-prompt mechanism; under `danger-full-access` nothing prompts. Documented. | — |

**Event mapping (pi JSONL → `WorkerProgress` / result):**

| pi event | Mapping |
|---|---|
| `{type:'session', …}` header | ignore (record session id for diagnostics) |
| `message_update` → `assistantMessageEvent` text delta | append to text buffer; emit `{kind:'text', text: delta}` |
| `message_update` → thinking delta | emit `{kind:'reasoning', text: delta}` |
| assistant `toolCall` content block (via message events) | emit `{kind:'tool', id: block.id, name: block.name, input: block.arguments}` |
| `toolResult` message | emit `{kind:'tool-result', id: toolCallId, output: stringified content, isError}` |
| assistant message done with `usage` | accumulate usage; emit `{kind:'usage', …}` |
| `turn_start` / `turn_end` / `agent_start` / message lifecycle | ignore |
| `agent_end` / final assistant message, `stopReason: 'stop'` (normal) | resolve: text from accumulated assistant text, `status: 'completed'` |
| final assistant `stopReason: 'error'` | `AgentError code: 'provider_error'` (message from `errorMessage`; classify auth/rate-limit-looking messages as their own codes if stable), `retryable: false` by default. **Must be detected in-stream — JSON print mode does not set the exit code for this** (`print-mode.ts:129-151`) |
| final assistant `stopReason: 'aborted'` | `ctx.signal.aborted` → `AgentInterrupted`; otherwise `AgentError code: 'aborted'` |
| process exit 1 before streaming (preflight: bad model, parse errors) | `AgentError code: 'provider_exit'` with stderr tail |
| unknown event types | ignore |

**Usage normalization:** `inputTokens = usage.input + usage.cacheRead + usage.cacheWrite`, `outputTokens = usage.output`, `costUsd = usage.cost.total` (cache-folding per Claude precedent).

### Phase 5 — Structured output (both workers)

Strategy mirrors Codex's two-phase flow (`codex.ts:161-206`) but adapted to spawn-per-call:

1. **Working turn** — normal run, progress forwarded, text accumulated. `spec.instructions` is applied as in Phases 3–4.
2. **Silent extraction turn** — second subprocess invocation, no progress forwarded, prompt =: original task summary + the working turn's final text + the author's JSON Schema (verbatim, not strictified — strictification exists for Codex's server-side `outputSchema` only, `schema.ts:42-45`) + "respond with a single JSON value matching this schema, nothing else." `spec.instructions` is forwarded to this turn too (pi: same `--append-system-prompt`; opencode: same preamble) — this is how the runtime's corrective retry guidance (`primitives.ts:376-384`) reaches the turn that actually emits JSON.
   - **pi:** run extraction with `--no-tools` (verified flag) and `--thinking off`.
   - **opencode:** run extraction with `--session <sessionID>` captured from the working turn's envelope (`run.ts:613-622`) so the model retains context; no verified tool-disable flag exists — rely on the prompt (open question on a deny-all permission config).
3. Parse extraction stdout text with `parseJsonLoose` (`schema.ts:191-197`); set `result.structured`; parse miss leaves `structured` undefined.
4. Centralized machinery is untouched: `RuntimePrimitives` strips null optionals, validates against the author schema with Ajv, performs the single corrective retry, and projects validated JSON into the transcript (`primitives.ts:371-399, 443-450`).
5. Pre-validate `spec.schema` compilability before the working turn via `assertValidSchema` (Claude precedent, `claude.ts:66-75`) so authors fail fast.
6. **Usage:** sum both turns' usage (per-process counters are per-turn — unlike Codex's thread-cumulative `tokenUsage.total`, no last-turn-only special case is needed).

### Phase 6 — Doctor, viewer, docs, skill

**Doctor** (`src/cli.ts:545-558`): add two rows using the existing first-stdout-line / `NOT FOUND` mechanism, with two corrections to the existing pattern:

- **Resolve binaries the same way the runtime will.** Doctor must consult the same env overrides the factory uses (`OPENCODE_BIN`, `PI_BIN`; and apply the same treatment to the existing `CODEX_BIN` path for consistency) — otherwise doctor reports `NOT FOUND` for a binary the runtime would happily spawn via its override.
- `opencode` → `<resolved bin> --version` (verified: prints version); report `outdated (< 1.16.2)` when below the required minimum.
- `pi` → `<resolved bin> --version`, **run with a scratch `PI_CODING_AGENT_DIR` and a neutral temp cwd** (the old 0.54.0 binary attempted filesystem writes — agent-dir `settings.json.lock`, repo-local `.pi` — even on `--version`; 0.79.1 is not yet confirmed clean, so isolation stays as cheap hygiene). Report `outdated (< 0.79.1)` when below the minimum; the message should point at `npm i -g @earendil-works/pi-coding-agent`, since installs from the renamed `@mariozechner/pi-coding-agent` package cap out at 0.73.1.

Keep doctor fast and offline. Deeper "installed-but-not-authed" probes (`pi --list-models` → "No models available…", `core/auth-guidance.ts:6-16`; opencode `auth list`/`providers list`) are a documented optional follow-up, not default doctor rows, because they can touch network/credentials.

**Viewer:**

- `viewer/src/components/glyphs.tsx:41-45`: replace the binary `claude-code ? ClaudeIcon : OpenAiIcon` with a 4-way map; add simple glyphs (or neutral monogram badges "OC" / "π") for `opencode`/`pi`; unknown strings keep a neutral fallback rather than the OpenAI icon.
- `viewer/src/lib/types.ts:3` already accepts the new ids; `viewer/src/lib/fold.ts` and `src/server/serve.ts` need no change (`AgentSnapshot.provider: ProviderId` widens with the union).
- Optional: provider accent variables in `viewer/src/index.css` for the two new ids.

**Docs:**

- `README.md`: provider list (4), prerequisites (install/auth `opencode` and/or `pi`), `--provider` strings, doctor description, an example showing backend-provider vs upstream-model-provider semantics (`provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.5"`), explicit safety-limitations paragraph, the minimum version requirements (opencode ≥ 1.16.2, pi ≥ 0.79.1 from `@earendil-works/pi-coding-agent`), and a **prominent note that both new providers support only `sandbox: "danger-full-access"`** (the default `read-only` is rejected).
- `DESIGN.md`: revise "two first-class providers" framing (`DESIGN.md:3-40`); add opencode/pi backend sections (process model, auth location, env overrides `OPENCODE_BIN`/`PI_BIN`, sandbox table, instructions mapping incl. opencode's prompt-level injection, structured-output strategy); update architecture diagram, CLI surface, and auth/config sections (`DESIGN.md:153-168, 575-613`).
- `skill/SKILL.md` (canonical authoring guidance, source for `guide`/`install-skill`): update frontmatter/intro, the `provider?:` signature (`SKILL.md:43-44`), the "Providers" section (`SKILL.md:55-65`) with per-provider effort/sandbox/instructions/structured-output/auth behavior incl. the rejection tables, the full-access-only sandbox requirement for both new providers, and the minimum versions, and the CLI block (`SKILL.md:199-212`). No new install-skill targets in v1.
- `package.json`: description + keywords (`opencode`, `pi`).
- Builtins/examples: **unchanged** — the four multi-provider builtins remain deliberately Codex-vs-Claude (their schemas, A/B slots, and opposite-of logic are two-provider by construction); note this in SKILL.md. Expansion is an open question.

## Testing matrix

All unit tests run offline via `node --test --import tsx ./test/*.test.ts`; new worker tests use a `FakeChild`-style scripted child injected through the spawn seam (pattern: `test/codex-worker.test.ts:24-93, 258-288`).

| Area | File | Cases |
|---|---|---|
| Provider types | `test/packaging.test.ts` | ambient/canonical 4-member union sync; ambient compiles standalone with a `provider: "pi"` snippet |
| CLI | `test/cli.test.ts` | `--provider opencode` / `--provider pi` accepted under `--fake --no-serve --json`; typo still rejected; help/doctor output strings; doctor binary resolution honors `OPENCODE_BIN`/`PI_BIN`; doctor min-version classification (`ok` / `outdated` / `NOT FOUND`) from stubbed version output |
| Runtime validation | `test/primitives.test.ts` | bad `opts.provider` and bad `meta.defaultProvider` rejected pre-factory; provider change still invalidates resume cache (existing H8 pattern) |
| Factory | `test/factory.test.ts` | 4-way worker class selection; per-provider cache; `opencodeBin`/`piBin` forwarding; unknown id still `unknown_provider`; fake routing |
| Subprocess helper | `test/subprocess-jsonl.test.ts` | LF-only splitting (incl. Unicode-separator payloads), partial-line buffering, stderr ring + exit diagnostics, stall watchdog → retryable `turn_stalled`, abort → SIGTERM→SIGKILL → `AgentInterrupted`, pre-aborted short-circuit, ENOENT → `binary_not_found`, non-JSON line tolerance |
| OpencodeWorker | `test/opencode-worker.test.ts` | argv construction (model with nested slashes; flag omission when model unset; `--thinking` always present; `--dangerously-skip-permissions` only for danger); stdin prompt incl. instructions-preamble injection; full event-mapping table incl. reasoning and tool completed/error pairs; **`error` event fatal on exit 0**; exit 0 + no text → `no_result`; usage accumulation across `step_finish`; rejections (`read-only` with actionable message, `workspace-write`, `maxTurns`, `effort`); version preflight (stubbed `--version` below 1.16.2 → `provider_outdated`, checked once per worker); schema extraction hit/miss + `--session` reuse + instructions forwarded to extraction + usage summing; corrective-retry instructions reach the prompt preamble; abort/stall |
| PiWorker | `test/pi-worker.test.ts` | argv (model verbatim incl. colon-suffix passthrough, `--no-session` always, `--thinking` omission, `--append-system-prompt` from instructions); stdin prompt; delta accumulation; tool/tool-result mapping; **`stopReason:'error'` fatal despite exit 0**; `aborted` vs signal disambiguation; preflight exit-1 classification; effort table incl. `max→xhigh`; rejections (`read-only` with actionable message, `workspace-write`, `maxTurns`); version preflight (stubbed `--version` below 0.79.1 → `provider_outdated`, run with scratch `PI_CODING_AGENT_DIR`); schema extraction with `--no-tools` + instructions forwarded; corrective-retry instructions appear in `--append-system-prompt`; usage folding |
| Fake-mode E2E | `test/cli.test.ts` | run `examples/hello.workflow.js` with `--provider pi --fake`, assert provider propagates into fake text/events/journal |

**Gated smoke tests** (manual / env-gated, e.g. `OMEGACODE_SMOKE=opencode,pi`; never in CI by default; require local installs + auth; use scratch `PI_CODING_AGENT_DIR` / opencode XDG dirs where auth permits):

```sh
omegacode doctor                                   # both rows show versions ≥ minimums; no stray .pi/lock files afterwards
omegacode run examples/hello.workflow.js --provider opencode --sandbox danger-full-access --no-serve
omegacode run examples/hello.workflow.js --provider pi --sandbox danger-full-access --no-serve
# + one schema workflow per provider to exercise extraction AND a forced corrective retry end-to-end
# + one default-sandbox run per provider asserting the actionable unsupported_option rejection
```

A first smoke run must also **capture real JSONL samples into `test/fixtures/`** — discovery could not collect authenticated samples (pi open question), so fixtures start from source-derived shapes and get replaced/confirmed by smoke captures.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Upstream version drift** — flags and event shapes are verified against opencode 1.16.2 / pi 0.79.1 only; older installs (incl. the renamed `@mariozechner/pi-coding-agent` package, which caps at 0.73.1) differ | Required minimums enforced by doctor and a once-per-worker `--version` preflight (`provider_outdated`, upgrade command in the message); no feature detection or fallbacks for older binaries; smoke-capture fixtures from the real binaries before shipping |
| **pi `--version` side effects** — the old 0.54.0 binary attempted FS writes (agent-dir `settings.json.lock`, repo-local `.pi`) even on version probes; 0.79.1 not yet confirmed clean | Doctor and version preflights run with scratch `PI_CODING_AGENT_DIR` and a neutral temp cwd regardless of version |
| **Both new providers reject omegacode's default sandbox** (`read-only`) — plain `agent({provider:"opencode"})` / `agent({provider:"pi"})` fails | Deliberate full-access-only policy: rejection error names the remedy (`sandbox: "danger-full-access"`); README/SKILL flag it prominently; acceptance criteria written against the explicit-sandbox calls |
| opencode exit 0 despite `error` event (attach-mode path) | Parser treats any `{type:'error'}` as fatal independent of exit code; pinned by unit test |
| pi JSON mode hides failures from exit codes | Terminal classification is driven by in-stream `stopReason`, never exit code alone; pinned by unit test |
| Corrective schema retry depends on `instructions` (`primitives.ts:376-384`) | Both workers support `instructions` (pi `--append-system-prompt`; opencode prompt preamble) and forward it to the extraction turn; exercised by unit tests and a forced-retry smoke test |
| JSONL event drift across upstream releases | Fixture-based parsers; unknown event types ignored; non-JSON lines tolerated; protocol-drift tests mirroring `codex-worker.test.ts` |
| No OS sandbox in either CLI | Full-access-only policy: confined modes (`read-only`, `workspace-write`) rejected outright for both providers in v1; documented |
| Hung subprocesses (no CLI timeouts upstream) | Stall watchdog with retryable `turn_stalled` (Codex precedent) |
| Structured-output extraction misses | `parseJsonLoose` + central validation + the existing one corrective retry; extraction prompt embeds the working answer so a retry has everything it needs |
| Usage/cost mismatch | Best-effort normalization with cache-folding per Claude precedent; absent fields default to 0; failed-turn usage still folded by the runtime (`primitives.ts:405-424`) |
| Config/auth side effects (opencode config loading mutates FS, seeds configs, can install deps) | `OPENCODE_DISABLE_AUTOUPDATE=1` always; tests run with full isolation env (`OPENCODE_CONFIG_CONTENT`, `OPENCODE_AUTH_CONTENT={}`, XDG scratch dirs, `OPENCODE_PURE=1`); pi tests use `PI_CODING_AGENT_DIR` scratch |
| Spawn-per-call startup latency | Accepted for v1; `pi --mode rpc` / `opencode serve` documented as follow-up optimizations once parsers are stable |
| Builtins assume two providers | Explicitly unchanged in v1; documented |

## PR breakdown

1. **Provider IDs + validation** — Phase 1 (tuple, ambient, CLI, `SPEC_ENUMS.provider`, `resolveDefaults` check) + test updates. Pure plumbing, fake-mode usable immediately.
2. **Subprocess/JSONL helper** — Phase 2 + tests.
3. **`OpencodeWorker`** — Phase 3 + factory wiring + fixtures + tests.
4. **`PiWorker`** — Phase 4 + factory wiring + fixtures + tests.
5. **Structured output for both workers** — Phase 5 + tests, including the corrective-retry-through-instructions path (kept separate so worker PRs land with text-only support first; alternatively folded into 3/4 if small).
6. **Doctor, viewer, docs, skill, package metadata** — Phase 6.
7. *(Optional follow-up, out of v1 scope)* `omegacode models` dynamic discovery (`opencode models --verbose`, pi RPC `get_available_models`), deeper doctor auth probes, opencode `effort → --variant` mapping, persistent-mode workers.

## Acceptance criteria

- `agent("…", { provider: "opencode", sandbox: "danger-full-access" })` and `agent("…", { provider: "pi", sandbox: "danger-full-access" })` execute end-to-end (smoke-verified locally) with text, reasoning (where the model emits it), tool, tool-result, and usage progress visible in terminal renderer and viewer. Plain `agent("…", { provider: "opencode" })` or `agent("…", { provider: "pi" })` (default `read-only` sandbox) fails fast with an actionable `unsupported_option` error naming the sandbox remedy.
- `--provider opencode|pi` accepted by the CLI; typos rejected at CLI, at `resolveSpec`, at `resolveDefaults`, and at the factory (defense in depth).
- Existing Codex/Claude tests pass unchanged; resume keys, journal, and transcript formats are untouched; provider switches still invalidate caches.
- Model strings pass through verbatim, including nested slashes (`openrouter/anthropic/claude-sonnet-4.5`).
- Fail-closed semantics enforced and tested: both providers reject `read-only` and `workspace-write` (full-access only) and `maxTurns`; opencode additionally rejects `effort`; opencode permission asks are auto-rejected except under `danger-full-access`.
- Binaries below the required minimums (opencode 1.16.2, pi 0.79.1) are refused with `provider_outdated` and an upgrade hint, by both doctor and the worker preflight.
- `instructions` works on both providers (pi `--append-system-prompt`; opencode prompt preamble), and the runtime's corrective schema retry — which travels through `runSpec.instructions` (`primitives.ts:376-384`) — completes end-to-end for both.
- In-stream failures (`opencode error` events; pi `stopReason:'error'|'aborted'`) are classified correctly regardless of process exit code.
- Schema-bearing calls return validated `structured` via extraction + central validation, with the corrective retry working for both providers.
- `omegacode doctor` shows version-or-NOT-FOUND rows for both new providers (flagging below-minimum versions as `outdated`), resolves binaries through the same `OPENCODE_BIN`/`PI_BIN` overrides the runtime uses, and probes pi without filesystem side effects; viewer renders distinct (non-OpenAI-fallback) identity for them; README/DESIGN/SKILL document the four-provider surface, the full-access-only sandbox requirement, the minimum versions, and the safety limitations.
- No live/paid provider calls in default CI.

## Open questions

1. **opencode `effort → --variant` mapping.** `--variant` is now verified as "model variant (provider-specific reasoning effort, e.g., high, max, minimal)" flowing into the session prompt input (`run.ts:208-211, 487-496, 782-856`), but its runtime behavior for values a given model doesn't support (error? silent ignore?) is unverified. V1 rejects `effort` (`unsupported_option`); implement and test the mapping as a follow-up once behavior is confirmed. (`--thinking` is resolved: boolean display gate, always passed.)
2. **opencode confined sandboxes and system-level instructions.** Is there a verified surface for deny-rule permission policies (`OPENCODE_PERMISSION` format is unverified) that could honestly back `read-only`, and could `--agent` definitions provide true system-prompt injection (replacing v1's prompt-preamble for `instructions`)? V1 rejects confined sandboxes and uses prompt-level instructions; revisit with fixture proof.
3. **opencode extraction-turn tool disabling.** No `--no-tools` equivalent found on `run`. V1 relies on prompt discipline plus `--session` continuity; a deny-all permission config could harden this if Q2 resolves.
4. ~~pi minimum supported version.~~ **Resolved:** require the newest verified versions — pi ≥ 0.79.1 (`@earendil-works/pi-coding-agent`) and opencode ≥ 1.16.2 — enforced by doctor and a once-per-worker version preflight; no feature detection or fallbacks. The local install was upgraded to pi 0.79.1 on 2026-06-09. Remaining sub-item: confirm 0.79.1's `--version` is side-effect-free (probes stay isolated either way).
5. **pi default model behavior.** Does pi resolve a default model when `--model` is omitted but auth exists, or is "missing model" always a preflight exit-1? Determines whether `spec.model` should be required for `provider: "pi"`.
6. **pi `--thinking` vs model colon-suffix precedence** when an author passes both. V1 documents "don't combine"; verify actual precedence.
7. **opencode project config.** Honor project `opencode.jsonc` by default (user expectation, but reduces reproducibility and config loading can mutate the FS) or always set `OPENCODE_DISABLE_PROJECT_CONFIG=1`? Lean: honor by default, isolate in tests — but confirm before PR 3.
8. **Empirical JSONL fixtures.** Discovery could not capture authenticated real-run samples for either CLI; fixtures are source-derived until the first smoke run replaces them. Treat fixture confirmation as a release gate for PRs 3–4.
9. **Multi-provider builtins.** Expand `bake-off`/`second-opinion`/`provider-debate`/`multi-provider-review` to accept provider lists via `args` (their two-slot logic requires redesign), or keep them Codex-vs-Claude? Out of v1; decide post-launch.
10. **Viewer identity.** Distinct brand icons vs neutral monogram badges for `opencode`/`pi` (plan assumes neutral badges; brand assets/licensing unverified).
11. **Persistent-mode upgrade criteria.** What latency/cancellation evidence would justify moving to `pi --mode rpc` / `opencode serve` + SDK (which adds `OPENCODE_SERVER_PASSWORD` and daemon lifecycle concerns)?
12. **Confined-sandbox support timeline.** Because omegacode defaults to `sandbox: "read-only"`, both new providers' v1 ergonomics are strictly worse than Codex/Claude (explicit `danger-full-access` opt-in required on every call). If Q2's opencode permission-policy route pans out — or an external OS-level sandbox wrapper is adopted — an honest confined mode would remove the biggest adoption friction. Pi's tool allowlists alone don't qualify (model/tool-layer, not confinement).