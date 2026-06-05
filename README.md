# agent-workflows

Run JavaScript **workflow files** that orchestrate **Codex** and **Claude Code** agents with a small
DSL — `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`. The capability target is Claude
Code's Workflows; the workers are pluggable (Codex via the `codex app-server`, Claude Code via the
`@anthropic-ai/claude-agent-sdk`). Workflow files run in a hardened sandbox, every run is journaled, and
any run is **resumable** (including after an edit — only the changed suffix re-runs).

See `DESIGN.md` for the full design and `skill/SKILL.md` for the authoring guide.

## Status

Working today:
- DSL runtime in a hardened `node:vm` sandbox (no eval/require/import; `Date.now`/`Math.random` shimmed).
- `agent` / `parallel` / `pipeline` / `phase` / `log` / seeded `now`/`random`; concurrency + agent caps.
- **Claude Code worker** (real) — text and native structured output (`outputFormat: json_schema`).
- **Fake worker** (`--fake`) for offline smoke tests.
- **Resume**: journal + chained-key replay (`--resume <runId>`); completed agents replay from disk.
- Determinism lint; `events.jsonl` + `journal.jsonl` + `result.json` per run.

In progress (see milestones in `DESIGN.md`):
- **Codex worker** (`codex app-server` JSON-RPC driver) — currently a stub; use `--fake` or
  `--provider claude-code`.
- **Viewer server** (`serve`) + web dashboard; `runs` / `tail` / `doctor` commands; live progress tree.

## Quick start

```bash
npm install
npx tsx src/cli.ts run examples/hello.workflow.js --fake          # offline smoke test
npx tsx src/cli.ts run examples/hello.workflow.js --provider claude-code
npx tsx src/cli.ts run examples/hello.workflow.js --resume <runId>  # replay from the journal
npm run build && node dist/cli.js run examples/hello.workflow.js --fake
```

## A workflow file

```js
export const meta = { name: "hello", description: "fan out, then synthesize" }

phase("Gather")
const facts = await parallel(
  ["rivers", "mountains"].map((t) => () => agent(`One fact about ${t}.`, { sandbox: "read-only" })),
)

phase("Synthesize")
return await agent(`Combine:\n${facts.join("\n")}`)
```

Files are plain JS: `export const meta` first, then a body using the injected globals, ending in a
top-level `return`. No imports — the globals are in scope. Use `now()`/`random()` (not `Date.now()`/
`Math.random()`, which throw). Data dir: `~/.agent-workflows/runs/<runId>/`.
