export const meta = {
  name: 'deep-verify',
  description: 'Adversarially verify a code artifact: refute-first verdicts per finding',
  phases: [
    { title: 'Verify', detail: 'one skeptic judges every claim' },
  ],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string' },
          verdict: { type: 'string' },
        },
        required: ['title', 'severity', 'verdict'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
}
phase('Verify')
const subject = args.code
  ? `Code under review:\n${args.code}`
  : `Review target: ${args.target}\nInspect it in the working directory first.`
const verdict = await agent(
  `Adversarially verify the following. For each potential issue, try to REFUTE it first: ` +
  `a finding survives only with concrete evidence (file, line, failing behavior). ` +
  `Default to REFUTED when uncertain. Verdicts are CONFIRMED, PLAUSIBLE, or REFUTED; ` +
  `severity is one of critical, major, minor.\n\n${subject}`,
  {
    label: `verify:${args.target || 'code'}`,
    schema: VERDICT_SCHEMA,
  },
)
return { target: args.target || 'code', summary: verdict.summary, findings: verdict.findings }
