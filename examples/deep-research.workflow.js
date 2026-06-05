export const meta = {
  name: "deep-research",
  description:
    "Research a question from multiple angles, gather sourced claims, adversarially verify each, and synthesize a cited report.",
  defaultSandbox: "read-only",
  phases: [
    { title: "Scope" },
    { title: "Search" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
}

const question =
  args && typeof args === "object" && typeof args.question === "string" && args.question.trim()
    ? args.question.trim()
    : "What are the most important recent developments in this field, and what is the evidence for them?"

// ----------------------------------------------------------------------------
// Phase 1: Scope — break the question into distinct research angles.
// ----------------------------------------------------------------------------
phase("Scope")
log(`scoping research for: ${question}`)

const scope = await agent(
  `You are scoping a research project for this question:\n\n${question}\n\n` +
    `Break it into 3-6 distinct, non-overlapping angles of investigation. ` +
    `Each angle should be a concrete sub-question or direction that, researched independently, ` +
    `would contribute a different piece of the overall answer. Avoid duplicates and avoid angles ` +
    `so broad they restate the original question.`,
  {
    label: "scope angles",
    sandbox: "read-only",
    schema: {
      type: "object",
      required: ["angles"],
      properties: {
        angles: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
    },
  },
)

const angles = (scope.angles || []).filter(Boolean)
log(`generated ${angles.length} angles`)

// ----------------------------------------------------------------------------
// Phase 2: Search — one researcher per angle, in parallel. Each returns sourced claims.
// ----------------------------------------------------------------------------
phase("Search")

const searches = await parallel(
  angles.map((angle, i) => () =>
    agent(
      `Overall research question:\n${question}\n\n` +
        `Investigate this specific angle (#${i + 1}):\n${angle}\n\n` +
        `Find concrete, verifiable claims that bear on this angle. For each claim, give the most ` +
        `authoritative source you can identify (a URL, paper title, dataset, or named primary source). ` +
        `Do not invent sources. Prefer fewer well-sourced claims over many weak ones.`,
      {
        label: `search: ${angle.slice(0, 40)}`,
        sandbox: "read-only",
        schema: {
          type: "object",
          required: ["claims"],
          properties: {
            claims: {
              type: "array",
              items: {
                type: "object",
                required: ["claim", "source"],
                properties: {
                  claim: { type: "string" },
                  source: { type: "string" },
                },
              },
            },
          },
        },
      },
    ).then((r) => ({ angle, claims: (r.claims || []).filter(Boolean) })),
  ),
)

const allClaims = searches
  .filter(Boolean)
  .flatMap((s) => s.claims.map((c) => ({ ...c, angle: s.angle })))

log(`collected ${allClaims.length} candidate claims across ${angles.length} angles`)

// ----------------------------------------------------------------------------
// Phase 3: Verify — for each claim, an independent agent tries to REFUTE it.
// Keep only the survivors. Pipeline so each claim verifies as soon as it exists.
// ----------------------------------------------------------------------------
phase("Verify")

const verified = await pipeline(allClaims, (claim) =>
  agent(
    `You are a skeptical fact-checker. Try to REFUTE the following claim using independent reasoning ` +
      `and the cited source. A claim is refuted if it is false, unsupported by its source, materially ` +
      `misleading, or the source does not exist / does not say this. Default to refuted=true when you ` +
      `are unsure.\n\n` +
      `Claim: ${claim.claim}\n` +
      `Cited source: ${claim.source}\n` +
      `(angle: ${claim.angle})`,
    {
      label: `verify: ${claim.claim.slice(0, 40)}`,
      sandbox: "read-only",
      schema: {
        type: "object",
        required: ["refuted", "reason"],
        properties: {
          refuted: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  ).then((v) => (v.refuted ? null : { ...claim, verifiedReason: v.reason })),
)

const survivors = verified.filter(Boolean)
log(`${survivors.length} of ${allClaims.length} claims survived verification`)

// ----------------------------------------------------------------------------
// Phase 4: Synthesize — write a cited report from the surviving claims.
// ----------------------------------------------------------------------------
phase("Synthesize")

if (survivors.length === 0) {
  return (
    `# Research report: ${question}\n\n` +
    `No claims survived adversarial verification. The available evidence was either unsourced, ` +
    `contradicted, or too weak to support a confident answer. Consider broadening the angles or ` +
    `relaxing the verification bar.`
  )
}

const report = await agent(
  `Write a well-structured, cited research report answering this question:\n\n${question}\n\n` +
    `Use ONLY the verified claims below. Group related claims, draw a clear overall conclusion, and ` +
    `note any remaining uncertainty or gaps. Cite the source inline for every claim you use. Do not ` +
    `introduce new facts that are not among these claims.\n\n` +
    `Verified claims (JSON):\n${JSON.stringify(survivors, null, 2)}`,
  {
    label: "synthesize report",
    sandbox: "read-only",
  },
)

return report
