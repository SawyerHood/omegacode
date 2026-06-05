export const meta = {
  name: "hello",
  description: "Smallest possible workflow: fan out a few agents and synthesize.",
  phases: [{ title: "Gather" }, { title: "Synthesize" }],
}

phase("Gather")
const topics = ["rivers", "mountains", "deserts"]
const facts = await parallel(
  topics.map((t) => () => agent(`Give one surprising fact about ${t}.`, { sandbox: "read-only" })),
)

phase("Synthesize")
log(`gathered ${facts.filter(Boolean).length} facts`)
const summary = await agent(`Combine these into a 2-sentence note:\n${facts.join("\n")}`)

return summary
