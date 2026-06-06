![omegacode](omega-logos/header.jpg)

# omegacode

[![CI](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml/badge.svg)](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml)

Run JavaScript **workflow files** that orchestrate **Codex** and **Claude Code** agents with a small
DSL — `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`. The capability target is Claude
Code's Workflows; the workers are pluggable (Codex via the `codex app-server`, Claude Code via the
`@anthropic-ai/claude-agent-sdk`). Workflow files run in a hardened sandbox, every run is journaled, and
any run is **resumable** (including after an edit — only the changed suffix re-runs).

**`skill/SKILL.md` is the canonical authoring/usage guide** — read it first if you are writing or running
workflows (`omegacode guide` prints it). `DESIGN.md` records the original design intent and is partly
aspirational; where it disagrees with the shipped CLI, SKILL.md and `--help` win. This README is the
short tour.

## Status

Working today:
- DSL runtime in a hardened `node:vm` sandbox (no eval/require/import; `Date.now`/`Math.random` shimmed).
- `agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / seeded `now`/`random`; concurrency +
  agent caps + an optional output-token budget ceiling.
- **Codex worker** (real) — drives the local `codex app-server` over JSON-RPC; text and structured output
  (a free-form working turn followed by a schema-constrained extraction turn). This is the default provider.
- **Claude Code worker** (real) — text and native structured output (`outputFormat: json_schema`).
- **Fake worker** (`--fake`) for offline smoke tests.
- **Resume**: journal + chained-key replay (`--resume <runId>`); completed agents replay from disk.
- Determinism lint; `events.jsonl` + `journal.jsonl` + per-agent transcripts + `result.json` per run.
- **Viewer**: `omegacode serve` (and `run` auto-starts it) runs a localhost-only React dashboard over
  SSE — a run list, a live phase/agent tree, and a per-agent chat-feed drilldown. It is read-only.
- `runs` (list / prune), `validate`, `doctor`, `guide`, `install-skill` commands.

## Quick start

```bash
npm install
npx tsx src/cli.ts run examples/hello.workflow.js --fake          # offline smoke test
npx tsx src/cli.ts run examples/hello.workflow.js                  # real agents (default provider: codex)
npx tsx src/cli.ts run examples/hello.workflow.js --provider claude-code
npx tsx src/cli.ts run examples/hello.workflow.js --resume <runId>  # replay from the journal
npm run build && node dist/cli.js run examples/hello.workflow.js --fake
```

`npm run build` builds the viewer's static bundle and then the CLI bundle into `dist/` (see
`package.json` "scripts" for the exact pipeline). `npm test` runs the `node:test` suites under
`test/`.

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
`Math.random()`, which throw). Data dir: `~/.omegacode/runs/<runId>/`.

## CLI

```
omegacode run <file.workflow.js | name> [options]   # run a workflow (auto-starts the viewer, prints its URL)
omegacode serve [--port 4123]                # localhost read-only viewer over all runs
omegacode runs [--prune --keep N] [--prune-stale]   # list / prune runs
omegacode workflows [--json]                 # list saved/named workflows (project, user, builtin)
omegacode save <file> [--project] [--force]  # save a workflow by its meta.name
omegacode validate <file | name>             # parse + check meta without running
omegacode doctor                             # check codex/claude availability + data dir
omegacode guide                              # print the authoring guide (the skill text)
omegacode install-skill [--claude] [--agents]   # install the authoring skill into agent skill dirs
```

`run`/`validate` accept a saved workflow's name (its `meta.name`) instead of a path, resolved from
`.omegacode/workflows/` in the project, `~/.omegacode/workflows/`, or the shipped built-ins —
`deep-research` and `code-review`. Try: `omegacode run deep-research --args '"your question"'`.

See `omegacode --help` for the full flag list and `omegacode guide` (i.e. `skill/SKILL.md`) for the
authoring guide.
