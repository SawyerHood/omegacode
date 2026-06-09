![omegacode](omega-logos/header.png)

# omegacode

[![CI](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml/badge.svg)](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml)

An **agent-agnostic implementation of Claude Code's Workflows**. omegacode runs JavaScript workflow
files that orchestrate fleets of coding agents with a small deterministic DSL — `agent()` /
`parallel()` / `pipeline()` / `phase()` — and the workers are pluggable: the same workflow can
drive **Claude Code**, **Codex**, **OpenCode**, **Pi**, or several providers in a single run.

## Install

```bash
npm install -g omegacode
omegacode install-skill
```

`install-skill` teaches your agents how to author and run workflows by copying the skill into
`~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (Codex and other agents). Pass
`--claude` or `--agents` to install to just one.

You'll need Node 20+ and at least one worker installed: `codex` (the default provider),
`claude`, `opencode`, or `pi`. Run `omegacode doctor` to check.

## Use it

With the skill installed, just ask your agent:

> use omegacode to adversarially review this PR with both claude code and codex

It will author a workflow — finders fan out in parallel, a cross-provider skeptic pass tries to
refute each finding, a synthesizer merges what survives — then run it and report back. Runs are
journaled and resumable, and `omegacode serve` opens a live dashboard of every agent as it works.

## What a workflow looks like

```js
export const meta = { name: "adversarial-review", description: "find bugs, cross-examine them" }
// FINDINGS and VERDICT are plain JSON Schemas, elided here

phase("Find")
const findings = await parallel(
  ["correctness", "security", "performance"].map((lens) => () =>
    agent(`Review the diff through the ${lens} lens. List concrete issues.`, { schema: FINDINGS })),
)

phase("Verify")
return await pipeline(
  findings.filter(Boolean).flatMap((f) => f.issues),
  (issue) => agent(`Try to refute: ${issue.desc}`, { provider: "claude-code", schema: VERDICT }),
)
```

Plain JavaScript, no imports — the DSL is injected. Each `agent()` spawns a real provider-backed
agent; omit `provider` to inherit whatever the run was started with (`--provider`, default
`codex`), or pin it per call when you want cross-provider diversity.

## CLI

```
omegacode run <file.workflow.js | name>   # run a workflow (auto-starts the live viewer)
omegacode serve                           # read-only dashboard over all runs
omegacode run <name> --resume <runId>     # resume — only the changed suffix re-runs
omegacode doctor                          # check provider availability
omegacode guide                           # print the full authoring guide
```

Providers are `codex`, `claude-code`, `opencode`, and `pi`. OpenCode models use
`provider/model` names and currently require `danger-full-access` because omegacode cannot
enforce OpenCode read-only mode itself. Pi runs in read-only mode with read/search tools only;
`PI_PROVIDER` and `PI_MODEL` can provide its defaults, and `OPENCODE_BIN` / `PI_BIN` override
binary paths.

`run` also accepts saved workflow names. Six built-ins ship with the package:
`deep-research`, `code-review`, and four multi-provider workflows that put provider-diverse
models' decorrelated errors to work — `multi-provider-review` (both review the same
branch independently, then a synthesis merges both), `bake-off` (both implement the
same task in isolated worktrees, blind cross-provider judges pick a winner),
`provider-debate` (propose → attack → rebut for N rounds, then a judge rules), and
`second-opinion` (both answer cheap; agreement returns merged, disagreement escalates
to deep effort and adjudicates). Try `omegacode run deep-research --args '"your
question"'`, or `omegacode workflows` to list them. See `omegacode guide` for the
complete authoring reference.
