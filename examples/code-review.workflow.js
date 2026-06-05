export const meta = {
  name: "code-review",
  description:
    "Review a diff/ref/path along several dimensions in parallel, then adversarially verify each finding and return only the confirmed ones.",
  defaultSandbox: "read-only",
  phases: [{ title: "Review" }, { title: "Verify" }],
}

const target =
  args && typeof args === "object" && typeof args.target === "string" && args.target.trim()
    ? args.target.trim()
    : "the staged diff"

// ----------------------------------------------------------------------------
// Phase 1: Review — one reviewer per dimension, in parallel.
// ----------------------------------------------------------------------------
phase("Review")
log(`reviewing ${target}`)

const dimensions = ["correctness", "security", "performance"]

const reviews = await parallel(
  dimensions.map((dimension) => () =>
    agent(
      `Review ${target} for ${dimension} issues. ` +
        `If ${target} is a git ref or path, inspect the relevant code; if it is "the staged diff", ` +
        `review the currently staged changes. Report each concrete issue as a finding with the file, ` +
        `the line if you can pinpoint it, a short title, and a clear explanation of why it is a ` +
        `${dimension} problem. Only report real issues you can point to in the code — do not speculate.`,
      {
        label: `review: ${dimension}`,
        sandbox: "read-only",
        schema: {
          type: "object",
          required: ["findings"],
          properties: {
            findings: {
              type: "array",
              items: {
                type: "object",
                required: ["file", "title", "why"],
                properties: {
                  file: { type: "string" },
                  line: { type: "number" },
                  title: { type: "string" },
                  why: { type: "string" },
                },
              },
            },
          },
        },
      },
    ).then((r) => ({ dimension, findings: (r.findings || []).filter(Boolean) })),
  ),
)

const findings = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings.map((f) => ({ ...f, dimension: r.dimension })))

log(`collected ${findings.length} candidate findings across ${dimensions.length} dimensions`)

// ----------------------------------------------------------------------------
// Phase 2: Verify — for each finding, an independent agent tries to REFUTE it.
// Keep only the confirmed (real) ones. Pipeline so each finding verifies independently.
// ----------------------------------------------------------------------------
phase("Verify")

const verdicts = await pipeline(findings, (finding) =>
  agent(
    `You are a skeptical senior reviewer double-checking a flagged issue in ${target}. ` +
      `Inspect the actual code and try to REFUTE this finding. It is NOT real if it is a false ` +
      `positive, already handled elsewhere, intended behavior, or not actually present in the code. ` +
      `Set real=false when you cannot confirm it from the code; default to skepticism when unsure.\n\n` +
      `Finding (JSON):\n${JSON.stringify(finding, null, 2)}`,
    {
      label: `verify: ${finding.title.slice(0, 40)}`,
      sandbox: "read-only",
      schema: {
        type: "object",
        required: ["real"],
        properties: {
          real: { type: "boolean" },
        },
      },
    },
  ).then((v) => (v.real ? finding : null)),
)

const confirmed = verdicts.filter(Boolean)
log(`${confirmed.length} of ${findings.length} findings confirmed`)

return confirmed
