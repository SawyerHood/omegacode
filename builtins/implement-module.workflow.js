export const meta = {
  name: 'implement-module',
  description: 'Implement one module from a brief: write the code and report what changed',
  phases: [
    { title: 'Build', detail: 'one agent implements the module' },
  ],
}
const MODULE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files'],
  additionalProperties: false,
}
phase('Build')
const module = args.module
const context = args.context ? `Repository context:\n${args.context}\n\n` : ''
const result = await agent(
  `${context}Implement this module and write the files:\n\n` +
  `Module: ${module.name}\nBrief: ${module.brief}\n\n` +
  `Rules: make the smallest change that satisfies the brief; run the relevant checks ` +
  `if the repo has them; list every file you created or modified.`,
  {
    label: `build:${module.name}`,
    // No sandbox pin: inherit the run default. Builders must write, so run this leaf under
    // a writing policy (the fleet default danger-full-access covers opencode/pi; a read-only
    // run fails closed here with an actionable error instead of silently not writing).
    schema: MODULE_SCHEMA,
  },
)
return { name: module.name, brief: module.brief, summary: result.summary, files: result.files }
