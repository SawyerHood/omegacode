export const meta = {
  name: 'feature-factory',
  description: 'PRD/task to reviewed working code: decompose, build each module, verify each build',
  phases: [
    { title: 'Decompose', detail: 'one agent splits the task into modules' },
    { title: 'Build', detail: 'one implement-module leaf per module' },
    { title: 'Verify', detail: 'one deep-verify leaf per build' },
    { title: 'Report', detail: 'synthesize the shipping report' },
  ],
}
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brief: { type: 'string' },
        },
        required: ['name', 'brief'],
        additionalProperties: false,
      },
    },
  },
  required: ['modules'],
  additionalProperties: false,
}
phase('Decompose')
const modules = args.modules || (await agent(
  `Decompose this task into 2-6 independently implementable modules. ` +
  `Each module needs a short kebab-case name and a one-paragraph brief a fresh agent ` +
  `could implement without further context. Task:\n\n${args.task}`,
  { label: 'decompose', schema: PLAN_SCHEMA },
)).modules
// Each module verifies as soon as its build completes — no barrier between stages.
phase('Build')
phase('Verify')
const built = await pipeline(
  modules,
  m => workflow('implement-module', { module: m, context: args.context }),
  (code, m) => workflow('deep-verify', { target: m.name, code: JSON.stringify(code) }),
)
phase('Report')
const shipped = built.filter(Boolean)
const blocked = shipped.filter(b => (b.findings || []).some(f => f.verdict === 'CONFIRMED' && f.severity === 'critical'))
return {
  task: args.task,
  modules: shipped.map(b => ({ target: b.target, summary: b.summary, critical: b.findings.filter(f => f.verdict === 'CONFIRMED') })),
  blocked: blocked.map(b => b.target),
}
