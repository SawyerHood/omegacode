// Audit agent-workflows for parity with Claude Code's built-in Workflows feature.
// Spawns Codex (gpt-5.5) workers and Claude Code workers to analyze different dimensions in
// parallel, then synthesizes a gap report. Reads the reverse-engineered Claude Code internals doc
// and this repo's own source.

export const meta = {
  name: "parity-audit",
  description: "Audit agent-workflows vs Claude Code Workflows; codex (gpt-5.5) + claude workers, then synthesize gaps.",
  phases: [{ title: "Analyze (codex + claude)" }, { title: "Synthesize" }],
}

const CC_DOC = "/Users/sawyerhood/computer-use/CLAUDE_CODE_WORKFLOWS.md"
const TOOL = "/Users/sawyerhood/agent-workflows"

const FINDING_SCHEMA = {
  type: "object",
  required: ["dimension", "items"],
  properties: {
    dimension: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["feature", "status", "claudeCode", "agentWorkflows"],
        properties: {
          feature: { type: "string" },
          status: { type: "string", enum: ["parity", "partial", "missing", "extra"] },
          claudeCode: { type: "string", description: "how Claude Code does it" },
          agentWorkflows: { type: "string", description: "how agent-workflows does it (cite files)" },
          note: { type: "string" },
        },
      },
    },
  },
}

const COMMON = `You are auditing FEATURE PARITY between two systems.
SYSTEM A = Claude Code's built-in "Workflows" feature. Its internals are exhaustively documented in ${CC_DOC} — READ IT.
SYSTEM B = "agent-workflows", a standalone CLI in ${TOOL}. READ ${TOOL}/DESIGN.md and the relevant files under ${TOOL}/src/.
For your assigned dimension, enumerate each concrete feature and classify B vs A:
- "parity": B matches A's behavior.
- "partial": B has it but weaker/different (explain how).
- "missing": A has it, B does not.
- "extra": B has it, A does not.
Be specific and evidence-based — cite the actual files/lines you read in B. Do not guess; read the code.
DIMENSION: `

const dimensions = [
  { key: "DSL primitives & authoring", provider: "codex", model: "gpt-5.5",
    focus: "the agent()/parallel()/pipeline()/phase()/log()/budget/args/workflow() primitives + the meta block + injected-globals authoring shape. Compare the full primitive set, signatures, and semantics (e.g. parallel barrier + null-mapping, pipeline stage args, budget, nested workflow())." },
  { key: "Resume, journal & determinism", provider: "claude-code",
    focus: "the chained-key journal, longest-unchanged-prefix replay, edit-and-resume, started-hit-respawn, and the determinism enforcement that blocks nondeterministic time/RNG calls (the runtime shims + the static submit-time lint)." },
  { key: "Sandbox & execution model", provider: "codex", model: "gpt-5.5",
    focus: "the hardened node:vm (codeGeneration off, frozen intrinsics, import/require blocked), meta pure-literal parsing, live-coroutine execution, and the 30s sync timeout." },
  { key: "Structured output, caps & budget", provider: "claude-code",
    focus: "schema/StructuredOutput vs native outputSchema/outputFormat; the concurrency cap, 1000-agent lifetime cap, 4096 fan-out cap; and the token budget/ceiling." },
  { key: "Tool surface, named workflows & UI", provider: "codex", model: "gpt-5.5",
    focus: "Claude Code's Workflow tool input (script/name/scriptPath/args/resumeFromRunId), saved/named workflows + the registry, the /workflows UI + progress tree, the approval gate, worktree isolation, and how all of that maps (or doesn't) to agent-workflows' CLI + viewer." },
]

phase("Analyze (codex + claude)")
const findings = await parallel(
  dimensions.map((d) => () =>
    agent(COMMON + d.focus, {
      label: d.key,
      provider: d.provider,
      ...(d.model ? { model: d.model } : {}),
      sandbox: "read-only",
      schema: FINDING_SCHEMA,
    }),
  ),
)

phase("Synthesize")
const real = findings.filter(Boolean)
log(`collected ${real.length}/${dimensions.length} dimension reports`)

const report = await agent(
  `You are writing the final PARITY REPORT for "agent-workflows" vs Claude Code's Workflows feature.
Below are structured findings from ${real.length} analysis agents (Codex gpt-5.5 + Claude Code), as JSON.
Write a crisp Markdown report:
1. A one-line verdict + an estimated parity percentage.
2. A "Gaps" section: every "missing" and "partial" item, grouped by severity (blocker / nice-to-have), each with what to build.
3. An "Extras" section: where agent-workflows exceeds Claude Code.
4. A short prioritized punch-list to reach 100% parity.
Be decisive and concrete. Findings JSON:\n\n${JSON.stringify(real, null, 2)}`,
  { provider: "claude-code", sandbox: "read-only" },
)

return report
