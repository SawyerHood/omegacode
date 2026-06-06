export const meta = {
  name: "omega-logos",
  description: "Generate 5 alternate omega logo PNGs with codex image gen, serially (rate limit).",
  phases: [{ title: "Generate", detail: "one codex image-gen agent at a time" }],
}

const OUT_DIR = "omega-logos"

const STYLES = [
  {
    slug: "minimal-geometric",
    direction:
      "Minimal flat geometric mark: a bold uppercase omega (Ω) built from clean circular arcs and straight terminals, single dark ink color on white, generous negative space, works at 16px favicon size.",
  },
  {
    slug: "neon-gradient",
    direction:
      "Modern neon gradient: omega (Ω) glyph with a smooth violet-to-cyan gradient, soft outer glow on a near-black background, crisp vector-like edges, tech-startup feel.",
  },
  {
    slug: "ink-brush",
    direction:
      "Hand-drawn sumi-e ink brush: a single confident brushstroke forming the omega (Ω), visible bristle texture and slight splatter, black ink on warm off-white paper.",
  },
  {
    slug: "metallic-3d",
    direction:
      "Polished 3D metallic emblem: extruded chrome/brushed-steel omega (Ω) with subtle studio reflections, floating over a dark gradient backdrop, premium hardware-brand look.",
  },
  {
    slug: "terminal-pixel",
    direction:
      "Retro terminal pixel art: omega (Ω) rendered as chunky phosphor-green pixels on a black CRT background with faint scanlines, evoking a classic CLI aesthetic.",
  },
]

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Relative path of the PNG that was written" },
    notes: { type: "string", description: "One sentence on the design choices made" },
  },
  required: ["path"],
  additionalProperties: false,
}

phase("Generate")
const results = []
// strictly serial: image-gen is rate limited, so await each agent before starting the next
for (let i = 0; i < STYLES.length; i++) {
  const s = STYLES[i]
  log(`generating ${i + 1}/${STYLES.length}: ${s.slug}`)
  const r = await agent(
    `You are generating one logo image for the "omegacode" project.

Art direction: ${s.direction}

Steps:
1. Create the directory ${OUT_DIR}/ in the workspace if it does not exist.
2. Use your hosted image generation tool to generate a square 1024x1024 logo image matching the art direction. It is a logo: centered single Ω mark, no text or wordmark, no watermark.
3. Save the result as a PNG at ${OUT_DIR}/omega-${i + 1}-${s.slug}.png.
4. Verify the file exists and is a non-empty valid PNG before finishing.

If the image generation tool is rate limited, wait briefly and retry rather than giving up.`,
    {
      label: `logo:${s.slug}`,
      sandbox: "workspace-write",
      schema: RESULT_SCHEMA,
      key: `logo-${s.slug}`,
    },
  )
  if (r) results.push({ style: s.slug, ...r })
}

log(`done: ${results.length}/${STYLES.length} logos written to ${OUT_DIR}/`)
return { outDir: OUT_DIR, logos: results }
